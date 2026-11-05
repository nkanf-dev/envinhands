import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentBus } from "../src/agent-bus.ts";

type Bus = ReturnType<typeof createAgentBus>;
const token = "team-test-token";
async function call(bus: Bus, path: string, method = "GET", body?: unknown, auth = `Bearer ${token}`) {
  const res = await bus.fetch(new Request(`http://local.test${path}`, { method, headers: { authorization: auth }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as any, headers: res.headers };
}
function withFile(run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-"));
  return run(join(dir, "bus.sqlite")).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("heartbeats upsert, discover observed status, and persist across restart", async () => withFile(async (path) => {
  let bus = createAgentBus({ dbPath: path, token });
  try {
    assert.deepEqual((await call(bus, "/v1/agents")).body, { agents: [] });
    const first = await call(bus, "/v1/agents/heartbeat", "POST", { agentId: "alpha", machineId: "host1", task: "work" });
    assert.equal(first.status, 200);
    assert.equal(first.body.agent.status, "observed");
    assert.ok(Number.isFinite(Date.parse(first.body.agent.lastHeartbeatAt)));
    await call(bus, "/v1/agents/heartbeat", "POST", { agentId: "alpha", machineId: "host2" });
    bus.close(); bus = createAgentBus({ dbPath: path, token });
    const { agents } = (await call(bus, "/v1/agents")).body;
    assert.equal(agents.length, 1);
    assert.equal(agents[0].machineId, "host2"); assert.equal(agents[0].task, null);
    assert.equal(agents[0].status, "observed"); assert.ok(Number.isFinite(Date.parse(agents[0].lastHeartbeatAt)));
  } finally { bus.close(); }
}));

test("durable acceptance is not delivery; replay until ack, idempotency survives restart and ack", async () => withFile(async (path) => {
  let bus = createAgentBus({ dbPath: path, token });
  const payload = { requestId: "r1", from: "a", to: "b", text: "hello" };
  try {
    const sent = await call(bus, "/v1/messages", "POST", payload);
    assert.equal(sent.status, 201); assert.equal(sent.body.status, "accepted");
    assert.equal(sent.body.duplicate, false); assert.equal(sent.body.message.acknowledgedAt, null);
    assert.ok(!("delivered" in sent.body));
    assert.deepEqual((await call(bus, "/v1/messages?to=a")).body.messages, []);
    assert.deepEqual((await call(bus, "/v1/messages?to=b")).body.messages, [sent.body.message]);
    assert.deepEqual((await call(bus, "/v1/messages?to=b")).body.messages, [sent.body.message]);
    const duplicate = await call(bus, "/v1/messages", "POST", payload);
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
    for (const diff of [{ from: "x" }, { to: "x" }, { text: "changed" }]) {
      assert.equal((await call(bus, "/v1/messages", "POST", { ...payload, ...diff })).status, 409);
    }
    bus.close(); bus = createAgentBus({ dbPath: path, token });
    assert.deepEqual((await call(bus, "/v1/messages?to=b")).body.messages, [sent.body.message]);
    const acked = await call(bus, "/v1/messages/r1/ack", "POST");
    assert.equal(acked.status, 200); assert.equal(acked.body.status, "acknowledged");
    assert.ok(Number.isFinite(Date.parse(acked.body.message.acknowledgedAt)));
    assert.equal((await call(bus, "/v1/messages/r1/ack", "POST")).body.message.acknowledgedAt, acked.body.message.acknowledgedAt);
    bus.close(); bus = createAgentBus({ dbPath: path, token });
    assert.deepEqual((await call(bus, "/v1/messages?to=b")).body.messages, []);
    const again = await call(bus, "/v1/messages", "POST", payload);
    assert.equal(again.status, 200); assert.equal(again.body.duplicate, true);
    assert.equal(again.body.message.acknowledgedAt, acked.body.message.acknowledgedAt);
    assert.equal((await call(bus, "/v1/messages", "POST", { ...payload, text: "new" })).status, 409);
    assert.deepEqual((await call(bus, "/v1/messages?to=b")).body.messages, []);
  } finally { bus.close(); }
}));

test("bound SQL supports quotes and treats injection as literal data", async () => withFile(async (path) => {
  const bus = createAgentBus({ dbPath: path, token });
  try {
    const id = "q' OR 1=1 --";
    const body = { requestId: "id' OR 1=1 --", from: "x'", to: id, text: "it's a test" };
    assert.equal((await call(bus, "/v1/agents/heartbeat", "POST", { agentId: id, machineId: "m'" })).status, 200);
    assert.equal((await call(bus, "/v1/messages", "POST", body)).status, 201);
    assert.equal((await call(bus, "/v1/messages?to=" + encodeURIComponent(id))).body.messages[0].text, body.text);
    assert.deepEqual((await call(bus, "/v1/messages?to=x")).body.messages, []);
    assert.equal((await call(bus, "/v1/messages/" + encodeURIComponent(body.requestId) + "/ack", "POST")).status, 200);
    assert.equal((await call(bus, "/v1/agents")).body.agents[0].agentId, id);
  } finally { bus.close(); }
}));

test("shared bearer authentication is required on every path, and empty token is rejected", async () => {
  for (const invalid of ["", "   ", "x\ny"]) assert.throws(() => createAgentBus({ dbPath: ":memory:", token: invalid }));
  const bus = createAgentBus({ dbPath: ":memory:", token });
  try {
    for (const path of ["/v1/agents", "/v1/messages?to=a", "/not-found"]) {
      for (const auth of ["", "Bearer wrong", token, "bearer " + token]) {
        const result = await call(bus, path, "GET", undefined, auth);
        assert.equal(result.status, 401); assert.ok(!JSON.stringify(result.body).includes(token));
      }
    }
    assert.equal((await call(bus, "/v1/agents/heartbeat", "POST", { agentId: "a", machineId: "m" }, "Bearer wrong")).status, 401);
    assert.deepEqual((await call(bus, "/v1/agents")).body.agents, []);
  } finally { bus.close(); }
});

test("bad input, request and field limits, methods, and ack not found", async () => {
  const bus = createAgentBus({ dbPath: ":memory:", token });
  try {
    for (const input of [null, [], {}, { agentId: "", machineId: "m" }, { agentId: "a", machineId: "m", extra: 1 }, { agentId: "x".repeat(129), machineId: "m" }, { agentId: "a", machineId: "m", task: null }, { agentId: "a\u0000", machineId: "m" }]) {
      assert.equal((await call(bus, "/v1/agents/heartbeat", "POST", input)).status, 400);
    }
    for (const input of [{}, { requestId: "x", from: "a", to: "b", text: " " }, { requestId: "x", from: "a", to: "b", text: "z".repeat(8193) }, { requestId: "x", from: "a", to: "b", text: "ok", unexpected: 1 }]) {
      assert.equal((await call(bus, "/v1/messages", "POST", input)).status, 400);
    }
    const invalid = await bus.fetch(new Request("http://local.test/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{" }));
    assert.equal(invalid.status, 400);
    const large = await bus.fetch(new Request("http://local.test/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "x".repeat(16385) }));
    assert.equal(large.status, 413);
    assert.equal((await call(bus, "/v1/messages")).status, 400);
    assert.equal((await call(bus, "/v1/messages?to=a&to=b")).status, 400);
    assert.equal((await call(bus, "/v1/messages?to=a&foo=b")).status, 400);
    assert.equal((await call(bus, "/v1/messages/no-such/ack", "POST")).status, 404);
    assert.equal((await call(bus, "/v1/messages/no-such/ack", "POST", {})).status, 400);
    assert.equal((await call(bus, "/v1/messages/%FF/ack", "POST")).status, 400);
    assert.equal((await call(bus, "/v1/agents", "POST")).status, 405);
    assert.equal((await call(bus, "/unknown")).status, 404);
  } finally { bus.close(); }
});

test("multiple handlers share a transactional idempotency record", async () => withFile(async (path) => {
  const a = createAgentBus({ dbPath: path, token }); const b = createAgentBus({ dbPath: path, token });
  try {
    const message = { requestId: "same", from: "f", to: "t", text: "x" };
    const results = await Promise.all([call(a, "/v1/messages", "POST", message), call(b, "/v1/messages", "POST", message)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
    assert.equal((await call(b, "/v1/messages?to=t")).body.messages.length, 1);
    assert.equal((await call(a, "/v1/messages", "POST", { ...message, text: "different" })).status, 409);
  } finally { a.close(); b.close(); }
}));


test("body limit is enforced for streamed data and declared lengths", async () => {
  const bus = createAgentBus({ dbPath: ":memory:", token });
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10000).fill(120));
        controller.enqueue(new Uint8Array(6385).fill(120));
        controller.close();
      },
    });
    const streamed = new Request("http://local.test/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: stream, duplex: "half" });
    assert.equal((await bus.fetch(streamed)).status, 413);
    const declared = new Request("http://local.test/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-length": "16385" }, body: "{}" });
    assert.equal((await bus.fetch(declared)).status, 413);
    const invalidUtf8 = new Request("http://local.test/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array([0xff]) });
    assert.equal((await bus.fetch(invalidUtf8)).status, 400);
  } finally { bus.close(); }
});
