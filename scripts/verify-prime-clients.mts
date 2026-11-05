/** Two real OS clients, no provider/model. Run explicitly with Bun from a prepared checkout. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { startAgentBusServer } from "../src/server.ts";
import { parseChange } from "../src/change-model.ts";

const checkout = process.env.PRIME_AGENT_CHECKOUT;
if (!checkout) throw new Error("Set PRIME_AGENT_CHECKOUT to the prepared actual Prime checkout.");
const root = mkdtempSync(join(tmpdir(), "env-prime-processes-"));
const reportPath = process.env.PRIME_CLIENT_REPORT ? resolve(process.env.PRIME_CLIENT_REPORT) : undefined;
const token = randomBytes(32).toString("hex");
const authority = "Authorized explicit no-model two-process integration fixture.";
const fixtureMachineId = `${process.platform}-fixture`;
const fault = process.argv.includes("--fault=ack-unavailable");
const auditFile = join(root, "controller-changes.jsonl");
const audit = (action: string, resourceId: string, outcome: string, summary: string) => appendFileSync(auditFile, JSON.stringify({
  agentId: "prime-client-controller", sessionId: `controller-${process.pid}`, signature: "EnvInHands no-model controller",
  executionMachineId: process.platform, targetMachineId: process.platform, recordedAt: new Date().toISOString(), action, resourceId, outcome, summary, authority,
  registrationRef: join(root, "controller-registration.json"), limitations: "Declared fixture ledger, not automatic all-resource capture or strong authentication.",
}) + "\n");
writeFileSync(join(root, "controller-registration.json"), JSON.stringify({ agentId: "prime-client-controller", sessionId: `controller-${process.pid}`,
  signature: "EnvInHands no-model controller", processId: process.pid, createdAt: new Date().toISOString(), authority }));
audit("create-fixture", root, "success", "Created isolated process/HTTP/SQLite fixture directory.");
const server = startAgentBusServer({ dbPath: join(root, "bus.sqlite"), token, hostname: "127.0.0.1", port: 0 });
audit("start-fixture-service", join(root, "bus.sqlite"), "success", "Started real loopback API on random port with random in-memory token.");
type Reply = { id?: string; type?: string; ok?: boolean; result?: unknown; [key:string]: unknown };
class Client {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<Reply>;
  exited: Promise<number | null>;
  private nextId = 0;
  private pending = new Map<string, { resolve(reply:Reply):void; reject(error:Error):void; timer:ReturnType<typeof setTimeout> }>();
  constructor(readonly label: string, mode: "normal" | "wrong-token" | "disabled" = "normal") {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { PRIME_AGENT_CHECKOUT: resolve(checkout!), PRIME_CLIENT_DATA_DIR: join(root, `${label}-${randomBytes(4).toString("hex")}`),
      ENVINHANDS_URL: server.url, ENVINHANDS_AGENT_ID: label, ENVINHANDS_MACHINE_ID: fixtureMachineId, PRIME_CLIENT_SERVICE_MACHINE_ID: fixtureMachineId,
      ENVINHANDS_AUDIT_SIGNATURE: `Fixture ${label}`, PI_OFFLINE: "1", DO_NOT_TRACK: "1", PRIME_FIXTURE_REDACT_TOKEN: token });
    if (fault && label === "client-b") env.PRIME_CLIENT_FIXTURE_FAULT = "ack-unavailable";
    if (mode !== "disabled") env.ENVINHANDS_TOKEN = mode === "wrong-token" ? "wrong-fixture-token" : token;
    this.process = spawn(process.execPath, ["run", "--tsconfig-override", join(resolve(checkout!), "tsconfig.json"), fileURLToPath(new URL("./prime-client.mts", import.meta.url))],
      { env, cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolveExit, reject) => { this.process.once("exit", resolveExit); this.process.once("error", reject); });
    this.ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Client ${label} readiness deadline exceeded`)), 15000);
      const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
      lines.on("line", line => {
        try {
          assert.equal(line.includes(token), false, "credential leaked in child protocol");
          const reply = JSON.parse(line) as Reply;
          if (reply.type === "ready") { clearTimeout(timer); resolveReady(reply); return; }
          if (reply.type === "startup_error") { clearTimeout(timer); reject(new Error(`Client ${label} startup rejected`)); return; }
          if (typeof reply.id === "string") { const pending = this.pending.get(reply.id); if (pending) { this.pending.delete(reply.id); clearTimeout(pending.timer); pending.resolve(reply); } }
        } catch { clearTimeout(timer); reject(new Error(`Client ${label} invalid or unsafe protocol`)); }
      });
      this.process.once("exit", () => { clearTimeout(timer); reject(new Error(`Client ${label} exited before readiness`)); });
    });
    this.process.stderr.on("data", chunk => { if (String(chunk).includes(token)) this.process.kill(); });
    this.process.once("exit", () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Client ${label} exited`)); } this.pending.clear(); });
    audit("spawn-client", env.PRIME_CLIENT_DATA_DIR!, "success", `Started real client process ${this.process.pid}; independent environment and workspace.`);
  }
  async command(command: Record<string,unknown>): Promise<Reply> {
    const id = `${this.label}-${++this.nextId}`;
    const reply = new Promise<Reply>((resolveReply,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Client ${this.label} command deadline exceeded`)); },15000);
      this.pending.set(id,{resolve:resolveReply,reject,timer});
    });
    this.process.stdin.write(JSON.stringify({id,...command})+"\n");
    return reply;
  }
  async call(name:string,args:object = {}): Promise<unknown> { const reply = await this.command({type:"call",name,args}); assert.equal(reply.ok,true); return reply.result; }
  async close(): Promise<void> { if (this.process.exitCode !== null || this.process.signalCode !== null) return; await this.command({type:"close"}); this.process.stdin.end(); assert.equal(await this.exited,0); }
}
const clients: Client[] = [];
const start = async (name:string, mode?:"normal"|"wrong-token"|"disabled") => { const client=new Client(name,mode); clients.push(client); const ready=await client.ready; return {client,ready}; };
const json = (value:unknown):Record<string,unknown> => { const result=value as {content:Array<{text:string}>;isError?:boolean}; assert.notEqual(result.isError,true); return JSON.parse(result.content[0].text.split("\n").slice(1).join("\n")); };
const text = (value:unknown) => JSON.stringify(value);
const outcomes: Record<string,unknown> = { result:"failed", runtime:"real ExtensionRunner processes; not full Prime daemon/TUI/model Agents", crossMachine:false };
let error: unknown;
try {
  const [{client:a,ready:ar},{client:b,ready:br}] = await Promise.all([start("client-a"),start("client-b")]);
  assert.notEqual(ar.pid,br.pid); assert.notEqual(ar.sessionId,br.sessionId); assert.notEqual(ar.dataDir,br.dataDir);
  assert.equal((ar.tools as unknown[]).length,10); assert.equal((br.tools as unknown[]).length,10);
  const registrationA=json(await a.call("envinhands_register_agent",{registrationId:"registration-a"}));
  const registrationB=json(await b.call("envinhands_register_agent",{registrationId:"registration-b"}));
  assert.equal((registrationA.registration as Record<string,unknown>).sessionId,ar.sessionId);
  assert.equal((registrationB.registration as Record<string,unknown>).sessionId,br.sessionId);
  for (const event of ["session_start","agent_start","agent_end","session_shutdown"]) {
    const reply=await a.command({type:"lifecycle",event});assert.equal(reply.ok,true);
    const agents=json(await b.call("envinhands_list_agents")); const observed=(agents.agents as Array<Record<string,unknown>>).find(item=>item.agentId==="client-a");
    assert.equal(observed?.task,event);assert.equal(observed?.status,"observed");
  }
  for(const [sender,recipient,to,id] of [[a,b,"client-b","a-to-b"],[b,a,"client-a","b-to-a"]] as const){
    const message={requestId:id,to,text:"Non-sensitive collaboration fixture"};
    assert.match(text(await sender.call("envinhands_send",message)),/Accepted/);
    assert.match(text(await sender.call("envinhands_send",message)),/Accepted/);
    assert.match(text(await sender.call("envinhands_send",{...message,text:"conflicting content"})),/failed/);
    assert.match(text(await recipient.call("envinhands_pull")),new RegExp(id)); assert.match(text(await recipient.call("envinhands_pull")),new RegExp(id));
    await recipient.call("envinhands_ack",{requestId:id}); await recipient.call("envinhands_ack",{requestId:id});
    assert.doesNotMatch(text(await recipient.call("envinhands_pull")),new RegExp(id));
  }
  const resources=json(await a.call("envinhands_list_resources"));assert.deepEqual(resources.machines,[]);
  assert.match(text(await a.call("envinhands_add_resource_note",{resourceId:"fixture-resource",text:"Non-sensitive resource experience"})),/saved/);
  const notes=json(await b.call("envinhands_resource_notes",{resourceId:"fixture-resource"}));assert.equal((notes.messages as Array<Record<string,unknown>>)[0].author,"client-a");
  const change=parseChange({requestId:"record-a",operationId:"operation-a",registrationId:"registration-a",targetMachineId:fixtureMachineId,resourceId:"fixture:collaboration",
    action:"verify",summary:"Verified fixture collaboration only",reason:"No-model independent process acceptance",authority,outcome:"success",occurredAt:new Date().toISOString(),beforeSha256:null,afterSha256:null,evidenceRef:"fixture-process-run"});
  const saved=json(await a.call("envinhands_record_change",change));assert.equal((saved.record as Record<string,unknown>).registrationId,"registration-a");
  assert.equal((json(await b.call("envinhands_list_changes"))).records instanceof Array,true);
  await a.call("envinhands_send",{requestId:"pending-b",to:"client-b",text:"Retained in B queue"});
  await b.call("envinhands_send",{requestId:"pending-a",to:"client-a",text:"Retained through A restart"});
  const beforeRestart=(await a.command({type:"status"})).result as Record<string,unknown>;await a.close();
  assert.match(text(await b.call("envinhands_pull")),/pending-b/);
  const {client:restarted,ready:rr}=await start("client-a");assert.notEqual(rr.pid,ar.pid);assert.notEqual(rr.sessionId,ar.sessionId);
  assert.match(text(await restarted.call("envinhands_pull")),/pending-a/);
  assert.equal((await restarted.call("envinhands_record_change",change) as {isError?:boolean}).isError,true);
  await restarted.call("envinhands_register_agent",{registrationId:"registration-a-restarted"});
  await b.call("envinhands_ack",{requestId:"pending-b"});await restarted.call("envinhands_ack",{requestId:"pending-a"});
  const {client:wrong,ready:wr}=await start("wrong-client","wrong-token");assert.equal((wr.tools as unknown[]).length,10);
  assert.equal((await wrong.call("envinhands_register_agent",{registrationId:"wrong-reg"}) as {isError?:boolean}).isError,true);
  assert.match(text(await wrong.call("envinhands_send",{requestId:"bad-send",to:"client-b",text:"Rejected"})),/failed/);
  const wrongStatus=(await wrong.command({type:"status"})).result as Record<string,unknown>;assert.ok((wrongStatus.wire as Array<{status:number}>).every(item=>item.status===401));
  const {client:disabled,ready:dr}=await start("disabled-client","disabled");assert.deepEqual(dr.tools,[]);assert.equal(dr.allowedRequests,0);
  const invalid=await b.command({type:"call",name:"envinhands_send",args:{requestId:"bad/id",to:"client-a",text:"Rejected before request"}});assert.equal(invalid.ok,false);
  const wire=beforeRestart.wire as Array<{path:string;status:number}>;assert.ok(wire.some(item=>item.path==="/v1/messages"&&item.status===201));assert.ok(wire.some(item=>item.path==="/v1/messages"&&item.status===200));assert.ok(wire.some(item=>item.path==="/v1/messages"&&item.status===409));
  for(const client of clients){if(client.process.exitCode===null){const status=(await client.command({type:"status"})).result as Record<string,unknown>;assert.equal(status.modelCalls,0);assert.equal(status.blockedNetwork,0);}}
  Object.assign(outcomes,{result:"passed",independentClientProcesses:2,processIds:[ar.pid,br.pid],restartProcessId:rr.pid,distinctSessions:true,realLoader:true,realSchema:true,wrappedTools:true,
    realHttpSqlite:true,heartbeatLifecycleObserved:true,bidirectionalReplayAck:true,clientRestartQueuePreserved:true,explicitAudit:true,resourceNotes:true,wrongToken401:true,disabledWithoutToken:true,modelCalls:0,
    limits:["Same host, not Windows-to-VM or full Prime daemon/TUI/model Agent","No real SSH/admin/relay/tmux or automatic mutation capture","Caller cancellation after dispatch is not transport cancellation","Shared bearer identity labels are not strong authentication"]});
} catch(caught){error=caught;} finally {
  for(const client of clients){try{await client.close();}catch{client.process.kill();await client.exited.catch(()=>null);}}
  await server.stop();audit("stop-fixture",join(root,"bus.sqlite"),"success","Stopped owned API and client processes.");
  const ledgers: Array<{relativePath:string;registration:unknown;records:unknown[]}> = [];
  const {readdirSync}=await import("node:fs");
  for(const entry of readdirSync(root,{withFileTypes:true}))if(entry.isDirectory()){const path=join(root,entry.name,"fixture-changes.jsonl");try{ledgers.push({relativePath:`${entry.name}/fixture-changes.jsonl`,registration:JSON.parse(readFileSync(join(root,entry.name,"fixture-registration.json"),"utf8")),records:readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))});}catch{}}
  audit("cleanup-fixture",root,"unknown","Own fixture cleanup requested; actual removal verified after this record is collected.");
  const report={...outcomes,negativeControl:fault,controllerRegistration:JSON.parse(readFileSync(join(root,"controller-registration.json"),"utf8")),recordedAt:new Date().toISOString(),controllerPid:process.pid,ledgers,controllerLedger:readFileSync(auditFile,"utf8").trim().split("\n").map(line=>JSON.parse(line))};
  rmSync(root,{recursive:true,force:true});
  report.controllerLedger.push({...report.controllerRegistration,recordedAt:new Date().toISOString(),action:"cleanup-fixture",resourceId:root,outcome:"success",summary:"Owned temporary resource removal completed.",authority});
  if(reportPath){mkdirSync(resolve(reportPath,".."),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");}
  console.log(JSON.stringify({...outcomes,reportPath,fixtureCleaned:true}));
}
if(error){console.error(error instanceof Error ? error.message : "Independent client verification failed");process.exitCode=1;}
