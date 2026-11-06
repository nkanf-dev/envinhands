import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startAgentBusServer } from "../src/server.ts";
import { createChangeStore } from "../src/change-store.ts";
import { createTeamIdentitiesApi, createTeamIdentitiesClient, type TeamIdentityInput } from "../src/team-identities.ts";

function key(n:number) {const b=Buffer.alloc(51);b.writeUInt32BE(11,0);b.write("ssh-ed25519",4);b.writeUInt32BE(32,15);b.fill(n,19);return `ssh-ed25519 ${b.toString("base64")}`;}
const item=(deviceId:string):TeamIdentityInput=>({deviceId,os:"linux",user:"agent",publicKey:key(3),hostKey:key(4)});
const TOKEN="test-directory-token";
const REG={registrationId:"directory-registration",agentId:"directory-agent",sessionId:"directory-session",machineId:"node",signature:"test registration"};
async function setup(){
 const dir=mkdtempSync(join(tmpdir(),"team-identities-")),path=join(dir,"db.sqlite");
 const api=createTeamIdentitiesApi({dbPath:path,token:TOKEN});
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api.fetch});
 const base=`http://127.0.0.1:${server.port}`;
 const client=createTeamIdentitiesClient({baseUrl:base,token:TOKEN,registration:REG});
 return {dir,path,api,server,base,client,async close(){await server.stop(true);api.close();rmSync(dir,{recursive:true,force:true});}};
}
describe("team public identity directory",()=>{
 test("HTTP durable idempotent revisions and immutable paginated snapshot across updates and delete",async()=>{
  const x=await setup();try{
   const a=await x.client.upsert(item("a"),"a1",null) as any;
   expect(a.record.revision).toBe(1);expect(a.record.publicKeyFingerprint).toBe(`SHA256:${createHash("sha256").update(Buffer.from(key(3).split(" ")[1],"base64")).digest("base64").replace(/=+$/,"")}`);
   expect(a.record.hostKeyFingerprint).not.toBe(a.record.publicKeyFingerprint);
   expect((await x.client.upsert(item("a"),"a2",1) as any).duplicate).toBe(true);
   await x.client.upsert(item("b"),"b1",null);await x.client.upsert(item("c"),"c1",null);
   const p1=await x.client.listPage({limit:1});expect(p1.snapshot).toBe(3);expect(p1.nextAfter).toBe("a");
   await x.client.delete("b","b-del1",2);await x.client.upsert({...item("c"),hostKey:key(5)},"c2",3);await x.client.upsert(item("d"),"d1",null);
   const p2=await x.client.listPage({limit:1,snapshot:p1.snapshot,after:p1.nextAfter!});
   const p3=await x.client.listPage({limit:1,snapshot:p1.snapshot,after:p2.nextAfter!});
   expect(p2.records[0].deviceId).toBe("b");expect(p3.records[0].hostKey).toBe(key(4));expect(p3.nextAfter).toBeNull();
   expect((await x.client.listPage()).records.map(r=>r.deviceId)).toEqual(["a","c","d"]);
   expect((await x.client.delete("b","b-del2",4) as any).deleted).toBe(false);
   x.api.close();const reopened=createTeamIdentitiesApi({dbPath:x.path,token:TOKEN});
   try {const r=await reopened.fetch(new Request(`${x.base}/v1/team-identities`,{headers:{authorization:`Bearer ${TOKEN}`}}));expect((await r.json() as any).records.length).toBe(3);}finally{reopened.close();}
  }finally{await x.close();}
 });
 test("concurrent connections serialize upserts and do not lose revision or replay duplicate",async()=>{
  const x=await setup();const api2=createTeamIdentitiesApi({dbPath:x.path,token:TOKEN});const s2=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api2.fetch});
  try {const c2=createTeamIdentitiesClient({baseUrl:`http://127.0.0.1:${s2.port}`,token:TOKEN,registration:REG});
   const results=await Promise.all(Array.from({length:30},(_,i)=>(i%2?x.client:c2).upsert(item("same"),`same-operation`,null))) as any[];
   expect(results.every(v=>v.record.revision===1 && !v.duplicate)).toBe(true);
   await Promise.all(Array.from({length:20},(_,i)=>(i%2?x.client:c2).upsert(item(`d${i}`),`d-${i}`,null)));
   const p=await x.client.listPage();expect(p.snapshot).toBe(21);expect(p.records.length).toBe(21);
  } finally {await s2.stop(true);api2.close();await x.close();}
 });
 test("rejects injection, malformed keys, secret-shaped fields, large bodies, bad auth and query",async()=>{
  const x=await setup();try{
   const url=`${x.base}/v1/team-identities`,auth={authorization:`Bearer ${TOKEN}`,"content-type":"application/json"};
   const send=(body:unknown)=>fetch(url,{method:"PUT",headers:auth,body:JSON.stringify(body)});
   const badwire=Buffer.from(key(3).split(" ")[1],"base64");badwire[4]|=128;
   for(const value of [null,[],{...item("x"),privateKey:"SECRET_PRIVATE"},{...item("x"),token:"SECRET_TOKEN"},
    {...item("x"),deviceId:"x'); DROP TABLE team_identity_history;--"},{...item("x"),user:"agent\nALL"},
    {...item("x"),hostKey:"-----BEGIN OPENSSH PRIVATE KEY-----"},{...item("x"),publicKey:`ssh-ed25519 ${badwire.toString("base64")}`},
    {...item("x"),publicKey:key(3)+" comment"},{...item("x"),hostKey:key(4)+"\n"}]) expect((await send(value)).status).toBe(400);
   const rejected=await send({...item("x"),privateKey:"SECRET_PRIVATE"});
   expect(await rejected.text()).not.toContain("SECRET_PRIVATE");
   expect((await send({...item("x"),evil:"SECRET".repeat(5000)})).status).toBe(413);
   expect((await fetch(url)).status).toBe(401);
   expect((await fetch(url+"?snapshot=0&snapshot=1",{headers:auth})).status).toBe(400);
   expect((await fetch(url+"?after=a",{headers:auth})).status).toBe(400);
   expect((await x.client.listPage()).records).toEqual([]);
   const db=readFileSync(x.path).toString("latin1");expect(db).not.toContain("SECRET_PRIVATE");expect(db).not.toContain("SECRET_TOKEN");expect(db).not.toContain(TOKEN);
  }finally{await x.close();}
 });
 test("journal survives lost response, intervening changes and reopen without reapplying",async()=>{
  const x=await setup();let reopened: ReturnType<typeof createTeamIdentitiesApi>|undefined;let server: ReturnType<typeof Bun.serve>|undefined;
  try {
   const losing=createTeamIdentitiesClient({baseUrl:x.base,token:TOKEN,registration:REG,fetch:async(url,init)=>{await fetch(url,init);throw new Error("timeout after commit");}});
   await expect(losing.upsert(item("node"),"lost-put",null)).rejects.toThrow("outcome unknown");
   await x.client.upsert({...item("node"),publicKey:key(9)},"newer",1);
   const original=await x.client.upsert(item("node"),"lost-put",null) as any;
   expect(original.record.publicKey).toBe(key(3));
   expect((await x.client.listPage()).records[0].publicKey).toBe(key(9));
   await expect(losing.delete("node","lost-delete",2)).rejects.toThrow("outcome unknown");
   await x.client.upsert({...item("node"),publicKey:key(7)},"after-delete",3);
   reopened=createTeamIdentitiesApi({dbPath:x.path,token:TOKEN});server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:reopened.fetch});
   const c=createTeamIdentitiesClient({baseUrl:`http://127.0.0.1:${server.port}`,token:TOKEN,registration:REG});
   expect((await c.delete("node","lost-delete",2) as any).deleted).toBe(true);
   expect((await c.listPage()).records[0].publicKey).toBe(key(7));
   expect((await c.delete("missing","noop-delete",null) as any).deleted).toBe(false);
   await c.upsert(item("missing"),"add-missing",null);
   expect((await c.delete("missing","noop-delete",null) as any).deleted).toBe(false);
   expect((await c.listPage()).records.map(v=>v.deviceId)).toContain("missing");
   await expect(c.upsert({...item("node"),publicKey:key(8)},"lost-put",null)).rejects.toThrow("409");
  } finally {if(server)await server.stop(true);reopened?.close();await x.close();}
 });
 test("concurrent operation ID conflict commits only one payload; legacy methods remain explicit",async()=>{
  const x=await setup();const api2=createTeamIdentitiesApi({dbPath:x.path,token:TOKEN});const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api2.fetch});
  try {
   const headers={authorization:`Bearer ${TOKEN}`,"content-type":"application/json"};
   const send=(base:string,n:number)=>fetch(`${base}/v1/team-identities`,{method:"POST",headers,body:JSON.stringify({action:"upsert",identity:{...item("raced"),publicKey:key(n)},operationId:"same-operation",expectedRevision:null})});
   const r=await Promise.all([send(x.base,5),send(`http://127.0.0.1:${server.port}`,6)]);
   expect(r.map(v=>v.status).sort()).toEqual([200,409]);
   const state=await x.client.listPage();expect(state.snapshot).toBe(1);expect(state.records.length).toBe(1);
   const same=await fetch(`${x.base}/v1/team-identities`,{method:"PUT",headers,body:JSON.stringify(item("legacy"))});expect(same.status).toBe(200);
   const del=await fetch(`${x.base}/v1/team-identities?deviceId=legacy`,{method:"DELETE",headers});expect(del.status).toBe(200);
   const malformed=await fetch(`${x.base}/v1/team-identities`,{method:"POST",headers,body:JSON.stringify({action:"delete",deviceId:"raced"})});expect(malformed.status).toBe(400);
   const mismatch=await fetch(`${x.base}/v1/team-identities`,{method:"POST",headers:{...headers,"x-envinhands-operation-id":"wrong"},body:JSON.stringify({action:"delete",deviceId:"raced",operationId:"different",expectedRevision:1})});expect(mismatch.status).toBe(409);
   expect((await x.client.listPage()).records[0].deviceId).toBe("raced");
  }finally{await server.stop(true);api2.close();await x.close();}
 });
 test("CAS serializes first registration and stale update/delete; conflict replay stays conflict",async()=>{
  const x=await setup();const api2=createTeamIdentitiesApi({dbPath:x.path,token:TOKEN});const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api2.fetch});
  try {
   const c=createTeamIdentitiesClient({baseUrl:`http://127.0.0.1:${server.port}`,token:TOKEN,registration:REG});
   const race=await Promise.allSettled([x.client.upsert(item("race"),"create-a",null),c.upsert({...item("race"),publicKey:key(8)},"create-b",null)]);
   expect(race.filter(r=>r.status==="fulfilled").length).toBe(1);expect(race.filter(r=>r.status==="rejected").length).toBe(1);
   const first=(await x.client.listPage()).records[0];expect(first.revision).toBe(1);
   const updates=await Promise.allSettled([x.client.upsert({...item("race"),hostKey:key(6)},"update-a",first.revision),c.delete("race","delete-a",first.revision)]);
   expect(updates.filter(r=>r.status==="fulfilled").length).toBe(1);
   const current=await x.client.listPage();
   if(current.records.length) {await expect(c.delete("race","stale-delete",first.revision)).rejects.toThrow("409");await x.client.delete("race","clean",current.records[0].revision);}
   else await expect(c.upsert(item("race"),"stale-update",first.revision)).rejects.toThrow("409");
   // A failed create-only CAS remains a failure even after a later deletion.
   const failedId=race[0].status==="rejected"?"create-a":"create-b";
   const failedValue=race[0].status==="rejected"?item("race"):{...item("race"),publicKey:key(8)};
   await expect(x.client.upsert(failedValue,failedId,null)).rejects.toThrow("409");
   expect((await x.client.listPage()).records).toEqual([]);
   const tomb=await x.client.getDevice("race");expect(tomb.record).toBeNull();expect(tomb.revision).not.toBeNull();
   await expect(x.client.upsert(item("race"),"late-create",null)).rejects.toThrow("409");
   await x.client.upsert(item("race"),"recreate",tomb.revision);
  }finally {await server.stop(true);api2.close();await x.close();}
 });
 test("tombstones prevent delayed create resurrection and survive restart",async()=>{
  const x=await setup();let next:ReturnType<typeof createTeamIdentitiesApi>|undefined;let s2:ReturnType<typeof Bun.serve>|undefined;
  try {
   expect(await x.client.getDevice("node")).toEqual({record:null,revision:null});
   await x.client.upsert(item("node"),"create",null);
   await x.client.delete("node","remove",1);
   await expect(x.client.upsert(item("node"),"delayed-create",null)).rejects.toThrow("409");
   expect(await x.client.getDevice("node")).toEqual({record:null,revision:2});
   next=createTeamIdentitiesApi({dbPath:x.path,token:TOKEN});s2=Bun.serve({hostname:"127.0.0.1",port:0,fetch:next.fetch});
   const c=createTeamIdentitiesClient({baseUrl:`http://127.0.0.1:${s2.port}`,token:TOKEN,registration:REG});
   const tomb=await c.getDevice("node");expect(tomb).toEqual({record:null,revision:2});
   expect((await c.upsert(item("node"),"reregister",tomb.revision) as any).record.revision).toBe(3);
   await expect(c.upsert(item("node"),"delayed-create",null)).rejects.toThrow("409");
   expect((await c.getDevice("node")).revision).toBe(3);
  }finally{if(s2)await s2.stop(true);next?.close();await x.close();}
 });
 test("formal signed mutations correlate business operation and audit across a lost response",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"directory-formal-")),dbPath=join(dir,"db.sqlite");
  const server=startAgentBusServer({dbPath,token:TOKEN,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
  try {
   const missing=createTeamIdentitiesClient({baseUrl:server.url,token:TOKEN});
   await expect(missing.upsert(item("x"),"missing-actor",null)).rejects.toThrow("registered agent");
   expect(()=>createTeamIdentitiesClient({baseUrl:server.url,token:TOKEN,registration:{...REG,signature:TOKEN}})).toThrow("Invalid mutation registration");
   const lost=createTeamIdentitiesClient({baseUrl:server.url,token:TOKEN,registration:REG,fetch:async(url,init)=>{await fetch(url,init);throw Error("lost");}});
   await expect(lost.upsert(item("x"),"same-audit-op",null)).rejects.toThrow("outcome unknown");
   const c=createTeamIdentitiesClient({baseUrl:server.url,token:TOKEN,registration:REG});
   const receipt=await c.upsert(item("x"),"same-audit-op",null) as any;expect(receipt.record.revision).toBe(1);
   expect((await c.listPage()).records.length).toBe(1);
   const store=createChangeStore(dbPath);try {const records=store.list(0,100).records.filter(r=>r.resourceId==="/v1/team-identities");
     expect(records.length).toBe(4);expect(records.every(r=>r.operationId==="same-audit-op"&&r.registrationId===REG.registrationId)).toBe(true);
     expect(JSON.stringify(records)).not.toContain(TOKEN);
   } finally {store.close();}
  }finally{await server.stop();rmSync(dir,{recursive:true,force:true});}
 });
 test("abort signal reaches fetch for reads and mutations; mutations report unknown outcome",async()=>{
  let seen:AbortSignal|null|undefined;
  const fetcher=(async(_url:URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    seen=init?.signal; if(!seen) {reject(new Error("no signal"));return;} if(seen.aborted){reject(new Error("aborted"));return;}
    seen.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
  }));
  const c=createTeamIdentitiesClient({baseUrl:"http://127.0.0.1",token:TOKEN,registration:REG,fetch:fetcher});
  const a=new AbortController();const read=c.listPage({signal:a.signal});expect(seen).toBe(a.signal);a.abort();await expect(read).rejects.toThrow("Directory request failed");
  const b=new AbortController();const write=c.upsert(item("x"),"cancelled-write",null,{signal:b.signal});expect(seen).toBe(b.signal);b.abort();await expect(write).rejects.toThrow("outcome unknown");
 });
 test("records macOS and Windows identities distinctly with safe system users",async()=>{
  const x=await setup();try {
   await x.client.upsert({...item("mac-laptop"),os:"macos",user:"Alice"},"mac",null);
   await x.client.upsert({...item("win"),os:"windows",user:"Agent User"},"win",null);
   expect((await x.client.listPage()).records.map(r=>r.os)).toEqual(["macos","windows"]);
   await expect(x.client.upsert({...item("mac-bad"),os:"macos",user:"root"},"bad",null)).rejects.toThrow();
  }finally{await x.close();}
 });
 test("client rejects unsafe destinations and mutation failures describe unknown outcome",async()=>{
  expect(()=>createTeamIdentitiesClient({baseUrl:"http://example.com",token:TOKEN})).toThrow();
  const c=createTeamIdentitiesClient({baseUrl:"http://127.0.0.1",token:TOKEN,registration:REG,fetch:async()=>{throw new Error("sensitive");}});
  await expect(c.upsert(item("x"),"lost",null)).rejects.toThrow("outcome unknown");
 });
});
