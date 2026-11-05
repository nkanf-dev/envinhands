import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrimeBridge } from "../src/prime-bridge.ts";
import { startAgentBusServer } from "../src/server.ts";

test("loopback HTTP server supports PrimeBridge and releases resources on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-server-"));
  const dbPath = join(dir, "bus.sqlite");
  const token = randomBytes(32).toString("hex");
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  try {
    server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    const address = new URL(server.url);
    expect(server.hostname).toBe("127.0.0.1");
    expect(address.protocol).toBe("http:");
    expect(address.hostname).toBe("127.0.0.1");
    expect(Number(address.port)).toBeGreaterThan(0);
    const unauthenticated = await fetch(`${server.url}/v1/agents`);
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.body?.cancel();
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

    // Omitting task clears the previous value; observations do not assert liveness.
    await bridge.heartbeat({ agentId: "alice", machineId: "machine-a" });
    const clearedAgents = await bridge.listAgents();
    expect(clearedAgents[0]).toMatchObject({ agentId: "alice", task: null, status: "observed" });

    // The bus/PrimeBridge allow slash IDs. The separate Prime extension has a
    // narrower ID grammar; this case is not proof of extension compatibility.
    const message = { requestId: "request/1", from: "alice", to: "bob", text: "hello over HTTP" };
    const postMessage = (value: typeof message) => fetch(`${server!.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const accepted = await postMessage(message);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ status: "accepted", duplicate: false });
    const duplicate = await postMessage(message);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ status: "accepted", duplicate: true });
    const conflict = await postMessage({ ...message, text: "conflicting content" });
    expect(conflict.status).toBe(409);
    await conflict.body?.cancel();
    expect(await bridge.pull("alice")).toEqual([]);
    expect(await bridge.pull("bob")).toEqual([message]);
    expect(await bridge.pull("bob")).toEqual([message]); // Pull does not acknowledge.
    await bridge.ack(message.requestId);
    await bridge.ack(message.requestId); // Ack retries are idempotent.
    expect(await bridge.pull("bob")).toEqual([]);

    const pending = { requestId: "request-2", from: "alice", to: "bob", text: "survives restart" };
    await bridge.send(pending);
    const stoppedUrl = server.url;
    await server.stop();
    await server.stop(); // Repeated shutdown is safe.
    await expect(fetch(`${stoppedUrl}/v1/agents`, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow();

    server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    const restarted = new PrimeBridge({ baseUrl: server.url, token, fetch });
    expect(await restarted.listAgents()).toEqual(clearedAgents);
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
  const token = randomBytes(32).toString("hex");
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  try {
    expect(() => startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: occupied.port })).toThrow();
    // On Linux, inspect open descriptors to verify the failed startup closed SQLite.
    // Descriptor entries may disappear between readdir and readlink.
    if (process.platform === "linux" && existsSync("/proc/self/fd")) {
      const openPaths = readdirSync("/proc/self/fd").flatMap((fd) => {
        try { return [readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
      });
      expect(openPaths.filter((path) => path === dbPath || path.startsWith(`${dbPath}-`))).toEqual([]);
    }
    // The same database remains usable by a subsequent successful startup.
    const server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    try {
      const bridge = new PrimeBridge({ baseUrl: server.url, token, fetch });
      expect(await bridge.listAgents()).toEqual([]);
    } finally {
      await server.stop();
    }
  } finally {
    await occupied.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("machine catalog and notes share the real HTTP server and survive restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-machines-"));
  const dbPath = join(dir, "catalog.sqlite");
  const token = randomBytes(32).toString("hex");
  let server: ReturnType<typeof startAgentBusServer> | undefined;

  const call = (path: string, method = "GET", value?: unknown) => fetch(server!.url + path, {
    method, headers: {authorization: `Bearer ${token}`, ...(value ? {"content-type": "application/json"} : {})},
    ...(value ? {body: JSON.stringify(value)} : {}),
  });
  try {
    server = startAgentBusServer({dbPath, token, hostname: "127.0.0.1", port: 0});
    for (const path of ["/v1/machines", "/v1/resources/nas/messages"]) {
      for (const authorization of [undefined, "Bearer wrong-token"]) {
        const denied = await fetch(server.url + path, {
          headers: authorization === undefined ? {} : { authorization },
        });
        expect(denied.status).toBe(401);
        await denied.body?.cancel();
      }
    }
    expect((await call("/v1/machines", "POST", {id:"nas",name:"NAS",host:"127.0.0.1",os:"linux",sshUser:"agent"})).status).toBe(202);
    expect((await call("/v1/machines/nas/heartbeat", "POST")).status).toBe(200);
    const note = { author: "agent-a", text: "Test note" };
    const first = await call("/v1/resources/nas/messages", "POST", note);
    const second = await call("/v1/resources/nas/messages", "POST", note);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json() as { message: { id: string } };
    const secondBody = await second.json() as { message: { id: string } };
    // Notes have no requestId: retrying the same body creates a second note.
    expect(firstBody.message.id).not.toBe(secondBody.message.id);
    await server.stop();
    server = startAgentBusServer({dbPath, token, hostname: "127.0.0.1", port: 0});
    expect(((await (await call("/v1/machines")).json()) as {machines: unknown[]}).machines).toEqual([]);
    const machines = await (await call("/v1/machines?includePending=true")).json() as {machines: {id: string; lastHeartbeatAt: string | null}[]};
    expect(machines.machines[0].id).toBe("nas");
    expect(machines.machines[0].lastHeartbeatAt).toBeTruthy();
    const notes = await (await call("/v1/resources/nas/messages")).json() as {messages: {text: string}[]};
    expect(notes.messages).toHaveLength(2);
    expect(notes.messages.map(note => note.text)).toEqual(["Test note", "Test note"]);
  } finally { await server?.stop(); rmSync(dir, {recursive: true, force: true}); }
});
