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


test("sync configuration is validated before the helper and errors never expose secrets",async()=>{
 const root=await mkdtemp(join(tmpdir(),"provision-config-"));
 const base={ENVINHANDS_AGENT_ID:"agent",ENVINHANDS_MACHINE_ID:"host",ENVINHANDS_SESSION_ID:"session",ENVINHANDS_AUDIT_SIGNATURE:"sig",ENVINHANDS_CHANGE_SPOOL:root};
 const output:string[]=[],errors:string[]=[];let calls=0,fetches=0;
 const io={readInput:async()=>JSON.stringify({action:"revoke",operationId:"grant",confirm:true}),write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch:async()=>{fetches++;throw new Error("secret");}};
 const runners={unix:async()=>{calls++;return {status:"revoked" as const,ready:false as const,fixture:false,message:"done"};},windows:async()=>{calls++;return {status:"revoked" as const,ready:false as const,fixture:false,message:"done"};}};
 try{
  for(const invalid of [
   {ENVINHANDS_URL:"ftp://localhost",ENVINHANDS_TOKEN:"secret"},
   {ENVINHANDS_URL:"http://example.com",ENVINHANDS_TOKEN:"secret"},
   {ENVINHANDS_URL:"https://user:secret@example.com",ENVINHANDS_TOKEN:"secret"},
   {ENVINHANDS_URL:"https://example.com/path",ENVINHANDS_TOKEN:"secret"},
   {ENVINHANDS_URL:"https://example.com",ENVINHANDS_TOKEN:"bad token"},
   {ENVINHANDS_URL:"https://example.com"}, {ENVINHANDS_TOKEN:"secret"},
   {ENVINHANDS_URL:"",ENVINHANDS_TOKEN:"secret"},
   {ENVINHANDS_AGENT_ID:"bad identity"}, {ENVINHANDS_VISUDO:"relative"},
  ]) assert.equal(await runProvisionCli([],{...base,...invalid},io,runners),1);
  assert.equal(calls,0);assert.equal(fetches,0);assert.equal(output.length,0);
  assert.ok(!errors.join("").includes("secret"));
 }finally{await rm(root,{recursive:true,force:true});}
});

test("failed sync preserves helper result and audit; token never appears in output",async()=>{
 const root=await mkdtemp(join(tmpdir(),"provision-sync-"));
 const env={ENVINHANDS_AGENT_ID:"agent",ENVINHANDS_MACHINE_ID:"host",ENVINHANDS_SESSION_ID:"session",ENVINHANDS_AUDIT_SIGNATURE:"sig",ENVINHANDS_CHANGE_SPOOL:root,ENVINHANDS_URL:"https://example.com",ENVINHANDS_TOKEN:"secret-token"};
 const output:string[]=[],errors:string[]=[];let calls=0;
 const io={readInput:async()=>JSON.stringify({action:"revoke",operationId:"grant",confirm:true}),write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch:async()=>{throw new Error("secret-token");}};
 const runner=async()=>{calls++;return {status:"revoked" as const,ready:false as const,fixture:false,message:"secret-token",receipt:{note:"secret-token"}};};
 try{
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),0);
  const saved=JSON.parse(output[0]);assert.equal(saved.result.status,"revoked");assert.equal(saved.synced,false);assert.equal(saved.audit.outcome,"success");assert.equal(saved.audit.locallyRecorded,true);
  assert.ok(!output.join("").includes("secret-token"));assert.deepEqual(errors,[]);assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("legacy dedupe remains; explicit distinct revoke attempts never replay an attempt",async()=>{
 const root=await mkdtemp(join(tmpdir(),"provision-retry-"));
 const env={ENVINHANDS_AGENT_ID:"agent",ENVINHANDS_MACHINE_ID:"host",ENVINHANDS_SESSION_ID:"session",ENVINHANDS_AUDIT_SIGNATURE:"sig",ENVINHANDS_CHANGE_SPOOL:root};
 let input=JSON.stringify({action:"revoke",operationId:"grant",confirm:true}),calls=0;const output:string[]=[],errors:string[]=[];
 const io={readInput:async()=>input,write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch};
 const runner=async(request:any)=>{calls++;assert.equal(request.attemptId,undefined);assert.equal(request.confirmRetry,undefined);return {status:"partial" as const,ready:false as const,fixture:false,message:"inspect receipt"};};
 try{
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);assert.equal(calls,1);
  input=JSON.stringify({action:"revoke",operationId:"grant",confirm:true,attemptId:"attempt-1"});
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);assert.equal(calls,1);
  input=JSON.stringify({action:"revoke",operationId:"grant",confirm:true,attemptId:"attempt-1",confirmRetry:true});
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);assert.equal(calls,2);
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);assert.equal(calls,2);
  input=JSON.stringify({action:"revoke",operationId:"another-grant",confirm:true,attemptId:"attempt-1",confirmRetry:true});
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);assert.equal(calls,2);
  input=JSON.stringify({action:"revoke",operationId:"grant",confirm:true,attemptId:"attempt-2",confirmRetry:true});
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);assert.equal(calls,3);
  assert.equal(new Set(output.map(s=>JSON.parse(s).audit.operationId)).size,3);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("a completion-spool failure does not hide the helper result",async()=>{
 const root=await mkdtemp(join(tmpdir(),"provision-local-")),spool=join(root,"spool");
 const env={ENVINHANDS_AGENT_ID:"agent",ENVINHANDS_MACHINE_ID:"host",ENVINHANDS_SESSION_ID:"session",ENVINHANDS_AUDIT_SIGNATURE:"sig",ENVINHANDS_CHANGE_SPOOL:spool};
 const output:string[]=[],errors:string[]=[];
 const io={readInput:async()=>JSON.stringify({action:"revoke",operationId:"grant",confirm:true}),write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch};
 const runner=async()=>{
  // Simulate storage failure after the helper has returned, without touching the real system.
  const {writeFile}=await import("node:fs/promises");
  await rm(spool,{recursive:true,force:true});await writeFile(spool,"unavailable");
  return {status:"revoked" as const,ready:false as const,fixture:false,message:"done"};
 };
 try{
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);
  const saved=JSON.parse(output[0]);assert.equal(saved.result.status,"revoked");assert.equal(saved.audit.outcome,"unknown");assert.equal(saved.audit.locallyRecorded,false);assert.equal(saved.synced,false);assert.deepEqual(errors,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("helper exception is unknown, never automatically retried",async()=>{
 const root=await mkdtemp(join(tmpdir(),"provision-unknown-"));
 const env={ENVINHANDS_AGENT_ID:"agent",ENVINHANDS_MACHINE_ID:"host",ENVINHANDS_SESSION_ID:"session",ENVINHANDS_AUDIT_SIGNATURE:"sig",ENVINHANDS_CHANGE_SPOOL:root};
 const output:string[]=[],errors:string[]=[];let calls=0;
 const io={readInput:async()=>JSON.stringify({action:"revoke",operationId:"grant",confirm:true}),write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch};
 const runner=async():Promise<never>=>{calls++;throw new Error("private helper failure");};
 try{
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);
  const saved=JSON.parse(output[0]);assert.equal(saved.result,null);assert.equal(saved.audit.outcome,"unknown");assert.equal(saved.synced,false);
  assert.equal(await runProvisionCli([],env,io,{unix:runner,windows:runner}),1);assert.equal(calls,1);assert.ok(!errors.join("").includes("private helper failure"));
 }finally{await rm(root,{recursive:true,force:true});}
});
