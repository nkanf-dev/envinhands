import { expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBus } from "../src/agent-bus.ts";
import { createNativeMeshApi, NativeMesh, qualifiedAgentId, familyReachable } from "../src/integrations/native-mesh.ts";

const token = "isolated-fixture";
type Api = ReturnType<typeof createNativeMeshApi>;
type Observation = {id:string; name:string; lastHeartbeatAt:string; [key:string]:unknown};
type Page = {version:number; revision:string; nextCursor:string|null; agents:Observation[]};
const headers = {authorization:`Bearer ${token}`};
function get(api:Api, query = "", auth = headers.authorization) {
  return api.fetch(new Request(`http://localhost/v1/native-mesh/agents${query}`, {headers:{authorization:auth}}));
}
function register(api:Api, agentId:string, name = agentId) {
  return api.fetch(new Request("http://localhost/v1/native-mesh/agents", {method:"POST", headers:{...headers,"content-type":"application/json"}, body:JSON.stringify({hostId:"host",agentId,parentId:null,name,state:"active"})}));
}
function continuation(page:Page, limit = 1) {
  return `?${new URLSearchParams({limit:String(limit),after:page.nextCursor!,revision:page.revision})}`;
}
async function first(api:Api, limit = 1):Promise<Page> {
  const response = await get(api, `?limit=${limit}`);
  expect(response.status).toBe(200);
  return await response.json() as Page;
}
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"mesh-snapshot-test-"));
  return {dir, path:join(dir,"test.sqlite"), cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test("snapshot remains immutable during registrations and repeated heartbeats on another connection", async () => {
  const f=fixture(), a=createNativeMeshApi({dbPath:f.path,token}), b=createNativeMeshApi({dbPath:f.path,token});
  try {
    for (const id of ["a","b","c","d"]) expect((await register(a,id)).status).toBe(200);
    const legacy = await (await get(a)).json() as {agents:Observation[]};
    let page=await first(a); const snapshot=page.revision, rows=[...page.agents];
    expect(page.version).toBe(2); expect(page.nextCursor).not.toBeNull();
    expect((await register(b,"b")).status).toBe(200);
    while (page.nextCursor) {
      expect((await register(b,"a")).status).toBe(200);
      const res=await get(a,continuation(page)); expect(res.status).toBe(200);
      page=await res.json() as Page;
      expect(page.revision).toBe(snapshot); rows.push(...page.agents);
    }
    expect(rows).toEqual(legacy.agents);
    expect(new Set(rows.map(row=>row.id)).size).toBe(4);
    expect((await (await get(a)).json() as {agents:Observation[]}).agents).toHaveLength(4);
  } finally { a.close(); b.close(); f.cleanup(); }
});

test("1500-row discovery finishes with a heartbeat before every continuation", async () => {
  const f=fixture(), db=new Database(f.path);
  db.exec("PRAGMA journal_mode=WAL");
  const a=createNativeMeshApi({dbPath:f.path,token}), b=createNativeMeshApi({dbPath:f.path,token});
  try {
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(()=>{for(let i=0;i<1500;i++) {
      const id=String(i); insert.run(qualifiedAgentId("host",id),"host",id,null,"initial","active","2025-01-01T00:00:00.000Z");
    }})();
    let page=await first(a,99), pages=1; const rows=[...page.agents];
    while (page.nextCursor) {
      expect((await register(b,"0","initial")).status).toBe(200);
      const response=await get(a,continuation(page,99)); expect(response.status).toBe(200);
      page=await response.json() as Page; rows.push(...page.agents); pages++;
    }
    expect(pages).toBe(16); expect(rows).toHaveLength(1500);
    expect(new Set(rows.map(row=>row.id)).size).toBe(1500);
    expect(rows.every(row=>row.name==="initial")).toBe(true);
  } finally { db.close(); a.close(); b.close(); f.cleanup(); }
});

test("WAL first pages read an atomic view while an independent process commits paired updates", async () => {
  const f=fixture(), setup=new Database(f.path);
  setup.exec("PRAGMA journal_mode=WAL"); setup.close();
  const api=createNativeMeshApi({dbPath:f.path,token});
  let worker:ReturnType<typeof Bun.spawn> | undefined;
  try {
    await register(api,"a","0"); await register(api,"b","0");
    const script=join(f.dir,"writer.ts");
    writeFileSync(script, `import { Database } from "bun:sqlite";
const db=new Database(process.argv[2]); db.exec("PRAGMA busy_timeout=5000");
const update=db.query("UPDATE native_mesh_agents_v1 SET name=? WHERE agent_id=?");
const tx=db.transaction((name:string)=>{update.run(name,"a"); update.run(name,"b");});
await Bun.write(Bun.stdout,"ready");
let n=0; while(true) tx(String(++n));`);
    worker=Bun.spawn([process.execPath,script,f.path],{stdout:"pipe",stderr:"ignore"});
    const reader=(worker.stdout as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).done).toBe(false); reader.releaseLock();
    const versions=new Set<string>();
    for (let i=0;i<300;i++) {
      const page=await first(api,100);
      expect(page.agents).toHaveLength(2);
      expect(page.agents[0]!.name).toBe(page.agents[1]!.name);
      versions.add(page.agents[0]!.name);
    }
    // The writer must have committed during this test, not merely before it.
    expect(versions.size).toBeGreaterThan(1);
  } finally {
    if (worker) { worker.kill(); await worker.exited; }
    api.close(); f.cleanup();
  }
});

test("continuations enforce auth, cursor provenance, exact page size, syntax and snapshot ownership", async () => {
  const f=fixture(); let a=createNativeMeshApi({dbPath:f.path,token}); const b=createNativeMeshApi({dbPath:f.path,token});
  try {
    for (const id of ["a","b","c"]) await register(a,id);
    const page=await first(a), query=continuation(page);
    expect((await get(a,query,"")).status).toBe(401);
    expect((await get(a,query,"Bearer incorrect")).status).toBe(401);
    expect((await get(b,query)).status).toBe(409);
    for (const invalid of [
      `?limit=2&after=${page.nextCursor}&revision=${page.revision}`,
      `?limit=1&after=${qualifiedAgentId("other","other")}&revision=${page.revision}`,
      `?limit=1&after=${page.nextCursor}&revision=${page.revision}&limit=1`,
      `?limit=1&after=${page.nextCursor}`,
      `?limit=1&revision=${page.revision}`,
      `?limit=01&after=${page.nextCursor}&revision=${page.revision}`,
      `?limit=1&after=bad&revision=${page.revision}`,
      `?limit=1&after=${page.nextCursor}&revision=-1`,
      `?limit=1&after=${page.nextCursor}&revision=${page.revision}&extra=1`,
    ]) expect((await get(a,invalid)).status).toBe(400);
    expect((await get(a,query)).status).toBe(200);
    a.close(); a=createNativeMeshApi({dbPath:f.path,token});
    expect((await get(a,query)).status).toBe(409);
  } finally { a.close(); b.close(); f.cleanup(); }
});

test("expiry is fixed from snapshot creation and expired discovery restarts cleanly", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token});
  try {
    const clock=jest.spyOn(performance,"now"); clock.mockReturnValue(0);
    for (const id of ["a","b","c"]) await register(api,id);
    const one=await first(api);
    clock.mockReturnValue(29_000);
    const response=await get(api,continuation(one)); expect(response.status).toBe(200);
    const two=await response.json() as Page; expect(two.nextCursor).not.toBeNull();
    clock.mockReturnValue(31_000);
    expect((await get(api,continuation(two))).status).toBe(409);
    const replacement=await first(api); expect(replacement.agents).toEqual(one.agents);
    expect(replacement.revision).not.toBe(one.revision);
  } finally { jest.restoreAllMocks(); api.close(); f.cleanup(); }
});

test("five concurrent page sizes share one snapshot and each completes a consistent scan", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token});
  try {
    for (const id of ["a","b","c","d","e","f"]) await register(api,id);
    const responses=await Promise.all([1,2,3,4,5].map(limit=>get(api,`?limit=${limit}`)));
    expect(responses.map(x=>x.status)).toEqual([200,200,200,200,200]);
    const pages=await Promise.all(responses.map(async r=>await r.json() as Page));
    expect(new Set(pages.map(p=>p.revision)).size).toBe(1);
    const results:Observation[][]=[];
    for (const [i,firstPage] of pages.entries()) {
      let page=firstPage; const rows=[...page.agents];
      while(page.nextCursor) {const response=await get(api,continuation(page,i+1)); expect(response.status).toBe(200); page=await response.json() as Page; rows.push(...page.agents);}
      results.push(rows);
    }
    for (const rows of results) {expect(rows).toHaveLength(6); expect(rows).toEqual(results[0]!);}
  } finally { api.close(); f.cleanup(); }
});

test("three existing NativeMesh clients can scan multi-page v2 registries concurrently", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(()=>{for(let i=0;i<8000;i++) {
      const id=String(i); insert.run(qualifiedAgentId("host",id),"host",id,null,"n".repeat(128),"active","2025-01-01T00:00:00.000Z");
    }})();
    const statuses:number[]=[];
    const transport=(async (input,init)=>{const res=await api.fetch(new Request(String(input),init)); statuses.push(res.status); return res;}) as typeof fetch;
    const clients=Array.from({length:3},()=>new NativeMesh({baseUrl:"http://localhost",token,fetch:transport}));
    const results=await Promise.all(clients.map(client=>client.discover()));
    expect(results).toHaveLength(3); expect(results.every(rows=>rows.length===8000)).toBe(true);
    for (const rows of results) expect(rows).toEqual(results[0]!);
    expect(statuses.filter(status=>status===200).length).toBeGreaterThanOrEqual(6);
    expect(statuses.every(status=>status===200 || status===400)).toBe(true);
  } finally { db.close(); api.close(); f.cleanup(); }
});


test("concurrent limit=100 v2 scans fail closed at snapshot capacity", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(()=>{for(let i=0;i<8000;i++) {
      const id=String(i); insert.run(qualifiedAgentId("host",id),"host",id,null,"n".repeat(128),"active","2025-01-01T00:00:00.000Z");
    }})();
    const statuses:number[]=[];
    for(let i=0;i<49;i++) {
      const res=await get(api,"?limit=100"); statuses.push(res.status);
      if(res.status===200) expect((await res.json() as Page).version).toBe(2);
    }
    expect(statuses[0]).toBe(200);
    expect(statuses.every(status=>status===200 || status===503)).toBe(true);
    expect(statuses).toContain(503);
  } finally {db.close();api.close();f.cleanup();}
});

test("shared snapshots tolerate heartbeats, refresh after ten seconds and expire without renewal", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token});
  try {
    const clock=jest.spyOn(performance,"now"); clock.mockReturnValue(0);
    for (const id of ["a","b","c"]) await register(api,id,"old");
    const original=await first(api);
    expect((await register(api,"a","old")).status).toBe(200);
    clock.mockReturnValue(9_999);
    const shared=await first(api);
    expect(shared.revision).toBe(original.revision); expect(shared.agents).toEqual(original.agents);
    clock.mockReturnValue(10_001);
    const refreshed=await first(api); expect(refreshed.revision).not.toBe(original.revision);
    const freshRows=[...refreshed.agents]; let page=refreshed;
    while(page.nextCursor) {const res=await get(api,continuation(page)); expect(res.status).toBe(200); page=await res.json() as Page; freshRows.push(...page.agents);}
    expect(freshRows.find(row=>row.id===qualifiedAgentId("host","a"))?.name).toBe("old");
    clock.mockReturnValue(30_001);
    expect((await get(api,continuation(original))).status).toBe(409);
    expect((await get(api,continuation(refreshed))).status).toBe(200);
    clock.mockReturnValue(40_002);
    expect((await get(api,continuation(refreshed))).status).toBe(409);
  } finally { jest.restoreAllMocks(); api.close(); f.cleanup(); }
});

test("oversized registry is rejected rather than truncated", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(()=>{for(let i=0;i<20001;i++) {const id=String(i); insert.run(qualifiedAgentId("host",id),"host",id,null,"n","active","2025-01-01T00:00:00.000Z");}})();
    expect((await get(api,"?limit=100")).status).toBe(413);
  } finally { db.close(); api.close(); f.cleanup(); }
});

test("large snapshot generations expire and a single oversized snapshot is rejected", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    const clock=jest.spyOn(performance,"now"); clock.mockReturnValue(0);
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    const add=(from:number,to:number)=>db.transaction(()=>{for(let i=from;i<to;i++) {
      const id=String(i).padStart(5,"0");
      insert.run(qualifiedAgentId("h",id),"h",id,null,"n".repeat(128),"active","2025-01-01T00:00:00.000Z");
    }})();
    add(0,8500);
    const one=await first(api,100);
    clock.mockReturnValue(10_001); const two=await first(api,100);
    clock.mockReturnValue(20_002); const three=await first(api,100);
    expect(new Set([one.revision,two.revision,three.revision]).size).toBe(3);
    clock.mockReturnValue(30_003); const four=await first(api,100);
    expect(four.revision).not.toBe(three.revision);
    expect((await get(api,continuation(one,100))).status).toBe(409);
    expect((await get(api,continuation(two,100))).status).toBe(200);
    add(8500,11000);
    clock.mockReturnValue(40_004);
    // Below the row cap: rejection is due to the 8 MiB accounting cap.
    expect((await get(api,"?limit=100")).status).toBe(413);
  } finally { jest.restoreAllMocks(); db.close(); api.close(); f.cleanup(); }
});

test("NativeMesh restarts a real scan after a topology change between pages", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), writer=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(()=>{for(let i=0;i<8000;i++) {const id=`existing-${i}`; insert.run(qualifiedAgentId("host",id),"host",id,null,"n".repeat(128),"active","2025-01-01T00:00:00.000Z");}})();
    let changed=false, conflicts=0, starts=0;
    const transport=(async (input,init)=>{
      const req=new Request(String(input),init), url=new URL(req.url);
      if (url.searchParams.has("after") && !changed) {changed=true; if ((await register(writer,"new")).status!==200) throw new Error("registration failed");}
      const res=await api.fetch(req); if(res.status===409) conflicts++;
      if (!url.searchParams.has("after") && res.ok) starts++;
      return res;
    }) as typeof fetch;
    const client=new NativeMesh({baseUrl:"http://localhost",token,fetch:transport});
    const rows=await client.discover();
    expect(changed).toBe(true); expect(conflicts).toBe(1); expect(starts).toBe(2);
    expect(rows).toHaveLength(8001); expect(rows.some(row=>row.id===qualifiedAgentId("host","new"))).toBe(true);
  } finally { db.close(); writer.close(); api.close(); f.cleanup(); }
});

test("all topology fields invalidate snapshots across instances, including ABA updates", async () => {
  const f=fixture(), a=createNativeMeshApi({dbPath:f.path,token}), b=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  const change=(values:Record<string,unknown>)=>b.fetch(new Request("http://localhost/v1/native-mesh/agents",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({hostId:"host",agentId:"a",parentId:null,name:"a",state:"active",...values})}));
  try {
    for (const id of ["a","b","c"]) await register(a,id);
    for (const values of [{name:"renamed"},{name:"a"},{parentId:qualifiedAgentId("host","b")},{state:"inactive"},{state:"active"}]) {
      const oldA=await first(a), oldB=await first(b);
      expect((await change(values)).status).toBe(200);
      expect((await get(a,continuation(oldA))).status).toBe(409);
      expect((await get(b,continuation(oldB))).status).toBe(409);
    }
    const old=await first(a);
    db.transaction(()=>{ db.query("UPDATE native_mesh_agents_v1 SET name=? WHERE agent_id=?").run("temporary","a"); db.query("UPDATE native_mesh_agents_v1 SET name=? WHERE agent_id=?").run("a","a"); })();
    expect((await get(a,continuation(old))).status).toBe(409);
    for (const [column,original,replacement] of [
      ["host_id","host","other-host"], ["agent_id","a","other-agent"],
      ["id",qualifiedAgentId("host","a"),qualifiedAgentId("host","other")],
    ]) {
      const page=await first(a);
      const rowid=(db.query("SELECT rowid AS value FROM native_mesh_agents_v1 WHERE id=?").get(qualifiedAgentId("host","a")) as {value:number}).value;
      db.transaction(()=>{const update=db.query(`UPDATE native_mesh_agents_v1 SET ${column}=? WHERE rowid=?`); update.run(replacement,rowid); update.run(original,rowid);})();
      expect((await get(a,continuation(page))).status).toBe(409);
    }
    const postAba=await first(a);
    expect((await change({})).status).toBe(200); // Identical topology; receipt time only.
    expect((await get(a,continuation(postAba))).status).toBe(200);
    const beforeDelete=await first(a);
    db.transaction(()=>{db.query("DELETE FROM native_mesh_agents_v1 WHERE agent_id=?").run("a"); db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)").run(qualifiedAgentId("host","a"),"host","a",null,"a","active","2025-01-01T00:00:00.000Z");})();
    expect((await get(a,continuation(beforeDelete))).status).toBe(409);
  } finally { db.close(); a.close(); b.close(); f.cleanup(); }
});

test("legacy revision survives restart and old-version SQL writers invalidate topology but not heartbeats", async () => {
  const f=fixture(), seed=new Database(f.path);
  seed.exec("CREATE TABLE native_mesh_revision_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL); INSERT INTO native_mesh_revision_v2 VALUES (1, 250)"); seed.close();
  let api=createNativeMeshApi({dbPath:f.path,token}); const old=new Database(f.path);
  const globalRevision=()=>Number((old.query("SELECT revision FROM native_mesh_revision_v2 WHERE singleton=1").get() as {revision:number}).revision);
  const topologyRevision=()=>Number((old.query("SELECT revision FROM native_mesh_topology_revision_v3 WHERE singleton=1").get() as {revision:number}).revision);
  // The former server's upsert and global-revision increment, run on an independent test DB connection.
  const oldWrite=(id:string,name:string)=>old.transaction(()=>{
    old.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,state=excluded.state,last_heartbeat_at=excluded.last_heartbeat_at").run(qualifiedAgentId("host",id),"host",id,null,name,"active","2025-01-01T00:00:00.000Z");
    old.query("UPDATE native_mesh_revision_v2 SET revision=revision+1 WHERE singleton=1").run();
  })();
  try {
    expect(globalRevision()).toBeGreaterThanOrEqual(250); expect(topologyRevision()).toBe(0);
    oldWrite("a","a"); oldWrite("b","b"); oldWrite("c","c");
    const firstRevision=globalRevision(); expect(firstRevision).toBeGreaterThan(250);
    const heartbeatPage=await first(api), topologyBeforeHeartbeat=topologyRevision(); oldWrite("a","a");
    expect(globalRevision()).toBeGreaterThan(firstRevision); expect(topologyRevision()).toBe(topologyBeforeHeartbeat);
    expect((await get(api,continuation(heartbeatPage))).status).toBe(200);
    const beforeChange=await first(api); oldWrite("a","changed");
    expect((await get(api,continuation(beforeChange))).status).toBe(409);
    expect(topologyRevision()).toBeGreaterThan(topologyBeforeHeartbeat);
    const retained=globalRevision(), topologyRetained=topologyRevision(); api.close(); api=createNativeMeshApi({dbPath:f.path,token});
    expect(globalRevision()).toBe(retained); expect(topologyRevision()).toBe(topologyRetained);
    expect((await get(api,continuation(beforeChange))).status).toBe(409);
    const fresh=await first(api); oldWrite("new","new");
    expect((await get(api,continuation(fresh))).status).toBe(409);
    expect(globalRevision()).toBeGreaterThan(retained); expect(topologyRevision()).toBeGreaterThan(topologyRetained);
  } finally { old.close(); api.close(); f.cleanup(); }
});

test("missing topology singleton fails closed for snapshots and topology-changing writes", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    for(const id of ["a","b","c"]) await register(api,id);
    const page=await first(api);
    db.exec("DELETE FROM native_mesh_topology_revision_v3 WHERE singleton=1");
    expect((await get(api,"?limit=1")).status).toBe(500);
    expect((await get(api,continuation(page))).status).toBe(500);
    expect((await register(api,"new")).status).toBe(500);
    expect((await register(api,"a","changed")).status).toBe(500);
    expect(()=>db.query("DELETE FROM native_mesh_agents_v1 WHERE agent_id=?").run("a")).toThrow();
    const result=db.query("SELECT COUNT(*) AS n FROM native_mesh_agents_v1").get() as {n:number};
    expect(result.n).toBe(3);
    const a=db.query("SELECT name FROM native_mesh_agents_v1 WHERE agent_id=?").get("a") as {name:string};
    expect(a.name).toBe("a");
  } finally { db.close(); api.close(); f.cleanup(); }
});

test("v3 triggers keep maintaining topology while an old-version writer runs after rollback", async () => {
  const f=fixture(); let api=createNativeMeshApi({dbPath:f.path,token}); const old=new Database(f.path);
  const revision=()=>Number((old.query("SELECT revision FROM native_mesh_topology_revision_v3 WHERE singleton=1").get() as {revision:number}).revision);
  const oldWrite=(id:string,name:string)=>old.transaction(()=>{
    old.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,state=excluded.state,last_heartbeat_at=excluded.last_heartbeat_at").run(qualifiedAgentId("host",id),"host",id,null,name,"active","2025-01-01T00:00:00.000Z");
    old.query("UPDATE native_mesh_revision_v2 SET revision=revision+1 WHERE singleton=1").run();
  })();
  try {
    await register(api,"a"); await register(api,"b"); const initial=revision();
    api.close(); // Simulated software rollback; preserve the shared test database and triggers.
    oldWrite("a","a"); expect(revision()).toBe(initial);
    oldWrite("a","changed"); const afterRollback=revision(); expect(afterRollback).toBeGreaterThan(initial);
    oldWrite("new","new"); const afterInsert=revision(); expect(afterInsert).toBeGreaterThan(afterRollback);
    api=createNativeMeshApi({dbPath:f.path,token});
    expect(revision()).toBe(afterInsert);
    expect((old.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('native_mesh_topology_insert_v3','native_mesh_topology_update_v3','native_mesh_topology_delete_v3')").get() as {n:number}).n).toBe(3);
    const page=await first(api);
    old.query("DELETE FROM native_mesh_agents_v1 WHERE agent_id=?").run("new");
    expect(revision()).toBeGreaterThan(afterInsert);
    expect((await get(api,continuation(page))).status).toBe(409);
  } finally { old.close(); api.close(); f.cleanup(); }
});

test("topology revision overflow rolls back the entire registration", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    db.exec("UPDATE native_mesh_topology_revision_v3 SET revision=9223372036854775807 WHERE singleton=1");
    expect((await register(api,"overflow")).status).toBe(500);
    expect(Number((db.query("SELECT COUNT(*) AS n FROM native_mesh_agents_v1 WHERE agent_id=?").get("overflow") as {n:number}).n)).toBe(0);
    expect((db.query("SELECT CAST(revision AS TEXT) AS value FROM native_mesh_topology_revision_v3 WHERE singleton=1").get() as {value:string}).value).toBe("9223372036854775807");
  } finally { db.close(); api.close(); f.cleanup(); }
});

test("embedded NUL cannot bypass stored-row size and registration validation", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), db=new Database(f.path);
  try {
    db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)").run(qualifiedAgentId("h","a"),"h","a",null,"initial","active","2025-01-01T00:00:00.000Z");
    db.query("UPDATE native_mesh_agents_v1 SET name=char(0) || ?").run("x".repeat(2*1024*1024));
    expect((db.query("SELECT length(CAST(name AS BLOB)) AS n FROM native_mesh_agents_v1").get() as {n:number}).n).toBe(2*1024*1024+1);
    // NUL is treated as corrupt data before potentially copying a giant blob.
    expect((await get(api,"?limit=1")).status).toBe(500);
    expect((await get(api)).status).toBe(413);
    db.exec("UPDATE native_mesh_agents_v1 SET name=char(0) || 'corrupt'");
    expect((await get(api,"?limit=1")).status).toBe(500);
  } finally { db.close(); api.close(); f.cleanup(); }
});

test("NativeMesh family discovery under page heartbeats preserves pending pull and ack semantics", async () => {
  const f=fixture(), mesh=createNativeMeshApi({dbPath:f.path,token}), writer=createNativeMeshApi({dbPath:f.path,token}), bus=createAgentBus({dbPath:f.path,token}), db=new Database(f.path);
  try {
    const senderId=qualifiedAgentId("host","sender"), recipientId=qualifiedAgentId("host","recipient");
    expect((await register(mesh,"sender")).status).toBe(200);
    const response=await mesh.fetch(new Request("http://localhost/v1/native-mesh/agents",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({hostId:"host",agentId:"recipient",parentId:senderId,name:"recipient",state:"active"})}));
    expect(response.status).toBe(200);
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(()=>{for(let i=0;i<8000;i++) {
      const id=`filler-${i}`; insert.run(qualifiedAgentId("host",id),"host",id,null,"f".repeat(128),"active","2025-01-01T00:00:00.000Z");
    }})();
    let heartbeats=0;
    const transport=(async (input,init)=>{
      const req=new Request(String(input),init), url=new URL(req.url);
      if (url.pathname==="/v1/native-mesh/agents") {
        if (req.method==="GET" && url.searchParams.has("after")) {
          const heartbeat=await register(writer,"sender");
          if (heartbeat.status!==200) throw new Error("heartbeat failed");
          heartbeats++;
        }
        return mesh.fetch(req);
      }
      return bus.fetch(req);
    }) as typeof fetch;
    const sender=new NativeMesh({baseUrl:"http://localhost",token,fetch:transport});
    const recipient=new NativeMesh({baseUrl:"http://localhost",token,fetch:transport});
    await sender.send({senderId,recipientId,messageId:"fixture-message",text:"fixture"});
    const observed=await sender.discover();
    expect(observed).toHaveLength(8002); expect(heartbeats).toBeGreaterThan(0);
    const self=observed.find(row=>row.id===senderId), target=observed.find(row=>row.id===recipientId);
    expect(self).toBeDefined(); expect(target).toBeDefined();
    expect(familyReachable(self!,target!)).toBe(true);
    const pending=await recipient.pull(recipientId);
    expect(pending).toHaveLength(1);
    expect((await recipient.pull(recipientId)).length).toBe(1);
    await recipient.ack(pending[0]!.requestId);
    expect((await recipient.pull(recipientId)).length).toBe(0);
  } finally { db.close(); bus.close(); writer.close(); mesh.close(); f.cleanup(); }
});

test("topology changes invalidate paging and immediately refresh caller family and pending visibility", async () => {
  const f=fixture(), mesh=createNativeMeshApi({dbPath:f.path,token}), bus=createAgentBus({dbPath:f.path,token}), db=new Database(f.path);
  try {
    const a=qualifiedAgentId("host","parent-a"), b=qualifiedAgentId("host","parent-b"), child=qualifiedAgentId("host","child");
    await register(mesh,"parent-a"); await register(mesh,"parent-b");
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(()=>{for(let i=0;i<101;i++) {const id=`seed-${i}`; insert.run(qualifiedAgentId("host",id),"host",id,null,"seed","active","2025-01-01T00:00:00.000Z");}})();
    const transport=(async (input,init)=>{
      const req=new Request(String(input),init);
      return new URL(req.url).pathname==="/v1/native-mesh/agents" ? mesh.fetch(req) : bus.fetch(req);
    }) as typeof fetch;
    const client=new NativeMesh({baseUrl:"http://localhost",token,fetch:transport});
    const setParent=async (parentId:string)=>mesh.fetch(new Request("http://localhost/v1/native-mesh/agents",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({hostId:"host",agentId:"child",parentId,name:"child",state:"active"})}));
    // This is caller-side compatibility filtering, not server authorization.
    const reachable=(rows:Awaited<ReturnType<NativeMesh["discover"]>>,from:string,to:string)=>{
      const self=rows.find(row=>row.id===from), other=rows.find(row=>row.id===to);
      return !!self && !!other && familyReachable(self,other);
    };
    const sendIfReachable=async (rows:Awaited<ReturnType<NativeMesh["discover"]>>,from:string,messageId:string)=>{
      if (!reachable(rows,from,child)) return false;
      await client.send({senderId:from,recipientId:child,messageId,text:"fixture"}); return true;
    };
    const initial=await client.discover(); expect(initial.some(row=>row.id===child)).toBe(false);
    const oldPage=await first(mesh);
    expect((await setParent(a)).status).toBe(200);
    expect((await get(mesh,continuation(oldPage))).status).toBe(409);
    const registered=await client.discover();
    expect(reachable(registered,a,child)).toBe(true); expect(reachable(registered,b,child)).toBe(false);
    expect(await sendIfReachable(registered,a,"first")).toBe(true);
    const firstPending=await client.pull(child); expect(firstPending.length).toBe(1);
    await client.ack(firstPending[0]!.requestId);
    const beforeMove=await first(mesh);
    expect((await setParent(b)).status).toBe(200);
    expect((await get(mesh,continuation(beforeMove))).status).toBe(409);
    const newParent=await client.discover();
    expect(reachable(newParent,a,child)).toBe(false); expect(reachable(newParent,b,child)).toBe(true);
    expect(await sendIfReachable(newParent,a,"old-parent")).toBe(false);
    expect(await sendIfReachable(newParent,b,"new-parent")).toBe(true);
    const secondPending=await client.pull(child); expect(secondPending.length).toBe(1);
    await client.ack(secondPending[0]!.requestId); expect((await client.pull(child)).length).toBe(0);
  } finally { db.close(); bus.close(); mesh.close(); f.cleanup(); }
});

test("legacy bus heartbeat and message semantics remain independent of mesh snapshots", async () => {
  const f=fixture(), api=createNativeMeshApi({dbPath:f.path,token}), bus=createAgentBus({dbPath:f.path,token});
  const call=(path:string,method="GET",data?:unknown)=>bus.fetch(new Request(`http://localhost${path}`,{method,headers,body:data===undefined?undefined:JSON.stringify(data)}));
  try {
    await register(api,"a"); await register(api,"b"); const page=await first(api);
    expect((await call("/v1/agents/heartbeat","POST",{agentId:"x",machineId:"host"})).status).toBe(200);
    const message={requestId:"fixture-id",from:"x",to:"y",text:"fixture"};
    expect((await call("/v1/messages","POST",message)).status).toBe(201);
    expect((await call("/v1/messages","POST",message)).status).toBe(200);
    expect((await call("/v1/messages","POST",{...message,to:"z"})).status).toBe(409);
    expect((await (await call("/v1/messages?to=y")).json() as {messages:unknown[]}).messages).toHaveLength(1);
    expect((await get(api,continuation(page))).status).toBe(200);
    expect((await call("/v1/messages/fixture-id/ack","POST")).status).toBe(200);
    expect((await call("/v1/messages/fixture-id/ack","POST")).status).toBe(200);
    expect((await (await call("/v1/messages?to=y")).json() as {messages:unknown[]}).messages).toHaveLength(0);
  } finally { api.close(); bus.close(); f.cleanup(); }
});
