import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter,once} from "node:events";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {startRemotePublish} from "../src/remote-publish.ts";
import {runRemotePublishCli} from "../src/remote-publish-cli.ts";
const options={host:"entry.example",user:"agent",localServicePort:8787,remotePort:41234};
function fixture(code:string):ChildProcessWithoutNullStreams{return spawn(process.execPath,["-e",code],{shell:false,stdio:["pipe","pipe","pipe"]});}
const confirm='debug1: remote forward success for: listen 127.0.0.1:41234, connect 127.0.0.1:8787\n';
test("publication awaits explicit forward confirmation, preserves strict argv and closes only its process",async()=>{
 let child!:ChildProcessWithoutNullStreams;let notify!:()=>void;const spawned=new Promise<void>(r=>{notify=r;});let args:string[]=[];let settled=false;
 const started=startRemotePublish({...options,identityFile:join(tmpdir(),"key-reference"),knownHostsFile:join(tmpdir(),"hosts-reference")},{spawn:(exe,argv)=>{
  assert.equal(exe,"ssh");args=argv;child=fixture(`process.stdin.once('data',()=>process.stderr.write(${JSON.stringify(confirm)}));process.stdin.resume();`);child.once("spawn",notify);return child;
 }}).then(value=>{settled=true;return value;});
 await spawned;await new Promise<void>(resolve=>setImmediate(resolve));
 if(settled){child.kill("SIGKILL");await started.then(value=>value.close());assert.fail("Spawn must not establish publication readiness");}
 child.stdin.write("confirm");const connection=await started;
 assert.equal(connection.url,"http://127.0.0.1:41234");assert.equal(connection.remoteHost,"entry.example");
 assert.ok(args.includes("StrictHostKeyChecking=yes"));assert.ok(args.includes("BatchMode=yes"));assert.ok(args.includes("IdentitiesOnly=yes"));assert.ok(args.includes("ExitOnForwardFailure=yes"));assert.ok(args.includes("-N"));assert.ok(args.includes("-T"));
 assert.equal(args[args.indexOf("-R")+1],"127.0.0.1:41234:127.0.0.1:8787");assert.ok(args.indexOf("-R")<args.indexOf("--"));
 await connection.close();await connection.close();await connection.finished;assert.ok(child.exitCode!==null||child.signalCode!==null);
});
test("early exit, wrong confirmation and cancellation never imply ready",async()=>{
 for(const code of ["process.exit(1)",`process.stderr.write('debug1: remote forward success for: listen 0.0.0.0:41234, connect 127.0.0.1:8787\n');process.exit(0);`])await assert.rejects(startRemotePublish(options,{spawn:()=>fixture(code)}));
 const controller=new AbortController();let child!:ChildProcessWithoutNullStreams;
 const pending=startRemotePublish(options,{signal:controller.signal,spawn:()=>{child=fixture("process.stdin.resume()");return child;}});await once(child,"spawn");controller.abort();await assert.rejects(pending);assert.ok(child.exitCode!==null||child.signalCode!==null);
 await assert.rejects(startRemotePublish(options,{setupTimeoutMs:25,spawn:()=>fixture("process.stdin.resume()")}));
 await assert.rejects(startRemotePublish({...options,remotePort:0}));await assert.rejects(startRemotePublish({...options,remoteBind:"0.0.0.0"} as typeof options));
});
test("confirmed publication reports subsequent unexpected SSH exit",async()=>{
 const child=fixture(`process.stderr.write(${JSON.stringify(confirm)});process.stdin.resume();`);
 const connection=await startRemotePublish(options,{spawn:()=>child});const lost=assert.rejects(connection.finished);child.kill("SIGKILL");await lost;await connection.close();
});
test("CLI private profile emits unverified endpoint and SIGTERM awaits its owned process",async()=>{
 const root=await mkdtemp(join(tmpdir(),"publish-cli-")),path=join(root,"profile.json"),signals=new EventEmitter();let child!:ChildProcessWithoutNullStreams;let ready!:()=>void;const shown=new Promise<void>(r=>{ready=r;});let text="";
 try{await writeFile(path,JSON.stringify(options),{mode:0o600});
  const pending=runRemotePublishCli([path],{write:t=>{text+=t;ready();},error:t=>{throw Error(t);}},signals,{start:(value,deps)=>startRemotePublish(value,{...deps,spawn:()=>{child=fixture(`process.stderr.write(${JSON.stringify(confirm)});process.stdin.resume();`);return child;}})});
  await shown;assert.equal(JSON.parse(text).backendVerified,false);signals.emit("SIGTERM");assert.equal(await pending,0);assert.ok(child.exitCode!==null||child.signalCode!==null);assert.equal(signals.listenerCount("SIGTERM"),0);
 }finally{child?.kill("SIGKILL");await rm(root,{recursive:true,force:true});}
});
