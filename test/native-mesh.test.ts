import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBus } from "../src/agent-bus.ts";
import { createMutationAudit } from "../src/mutation-audit.ts";
import { createSignedFetch } from "../src/signed-fetch.ts";
import { createNativeMeshApi, NativeMesh, qualifiedAgentId, meshRequestId, familyReachable } from "../src/integrations/native-mesh.ts";

test("isolated HTTP + SQLite: registration, retry, durable mailbox and ack across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-mesh-test-"));
  const dbPath = join(dir, "control.sqlite"), token = "test-token";
  let server: ReturnType<typeof Bun.serve> | undefined;
  let bus: ReturnType<typeof createAgentBus> | undefined;
  let mesh: ReturnType<typeof createNativeMeshApi> | undefined;
  let audit: ReturnType<typeof createMutationAudit> | undefined;
  let port = 0;
  const start = () => {
    bus = createAgentBus({dbPath, token}); mesh = createNativeMeshApi({dbPath,token});
    audit = createMutationAudit({dbPath,token,machineId:"test-control",requireSignedMutations:true});
    server = Bun.serve({hostname:"127.0.0.1",port,fetch:req => audit!.dispatch(req, r =>
      new URL(r.url).pathname === "/v1/native-mesh/agents" ? mesh!.fetch(r) : bus!.fetch(r))});
    port = server.port!;
  };
  const stop = async () => { if (server) await server.stop(true); server=undefined; audit?.close(); mesh?.close(); bus?.close(); };
  try {
    start();
    const origin = `http://127.0.0.1:${port}`;
    const signed = (agent: string, underlying: typeof fetch = fetch) => createSignedFetch({baseUrl:origin,fetch:underlying,
      registration:()=>({registrationId:`reg-${agent}`,agentId:agent,machineId:`host-${agent}`,sessionId:`session-${agent}`,signature:"test declaration"})});
    const alice = new NativeMesh({baseUrl:origin,token,fetch:signed("alice"),timeoutMs:300});
    const bob = new NativeMesh({baseUrl:origin,token,fetch:signed("bob"),timeoutMs:300});
    const aid=qualifiedAgentId("host-a","session-a"), bid=qualifiedAgentId("host-b","session-b");
    await alice.register({hostId:"host-a",agentId:"session-a",parentId:null,name:"Alice",state:"active"});
    await bob.register({hostId:"host-b",agentId:"session-b",parentId:aid,name:"Bob",state:"active"});
    await bob.register({hostId:"host-b",agentId:"session-b",parentId:aid,name:"Bob",state:"active"});
    const agents = await alice.discover(); expect(agents).toHaveLength(2);
    const a = agents.find(x => x.id === aid)!, b = agents.find(x => x.id === bid)!;
    expect(familyReachable(a,b)).toBe(true); expect(familyReachable(a,a)).toBe(false);
    expect(a.status).toBe("observed"); expect(Number.isFinite(Date.parse(a.lastHeartbeatAt))).toBe(true);
    expect((await fetch(origin+"/v1/native-mesh/agents")).status).toBe(401);
    const input={senderId:aid,recipientId:bid,messageId:"stable-1",text:"hello"};
    let loseResponse=true;
    const uncertain = new NativeMesh({baseUrl:origin,token,fetch:signed("alice",(async (i, init) => {const res=await fetch(i,init); if (loseResponse && new URL(String(i)).pathname==="/v1/messages" && init?.method==="POST") { loseResponse=false; throw new Error("response lost"); } return res;}) as typeof fetch)});
    await expect(uncertain.send(input)).rejects.toThrow();
    await alice.send(input);
    expect(await bob.pull(bid)).toHaveLength(1);
    await expect(alice.send({...input,text:"conflict"})).rejects.toMatchObject({status:409});
    await stop();
    await expect(alice.send(input)).rejects.toThrow();
    start();
    expect(await bob.discover()).toHaveLength(2);
    const pending = await bob.pull(bid); expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).toBe(meshRequestId(aid,"stable-1"));
    // A test-only SQLite inbox models durable acceptance. It is not Prime's native inbox.
    const inboxPath = join(dir,"test-inbox.sqlite");
    let inbox = new Database(inboxPath, {create:true});
    inbox.exec("CREATE TABLE inbox (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
    for (const m of pending) inbox.query("INSERT OR IGNORE INTO inbox VALUES (?,?)").run(m.requestId,m.text);
    inbox.close(); // Simulated crash before remote ack.
    inbox = new Database(inboxPath);
    for (const m of await bob.pull(bid)) inbox.query("INSERT OR IGNORE INTO inbox VALUES (?,?)").run(m.requestId,m.text);
    expect(inbox.query("SELECT * FROM inbox").all()).toHaveLength(1);
    inbox.close();
    await bob.ack(pending[0]!.requestId); await bob.ack(pending[0]!.requestId);
    await alice.send(input); expect(await bob.pull(bid)).toEqual([]);
    await stop(); start(); await alice.send(input); expect(await bob.pull(bid)).toEqual([]);
  } finally { await stop(); rmSync(dir,{recursive:true,force:true}); }
});

test("rejects invalid registrations and keeps namespaced IDs unambiguous", async () => {
  expect(qualifiedAgentId("a","bc")).not.toBe(qualifiedAgentId("ab","c"));
  const api=createNativeMeshApi({dbPath:":memory:",token:"token"});
  try {
    const send=(data:unknown)=>api.fetch(new Request("http://localhost/v1/native-mesh/agents",{method:"POST",headers:{authorization:"Bearer token","content-type":"application/json"},body:JSON.stringify(data)}));
    const good={hostId:"a",agentId:"b",parentId:null,name:"x",state:"active"};
    expect((await send({...good,parentId:qualifiedAgentId("a","b")})).status).toBe(400);
    expect((await send({...good,name:null})).status).toBe(400);
    expect((await send({...good,extra:true})).status).toBe(400);
    expect((await send(good)).status).toBe(200);
  } finally { api.close(); }
});


test("bounded snapshot pages, legacy overflow, validation and restart expiration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-pages-")), dbPath = join(dir, "db.sqlite");
  let api = createNativeMeshApi({dbPath, token:"token"});
  const request = (query = "") => api.fetch(new Request(`http://localhost/v1/native-mesh/agents${query}`, {headers:{authorization:"Bearer token"}}));
  const register = (i: number) => api.fetch(new Request("http://localhost/v1/native-mesh/agents", {method:"POST",headers:{authorization:"Bearer token","content-type":"application/json"},body:JSON.stringify({hostId:"host",agentId:`agent-${i}`,parentId:null,name:"n",state:"active"})}));
  try {
    for (let i=0; i<205; i++) expect((await register(i)).status).toBe(200);
    expect((await request()).status).toBe(413);
    for (const q of ["?limit=0", "?limit=101", "?limit=01", "?limit=1&limit=2", "?limit=1&after=bad&revision=0", "?limit=1&revision=1", "?foo=1"]) expect((await request(q)).status).toBe(400);
    let after: string | null = null, revision: string | undefined;
    const ids: string[] = [];
    do {
      const q = new URLSearchParams({limit:"99"});
      if (after) { q.set("after",after); q.set("revision",revision!); }
      const res = await request(`?${q}`), text = await res.text();
      expect(res.status).toBe(200); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2*1024*1024);
      const page = JSON.parse(text); expect(page.version).toBe(2); expect(page.agents.length).toBeLessThanOrEqual(99);
      revision ??= page.revision; expect(page.revision).toBe(revision);
      ids.push(...page.agents.map((a: {id:string}) => a.id)); after = page.nextCursor;
    } while (after);
    expect(ids).toHaveLength(205); expect(new Set(ids).size).toBe(205); expect(ids).toEqual([...ids].sort());
    const first = await (await request("?limit=1")).json() as {nextCursor:string;revision:string};
    await register(0); // Heartbeats do not change an existing snapshot.
    expect((await request(`?limit=1&after=${first.nextCursor}&revision=${first.revision}`)).status).toBe(200);
    api.close(); api = createNativeMeshApi({dbPath,token:"token"});
    expect((await request(`?limit=1&after=${first.nextCursor}&revision=${first.revision}`)).status).toBe(409);
    const client = new NativeMesh({baseUrl:"http://localhost",token:"token",fetch: ((input,init) => api.fetch(new Request(String(input),init))) as typeof fetch});
    expect(await client.discover()).toHaveLength(205);
  } finally { api.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("client validates legacy and v2 pages and retries revision conflicts", async () => {
  const make = (agentId: string) => ({id:qualifiedAgentId("h",agentId),hostId:"h",agentId,parentId:null,name:agentId,state:"active" as const,lastHeartbeatAt:"2025-01-01T00:00:00.000Z",status:"observed" as const});
  const [a,b] = [make("a"),make("b")].sort((x,y) => x.id.localeCompare(y.id));
  const makeClient = (respond: (url: URL) => Response) => new NativeMesh({baseUrl:"http://localhost",token:"token",fetch:(async input => respond(new URL(String(input)))) as typeof fetch});
  const jsonResponse = (body:unknown, status=200) => new Response(JSON.stringify(body),{status});
  expect(await makeClient(() => jsonResponse({agents:[b,a]})).discover()).toHaveLength(2);
  await expect(makeClient(() => jsonResponse({agents:[a,a]})).discover()).rejects.toThrow();
  await expect(makeClient(() => jsonResponse({agents:[{...a,id:b.id}]})).discover()).rejects.toThrow();
  await expect(makeClient(() => jsonResponse({version:2,agents:[b,a],nextCursor:null,revision:"1"})).discover()).rejects.toThrow();
  await expect(makeClient(() => jsonResponse({version:2,agents:[a],nextCursor:b.id,revision:"1"})).discover()).rejects.toThrow();
  await expect(makeClient(url => jsonResponse(url.searchParams.has("after") ? {version:2,agents:[a],nextCursor:null,revision:"1"} : {version:2,agents:[a],nextCursor:a.id,revision:"1"})).discover()).rejects.toThrow();
  let starts=0;
  const retry = makeClient(url => {
    if (!url.searchParams.has("after")) { starts++; return jsonResponse({version:2,agents:[a],nextCursor:a.id,revision:String(starts)}); }
    if (starts === 1) return jsonResponse({error:"changed"},409);
    expect(url.searchParams.get("revision")).toBe("2");
    return jsonResponse({version:2,agents:[b],nextCursor:null,revision:"2"});
  });
  expect(await retry.discover()).toEqual([a,b]); expect(starts).toBe(2);
  let requests=0;
  await expect(makeClient(url => { requests++; return url.searchParams.has("after") ? jsonResponse({},409) : jsonResponse({version:2,agents:[a],nextCursor:a.id,revision:"1"}); }).discover()).rejects.toMatchObject({status:409});
  expect(requests).toBe(6);
});

test("server rejects corrupt stored rows and enforces the hard byte budget", async () => {
  const dir=mkdtempSync(join(tmpdir(),"mesh-bytes-")), dbPath=join(dir,"db.sqlite");
  const api=createNativeMeshApi({dbPath,token:"token"}), db=new Database(dbPath);
  const get=(q:string)=>api.fetch(new Request(`http://localhost/v1/native-mesh/agents${q}`,{headers:{authorization:"Bearer token"}}));
  try {
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    for (let i=0;i<3;i++) insert.run(qualifiedAgentId("h",String(i)),"h",String(i),null,"x".repeat(750000),"active","2025-01-01T00:00:00Z");
    expect((await get("")).status).toBe(413);
    // Rows this large violate registration field limits, even below the hard byte ceiling.
    expect((await get("?limit=100")).status).toBe(500);
    db.query("UPDATE native_mesh_agents_v1 SET name=?").run("x".repeat(2*1024*1024));
    expect((await get("?limit=100")).status).toBe(413);
  } finally { db.close(); api.close(); rmSync(dir,{recursive:true,force:true}); }
});


test("real HTTP discovery exceeds 2 MiB and rejects topology changes and restart", async () => {
  const dir=mkdtempSync(join(tmpdir(),"mesh-real-pages-")), dbPath=join(dir,"db.sqlite"), token="token";
  let api=createNativeMeshApi({dbPath,token});
  const second=createNativeMeshApi({dbPath,token});
  const db=new Database(dbPath);
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>api.fetch(req)});
  const origin=`http://127.0.0.1:${server.port}`, headers={authorization:`Bearer ${token}`};
  try {
    const insert=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i=0;i<10000;i++) {
        const agent=`session-${i}`;
        insert.run(qualifiedAgentId("host",agent),"host",agent,null,"name", "active", "2025-01-01T00:00:00.000Z");
      }
    })();
    let transferred=0, requests=0;
    const client=new NativeMesh({baseUrl:origin,token,fetch: (async (input,init) => {
      requests++;
      const res=await fetch(input,init), data=await res.arrayBuffer();
      transferred+=data.byteLength;
      return new Response(data,{status:res.status,headers:res.headers});
    }) as typeof fetch});
    const agents=await client.discover();
    expect(agents).toHaveLength(10000); expect(transferred).toBeGreaterThan(2*1024*1024); expect(requests).toBe(100);
    expect(new Set(agents.map(a=>a.id)).size).toBe(10000);
    const first=await (await fetch(`${origin}/v1/native-mesh/agents?limit=1`,{headers})).json() as {revision:string;nextCursor:string};
    const post=new Request(`${origin}/v1/native-mesh/agents`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({hostId:"host",agentId:"new",parentId:null,name:"new",state:"active"})});
    expect((await second.fetch(post)).status).toBe(200);
    const continuation=`${origin}/v1/native-mesh/agents?limit=1&after=${first.nextCursor}&revision=${first.revision}`;
    expect((await fetch(continuation,{headers})).status).toBe(409);
    api.close(); api=createNativeMeshApi({dbPath,token});
    expect((await fetch(continuation,{headers})).status).toBe(409);
  } finally { await server.stop(true); db.close(); second.close(); api.close(); rmSync(dir,{recursive:true,force:true}); }
});


test("discovery bounds total wire bytes and the full operation deadline", async () => {
  const agents=Array.from({length:20},(_,i) => ({id:qualifiedAgentId("h",String(i)),hostId:"h",agentId:String(i),parentId:null,name:"n",state:"active",lastHeartbeatAt:"2025-01-01T00:00:00Z",status:"observed"})).sort((a,b)=>a.id.localeCompare(b.id));
  let calls=0;
  const padded=new NativeMesh({baseUrl:"http://localhost",token:"token",fetch:(async () => {
    const item=agents[calls++]!;
    return new Response(JSON.stringify({version:2,revision:"1",agents:[item],nextCursor:item.id}) + " ".repeat(1900000));
  })});
  await expect(padded.discover()).rejects.toThrow();
  expect(calls).toBe(18);
  let calls2=0;
  const slow=new NativeMesh({baseUrl:"http://localhost",token:"token",timeoutMs:30,fetch:(async () => {
    const item=agents[calls2++]!;
    await new Promise(resolve=>setTimeout(resolve,12));
    return new Response(JSON.stringify({version:2,revision:"1",agents:[item],nextCursor:item.id}));
  })});
  await expect(slow.discover()).rejects.toThrow();
  expect(calls2).toBeLessThan(10);
});


test("discovery limits total records over all pages", async () => {
  const rows=Array.from({length:100100},(_,i)=> {
    const agentId=String(i);
    return {id:qualifiedAgentId("h",agentId),hostId:"h",agentId,parentId:null,name:"n",state:"active",lastHeartbeatAt:"2025-01-01T00:00:00Z",status:"observed"};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  let calls=0;
  const client=new NativeMesh({baseUrl:"http://localhost",token:"token",timeoutMs:10000,fetch:async () => {
    const page=rows.slice(calls*100,++calls*100);
    return new Response(JSON.stringify({version:2,revision:"1",agents:page,nextCursor:page.at(-1)!.id}));
  }});
  await expect(client.discover()).rejects.toThrow("Discovery record budget exceeded");
  expect(calls).toBe(1001);
});
