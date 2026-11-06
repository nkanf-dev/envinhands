import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startAgentBusServer} from "../src/server.ts";
import {createChangeStore} from "../src/change-store.ts";
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
