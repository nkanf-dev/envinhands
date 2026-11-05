import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import collaboration from "../src/integrations/prime-collaboration.ts";
import {installPrimeTransport} from "../src/integrations/prime-transport.ts";
import {startAgentBusServer} from "../src/server.ts";
import {createChangeStore} from "../src/change-store.ts";
import {Storage} from "../src/storage.ts";

type Host=Parameters<typeof collaboration>[0];type Tool=Parameters<Host["registerTool"]>[0];
test("seven Env-owned collaboration tools and lifecycle events use actual context actors through a strict service",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"prime-collaboration-")),dbPath=join(dir,"bus.sqlite"),token=randomBytes(32).toString("hex");
 const server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
 const keys=["ENVINHANDS_URL","ENVINHANDS_TOKEN","ENVINHANDS_AGENT_ID","ENVINHANDS_MACHINE_ID","ENVINHANDS_AUDIT_SIGNATURE"] as const;
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));const originalFetch=globalThis.fetch;
 const captured:Array<{path:string;method:string;body:string}>=[];
 globalThis.fetch=Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{captured.push({path:new URL(String(input)).pathname,method:init?.method??"GET",body:typeof init?.body==="string"?init.body:""});return originalFetch(input,init);},originalFetch) as typeof fetch;
 const dispose=installPrimeTransport({baseUrl:server.url,registration:()=>({registrationId:"wrong-ambient",agentId:"wrong",machineId:"host",sessionId:"wrong-session",signature:"Wrong ambient"})});
 const tools=new Map<string,Tool>(),handlers=new Map<string,(event:unknown,ctx:Parameters<Tool["execute"]>[4])=>Promise<void>>();
 const ctx=(sessionId:string)=>({sessionManager:{getSessionId:()=>sessionId},ui:{notify:()=>{}}});
 const a=ctx("session-a"),b=ctx("session-b");
 try{
  Object.assign(process.env,{ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:token,ENVINHANDS_AGENT_ID:"participant",ENVINHANDS_MACHINE_ID:"host",ENVINHANDS_AUDIT_SIGNATURE:"Participant"});
  collaboration({registerTool:tool=>tools.set(tool.name,tool),on:(event:string,handler:never)=>handlers.set(event,handler)} as Host);
  assert.deepEqual([...tools.keys()],["envinhands_list_agents","envinhands_send","envinhands_pull","envinhands_ack","envinhands_list_resources","envinhands_resource_notes","envinhands_add_resource_note"]);
  const call=(name:string,args:Record<string,unknown>,context=a)=>tools.get(name)!.execute("fixture",args,undefined,undefined,context);
  const parse=(result:Awaited<ReturnType<Tool["execute"]>>)=>{assert.notEqual(result.isError,true);return JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));};
  for(const event of["session_start","agent_start","agent_end","session_shutdown"]){await handlers.get(event)!({},a);assert.equal(parse(await call("envinhands_list_agents",{})).agents[0].task,event);}
  assert.match((await call("envinhands_send",{requestId:"message-a",to:"participant",text:"actual shared work"},a)).content[0].text,/Accepted/);
  assert.equal(parse(await call("envinhands_pull",{},b)).messages[0].requestId,"message-a");assert.equal(parse(await call("envinhands_pull",{},b)).messages.length,1);
  await call("envinhands_ack",{requestId:"message-a"},b);await call("envinhands_ack",{requestId:"message-a"},b);assert.deepEqual(parse(await call("envinhands_pull",{},b)).messages,[]);
  await call("envinhands_add_resource_note",{resourceId:"project",text:"Shared experience"},a);await call("envinhands_add_resource_note",{resourceId:"project",text:"Shared experience"},b);
  const notes=parse(await call("envinhands_resource_notes",{resourceId:"project"},b)).messages;assert.equal(notes.length,2);assert.notEqual(notes[0].id,notes[1].id);
  const storage=Storage.open(dbPath);try{storage.addMessage("project","author","echo "+token);}finally{storage.close();}
  assert.equal(JSON.stringify(await call("envinhands_resource_notes",{resourceId:"project"})).includes(token),false);
  assert.deepEqual(parse(await call("envinhands_list_resources",{})).machines,[]);
  assert.equal((await call("envinhands_send",{requestId:"large",to:"participant",text:"😀".repeat(1001)})).isError,true);
  const store=createChangeStore(dbPath);try{
   const records=store.list(0,100).records;assert.ok(records.length>0);assert.ok(records.every(record=>record.registration.sessionId!=="wrong-session"));
   const ack=records.filter(record=>record.resourceId.includes("message-a/ack"));assert.ok(ack.length>0);assert.ok(ack.every(record=>record.registration.sessionId==="session-b"));
   const noteActors=records.filter(record=>record.resourceId.includes("/v1/resources/project/messages"));assert.deepEqual([...new Set(noteActors.map(record=>record.registration.sessionId))].sort(),["session-a","session-b"]);
  }finally{store.close();}
  assert.ok(captured.filter(request=>request.path.endsWith("/ack")).every(request=>request.body===""));
 }finally{dispose();globalThis.fetch=originalFetch;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}await server.stop();await rm(dir,{recursive:true,force:true});}
});
