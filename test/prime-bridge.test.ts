import { test } from "node:test";
import assert from "node:assert/strict";
import { PrimeBridge, BridgeError } from "../src/prime-bridge.ts";

const token = "secret-token";
type Call = { url: string; init: RequestInit };
function fixture(response: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return response(String(url), init!);
  }) as typeof fetch;
  return { calls, bridge: new PrimeBridge({ baseUrl: "https://bus.example/", token, fetch: fetcher, timeoutMs: 50 }) };
}
const ok = () => Promise.resolve(new Response(null, { status: 204 }));
const message = { requestId: "req-1", from: "agent-a", to: "agent-b", text: "hello" };

test("heartbeat and send use exact paths, bodies, bearer auth, and no redirect", async () => {
  const { bridge, calls } = fixture(ok);
  await bridge.heartbeat({ agentId: "agent-a", machineId: "machine-1", task: "work" });
  assert.equal(await bridge.send(message), undefined);
  assert.deepEqual(calls.map(c => [c.url, c.init.method, JSON.parse(c.init.body as string)]), [
    ["https://bus.example/v1/agents/heartbeat", "POST", { agentId: "agent-a", machineId: "machine-1", task: "work" }],
    ["https://bus.example/v1/messages", "POST", message],
  ]);
  for (const c of calls) {
    assert.equal((c.init.headers as Record<string, string>).authorization, `Bearer ${token}`);
    assert.equal((c.init.headers as Record<string, string>)["content-type"], "application/json");
    assert.equal(c.init.redirect, "manual");
    assert.ok(c.init.signal);
  }
});

test("pull never sends an acknowledgement, and ack is explicit", async () => {
  const { bridge, calls } = fixture(async (url) => url.includes("?")
    ? Response.json({ messages: [message] }) : new Response(null, { status: 204 }));
  assert.deepEqual(await bridge.pull("agent-b"), [message]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bus.example/v1/messages?to=agent-b");
  assert.equal(calls[0].init.method, "GET");
  await bridge.ack("req-1");
  assert.equal(calls[1].url, "https://bus.example/v1/messages/req-1/ack");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body, undefined);
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, `Bearer ${token}`);
});

test("invalid inputs fail before any request", async () => {
  const { bridge, calls } = fixture(ok);
  for (const fn of [
    () => bridge.heartbeat({ agentId: "\u0000bad", machineId: "m" }),
    () => bridge.heartbeat({ agentId: "a", machineId: "m", task: " " }),
    () => bridge.send({ ...message, text: " " }),
    () => bridge.pull("\u0000bad"),
    () => bridge.ack(".."),
  ]) await assert.rejects(fn, BridgeError);
  assert.equal(calls.length, 0);
  for (const baseUrl of ["https://bus.example/path", "https://bus.example/?x=1", "https://user:pass@bus.example", "file:///tmp/x", "not a url"]) {
    assert.throws(() => new PrimeBridge({ baseUrl, token, fetch }), BridgeError);
  }
  assert.throws(() => new PrimeBridge({ baseUrl: "https://bus.example", token: "bad\r\ntoken", fetch }), BridgeError);
});

test("HTTP, network and malformed response failures do not claim success or leak credentials", async () => {
  for (const handler of [
    async () => new Response("secret-token", { status: 500 }),
    async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    async () => { throw new Error("secret-token"); },
  ]) {
    const { bridge, calls } = fixture(handler);
    await assert.rejects(bridge.send(message), (error: Error) => error instanceof BridgeError && !String(error).includes(token));
    assert.equal(calls.length, 1);
  }
  for (const data of [{}, { messages: [message, { ...message, to: "other" }] }, { messages: [{ ...message, requestId: ".." }] }]) {
    const { bridge, calls } = fixture(async () => Response.json(data));
    await assert.rejects(bridge.pull("agent-b"), BridgeError);
    assert.equal(calls.length, 1);
  }
});

test("timeout fails closed even when fetch ignores abort", async () => {
  const { bridge, calls } = fixture(async () => new Promise<Response>(() => {}));
  await assert.rejects(bridge.send(message), /timed out/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal?.aborted, true);
});

test("timeout covers an unresponsive response body", async () => {
  const { bridge, calls } = fixture(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }));
  await assert.rejects(bridge.pull("agent-b"), /timed out/);
  assert.equal(calls.length, 1);
});


test("IDs are correctly encoded and agent listing is observed data only", async () => {
  const { bridge, calls } = fixture(async url => url.endsWith("/v1/agents")
    ? Response.json({ agents: [{ agentId: "a/b", machineId: "m", task: null, status: "observed", lastHeartbeatAt: "2026-01-01T00:00:00.000Z" }] })
    : url.includes("?") ? Response.json({ messages: [] }) : new Response(null, { status: 204 }));
  assert.equal((await bridge.listAgents())[0].status, "observed");
  await bridge.pull("a&to=other");
  await bridge.ack("a/b?x");
  assert.equal(calls[1].url, "https://bus.example/v1/messages?to=a%26to%3Dother");
  assert.equal(calls[2].url, "https://bus.example/v1/messages/a%2Fb%3Fx/ack");
});
