import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startAgentBusServer} from "../src/server.ts";
import {SharedFilesClient} from "../src/shared-files-client.ts";
import {writeSharedOperation,inspectSharedOperation} from "../src/shared-write-operation.ts";
import {runFilesCli} from "../src/files-cli.ts";
const registration={registrationId:"shared-worker",agentId:"worker",machineId:"client",sessionId:"session",signature:"Worker"};
test("actual write with lost HTTP response returns inspectable original operation without replay; conflict stays distinct",async()=>{
 const root=await mkdtemp(join(tmpdir(),"shared-operation-"));const file=join(root,"work.txt");await writeFile(file,"original");
 const server=startAgentBusServer({dbPath:join(root,"bus.sqlite"),token:"operation-fixture",hostname:"127.0.0.1",port:0,requireSignedMutations:true,machineId:"target",sharedRoots:{work:root}});
 let writes=0;const host={hostId:"selected",baseUrl:server.url,token:"operation-fixture",fetch};
 const client=new SharedFilesClient(host);
 try{
  const before=await client.read("work","work.txt");const lost={...host,fetch:async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await fetch(input,init);if(init?.method==="POST"&&new URL(String(input)).pathname==="/v1/shared-files"){writes++;await response.arrayBuffer();throw Error("fixture response lost after actual side effect");}return response;}};
  const result=await writeSharedOperation(lost,registration,{resourceId:"work",path:"work.txt",text:"modified once",expectedSha256:before.sha256});assert.equal(result.status,"unknown");assert.equal(result.hostId,"selected");assert.ok(result.operationId);
  const inspected=await inspectSharedOperation(host,result.operationId);assert.deepEqual(inspected.records.map(r=>r.outcome),["unknown","success"]);assert.equal(inspected.records[1].registration.sessionId,"session");assert.equal(inspected.records[1].targetMachineId,"target");assert.equal(await readFile(file,"utf8"),"modified once");assert.equal(writes,1);
  const conflict=await writeSharedOperation(host,registration,{resourceId:"work",path:"work.txt",text:"must not overwrite",expectedSha256:before.sha256});assert.equal(conflict.status,"conflict");assert.notEqual(conflict.operationId,result.operationId);const failed=await inspectSharedOperation(host,conflict.operationId);assert.deepEqual(failed.records.map(r=>r.outcome),["unknown","failed"]);assert.equal(await readFile(file,"utf8"),"modified once");
 }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});
test("ordinary CLI retains selected host reference after uncertain write and inspects that host not default service",async()=>{
 const root=await mkdtemp(join(tmpdir(),"shared-cli-inspect-")),file=join(root,"work.txt"),catalog=join(root,"hosts.json");await writeFile(file,"before");
 const server=startAgentBusServer({dbPath:join(root,"bus.sqlite"),token:"cli-operation-fixture",hostname:"127.0.0.1",port:0,requireSignedMutations:true,sharedRoots:{work:root}});
 try{
  await writeFile(catalog,JSON.stringify({hosts:[{hostId:"target",url:server.url,token:"cli-operation-fixture"}]}),{mode:0o600});
  const env={ENVINHANDS_URL:"http://127.0.0.1:1",ENVINHANDS_TOKEN:"wrong-default",ENVINHANDS_SHARED_HOSTS:catalog,ENVINHANDS_AGENT_ID:"cli-agent",ENVINHANDS_MACHINE_ID:"client",ENVINHANDS_SESSION_ID:"cli-session",ENVINHANDS_AUDIT_SIGNATURE:"CLI Worker"};
  const before=await new SharedFilesClient({baseUrl:server.url,token:"cli-operation-fixture",fetch}).read("work","work.txt");
  let input=JSON.stringify({resourceId:"work",path:"work.txt",text:"only once",expectedSha256:before.sha256}),text="",writes=0;
  const io={readInput:async()=>input,write:(value:string)=>{text=value;},error:()=>{},fetch:async(value:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await fetch(value,init);if(init?.method==="POST"){writes++;await response.arrayBuffer();throw Error("lost reply");}return response;}};
  assert.equal(await runFilesCli(["write","target"],env,io),1);const original=JSON.parse(text).receipt;assert.equal(original.status,"unknown");assert.equal(original.hostId,"target");
  input=JSON.stringify({operationId:original.operationId});assert.equal(await runFilesCli(["inspect","target"],env,io),0);const inspected=JSON.parse(text).receipt;assert.equal(inspected.hostId,"target");assert.deepEqual(inspected.records.map((r:{outcome:string})=>r.outcome),["unknown","success"]);assert.equal(writes,1);assert.equal(await readFile(file,"utf8"),"only once");
 }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});
