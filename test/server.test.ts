import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrimeBridge } from "../src/prime-bridge.ts";
import { startAgentBusServer } from "../src/server.ts";

test("loopback HTTP server supports PrimeBridge and releases resources on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-server-"));
  const dbPath = join(dir, "bus.sqlite");
  const token = "server-test-token";
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  try {
    server = startAgentBusServer({ dbPath, token, port: 0 });
    const address = new URL(server.url);
    expect(server.hostname).toBe("0.0.0.0");
    expect(address.protocol).toBe("http:");
    expect(address.hostname).toBe("127.0.0.1");
    expect(Number(address.port)).toBeGreaterThan(0);
    const bridge = new PrimeBridge({ baseUrl: server.url, token, fetch });
    const wrongToken = new PrimeBridge({ baseUrl: server.url, token: "wrong-token", fetch });

    await expect(wrongToken.listAgents()).rejects.toMatchObject({ name: "BridgeError", status: 401 });
    await expect(wrongToken.send({ requestId: "bad", from: "alice", to: "bob", text: "no" }))
      .rejects.toMatchObject({ name: "BridgeError", status: 401 });
    await bridge.heartbeat({ agentId: "alice", machineId: "machine-a", task: "working" });
    const agents = await bridge.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agentId: "alice", machineId: "machine-a", task: "working", status: "observed" });
    expect(Number.isNaN(Date.parse(agents[0].lastHeartbeatAt))).toBe(false);

    const message = { requestId: "request/1", from: "alice", to: "bob", text: "hello over HTTP" };
    await bridge.send(message);
    expect(await bridge.pull("alice")).toEqual([]);
    expect(await bridge.pull("bob")).toEqual([message]);
    expect(await bridge.pull("bob")).toEqual([message]); // Pull does not acknowledge.
    await bridge.ack(message.requestId);
    expect(await bridge.pull("bob")).toEqual([]);

    const pending = { requestId: "request-2", from: "alice", to: "bob", text: "survives restart" };
    await bridge.send(pending);
    const stoppedUrl = server.url;
    await server.stop();
    await server.stop(); // Repeated shutdown is safe.
    await expect(fetch(`${stoppedUrl}/v1/agents`, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow();

    server = startAgentBusServer({ dbPath, token, port: 0 });
    const restarted = new PrimeBridge({ baseUrl: server.url, token, fetch });
    expect(await restarted.listAgents()).toEqual(agents);
    expect(await restarted.pull("bob")).toEqual([pending]);
    await restarted.send(message); // Acknowledged IDs stay idempotent across restart.
    expect(await restarted.pull("bob")).toEqual([pending]);
    await expect(restarted.send({ ...message, text: "conflict" })).rejects.toMatchObject({ name: "BridgeError", status: 409 });
    await restarted.ack(pending.requestId);
    expect(await restarted.pull("bob")).toEqual([]);
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("bind failure closes the opened bus database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-bind-failure-"));
  const dbPath = join(dir, "bus.sqlite");
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  try {
    expect(() => startAgentBusServer({ dbPath, token: "server-test-token", port: occupied.port })).toThrow();
    // On Linux, inspect open descriptors to verify the failed startup closed SQLite.
    // Descriptor entries may disappear between readdir and readlink.
    if (process.platform === "linux" && existsSync("/proc/self/fd")) {
      const openPaths = readdirSync("/proc/self/fd").flatMap((fd) => {
        try { return [readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
      });
      expect(openPaths.filter((path) => path === dbPath || path.startsWith(`${dbPath}-`))).toEqual([]);
    }
    // The same database remains usable by a subsequent successful startup.
    const server = startAgentBusServer({ dbPath, token: "server-test-token", port: 0 });
    try {
      const bridge = new PrimeBridge({ baseUrl: server.url, token: "server-test-token", fetch });
      expect(await bridge.listAgents()).toEqual([]);
    } finally {
      await server.stop();
    }
  } finally {
    await occupied.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
