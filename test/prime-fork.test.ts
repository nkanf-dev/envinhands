import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startAgentBusServer } from "../src/server.ts";

type Lifecycle = "session_start" | "agent_start" | "agent_end" | "session_shutdown";
type Agent = { agentId: string; machineId: string; task: string | null; status: string; lastHeartbeatAt: string };
type Extension = (pi: { on(event: Lifecycle, callback: () => void): void }) => void;

// An absent checkout is optional, but an existing broken extension must fail.
const checkout = process.env.PRIME_AGENT_CHECKOUT ?? "/home/nkanf/projs/prime-agent";
const extensionPath = resolve(checkout, "packages/coding-agent/examples/extensions/envinhands-heartbeat.ts");
const integrationTest = existsSync(extensionPath) ? test : test.skip;

async function waitForTask(url: string, token: string, task: string): Promise<Agent> {
  const deadline = Date.now() + 4000;
  let last: Agent[] = [];
  do {
    const response = await fetch(`${url}/v1/agents`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Agent discovery failed: ${response.status}`);
    last = (await response.json() as { agents: Agent[] }).agents;
    const found = last.find((agent) => agent.agentId === "prime-test-agent" && agent.task === task);
    if (found) return found;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${task}: ${JSON.stringify(last)}`);
}

integrationTest("real Prime extension reports lifecycle to a real loopback bus", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envinhands-prime-fork-"));
  const dbPath = join(dir, "bus.sqlite");
  const token = "prime-fork-test-token";
  const envKeys = ["ENVINHANDS_URL", "ENVINHANDS_TOKEN", "ENVINHANDS_AGENT_ID", "ENVINHANDS_MACHINE_ID"] as const;
  const original = envKeys.map((key) => process.env[key]);
  const hooks = new Map<Lifecycle, () => void>();
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  let started = false;
  let stopped = false;
  try {
    server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    expect(server.hostname).toBe("127.0.0.1");
    expect(Number(new URL(server.url).port)).toBeGreaterThan(0);
    process.env.ENVINHANDS_URL = server.url;
    process.env.ENVINHANDS_TOKEN = token;
    process.env.ENVINHANDS_AGENT_ID = "prime-test-agent";
    process.env.ENVINHANDS_MACHINE_ID = "test-machine";

    // Dynamic import avoids resolving the optional fork during tsc type checking.
    const extension = (await import(pathToFileURL(extensionPath).href) as { default: Extension }).default;
    extension({ on(event, callback) { hooks.set(event, callback); } });
    expect([...hooks.keys()].sort()).toEqual(["agent_end", "agent_start", "session_shutdown", "session_start"]);
    const trigger = (event: Lifecycle) => {
      const hook = hooks.get(event);
      if (!hook) throw new Error(`Missing ${event} hook`);
      hook();
    };

    const denied = await fetch(`${server.url}/v1/agents`, { headers: { authorization: "Bearer wrong-token" } });
    expect(denied.status).toBe(401);
    const initial = await fetch(`${server.url}/v1/agents`, { headers: { authorization: `Bearer ${token}` } });
    expect(await initial.json()).toEqual({ agents: [] });

    // The extension sends asynchronously, so observe each lifecycle before the next.
    started = true;
    trigger("session_start");
    const agent = await waitForTask(server.url, token, "session_start");
    expect(agent).toMatchObject({ agentId: "prime-test-agent", machineId: "test-machine", task: "session_start", status: "observed" });
    expect(Number.isNaN(Date.parse(agent.lastHeartbeatAt))).toBe(false);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query("SELECT agent_id, machine_id, task FROM agents WHERE agent_id = ?").get("prime-test-agent"))
        .toEqual({ agent_id: "prime-test-agent", machine_id: "test-machine", task: "session_start" });
    } finally { db.close(); }

    trigger("agent_start");
    await waitForTask(server.url, token, "agent_start");
    trigger("agent_end");
    await waitForTask(server.url, token, "agent_end");
    trigger("session_shutdown");
    stopped = true;
    await waitForTask(server.url, token, "session_shutdown");
  } finally {
    // The shutdown hook clears the extension's interval, even on assertion failure.
    if (started && !stopped) {
      hooks.get("session_shutdown")?.();
      if (server) await waitForTask(server.url, token, "session_shutdown").catch(() => {});
    }
    try { await server?.stop(); }
    finally {
      envKeys.forEach((key, index) => {
        const value = original[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
