import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRemoteAccess } from "../src/remote-access.ts";

test("real loopback HTTP passes through owned SSH-stdio fixture with strict argv and no -n", async () => {
  const http = createServer((request, response) => { const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => { response.setHeader("connection", "close"); response.end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString() })); }); });
  http.listen(0, "127.0.0.1"); await once(http, "listening"); const address = http.address(); assert.ok(address && typeof address !== "string");
  const children: ChildProcessWithoutNullStreams[] = [], calls: Array<{ executable: string; args: string[] }> = [];
  const bridge = await startRemoteAccess({ host: "control.example", user: "agent", port: 2222, hostKeyAlias: "trusted-control", identityFile: join(tmpdir(), "fixture-key-reference"), knownHostsFile: join(tmpdir(), "fixture-hosts-reference"), jump: "trusted-jump", destinationHost: "127.0.0.1", destinationPort: address.port }, { spawn: (executable, args) => {
    calls.push({ executable, args });
    const child = spawn(process.execPath, ["-e", `const net=require('node:net');const s=net.createConnection({host:'127.0.0.1',port:${address.port},allowHalfOpen:true});process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(2));s.on('end',()=>{process.stdout.end();process.stdin.destroy();s.end();});`], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    children.push(child); return child;
  } });
  try {
    const reply = await fetch(bridge.url, { method: "POST", body: "actual fixture payload" });
    assert.deepEqual(await reply.json(), { method: "POST", body: "actual fixture payload" });
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/); assert.ok(bridge.port > 0);
    assert.equal(calls[0].executable, "ssh"); const args = calls[0].args;
    assert.equal(args.includes("-n"), false); assert.ok(args.includes("-T"));
    assert.ok(args.includes("BatchMode=yes")); assert.ok(args.includes("StrictHostKeyChecking=yes")); assert.ok(args.includes("IdentitiesOnly=yes"));
    const separator = args.indexOf("--"); assert.ok(args.indexOf("-W") < separator); assert.equal(args[args.indexOf("-W") + 1], `127.0.0.1:${address.port}`); assert.equal(args[separator + 1], "control.example");
    assert.equal(args[args.indexOf("-J") + 1], "trusted-jump");
  } finally { await bridge.close(); await bridge.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  await assert.rejects(fetch(bridge.url));
});

test("close terminates an active owned child and rejects unsupported remote destinations before listening", async () => {
  await assert.rejects(startRemoteAccess({ host: "control.example", user: "agent", destinationHost: "0.0.0.0" as "127.0.0.1", destinationPort: 80 }));
  let started!: () => void; const childStarted = new Promise<void>(resolve => { started = resolve; }); let child: ChildProcessWithoutNullStreams | undefined;
  const bridge = await startRemoteAccess({ host: "control.example", user: "agent", destinationHost: "127.0.0.1", destinationPort: 8787 }, { spawn: () => {
    child = spawn(process.execPath, ["-e", "process.stdin.resume();"], { stdio: ["pipe", "pipe", "pipe"], shell: false }); child.once("spawn", started); return child;
  } });
  const socket = createConnection({ host: "127.0.0.1", port: bridge.port }); socket.on("error", () => {});
  const closed = once(socket, "close");
  await childStarted; await bridge.close(); await closed;
  assert.ok(child && (child.exitCode !== null || child.signalCode !== null));
});
