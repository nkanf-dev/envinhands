// Isolated subprocess fixture. No real network, SSH, or user files are used.
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { runCli } from "../../src/cli.ts";

const mode = process.argv[2];
const signals = new EventEmitter();
let cancelled = 0;
if (mode === "fallback-interactive") {
  const dir = mkdtempSync(join(tmpdir(), "connect-fixture-"));
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, "#!/usr/bin/env bun\nif (process.argv.includes('-tt')) setTimeout(() => process.exit(0), 350); else process.exit(0);\n", {mode:0o700});
  let calls = 0, abandoned = 0;
  const output = {write(_text: string) {}};
  const env = {ENVINHANDS_URL:"http://127.0.0.1", ENVINHANDS_TOKEN:"fixture-token",
    ENVINHANDS_RELAY_URL:"", ENVINHANDS_RELAY_SECRET:"",
    ENVINHANDS_SSH_IDENTITY:"/fixture/key", ENVINHANDS_SSH_KNOWN_HOSTS:"/fixture/hosts",
    PATH:dir + delimiter + (process.env.PATH ?? "")};
  try {
    const started = performance.now();
    const code = await runCli(["connect", "fixture"], env, {stdinIsTTY:true, stdoutIsTTY:true,
      signals, stdout:output, stderr:output, requestTimeoutMs:100, fetch:async () => {
        calls++;
        if (calls === 1) return new Response(new ReadableStream({cancel() { abandoned++; }}), {status:404});
        if (calls === 2) return Response.json({machines:[{id:"fixture", sshUser:"user", os:"linux"}]});
        return Response.json({machineId:"fixture",routes:[{machineId:"fixture",routeId:"direct",kind:"direct",
          controller:"fixture",host:"127.0.0.1",port:22,priority:1,observedAt:Date.now()-1,ttlMs:60000,status:"observed"}]});
      }});
    if (code !== 0 || calls !== 3 || abandoned !== 1 || performance.now() - started < 300)
      throw new Error("Fallback or interactive SSH did not finish normally");
  } finally { rmSync(dir, {recursive:true, force:true}); }
  console.log("fixture-complete");
} else {
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    if (mode === "large") controller.enqueue(new Uint8Array(65_537));
    if (mode === "invalid") { controller.enqueue(new TextEncoder().encode("{")); controller.close(); }
  },
  cancel() { cancelled++; return mode === "error-reject" ? Promise.reject(new Error("fixture cancel rejection")) : new Promise<void>(() => {}); },
});
const env = {ENVINHANDS_URL:"http://127.0.0.1", ENVINHANDS_TOKEN:"fixture-token",
  ENVINHANDS_RELAY_URL:"", ENVINHANDS_RELAY_SECRET:"",
  ENVINHANDS_SSH_IDENTITY:"/fixture/key", ENVINHANDS_SSH_KNOWN_HOSTS:"/fixture/hosts"};
const output = {write(_text: string) {}};
const task = runCli(["connect", "fixture", "user"], env, {
  stdinIsTTY:true, stdoutIsTTY:true, signals, stdout:output, stderr:output, requestTimeoutMs:mode === "deadline" ? 100 : 6000,
  fetch:async () => new Response(body, {status: mode === "error" || mode === "error-reject" ? 503 : 200,
    headers: mode === "declared" ? {"content-length":"65537"} : undefined}),
});
if (mode === "cancel") setTimeout(() => signals.emit("SIGTERM"), 25);
const code = await task;
if (code !== (mode === "cancel" ? 130 : 1)) throw new Error("Unexpected exit code");
if (["error", "error-reject", "large", "declared", "cancel", "deadline"].includes(mode) && cancelled !== 1)
  throw new Error("Response body was not cancelled once");
console.log("fixture-complete");

}
