import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startAgentBusServer} from "../src/server.ts";
import {createChangeStore} from "../src/change-store.ts";
import {createMutationAudit} from "../src/mutation-audit.ts";
import {Database} from "bun:sqlite";
const registration={registrationId:"audit-client",agentId:"audit-agent",sessionId:"audit-session",machineId:"client",signature:"Agent test"};
test("formal API mutations require identity and record intent/outcome across restart without message bodies",async()=>{
 const root=await mkdtemp(join(tmpdir(),"api-mutation-"));const dbPath=join(root,"bus.sqlite"),token="mutation-audit-test";
 let server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
 try{
  const path="/v1/messages",body=JSON.stringify({requestId:"message-one",from:"audit-agent",to:"peer",text:"private fixture message"});
  assert.equal((await fetch(server.url+path,{method:"POST",headers,body})).status,400);
  const signed={...headers,"x-envinhands-registration":Buffer.from(JSON.stringify(registration)).toString("base64url"),"x-envinhands-operation-id":"write-one"};
  assert.equal((await fetch(server.url+path,{method:"POST",headers:signed,body})).status,201);
  await server.stop();server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
  const store=createChangeStore(dbPath);try{const records=store.list(0,100).records;
   assert.equal(records.length,2);assert.equal(records[0].outcome,"unknown");assert.equal(records[1].outcome,"success");
   assert.equal(records[0].registration.agentId,registration.agentId);assert.equal(records[1].operationId,"write-one");
   assert.equal(records[1].resourceId,"/v1/messages/message-one");assert.ok(!JSON.stringify(records).includes("private fixture message"));
  }finally{store.close();}
  const pending=await fetch(server.url+"/v1/messages?to=peer",{headers});const pendingBody = await pending.json() as {messages: unknown[]};assert.equal(pendingBody.messages.length,1);
 }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});

test("access observations cannot contradict the declared mutation actor",async()=>{
 const root=await mkdtemp(join(tmpdir(),"access-actor-")),dbPath=join(root,"db.sqlite"),token="access-actor-fixture";
 const server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 try{
  const other={...registration,registrationId:"other-reg",agentId:"other-agent",sessionId:"other-session"};
  const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
  for(const identity of[registration,other])assert.equal((await fetch(server.url+"/v1/agent-registrations",{method:"POST",headers,body:JSON.stringify(identity)})).status,201);
  const evidence={registrationId:other.registrationId,agentId:other.agentId,sessionId:other.sessionId,targetMachineId:"target",routeId:"route",sshIdentityRef:"SHA256:"+"A".repeat(43),sshUser:"agent",hostKeyAlias:"trusted.example",os:"linux",checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+10000).toISOString(),ready:false,status:"not-ready",verificationScope:"actual-client-ssh-identity-and-route"};
  const signed={...headers,"x-envinhands-registration":Buffer.from(JSON.stringify(registration)).toString("base64url"),"x-envinhands-operation-id":"access-attempt"};
  assert.equal((await fetch(server.url+"/v1/access-evidence",{method:"POST",headers:signed,body:JSON.stringify({requestId:"observation",evidence})})).status,409);
 }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});


test("formal signed v2 scope and result must agree with declared actor",async()=>{
 const root=await mkdtemp(join(tmpdir(),"access-v2-actor-")),dbPath=join(root,"db.sqlite"),token="v2-actor-fixture";
 const server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const headers={authorization:`Bearer ${token}`,"content-type":"application/json","x-envinhands-registration":Buffer.from(JSON.stringify(registration)).toString("base64url"),"x-envinhands-operation-id":"v2-actor"};
 const post=(value:unknown)=>fetch(server.url+"/v1/access-evidence",{method:"POST",headers,body:JSON.stringify(value)});
 const scope={registrationId:registration.registrationId,agentId:registration.agentId,sessionId:registration.sessionId,targetMachineId:"vm"};
 try {
  for(const key of ["registrationId","agentId","sessionId"]) assert.equal((await post({action:"begin",beginId:"bad-"+key,scope:{...scope,[key]:"other"}})).status,409);
  const first=await post({action:"begin",beginId:"allowed",scope});assert.equal(first.status,201);
  const {generation}=await first.json() as {generation:string};
  assert.equal((await post({action:"commit",scope:{...scope,agentId:"other"},generation,result:{status:"unknown"}})).status,409);
  const now=Date.now();const result={...scope,agentId:"other",routeId:"route",sshIdentityRef:"SHA256:"+"A".repeat(43),sshUser:"agent",hostKeyAlias:"trusted.local",os:"linux",checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),ready:true,status:"ready",verificationScope:"actual-client-ssh-identity-and-route"};
  assert.equal((await post({action:"commit",scope,generation,result})).status,409);
  assert.equal((await post({action:"commit",scope,generation,result:{status:"unknown"}})).status,200);
 }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});


const auditFixtureToken = "audit-failure-fixture";
function mutationRequest(identity: unknown = registration, operationId = "failure-test") {
 return new Request("http://localhost/v1/synthetic", {method:"POST", headers:{
  authorization:`Bearer ${auditFixtureToken}`,
  "x-envinhands-registration":Buffer.from(JSON.stringify(identity)).toString("base64url"),
  "x-envinhands-operation-id":operationId,
 }});
}

test("registration write lock returns pre-dispatch 503 after SQLite busy timeout",{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"audit-busy-")), dbPath=join(root,"db.sqlite");
 const audit=createMutationAudit({dbPath,token:auditFixtureToken,machineId:"test",requireSignedMutations:true});
 const lock=new Database(dbPath); let dispatched=0;
 try {
  lock.exec("BEGIN IMMEDIATE");
  const start=Date.now();
  const result=await audit.dispatch(mutationRequest(),()=>{dispatched++;return new Response("dispatched");});
  assert.ok(Date.now()-start>=4900,"must exercise the configured 5s SQLite busy timeout");
  assert.equal(result.status,503);assert.equal(result.headers.get("retry-after"),null);
  assert.match((await result.json() as {error:string}).error,/this attempt was not dispatched; check any prior operation with unknown outcome before retry/);
  assert.equal(dispatched,0);
  lock.exec("ROLLBACK");
  const store=createChangeStore(dbPath);try{assert.equal(store.list(0,10).records.length,0);}finally{store.close();}
  const retry=await audit.dispatch(mutationRequest(),()=>{dispatched++;return new Response("ok",{status:201});});
  assert.equal(retry.status,201);assert.equal(dispatched,1);
 }finally{lock.close();audit.close();await rm(root,{recursive:true,force:true});}
});

test("registration I/O fault returns pre-dispatch 503 without leaking details",async()=>{
 const root=await mkdtemp(join(tmpdir(),"audit-io-")),dbPath=join(root,"db.sqlite");
 const audit=createMutationAudit({dbPath,token:auditFixtureToken,machineId:"test",requireSignedMutations:true});
 const query=Database.prototype.query;let dispatched=0;
 try {
  Database.prototype.query=function(this:Database,sql:string){
   if(sql.startsWith("INSERT OR IGNORE INTO agent_registrations")) throw Object.assign(new Error("sensitive simulated I/O detail"),{code:"SQLITE_IOERR"});
   return query.call(this,sql);
  } as typeof Database.prototype.query;
  const result=await audit.dispatch(mutationRequest(),()=>{dispatched++;return new Response("dispatched");});
  assert.equal(result.status,503);assert.equal(result.headers.get("retry-after"),null);
  const body=await result.text();assert.match(body,/this attempt was not dispatched; check any prior operation with unknown outcome before retry/);assert.doesNotMatch(body,/sensitive|SQLITE_IOERR/);
  assert.equal(dispatched,0);
 }finally{Database.prototype.query=query;audit.close();await rm(root,{recursive:true,force:true});}
});

test("invalid attribution and conflicting registration remain 400; valid dispatch remains audited",async()=>{
 const root=await mkdtemp(join(tmpdir(),"audit-claims-")),dbPath=join(root,"db.sqlite");
 const audit=createMutationAudit({dbPath,token:auditFixtureToken,machineId:"test",requireSignedMutations:true});let dispatched=0;
 const next=()=>{dispatched++;return new Response("ok",{status:201});};
 try {
  const bad=new Request("http://localhost/v1/synthetic",{method:"POST",headers:{authorization:`Bearer ${auditFixtureToken}`,"x-envinhands-registration":"!invalid!","x-envinhands-operation-id":"op"}});
  assert.equal((await audit.dispatch(bad,next)).status,400);
  assert.equal((await audit.dispatch(mutationRequest(registration,"!invalid!"),next)).status,400);
  assert.equal(dispatched,0);
  assert.equal((await audit.dispatch(mutationRequest(),next)).status,201);
  assert.equal((await audit.dispatch(mutationRequest({...registration,agentId:"different-agent"}),next)).status,400);
  assert.equal(dispatched,1);
  const store=createChangeStore(dbPath);try{
   const records=store.list(0,10).records;assert.equal(records.length,2);
   assert.deepEqual(records.map(r=>r.outcome),["unknown","success"]);
   assert.ok(records.every(r=>r.operationId==="failure-test"));
  }finally{store.close();}
 }finally{audit.close();await rm(root,{recursive:true,force:true});}
});


test("audit intent and completion faults preserve distinct fail-closed responses",async()=>{
 for(const failureAt of [1,2]) {
  const root=await mkdtemp(join(tmpdir(),"audit-append-fault-")),dbPath=join(root,"db.sqlite");
  const audit=createMutationAudit({dbPath,token:auditFixtureToken,machineId:"test",requireSignedMutations:true});
  const query=Database.prototype.query;let writes=0,dispatched=0;
  try {
   Database.prototype.query=function(this:Database,sql:string){
    if(sql.startsWith("INSERT OR IGNORE INTO change_records") && ++writes===failureAt) throw new Error("simulated append fault");
    return query.call(this,sql);
   } as typeof Database.prototype.query;
   const result=await audit.dispatch(mutationRequest(),()=>{dispatched++;return new Response("ok");});
   assert.equal(result.status,503);assert.equal(result.headers.get("retry-after"),null);
   assert.match((await result.json() as {error:string}).error,failureAt===1?/operation not dispatched/:/effects may exist/);
   assert.equal(dispatched,failureAt-1);
   Database.prototype.query=query;
   const store=createChangeStore(dbPath);try{
    const records=store.list(0,10).records;
    assert.equal(records.length,failureAt-1);
    if(failureAt===2) assert.equal(records[0].outcome,"unknown");
   }finally{store.close();}
  }finally{Database.prototype.query=query;audit.close();await rm(root,{recursive:true,force:true});}
 }
});


test("a pre-dispatch registration fault says nothing about a prior unknown attempt",async()=>{
 const root=await mkdtemp(join(tmpdir(),"audit-prior-unknown-")),dbPath=join(root,"db.sqlite");
 const audit=createMutationAudit({dbPath,token:auditFixtureToken,machineId:"test",requireSignedMutations:true});
 const query=Database.prototype.query;let effects=0;
 try {
  const first=await audit.dispatch(mutationRequest(),()=>{effects++;throw new Error("outcome unknown after effect");});
  assert.equal(first.status,500);assert.equal(effects,1);
  Database.prototype.query=function(this:Database,sql:string){
   if(sql.startsWith("INSERT OR IGNORE INTO agent_registrations")) throw new Error("simulated I/O fault");
   return query.call(this,sql);
  } as typeof Database.prototype.query;
  const failed=await audit.dispatch(mutationRequest(),()=>{effects++;return new Response("ok");});
  assert.equal(failed.status,503);assert.equal(failed.headers.get("retry-after"),null);
  assert.match((await failed.json() as {error:string}).error,/this attempt was not dispatched; check any prior operation with unknown outcome before retry/);
  assert.equal(effects,1);
  Database.prototype.query=query;
  const repeated=await audit.dispatch(mutationRequest(),()=>{effects++;return new Response("ok");});
  assert.equal(repeated.status,200);assert.equal(effects,2,"operation ID does not generally deduplicate business dispatch");
  const store=createChangeStore(dbPath);try{
   assert.deepEqual(store.list(0,10).records.map(r=>r.outcome),["unknown","unknown","unknown","success"]);
  }finally{store.close();}
 }finally{Database.prototype.query=query;audit.close();await rm(root,{recursive:true,force:true});}
});
