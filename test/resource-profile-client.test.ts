import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createResourceProfileApi} from "../src/resource-profile.ts";
import {createMachineApi} from "../src/machine-api.ts";
import {CollaborationClient} from "../src/collaboration-client.ts";
import {runCollaborationCli} from "../src/collaboration-cli.ts";
import {signedCliFetch} from "../src/cli-registration.ts";
import primeCollaboration from "../src/integrations/prime-collaboration.ts";

test("profile client, CLI and Prime tools keep legacy notes and signed structured claims across reopen", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"profile-client-")), dbPath=join(dir,"data.sqlite"),token="fixture-secret-token";
 let profile=createResourceProfileApi({dbPath,token}), machine=createMachineApi({dbPath,token});
 const signed:string[]=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
   const path=new URL(req.url).pathname;
   if(req.method==="POST") {
     const raw=req.headers.get("x-envinhands-registration");
     if(!raw||!req.headers.get("x-envinhands-operation-id")) return new Response("missing signature",{status:403});
     signed.push(JSON.parse(Buffer.from(raw,"base64url").toString()).agentId);
   }
   return path.includes("/profile-notes")?profile.fetch(req):machine.fetch(req);
 }});
 const baseUrl=`http://127.0.0.1:${server.port}`;
 const env={ENVINHANDS_URL:baseUrl,ENVINHANDS_TOKEN:token,ENVINHANDS_AGENT_ID:"agent",ENVINHANDS_MACHINE_ID:"host",ENVINHANDS_SESSION_ID:"session",ENVINHANDS_AUDIT_SIGNATURE:"Agent"};
 const keys=Object.keys(env), previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try {
   Object.assign(process.env,env);
   const tools=new Map<string,Parameters<Parameters<typeof primeCollaboration>[0]["registerTool"]>[0]>();
   primeCollaboration({registerTool:t=>tools.set(t.name,t),on:()=>{}});
   const ctx={sessionManager:{getSessionId:()=>"session"},ui:{notify:()=>{}}};
   const call=(name:string,input:Record<string,unknown>)=>tools.get(name)!.execute("id",input,undefined,undefined,ctx);
   assert.notEqual((await call("envinhands_add_resource_note",{resourceId:"project",text:"old note"})).isError,true);
   const old=await call("envinhands_resource_notes",{resourceId:"project"}); assert.match(old.content[0].text,/old note/);
   const added=await call("envinhands_add_resource_profile_note",{resourceId:"project",text:"first claim",category:"experience",topic:"setup"});
   assert.notEqual(added.isError,true);
   const first=JSON.parse(added.content[0].text.split("\n").slice(1).join("\n")).note;
   const output:string[]=[],errors:string[]=[];
   const io={readInput:async()=>JSON.stringify({resourceId:"project",author:"agent",text:"reply",category:"answer",replyTo:first.id}),write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch};
   assert.equal(await runCollaborationCli(["profile-notes","reply"],env,io),0);
   assert.equal(JSON.parse(output[0]).receipt.replyTo,first.id);
   assert.equal(await runCollaborationCli(["profile-notes","reply"],env,io),0);
   assert.notEqual(JSON.parse(output[0]).receipt.id,JSON.parse(output[1]).receipt.id);
   let attempts=0;
   const uncertain=new CollaborationClient({baseUrl,token,fetch:signedCliFetch(env,async(input,init)=>{attempts++;await fetch(input,init);throw new Error("lost response");})});
   await assert.rejects(uncertain.addProfileNote("project",{author:"agent",text:"committed despite failure",category:"change"}));
   assert.equal(attempts,1);
   profile.close(); machine.close();
   profile=createResourceProfileApi({dbPath,token}); machine=createMachineApi({dbPath,token});
   const client=new CollaborationClient({baseUrl,token,fetch});
   const page=await client.listProfileNotes("project",{limit:1}); assert.equal(page.notes[0].category,null); assert.ok(page.nextCursor);
   const rest=await client.listProfileNotes("project",{after:page.nextCursor!}); assert.equal(rest.notes.length,4); assert.equal(rest.notes[1].replyTo,first.id);
   assert.equal((await client.listProfileNotes("project",{topic:"setup"})).notes.length,1);
   assert.equal((await client.readNotes("project")).length,5);
   assert.deepEqual(signed,["agent","agent","agent","agent","agent"]); assert.deepEqual(errors,[]);
   assert.equal((await call("envinhands_add_resource_profile_note",{resourceId:"project",text:token,category:"issue"})).isError,true);
 } finally {server.stop(true);profile.close();machine.close();for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}rmSync(dir,{recursive:true,force:true});}
});

test("uncertain writes are not retried on failure or timeout",async()=>{
 let calls=0;
 const rejected=new CollaborationClient({baseUrl:"http://127.0.0.1",token:"secret",fetch:async()=>{calls++;throw new Error("secret");},timeoutMs:20});
 await assert.rejects(rejected.addProfileNote("project",{author:"a",text:"claim",category:"issue"}),e=>!String(e).includes("secret")); assert.equal(calls,1);
 calls=0;
 const hanging=new CollaborationClient({baseUrl:"http://127.0.0.1",token:"secret",fetch:async()=>{calls++;return await new Promise<Response>(()=>{});},timeoutMs:20});
 await assert.rejects(hanging.addProfileNote("project",{author:"a",text:"claim",category:"issue"})); assert.equal(calls,1);
});


test("full legal profile pages fit the response cap, including JSON escapes and multibyte text", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"profile-page-")),token="fixture-token";
 const profile=createResourceProfileApi({dbPath:join(dir,"data.sqlite"),token});
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>profile.fetch(req)});
 const baseUrl=`http://127.0.0.1:${server.port}`;
 let pageBytes=0;
 const client=new CollaborationClient({baseUrl,token,fetch:async(input,init)=>{
   const response=await fetch(input,init);
   if(init?.method==="GET") pageBytes=(await response.clone().arrayBuffer()).byteLength;
   return response;
 }});
 try {
   const escaped="\u0001".repeat(2300)+"a".repeat(1700), emoji="😀".repeat(2000);
   for(let i=0;i<100;i++) await client.addProfileNote("project",{
     author:"a".repeat(200),text:i%2?escaped:emoji,category:"experience",topic:"b".repeat(200)
   });
   const page=await client.listProfileNotes("project",{limit:100});
   assert.equal(page.notes.length,100);
   assert.equal(page.nextCursor,null);
   assert.equal(page.notes[0].text,emoji);
   assert.equal(page.notes[1].text,escaped);
   assert.ok(pageBytes>512*1024,`expected >512 KiB, got ${pageBytes}`);
   assert.ok(pageBytes<4*1024*1024);
 } finally {server.stop(true);profile.close();rmSync(dir,{recursive:true,force:true});}
});

test("profile page response still has a finite byte limit",async()=>{
 let calls=0;
 const client=new CollaborationClient({baseUrl:"http://127.0.0.1",token:"fixture-token",fetch:async()=>{
   calls++;return new Response("x".repeat(4*1024*1024+1));
 }});
 await assert.rejects(client.listProfileNotes("project",{limit:100}));
 assert.equal(calls,1);
});
