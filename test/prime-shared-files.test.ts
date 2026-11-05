import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import extension from "../src/integrations/prime-shared-files.ts";
import {createChangeStore} from "../src/change-store.ts";
import {installPrimeTransport} from "../src/integrations/prime-transport.ts";
import {startAgentBusServer} from "../src/server.ts";
test("Prime shared-work tools read and change real selected files using actual session actor",async()=>{
 const root=await mkdtemp(join(tmpdir(),"prime-shared-"));await writeFile(join(root,"work.txt"),"shared original");
 const server=startAgentBusServer({dbPath:join(root,"db.sqlite"),token:"prime-shared-test",hostname:"127.0.0.1",port:0,requireSignedMutations:true,sharedRoots:{work:root}});
 const values={ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:"prime-shared-test",ENVINHANDS_AGENT_ID:"file-agent",ENVINHANDS_MACHINE_ID:"client",ENVINHANDS_AUDIT_SIGNATURE:"File agent"};
 const previous=Object.fromEntries([...Object.keys(values),"ENVINHANDS_SHARED_HOSTS"].map(k=>[k,process.env[k]]));Object.assign(process.env,values);delete process.env.ENVINHANDS_SHARED_HOSTS;
 const tools=new Map<string,Parameters<Parameters<typeof extension>[0]["registerTool"]>[0]>();
 try{
  extension({registerTool:tool=>tools.set(tool.name,tool)});const ctx={sessionManager:{getSessionId:()=>"real-fixture-session"}};
  const resources=await tools.get("envinhands_list_shared_resources")!.execute("resources",{},undefined,undefined,ctx);
  assert.ok(resources.content[0].text.includes('"resourceId":"work"'));
  const files=await tools.get("envinhands_list_shared_files")!.execute("files",{resourceId:"work"},undefined,undefined,ctx);
  assert.ok(files.content[0].text.includes('"name":"work.txt"'));
  const read=await tools.get("envinhands_read_shared_file")!.execute("read",{resourceId:"work",path:"work.txt"},undefined,undefined,ctx);
  const receipt=JSON.parse(read.content[0].text.split("\n")[1]);assert.equal(receipt.text,"shared original");
  const dispose=installPrimeTransport({baseUrl:server.url,registration:()=>({registrationId:"unrelated-global",agentId:"other-agent",machineId:"client",sessionId:"other-global-session",signature:"Other session"})});
  const written=await tools.get("envinhands_write_shared_file")!.execute("write",{resourceId:"work",path:"work.txt",text:"agent modification",expectedSha256:receipt.sha256},undefined,undefined,ctx);
  try {
   assert.notEqual(written.isError,true);assert.equal(await readFile(join(root,"work.txt"),"utf8"),"agent modification");
   const next=JSON.parse(written.content[0].text.split("\n")[1]);
   assert.equal(next.status,"success");assert.equal(next.hostId,"configured-service");
   const inspected=await tools.get("envinhands_inspect_shared_write")!.execute("inspect",{operationId:next.operationId},undefined,undefined,ctx);
   assert.notEqual(inspected.isError,true);const observed=JSON.parse(inspected.content[0].text.split("\n")[1]);assert.deepEqual(observed.records.map((r:{outcome:string})=>r.outcome),["unknown","success"]);
   const second=await tools.get("envinhands_write_shared_file")!.execute("second",{resourceId:"work",path:"work.txt",text:"second session modification",expectedSha256:next.afterSha256},undefined,undefined,{sessionManager:{getSessionId:()=>"second-executing-session"}});
   assert.notEqual(second.isError,true);
   const secondReceipt=JSON.parse(second.content[0].text.split("\n")[1]);
   const previousFetch=globalThis.fetch;let writes=0;
   try {
    globalThis.fetch=Object.assign(async(value:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{const response=await previousFetch(value,init);if(init?.method==="POST"&&new URL(String(value)).pathname==="/v1/shared-files"){writes++;await response.arrayBuffer();throw Error("actual response deliberately lost");}return response;},previousFetch);
    const uncertain=await tools.get("envinhands_write_shared_file")!.execute("uncertain",{resourceId:"work",path:"work.txt",text:"once despite lost reply",expectedSha256:secondReceipt.afterSha256},undefined,undefined,ctx);
    assert.equal(uncertain.isError,true);const reference=JSON.parse(uncertain.content[0].text.split("\n")[1]);assert.equal(reference.status,"unknown");assert.equal(reference.hostId,"configured-service");
    const checked=await tools.get("envinhands_inspect_shared_write")!.execute("inspect-lost",{operationId:reference.operationId},undefined,undefined,ctx);
    const actual=JSON.parse(checked.content[0].text.split("\n")[1]);assert.deepEqual(actual.records.map((r:{outcome:string})=>r.outcome),["unknown","success"]);assert.equal(writes,1);assert.equal(await readFile(join(root,"work.txt"),"utf8"),"once despite lost reply");
   } finally {globalThis.fetch=previousFetch;}
   const store=createChangeStore(join(root,"db.sqlite"));try{const records=store.list(0,100).records.filter(r=>r.outcome==="success");
    assert.deepEqual(records.map(r=>r.registration.sessionId),["real-fixture-session","second-executing-session","real-fixture-session"]);
    assert.ok(records.every(r=>r.registration.agentId==="file-agent"));
   }finally{store.close();}
  }finally{dispose();}
 }finally{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await server.stop();await rm(root,{recursive:true,force:true});}
});
