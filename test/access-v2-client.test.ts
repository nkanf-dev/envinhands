import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startAgentBusServer} from "../src/server.ts";
import {runAccessCli} from "../src/access-cli.ts";
import {verifyClientAccess} from "../src/client-access.ts";
import {AccessEvidenceClient} from "../src/access-evidence-client.ts";
import {createSignedFetch} from "../src/signed-fetch.ts";
import type {Fetcher} from "../src/prime-bridge.ts";
import {ChangeClient} from "../src/change-client.ts";

const registration={registrationId:"v2-client",agentId:"v2-agent",sessionId:"v2-session",machineId:"client",signature:"Agent"};
const scope={registrationId:registration.registrationId,agentId:registration.agentId,sessionId:registration.sessionId,targetMachineId:"target"};
const input={registration,targetMachineId:"target",os:"linux",routes:[{id:"route",host:"localhost"}],access:{user:"agent",hostKeyAlias:"trusted.local",identityFile:"/tmp/test-key"},priority:["route"],totalBudgetMs:10000};
const key="SHA256:"+"A".repeat(43);

test("formal server v2: real HTTP, fake SSH, failure invalidation, lost response recovery and retry",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-cycle-")),token="cycle-token";
 const server=startAgentBusServer({dbPath:join(dir,"db.sqlite"),token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const client=new AccessEvidenceClient({baseUrl:server.url,token,fetch:createSignedFetch({baseUrl:server.url,registration:()=>registration,fetch})});
 let mode="ready",ssh=0;
 const verify:typeof verifyClientAccess=(opts)=>verifyClientAccess(opts,{fingerprint:async()=>{if(mode==="key")throw Error("missing");return key;},runner:async(_cmd,args)=>{ssh++;return {exitCode:mode==="admin"&&args.at(-1)?.startsWith("sudo -n -- ")?1:0};}});
 const run=async(value:unknown,args:string[]=[], fetcher:Fetcher=fetch)=>{
  const lines:string[]=[];
  const code=await runAccessCli(args,{ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token},{readInput:async()=>JSON.stringify(value),write:s=>lines.push(s),error:()=>{},fetch:fetcher},{verify});
  return {code,body:JSON.parse(lines.join(""))};
 };
 try{
  let r=await run({...input,operationId:"initial"}); assert.equal(r.code,0); assert.equal(r.body.ready,true); assert.equal((await client.current(scope)).status,"ready");
  const expected={...scope,routeId:"route",sshIdentityRef:key,sshUser:"agent",hostKeyAlias:"trusted.local",os:"linux" as const};
  assert.equal(await client.currentReady(scope,expected),true);
  assert.equal(await client.currentReady(scope,{...expected,hostKeyAlias:"wrong.local"}),false);
  mode="key";const prior=ssh;r=await run({...input,operationId:"key-fail"}); assert.equal(r.code,1);assert.equal(ssh,prior);assert.equal((await client.current(scope)).status,"unknown");
  mode="admin";r=await run({...input,operationId:"admin-fail"});assert.equal(r.code,1);assert.equal((await client.current(scope)).status,"not-ready");
  mode="ready"; let once=true;
  const transient:Fetcher=async(request,init)=>{
   if(once && init?.method==="POST" && typeof init.body==="string" && JSON.parse(init.body).action==="commit") {once=false;await fetch(request,init);throw Error("response lost once");}
   return fetch(request,init);
  };
  r=await run({...input,operationId:"automatic-retry"},[],transient);assert.equal(r.code,0);assert.equal(r.body.synced,true);
  let drop=2;
  const lost:Fetcher=async (request,init)=>{
   if(drop && init?.method==="POST" && typeof init.body==="string" && JSON.parse(init.body).action==="commit") {if (drop-- === 2) await fetch(request,init);throw Error("response lost");}
   return fetch(request,init);
  };
  r=await run({...input,operationId:"lost-response"},[],lost);assert.equal(r.code,1);assert.equal(r.body.synced,false);assert.equal(r.body.ready,false);assert.ok(r.body.recovery);assert.equal((await client.current(scope)).status,"ready");
  const synced=await run({registration,recovery:r.body.recovery},["sync"]);assert.equal(synced.code,0);assert.equal(synced.body.ready,false);assert.equal(synced.body.synced,true);
  const priorSsh=ssh; r=await run({...input,operationId:"lost-response"});assert.equal(r.code,1);assert.equal(ssh,priorSsh);
  r=await run({...input,operationId:"recovered"});assert.equal(r.code,0);assert.equal((await client.current(scope)).status,"ready");
 }finally{await server.stop();await rm(dir,{recursive:true,force:true});}
});

test("overlapping generations: newer failure cannot be overwritten by older delayed success",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-overlap-")),token="overlap-token";
 const server=startAgentBusServer({dbPath:join(dir,"db.sqlite"),token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const fetchSigned=createSignedFetch({baseUrl:server.url,registration:()=>registration,fetch});
 const client=new AccessEvidenceClient({baseUrl:server.url,token,fetch:fetchSigned});
 try{
  await new ChangeClient({baseUrl:server.url,token,fetch}).register(registration);
  const first=await client.begin("old",scope), second=await client.begin("new",scope);
  assert.equal((await client.current(scope)).status,"unknown");
  await client.commit(scope,second.generation,{status:"unknown"});
  const now=Date.now(), good={...scope,routeId:"route",sshIdentityRef:key,sshUser:"agent",hostKeyAlias:"trusted.local",os:"linux" as const,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),ready:true,status:"ready" as const,verificationScope:"actual-client-ssh-identity-and-route" as const};
  await assert.rejects(client.commit(scope,first.generation,good));
  assert.equal((await client.current(scope)).status,"unknown");
  await client.commit(scope,second.generation,{status:"unknown"});
  await assert.rejects(client.commit(scope,second.generation,good));
 }finally{await server.stop();await rm(dir,{recursive:true,force:true});}
});


test("verification begins before SSH; a later failure wins a delayed successful check",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-inflight-")),token="inflight-token";
 const server=startAgentBusServer({dbPath:join(dir,"db.sqlite"),token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const client=new AccessEvidenceClient({baseUrl:server.url,token,fetch:createSignedFetch({baseUrl:server.url,registration:()=>registration,fetch})});
 let release!:()=>void, started!:()=>void; const gate=new Promise<void>(r=>release=r), probing=new Promise<void>(r=>started=r);
 const cli=async(id:string,verify:typeof verifyClientAccess,fetcher:Fetcher=fetch)=>{
  let out="";const code=await runAccessCli([],{ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token},{readInput:async()=>JSON.stringify({...input,operationId:id}),write:s=>out+=s,error:()=>{},fetch:fetcher},{verify});
  return {code,body:JSON.parse(out)};
 };
 const verify=(delay:boolean,fail:boolean):typeof verifyClientAccess => opts=>verifyClientAccess(opts,{fingerprint:async()=>key,runner:async()=>{
  if(delay){started();await gate;}return {exitCode:fail?255:0};
 }});
 try{
  assert.equal((await cli("seed",verify(false,false))).code,0);
  let ran=false;
  const offline:Fetcher=async(req,init)=>{if(init?.method==="POST" && typeof init.body==="string" && JSON.parse(init.body).action==="begin")throw Error("offline");return fetch(req,init);};
  const failed=await cli("offline",async opts=>{ran=true;return verify(false,false)(opts);},offline);
  assert.equal(failed.body.ready,false);assert.equal(failed.body.synced,false);assert.equal(ran,false);
  assert.equal((await client.current(scope)).status,"ready"); // Server was unreachable; its old result cannot be remotely revoked.
  const old=cli("slow",verify(true,false));await probing;
  assert.equal((await client.current(scope)).status,"unknown");
  const newer=await cli("newer",verify(false,true));assert.equal(newer.body.ready,false);
  release();const older=await old;assert.equal(older.body.ready,false);assert.equal(older.body.synced,false);
  assert.equal((await client.current(scope)).status,"unknown");
  assert.equal((await cli("after-repair",verify(false,false))).code,0);
 }finally{release?.();await server.stop();await rm(dir,{recursive:true,force:true});}
});


test("client wall clock may be ten minutes fast, slow, or move backward during SSH",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-skew-")),token="skew-token";
 const server=startAgentBusServer({dbPath:join(dir,"db.sqlite"),token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const client=new AccessEvidenceClient({baseUrl:server.url,token,fetch:createSignedFetch({baseUrl:server.url,registration:()=>registration,fetch})});
 try {
  for(const [i,skew] of [600000,-600000].entries()) {
   let wall=Date.now()+skew;
   const verify:typeof verifyClientAccess=opts=>verifyClientAccess(opts,{now:()=>wall,monotonic:()=>performance.now(),fingerprint:async()=>key,runner:async()=>{wall-=300000;return {exitCode:0};}});
   let out="";const code=await runAccessCli([],{ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token},{readInput:async()=>JSON.stringify({...input,operationId:`skew-${i}`}),write:s=>out+=s,error:()=>{},fetch},{verify});
   assert.equal(code,0);const response=JSON.parse(out);assert.equal(response.ready,true);
   const current=await client.current(scope);assert.equal(current.status,"ready");assert.ok(current.remainingMs>0&&current.remainingMs<=300000);
   assert.equal(await client.currentReady(scope,{...scope,routeId:"route",sshIdentityRef:key,sshUser:"agent",hostKeyAlias:"trusted.local",os:"linux"}),true);
  }
 }finally{await server.stop();await rm(dir,{recursive:true,force:true});}
});

test("current accounts for transport delay, rejects replay nonce and requires server clock",async()=>{
 const now=Date.now();const e={...scope,routeId:"route",sshIdentityRef:key,sshUser:"agent",hostKeyAlias:"trusted.local",os:"linux",checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+20).toISOString(),ready:true,status:"ready",verificationScope:"actual-client-ssh-identity-and-route"};
 let mode="delay", replay="";
 const fake:Fetcher=async request=>{
  const nonce=new URL(String(request)).searchParams.get("nonce");
  const body={scope,generation:"gen",status:"ready",evidence:e,serverNow:new Date(now).toISOString(),nonce};
  if(mode==="delay")await new Promise(resolve=>setTimeout(resolve,35));
  if(mode==="record")replay=JSON.stringify(body);
  if(mode==="replay")return new Response(replay,{headers:{"content-type":"application/json"}});
  if(mode==="old"){const {serverNow:_discard,nonce:_discard2,...legacy}=body;return Response.json(legacy);}
  return Response.json(body);
 };
 const client=new AccessEvidenceClient({baseUrl:"http://127.0.0.1",token:"fake-token",fetch:fake});
 assert.equal((await client.current(scope)).status,"unknown");
 mode="record";assert.equal((await client.current(scope)).status,"ready");
 mode="replay";await assert.rejects(client.current(scope),/Invalid access current response/);
 mode="old";await assert.rejects(client.current(scope),/clock upgrade/);
});

test("probe budget uses monotonic time even if wall clock moves backwards",async()=>{
 let wall=Date.now(),mono=0,calls=0;
 const result=await verifyClientAccess(input as Parameters<typeof verifyClientAccess>[0],{
  now:()=>wall,monotonic:()=>mono,fingerprint:async()=>key,runner:async()=>{calls++;wall-=600000;mono+=6000;return {exitCode:0};}
 });
 assert.equal(calls,2);assert.equal(result.ready,false);
});


test("a successful SSH probe exceeding its server-anchored TTL is unknown, not ready",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-ttl-")),token="ttl-token";
 const server=startAgentBusServer({dbPath:join(dir,"db.sqlite"),token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const client=new AccessEvidenceClient({baseUrl:server.url,token,fetch:createSignedFetch({baseUrl:server.url,registration:()=>registration,fetch})});
 try {
  let calls=0,out="";
  const verify:typeof verifyClientAccess=opts=>verifyClientAccess(opts,{fingerprint:async()=>key,runner:async()=>{if(++calls===1)await new Promise(r=>setTimeout(r,30));return {exitCode:0};}});
  const code=await runAccessCli([],{ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token},{readInput:async()=>JSON.stringify({...input,operationId:"slow-ttl",ttlMs:10}),write:s=>out+=s,error:()=>{},fetch},{verify});
  assert.equal(calls,2);assert.equal(code,1);assert.equal(JSON.parse(out).ready,false);assert.equal((await client.current(scope)).status,"unknown");
 }finally{await server.stop();await rm(dir,{recursive:true,force:true});}
});


test("Windows user with spaces survives real v2 begin, verification, commit and scoped current",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-win-user-")),token="windows-user-token";
 const server=startAgentBusServer({dbPath:join(dir,"db.sqlite"),token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const client=new AccessEvidenceClient({baseUrl:server.url,token,fetch:createSignedFetch({baseUrl:server.url,registration:()=>registration,fetch})});
 const argv:readonly string[][]=[];
 const verify:typeof verifyClientAccess=opts=>verifyClientAccess(opts,{fingerprint:async()=>key,runner:async(_cmd,args)=>{(argv as string[][]).push([...args]);return {exitCode:0};}});
 try {
  let out="";const value={...input,os:"windows",access:{...input.access,user:"Jane Doe"},operationId:"win-space"};
  const code=await runAccessCli([],{ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token},{readInput:async()=>JSON.stringify(value),write:s=>out+=s,error:()=>{},fetch},{verify});
  assert.equal(code,0);assert.equal(JSON.parse(out).ready,true);
  assert.equal(argv.length,2);assert.equal(argv[0][argv[0].indexOf("-l")+1],"Jane Doe");
  assert.ok(argv[1].includes("powershell.exe"));
  const current=await client.current(scope);assert.equal(current.status,"ready");assert.equal(current.evidence?.sshUser,"Jane Doe");assert.equal(current.evidence?.os,"windows");
  assert.equal(await client.currentReady(scope,{...scope,routeId:"route",sshIdentityRef:key,sshUser:"Jane Doe",hostKeyAlias:"trusted.local",os:"windows"}),true);
 }finally{await server.stop();await rm(dir,{recursive:true,force:true});}
});
