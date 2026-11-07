import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeMeshApi, qualifiedAgentId } from "../src/integrations/native-mesh.ts";

const token = "fixture", MAX = 2 * 1024 * 1024;
type Row = {id:string; hostId:string; agentId:string; parentId:null; name:string; state:string; lastHeartbeatAt:string; status:string};
type Page = {version:number; agents:Row[]; nextCursor:string|null; revision:string};
const get = (api:ReturnType<typeof createNativeMeshApi>, query:string) => api.fetch(new Request(`http://localhost/v1/native-mesh/agents${query}`,{headers:{authorization:`Bearer ${token}`}}));
const follow = (page:Page) => `?${new URLSearchParams({limit:"4000",after:page.nextCursor!,revision:page.revision})}`;

test("4000 limit pages use exact escaped UTF-8 bytes and retain every snapshot row", async () => {
 const dir=mkdtempSync(join(tmpdir(),"mesh-limit4000-")), path=join(dir,"test.sqlite");
 const api=createNativeMeshApi({dbPath:path,token}), db=new Database(path);
 try {
  const add=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
  const host="\\".repeat(128), expected=new Set<string>();
  db.transaction(()=>{for(let i=0;i<3000;i++){
   const agent="\\".repeat(100)+String(i), id=qualifiedAgentId(host,agent);
   expected.add(id); add.run(id,host,agent,null,"\\".repeat(100)+"😀".repeat(7),"active","2025-01-01T00:00:00.000Z");
  }})();
  let query="?limit=4000", revision:string|undefined, pages=0, previous:Page|undefined;
  const seen=new Set<string>();
  for (;;) {
   const res=await get(api,query); expect(res.status).toBe(200);
   const bytes=await res.arrayBuffer(); expect(bytes.byteLength).toBeLessThan(MAX);
   const page=JSON.parse(new TextDecoder().decode(bytes)) as Page;
   expect(page.version).toBe(2); expect(page.agents.length).toBeGreaterThan(0); expect(page.agents.length).toBeLessThanOrEqual(4000);
   if(revision===undefined) revision=page.revision; else expect(page.revision).toBe(revision);
   if(previous) {
    const candidate={version:2,agents:[...previous.agents,page.agents[0]!],nextCursor:page.agents[0]!.id,revision};
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBeGreaterThanOrEqual(MAX);
   }
   for(const row of page.agents) {expect(seen.has(row.id)).toBe(false);seen.add(row.id);expect(row.lastHeartbeatAt).toBe("2025-01-01T00:00:00.000Z");}
   pages++;
   if(page.nextCursor===null) break;
   expect(page.nextCursor).toBe(page.agents.at(-1)!.id);
   // Heartbeats must not change the already captured snapshot.
   db.query("UPDATE native_mesh_agents_v1 SET last_heartbeat_at=?").run("2025-01-01T00:00:01.000Z");
   previous=page; query=follow(page);
  }
  expect(pages).toBeGreaterThan(1); expect(seen).toEqual(expected);
  for(const limit of ["0","01","1001","3999","4001","40000","4e3"]) expect((await get(api,`?limit=${limit}`)).status).toBe(400);
 } finally {db.close();api.close();rmSync(dir,{recursive:true,force:true});}
});

test("a single oversized stored observation fails explicitly", async () => {
 const dir=mkdtempSync(join(tmpdir(),"mesh-oversize-")), path=join(dir,"test.sqlite");
 const api=createNativeMeshApi({dbPath:path,token}), db=new Database(path);
 try {
  db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)").run(qualifiedAgentId("h","a"),"h","a",null,"x".repeat(MAX),"active","2025-01-01T00:00:00.000Z");
  const res=await get(api,"?limit=4000"); expect(res.status).toBe(413); expect(await res.json()).toEqual({error:"Observation too large"});
 } finally {db.close();api.close();rmSync(dir,{recursive:true,force:true});}
});

test("an exact 2 MiB candidate is excluded and appears on the next page", async () => {
 const dir=mkdtempSync(join(tmpdir(),"mesh-exact-boundary-")), path=join(dir,"test.sqlite");
 const api=createNativeMeshApi({dbPath:path,token}), db=new Database(path);
 try {
  const add=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)"), host="\\".repeat(128);
  db.transaction(()=>{for(let i=0;i<3000;i++) { const agent="\\".repeat(100)+String(i); add.run(qualifiedAgentId(host,agent),host,agent,null,"\\".repeat(100)+"😀".repeat(7),"active","2025-01-01T00:00:00.000Z"); }})();
  let first=await (await get(api,"?limit=4000")).json() as Page;
  expect(first.nextCursor).not.toBeNull();
  const next=await (await get(api,follow(first))).json() as Page;
  const count=first.agents.length+1, rows=[...first.agents,...next.agents];
  expect(rows.length).toBeGreaterThan(count);
  const update=db.query("UPDATE native_mesh_agents_v1 SET name=? WHERE id=?");
  let exact=false;
  for(let attempt=0;attempt<20;attempt++) {
   const candidate={version:2,agents:rows.slice(0,count),nextCursor:rows[count-1]!.id,revision:first.revision};
   let delta=Buffer.byteLength(JSON.stringify(candidate))-MAX;
   if(delta===0) {
    expect(first.agents).toHaveLength(count-1);
    expect(first.nextCursor).toBe(rows[count-2]!.id);
    const continuation=await get(api,follow(first)); expect(continuation.status).toBe(200);
    const page=await continuation.json() as Page; expect(page.agents[0]!.id).toBe(rows[count-1]!.id);
    exact=true; break;
   }
   db.transaction(()=>{for(const row of rows.slice(0,count)) {
    while(delta>0 && row.name.includes("\\")) {row.name=row.name.replace("\\","x");delta--;}
    while(delta<0 && row.name.includes("x")) {row.name=row.name.replace("x","\\");delta++;}
    update.run(row.name,row.id); if(delta===0) break;
   }})();
   expect(delta).toBe(0);
   first=await (await get(api,"?limit=4000")).json() as Page;
  }
  expect(exact).toBe(true);
 } finally {db.close();api.close();rmSync(dir,{recursive:true,force:true});}
});

test("4000 small records fit one page and topology changes invalidate continuation", async () => {
 const dir=mkdtempSync(join(tmpdir(),"mesh-4000-count-")), path=join(dir,"test.sqlite");
 const api=createNativeMeshApi({dbPath:path,token}), db=new Database(path);
 try {
  const add=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
  db.transaction(()=>{for(let i=0;i<4500;i++) {const a=String(i);add.run(qualifiedAgentId("h",a),"h",a,null,"n","active","2025-01-01T00:00:00.000Z");}})();
  const first=await (await get(api,"?limit=4000")).json() as Page;
  expect(first.agents).toHaveLength(4000); expect(first.nextCursor).toBe(first.agents.at(-1)!.id);
  const second=await (await get(api,follow(first))).json() as Page;
  expect(second.agents).toHaveLength(500); expect(second.nextCursor).toBeNull(); expect(second.revision).toBe(first.revision);
  expect(new Set([...first.agents,...second.agents].map(row=>row.id)).size).toBe(4500);
  db.query("UPDATE native_mesh_agents_v1 SET name='changed' WHERE id=?").run(first.agents[0]!.id);
  expect((await get(api,follow(first))).status).toBe(409);
 } finally {db.close();api.close();rmSync(dir,{recursive:true,force:true});}
});
