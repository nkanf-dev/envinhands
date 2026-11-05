import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { runServiceCli } from "../src/service-cli.ts";
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
      task = runServiceCli([file], { write: text => { output += text; resolveReady(JSON.parse(text)); }, error: text => { errors += text; rejectReady(new Error(text)); } }, signals);
      const service = await ready;
      expect(service.pid).toBe(process.pid); expect(service.requireSignedMutations).toBe(true);
      expect(output).not.toContain(token);
      const env = { ENVINHANDS_URL: service.url, ENVINHANDS_TOKEN: token, ENVINHANDS_AGENT_ID: registration.agentId, ENVINHANDS_MACHINE_ID: registration.machineId, ENVINHANDS_SESSION_ID: registration.sessionId, ENVINHANDS_AUDIT_SIGNATURE: registration.signature };
      const inventory: string[] = [], deviceErrors: string[] = [];
      const io = { readInput: async () => JSON.stringify({ id: "formal-device", host: "127.0.0.1", sshUser: "debian" }), write: (s: string) => inventory.push(s), error: (s: string) => deviceErrors.push(s), fetch: signedFetch };
      expect((await fetch(service.url + "/v1/machines")).status).toBe(401);
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
