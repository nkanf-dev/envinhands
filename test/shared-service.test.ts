import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startAgentBusServer} from "../src/server.ts";
import {runFilesCli} from "../src/files-cli.ts";
import {createChangeStore} from "../src/change-store.ts";
test("normal shared-file CLI read and compare-write records real target hashes on strict service",async()=>{
 const root=await mkdtemp(join(tmpdir(),"shared-service-"));const file=join(root,"work.txt");await writeFile(file,"host-owned work\n");
 const dbPath=join(root,"bus.sqlite"),token="shared-service-fixture";
 const server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true,machineId:"resource-host",sharedRoots:{work:root}});
 const env={ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token,ENVINHANDS_AGENT_ID:"remote-worker",ENVINHANDS_MACHINE_ID:"remote-host",ENVINHANDS_SESSION_ID:"work-session",ENVINHANDS_AUDIT_SIGNATURE:"Remote worker"};
 let input=JSON.stringify({resourceId:"work",path:"work.txt"});const output:string[]=[],errors:string[]=[];
 const io={readInput:async()=>input,write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch};
 try{
  assert.equal(await runFilesCli(["resources"],env,io),0);
  const discovered=JSON.parse(output.pop()!).receipt;assert.equal(discovered.resources[0].resourceId,"work");
  input=JSON.stringify({resourceId:"work",path:""});assert.equal(await runFilesCli(["list"],env,io),0);
  const listing=JSON.parse(output.pop()!).receipt;assert.ok(listing.entries.some((entry:{name:string})=>entry.name==="work.txt"));
  input=JSON.stringify({resourceId:"work",path:"work.txt"});
  assert.equal(await runFilesCli(["read"],env,io),0);const before=JSON.parse(output[0]).receipt;
  input=JSON.stringify({resourceId:"work",path:"work.txt",text:before.text+"remote reviewed\n",expectedSha256:before.sha256});
  assert.equal(await runFilesCli(["write"],env,io),0);const written=JSON.parse(output[1]).receipt;
  assert.equal(written.beforeSha256,before.sha256);assert.notEqual(written.afterSha256,before.sha256);
  assert.equal(await readFile(file,"utf8"),"host-owned work\nremote reviewed\n");
  const store=createChangeStore(dbPath);try{const records=store.list(0,100).records;assert.equal(records.length,2);const result=records[1];
   assert.equal(result.resourceId,"shared-file:work/work.txt");assert.equal(result.targetMachineId,"resource-host");assert.equal(result.registration.agentId,"remote-worker");
   assert.equal(result.beforeSha256,written.beforeSha256);assert.equal(result.afterSha256,written.afterSha256);assert.ok(!JSON.stringify(records).includes("host-owned work"));
  }finally{store.close();}
  assert.deepEqual(errors,[]);
 }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});
