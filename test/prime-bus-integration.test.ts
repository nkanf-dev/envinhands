import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBus } from "../src/agent-bus";
import { BridgeError, PrimeBridge } from "../src/prime-bridge";

test("PrimeBridge and persistent agent bus deliver with explicit ack and idempotent request IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prime-bus-integration-"));
  const dbPath = join(dir, "bus.sqlite");
  const token = "integration-token";
  let bus: ReturnType<typeof createAgentBus> | undefined;
  let lastStatus: number | undefined;
  try {
    bus = createAgentBus({ dbPath, token });
    // Forward the bridge's real requests to the real bus, without a socket.
    // Test double uses only fetch's call signature; it does not need Bun's preconnect helper.
    const localFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const response = await bus!.fetch(request);
      lastStatus = response.status;
      return response;
    }) as typeof fetch;
    const alice = new PrimeBridge({ baseUrl: "http://local.test", token, fetch: localFetch });
    const bob = new PrimeBridge({ baseUrl: "http://local.test", token, fetch: localFetch });

    await alice.heartbeat({ agentId: "alice", machineId: "machine-a", task: "send" });
    await bob.heartbeat({ agentId: "bob", machineId: "machine-b" });
    const agents = await alice.listAgents();
    expect(agents.map(({ agentId, machineId, task, status }) => ({ agentId, machineId, task, status }))).toEqual([
      { agentId: "alice", machineId: "machine-a", task: "send", status: "observed" },
      { agentId: "bob", machineId: "machine-b", task: null, status: "observed" },
    ]);
    for (const agent of agents) expect(Number.isNaN(Date.parse(agent.lastHeartbeatAt))).toBe(false);

    const message = { requestId: "request/1", from: "alice", to: "bob", text: "hello" };
    await alice.send(message);
    expect(lastStatus).toBe(201);
    expect(await alice.pull("alice")).toEqual([]);
    expect(await bob.pull("bob")).toEqual([message]);
    expect(await bob.pull("bob")).toEqual([message]); // Pull alone is not an ack.
    await bob.ack(message.requestId);
    expect(await bob.pull("bob")).toEqual([]);

    const pending = { requestId: "request-2", from: "alice", to: "bob", text: "still pending" };
    await alice.send(pending);
    expect(lastStatus).toBe(201);
    bus.close();
    bus = createAgentBus({ dbPath, token });

    expect(await bob.listAgents()).toEqual(agents);
    expect(await bob.pull("bob")).toEqual([pending]);
    await alice.send(message); // Retained acknowledged ID remains idempotent after restart.
    expect(lastStatus).toBe(200);
    expect(await bob.pull("bob")).toEqual([pending]);
    await alice.send(pending); // A pending ID is also not duplicated.
    expect(lastStatus).toBe(200);
    expect(await bob.pull("bob")).toEqual([pending]);
    try {
      await alice.send({ ...message, text: "different content" });
      throw new Error("expected conflicting requestId to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).status).toBe(409);
    }
    expect(lastStatus).toBe(409);
    expect(await bob.pull("bob")).toEqual([pending]);
    await bob.ack(pending.requestId);
    expect(await bob.pull("bob")).toEqual([]);
  } finally {
    bus?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
