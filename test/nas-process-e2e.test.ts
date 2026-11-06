import { test, expect } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(project, "src/cli.ts");
const deadlineMs = 8_000;

// Never include child output, request bodies or environment values in errors.
function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), deadlineMs); }),
  ]).finally(() => clearTimeout(timer));
}

type Running = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: { stdout: string; stderr: string };
  events: string[];
};

function launch(args: string[], env: NodeJS.ProcessEnv, children: Set<Running>): Running {
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: "pipe" });
  const output = { stdout: "", stderr: "" };
  const events: string[] = [];
  child.once("spawn", () => events.push("spawn"));
  child.once("exit", (code, signal) => events.push(`exit:${code ?? "null"}:${signal ?? "none"}`));
  child.once("close", (code, signal) => events.push(`close:${code ?? "null"}:${signal ?? "none"}`));
  child.once("error", () => events.push("error"));
  // Drain both pipes as the process runs. Output is deliberately not logged.
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { output.stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not start CLI process")));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const running = { child, closed, output, events };
  children.add(running);
  return running;
}

async function finish(running: Running, children: Set<Running>) {
  const result = await deadline(running.closed, "CLI process");
  children.delete(running);
  return result;
}

async function device(args: string[], input: unknown, env: NodeJS.ProcessEnv, children: Set<Running>) {
  const running = launch(["device", ...args], env, children);
  running.child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const exit = await finish(running, children);
  return { ...exit, ...running.output };
}

async function startService(config: string, token: string, env: NodeJS.ProcessEnv, children: Set<Running>) {
  const running = launch(["service", config], env, children);
  running.child.stdin.end();
  const ready = new Promise<{ type: string; url: string; hostname: string; port: number; pid: number; requireSignedMutations: boolean }>((resolve, reject) => {
    const onData = () => {
      const newline = running.output.stdout.indexOf("\n");
      if (newline < 0) return;
      running.child.stdout.off("data", onData);
      if (running.output.stdout.includes(token)) { reject(new Error("Service readiness leaked a credential")); return; }
      try { resolve(JSON.parse(running.output.stdout.slice(0, newline))); }
      catch { reject(new Error("Service emitted invalid readiness JSON")); }
    };
    running.child.stdout.on("data", onData);
    void running.closed.then(() => reject(new Error("Service exited before readiness")), reject);
    onData();
  });
  let info: Awaited<typeof ready>;
  try { info = await deadline(ready, "Service readiness"); }
  catch {
    // Diagnostic categories only: never copy arbitrary child output or credentials.
    const stderr = running.output.stderr;
    const categories = [
      stderr.includes("Control service failed.") ? "service-failed" : "",
      stderr.includes("Logging fault") ? "logging-fault" : "",
      stderr.includes("Logging retention fault") ? "logging-retention-fault" : "",
    ].filter(Boolean).join(",") || "none-recognized";
    throw new Error(`Service failed before readiness; events=${running.events.join(",") || "none"}; stdout-bytes=${Buffer.byteLength(running.output.stdout)}; stderr-bytes=${Buffer.byteLength(stderr)}; stderr-categories=${categories}`);
  }
  expect(info.type).toBe("ready");
  if (running.child.pid === undefined) throw new Error("Service process has no PID");
  expect(info.pid).toBe(running.child.pid);
  expect(info.pid).not.toBe(process.pid);
  expect(info.hostname).toBe("127.0.0.1");
  expect(info.requireSignedMutations).toBe(true);
  const url = new URL(info.url);
  expect(url.protocol).toBe("http:"); expect(url.hostname).toBe("127.0.0.1");
  expect(Number(url.port)).toBe(info.port); expect(info.port).toBeGreaterThan(0);
  return { running, url: url.origin };
}

async function stopService(running: Running, children: Set<Running>) {
  expect(running.child.kill("SIGTERM")).toBe(true);
  const exit = await finish(running, children);
  expect(exit.code).toBe(0); expect(exit.signal).toBeNull();
}

test("real CLI processes persist pending device and audit records across service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "envinhands-nas-e2e-"));
  const children = new Set<Running>();
  const token = randomBytes(32).toString("hex");
  const config = join(root, "service.json"), db = join(root, "catalog.sqlite"), shared = join(root, "shared");
  const configBytes = JSON.stringify({ hostname: "127.0.0.1", port: 0, dbPath: db, token, machineId: "nas-test-service", sharedRoots: { fixture: shared } });
  // No inherited ENVINHANDS, HOME, proxy, SSH or user config settings.
  const baseEnv = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), TMPDIR: root, PATH: "/usr/bin:/bin" };
  const identity = { ENVINHANDS_AGENT_ID: "nas-test-agent", ENVINHANDS_MACHINE_ID: "nas-client", ENVINHANDS_SESSION_ID: "nas-session", ENVINHANDS_AUDIT_SIGNATURE: "NAS test declaration" };
  const deviceInput = { id: "nas-device", name: "NAS test device", host: "127.0.0.1", sshUser: "fixture" };
  const explicitRegistration = { registrationId: "nas-explicit-reg", agentId: "nas-explicit-agent", sessionId: "nas-explicit-session", machineId: "nas-client", signature: "Explicit test declaration" };
  const change = { requestId: "nas-request-1", operationId: "nas-operation-1", registrationId: explicitRegistration.registrationId,
    targetMachineId: "nas-test-service", resourceId: "fixture", action: "test", summary: "Test declaration", reason: "Regression", authority: "Test", outcome: "success",
    occurredAt: "2025-01-01T00:00:00.000Z", beforeSha256: null, afterSha256: null, evidenceRef: null };
  try {
    await mkdir(shared);
    await writeFile(config, configBytes, { mode: 0o600 });
    const first = await startService(config, token, baseEnv, children);
    const clientEnv = { ...baseEnv, ...identity, ENVINHANDS_URL: first.url, ENVINHANDS_TOKEN: token };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const request = (url: string, path: string, init: RequestInit = {}) => fetch(url + path, { ...init, redirect: "error", signal: AbortSignal.timeout(deadlineMs) });
    const post = (url: string, path: string, body: unknown) => request(url, path, { method: "POST", headers, body: JSON.stringify(body) });

    expect((await request(first.url, "/v1/machines")).status).toBe(401);
    const machineBody = { ...deviceInput, os: "linux", sshPort: 22 };
    expect((await request(first.url, "/v1/machines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(machineBody) })).status).toBe(401);
    expect((await post(first.url, "/v1/machines", machineBody)).status).toBe(400);

    const registered = await device(["register"], deviceInput, clientEnv, children);
    expect(registered.code).toBe(0); expect(registered.signal).toBeNull(); expect(registered.stderr === "").toBe(true);
    expect(registered.stdout.includes(token)).toBe(false);
    const receipt = JSON.parse(registered.stdout);
    expect(receipt.provisioned).toBe(false); expect(receipt.receipt.verificationRequested).toBe(false);
    expect(receipt.receipt.verificationScope).toBeNull(); expect(receipt.receipt.machine.status).toBe("pending");
    const duplicate = await device(["register"], deviceInput, clientEnv, children);
    expect(duplicate.code).toBe(1); expect(duplicate.stderr.includes("already registered")).toBe(true);
    expect((duplicate.stdout + duplicate.stderr).includes(token)).toBe(false);
    const visible = await request(first.url, "/v1/machines", { headers });
    expect(visible.status).toBe(200); expect((await visible.json() as { machines: unknown[] }).machines).toEqual([]);
    const inventory = await device(["inventory"], undefined, clientEnv, children);
    expect(inventory.code).toBe(0); expect(inventory.stderr === "").toBe(true); expect(inventory.stdout.includes(token)).toBe(false);
    const listed = JSON.parse(inventory.stdout);
    expect(listed.untrusted).toBe(true); expect(listed.inventory.machines).toHaveLength(1);
    expect(listed.inventory.machines[0].id).toBe(deviceInput.id); expect(listed.inventory.machines[0].status).toBe("pending");

    const reg = await post(first.url, "/v1/agent-registrations", explicitRegistration);
    expect(reg.status).toBe(201); expect((await reg.json() as { duplicate: boolean }).duplicate).toBe(false);
    const entry = await post(first.url, "/v1/changes", change);
    expect(entry.status).toBe(201); expect((await entry.json() as { duplicate: boolean }).duplicate).toBe(false);
    await stopService(first.running, children);
    await expect(request(first.url, "/v1/machines", { headers })).rejects.toThrow();
    expect((first.running.output.stdout + first.running.output.stderr).includes(token)).toBe(false);
    expect((await readFile(config, "utf8")) === configBytes).toBe(true);

    const second = await startService(config, token, baseEnv, children);
    const againEnv = { ...clientEnv, ENVINHANDS_URL: second.url };
    const inventoryAgain = await device(["inventory"], undefined, againEnv, children);
    expect(inventoryAgain.code).toBe(0); expect(inventoryAgain.stderr === "").toBe(true); expect(inventoryAgain.stdout.includes(token)).toBe(false);
    const machines = JSON.parse(inventoryAgain.stdout).inventory.machines;
    expect(machines).toHaveLength(1); expect(machines[0].id).toBe(deviceInput.id); expect(machines[0].status).toBe("pending");
    const regAgain = await post(second.url, "/v1/agent-registrations", explicitRegistration);
    expect(regAgain.status).toBe(200); expect((await regAgain.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect((await post(second.url, "/v1/agent-registrations", { ...explicitRegistration, signature: "Changed declaration" })).status).toBe(409);
    const entryAgain = await post(second.url, "/v1/changes", change);
    expect(entryAgain.status).toBe(200); expect((await entryAgain.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect((await post(second.url, "/v1/changes", { ...change, summary: "Conflicting declaration" })).status).toBe(409);
    const auditResponse = await request(second.url, "/v1/changes?after=0&limit=100", { headers });
    expect(auditResponse.status).toBe(200);
    const page = await auditResponse.json() as { records: Array<Record<string, any>>; nextAfter: number | null };
    expect(page.nextAfter).toBeNull();
    const audit = page.records.filter(record => record.resourceId === "/v1/machines/nas-device");
    expect(audit).toHaveLength(4);
    expect(audit.map(record => record.outcome)).toEqual(["unknown", "success", "unknown", "failed"]);
    expect(audit[0]!.operationId).toBe(audit[1]!.operationId);
    expect(audit[2]!.operationId).toBe(audit[3]!.operationId);
    expect(audit[0]!.operationId).not.toBe(audit[2]!.operationId);
    for (const record of audit) {
      expect(record.registration.agentId).toBe(identity.ENVINHANDS_AGENT_ID);
      expect(record.registration.sessionId).toBe(identity.ENVINHANDS_SESSION_ID);
      expect(record.registration.signature).toBe(identity.ENVINHANDS_AUDIT_SIGNATURE);
    }
    expect(audit[1]!.evidenceRef).toContain(`intent:${audit[0]!.requestId};http-status:202;`);
    expect(audit[3]!.evidenceRef).toContain(`intent:${audit[2]!.requestId};http-status:409;`);
    expect(page.records.filter(record => record.requestId === change.requestId)).toHaveLength(1);
    expect(JSON.stringify(page).includes(token)).toBe(false);
    await stopService(second.running, children);
    expect((second.running.output.stdout + second.running.output.stderr).includes(token)).toBe(false);
    expect((await readFile(config, "utf8")) === configBytes).toBe(true);
  } finally {
    for (const running of children) running.child.kill("SIGKILL");
    await Promise.allSettled([...children].map(running => deadline(running.closed, "Child cleanup")));
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
