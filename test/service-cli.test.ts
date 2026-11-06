import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { runServiceCli } from "../src/service-cli.ts";
import { runCli } from "../src/cli.ts";
import { runDeviceCli } from "../src/device-cli.ts";

test("formal service requires actor headers, exposes real inventory and restarts using the unchanged private config and DB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-service-life-"));
  const file = join(dir, "config.json"), token = randomBytes(32).toString("hex");
  const bytes = JSON.stringify({ hostname: "127.0.0.1", port: 0, dbPath: join(dir, "bus.sqlite"), token });
  const registration = { registrationId: "service-test-reg", agentId: "service-test-agent", sessionId: "service-test-session", machineId: "service-test-machine", signature: "Service fixture" };
  const signedFetch = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("x-envinhands-registration", Buffer.from(JSON.stringify(registration)).toString("base64url"));
    headers.set("x-envinhands-operation-id", randomUUID());
    return fetch(input, { ...init, headers });
  };
  let stop: (() => void) | undefined, task: Promise<number> | undefined;
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    for (let run = 0; run < 2; run++) {
      const signals = new EventEmitter();
      let resolveReady!: (value: { url: string; pid: number; requireSignedMutations: boolean }) => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<{ url: string; pid: number; requireSignedMutations: boolean }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      let output = "", errors = "";
      stop = () => { signals.emit("SIGTERM"); };
      const serviceIO = { write: (text: string) => { output += text; resolveReady(JSON.parse(text)); }, error: (text: string) => { errors += text; rejectReady(new Error(text)); } };
      const logEnv = { ENVINHANDS_LOG_DIR: join(dir, "logs") };
      task = run === 0 ? runServiceCli([file], serviceIO, signals, { env: logEnv })
        : runCli(["service", file], logEnv, { signals, stdout: { write: serviceIO.write }, stderr: { write: serviceIO.error } });
      const service = await ready;
      expect(service.pid).toBe(process.pid); expect(service.requireSignedMutations).toBe(true);
      expect(output).not.toContain(token);
      const env = { ENVINHANDS_URL: service.url, ENVINHANDS_TOKEN: token, ENVINHANDS_AGENT_ID: registration.agentId, ENVINHANDS_MACHINE_ID: registration.machineId, ENVINHANDS_SESSION_ID: registration.sessionId, ENVINHANDS_AUDIT_SIGNATURE: registration.signature };
      const inventory: string[] = [], deviceErrors: string[] = [];
      const io = { readInput: async () => JSON.stringify({ id: "formal-device", host: "127.0.0.1", sshUser: "debian" }), write: (s: string) => inventory.push(s), error: (s: string) => deviceErrors.push(s), fetch: signedFetch };
      expect((await fetch(service.url + "/v1/machines")).status).toBe(401);
      const forbiddenBody = await fetch(service.url + "/v1/messages", { method: "POST", body: "private-agent-message-body-marker" });
      expect(forbiddenBody.status).toBe(401);
      if (run === 0) {
        const unsigned = await fetch(service.url + "/v1/machines", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ id: "unsigned-device", name: "Unsigned", host: "127.0.0.1", os: "linux", sshUser: "debian" }) });
        expect(unsigned.ok).toBe(false);
        expect(await runDeviceCli(["register"], env, io)).toBe(0);
      }
      expect(await runDeviceCli(["inventory"], env, io)).toBe(0);
      const listed = JSON.parse(inventory[inventory.length - 1]!).inventory.machines;
      expect(listed).toHaveLength(1); expect(listed[0].id).toBe("formal-device"); expect(listed[0].status).toBe("pending");
      expect(deviceErrors).toEqual([]);
      const changes = await fetch(service.url + "/v1/changes?after=0&limit=100", { headers: { authorization: `Bearer ${token}` } });
      expect(changes.status).toBe(200);
      const records = (await changes.json() as { records: Array<{ registration: { agentId: string }; outcome: string }> }).records;
      expect(records.some(record => record.registration.agentId === registration.agentId && record.outcome === "success")).toBe(true);
      stop(); expect(await task).toBe(0); task = undefined;
      expect(signals.listenerCount("SIGTERM")).toBe(0); expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(errors).toBe(""); expect(await readFile(file, "utf8")).toBe(bytes);
      await expect(fetch(service.url + "/v1/agents")).rejects.toThrow();
    }
    if (process.platform !== "win32") {
      const dirs = await readdir(join(dir, "logs")); expect(dirs).toHaveLength(2);
      for (const name of dirs) {
        const logDir = join(dir, "logs", name), file = join(logDir, "events.jsonl");
        expect((await stat(logDir)).mode & 0o777).toBe(0o700);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        const data = await readFile(file, "utf8");
        expect(data).toContain("server_started"); expect(data).toContain("server_stopped");
        expect(data).not.toContain(token); expect(data).not.toContain(registration.signature); expect(data).not.toContain("private-agent-message-body-marker");
      }
    }
  } finally { stop?.(); await task; await rm(dir, { recursive: true, force: true }); }
});

test("standalone service entry rejects invalid configuration with a redacted exit and no ready output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-service-invalid-"));
  try {
    const secret = randomBytes(32).toString("hex"), file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ token: secret }), { mode: 0o600 });
    const child = Bun.spawn([process.execPath, "src/service-cli.ts", file], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("Control service failed"); expect(stderr).not.toContain(secret);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("formal CLI service warns about logging faults but still starts and stops without leaking the token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-service-logging-fault-"));
  const token = randomBytes(32).toString("hex"), file = join(dir, "config.json");
  const signals = new EventEmitter(); let output = "", errors = "";
  let ready!: (value: { url: string }) => void;
  const readyPromise = new Promise<{ url: string }>(resolve => { ready = resolve; });
  await writeFile(file, JSON.stringify({ hostname: "127.0.0.1", port: 0, dbPath: join(dir, "bus.sqlite"), token }), { mode: 0o600 });
  const task = runCli(["service", file], { ENVINHANDS_LOG_DIR: "relative-unsafe" }, {
    signals, stdout: { write(text) { output += text; ready(JSON.parse(text)); } }, stderr: { write(text) { errors += text; } },
  });
  try {
    const service = await readyPromise;
    expect((await fetch(service.url + "/v1/agents")).status).toBe(401);
    expect(errors).toContain("Logging fault (configuration)");
    expect(output + errors).not.toContain(token);
    signals.emit("SIGTERM"); expect(await task).toBe(0);
  } finally { signals.emit("SIGTERM"); await task; await rm(dir, { recursive: true, force: true }); }
});


test("real CLI and standalone service entrypoints become ready, log metadata, and stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-service-entrypoints-"));
  const token = randomBytes(32).toString("hex"), file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ hostname: "127.0.0.1", port: 0, dbPath: join(dir, "bus.sqlite"), token }), { mode: 0o600 });
  async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("service entrypoint timed out")), 3000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  try {
    for (const [index, argv] of [["src/cli.ts", "service", file], ["src/service-cli.ts", file]].entries()) {
      const logs = join(dir, `logs-${index}`);
      const env: NodeJS.ProcessEnv = { ...process.env, ENVINHANDS_LOG_DIR: logs };
      delete env.ENVINHANDS_TOKEN; delete env.ENVINHANDS_RELAY_SECRET;
      const child = Bun.spawn([process.execPath, ...argv], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
      const stderr = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      try {
        const readyText = await bounded((async () => {
          let text = "";
          while (!text.includes("\n")) {
            const chunk = await reader.read(); if (chunk.done) throw new Error("service exited before ready");
            text += new TextDecoder().decode(chunk.value);
          }
          return text;
        })());
        const ready = JSON.parse(readyText.trim());
        expect(ready.type).toBe("ready"); expect(ready.requireSignedMutations).toBe(true);
        expect((await fetch(ready.url + "/v1/agents", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
        child.kill("SIGTERM"); expect(await bounded(child.exited)).toBe(0);
        const errorText = await stderr;
        expect(readyText + errorText).not.toContain(token);
        const names = await readdir(logs); expect(names).toHaveLength(1);
        const data = await readFile(join(logs, names[0]!, "events.jsonl"), "utf8");
        expect(data).toContain("server_started"); expect(data).toContain("server_stopped"); expect(data).not.toContain(token);
      } finally {
        try { child.kill("SIGKILL"); } catch {}
        await child.exited; reader.releaseLock(); await stderr;
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
