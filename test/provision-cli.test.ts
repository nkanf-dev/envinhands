import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {runProvisionCli} from "../src/provision-cli.ts";
test("provisioning CLI records separate apply/revoke attempts and refuses missing owner confirmation",async()=>{
 const root=await mkdtemp(join(tmpdir(),"provision-cli-"));const env={ENVINHANDS_AGENT_ID:"fixture-agent",ENVINHANDS_MACHINE_ID:"fixture-host",ENVINHANDS_SESSION_ID:"fixture-session",ENVINHANDS_AUDIT_SIGNATURE:"Fixture agent",ENVINHANDS_CHANGE_SPOOL:root};
 let input=JSON.stringify({action:"apply",operationId:"grant-one",user:"fixture",publicKey:"invalid",confirm:false});const output:string[]=[],errors:string[]=[];
 const io={readInput:async()=>input,write:(text:string)=>output.push(text),error:(text:string)=>errors.push(text),fetch};
 try{
  assert.equal(await runProvisionCli([],env,io),1);assert.equal(JSON.parse(output[0]).result.status,"failed");
  input=JSON.stringify({action:"revoke",operationId:"grant-one",confirm:false});assert.equal(await runProvisionCli([],env,io),1);
  assert.equal(output.length,2);assert.notEqual(JSON.parse(output[0]).audit.operationId,JSON.parse(output[1]).audit.operationId);assert.deepEqual(errors,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
