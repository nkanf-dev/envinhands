import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startAgentBusServer} from "../src/server.ts";
import {runDeviceCli} from "../src/device-cli.ts";
import {runCollaborationCli} from "../src/collaboration-cli.ts";
import {createChangeStore} from "../src/change-store.ts";

test("normal device and collaboration CLI writes are attributed on formal service",async()=>{
 const root=await mkdtemp(join(tmpdir(),"signed-clis-")),dbPath=join(root,"db.sqlite"),token="signed-cli-fixture";
 const server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const env={ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token,ENVINHANDS_AGENT_ID:"actual-cli",ENVINHANDS_MACHINE_ID:"client",ENVINHANDS_SESSION_ID:"session-one",ENVINHANDS_AUDIT_SIGNATURE:"CLI user"};
 let input="";const output:string[]=[],errors:string[]=[];const io={readInput:async()=>input,write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch};
 try{
  input=JSON.stringify({id:"device-one",host:"example.org",sshUser:"agent"});assert.equal(await runDeviceCli(["register"],env,io),0);
  input=JSON.stringify({agentId:"actual-cli",machineId:"client"});assert.equal(await runCollaborationCli(["heartbeat"],env,io),0);
  input=JSON.stringify({requestId:"m-one",from:"actual-cli",to:"peer",text:"private body"});assert.equal(await runCollaborationCli(["send"],env,io),0);
  input=JSON.stringify({requestId:"m-one"});assert.equal(await runCollaborationCli(["ack"],env,io),0);
  input=JSON.stringify({resourceId:"device-one",author:"actual-cli",text:"private note"});assert.equal(await runCollaborationCli(["add-note"],env,io),0);
  const store=createChangeStore(dbPath);try{const records=store.list(0,100).records;assert.equal(records.length,10);
   assert.ok(records.every(record=>record.registration.agentId==="actual-cli"&&record.registration.sessionId==="session-one"));
   assert.equal(records.filter(record=>record.outcome==="success").length,5);
   assert.ok(!JSON.stringify(records).includes("private body"));assert.ok(!JSON.stringify(records).includes("private note"));
  }finally{store.close();}
  assert.deepEqual(errors,[]);
 }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});
