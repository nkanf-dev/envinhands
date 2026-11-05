import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeClient } from "../src/change-client.ts";
import { BridgeError } from "../src/prime-bridge.ts";

const registration = { registrationId: "reg-a", agentId: "agent-a", sessionId: "session-a", machineId: "machine-a", signature: "Agent A" };
const registered = { ...registration, registeredAt: "2026-11-05T18:00:00.000Z" };
const change = { requestId: "request-1", operationId: "operation-1", registrationId: "reg-a", targetMachineId: "machine-b",
  resourceId: "/tmp/fixture.txt", action: "write", summary: "Changed fixture", reason: "Test", authority: "Test request",
  outcome: "success" as const, occurredAt: null, beforeSha256: null, afterSha256: null, evidenceRef: null };
const saved = { ...change, sequence: 5, recordedAt: registered.registeredAt, registration: registered };

test("provenance client uses exact endpoints and returns durable receipts without implicit writes on reads", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ChangeClient({ baseUrl: "http://127.0.0.1:8787", token: "fixture-token", fetch: (async (url, init) => {
    calls.push({ url: String(url), init });
    const body = String(url).endsWith("/v1/agent-registrations") ? { registration: registered, duplicate: false }
      : init?.method === "POST" ? { record: saved, duplicate: true } : { records: [saved], nextAfter: null };
    return Response.json(body);
  }) });
  assert.deepEqual(await client.register(registration), { registration: registered, duplicate: false });
  assert.deepEqual(await client.recordChange(change), { record: saved, duplicate: true });
  assert.deepEqual(await client.listChanges(), { records: [saved], nextAfter: null });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ["/v1/agent-registrations", "/v1/changes", "/v1/changes"]);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), registration);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), change);
  assert.equal(calls[2].init?.method, "GET"); assert.equal(new URL(calls[2].url).search, "?after=0&limit=10");
  for (const call of calls) {
    assert.equal((call.init?.headers as Record<string,string>).authorization, "Bearer fixture-token");
    assert.equal(call.init?.redirect, "manual");
  }
});

test("bad echoed identity, operation, ordering or cursor is not a successful provenance receipt", async () => {
  const run = (value: unknown) => new ChangeClient({ baseUrl: "http://127.0.0.1", token: "fixture-token", fetch: (async () => Response.json(value)) });
  await assert.rejects(run({ registration: { ...registered, agentId: "other" }, duplicate: false }).register(registration), BridgeError);
  await assert.rejects(run({ record: { ...saved, summary: "other" }, duplicate: false }).recordChange(change), BridgeError);
  await assert.rejects(run({ record: { ...saved, registration: { ...registered, registrationId: "other" } }, duplicate: false }).recordChange(change), BridgeError);
  for (const body of [{ records: [saved, saved], nextAfter: null }, { records: [saved], nextAfter: 6 },
    { records: [saved], nextAfter: 5 }, { records: [{ ...saved, sequence: 0 }], nextAfter: null },
    { records: [], nextAfter: 1 }]) await assert.rejects(run(body).listChanges(0, 2), BridgeError);
  assert.deepEqual(await run({ records: [saved], nextAfter: 5 }).listChanges(0, 1), { records: [saved], nextAfter: 5 });
});

test("missing registration, conflict, timeout and oversized requests do not silently retry or invent success", async () => {
  let calls = 0;
  const client = new ChangeClient({ baseUrl: "http://127.0.0.1", token: "fixture-token", fetch: (async () => { calls++; return Response.json({}, { status: 404 }); }) });
  await assert.rejects(client.recordChange(change), (e: unknown) => e instanceof BridgeError && e.status === 404);
  assert.equal(calls, 1);
  await assert.rejects(client.recordChange({ ...change, summary: "汉".repeat(2000), reason: "汉".repeat(2000), authority: "汉".repeat(2000) }), /too large/);
  assert.equal(calls, 1);
  await assert.rejects(client.listChanges(-1)); assert.equal(calls, 1);
});


test("provenance response byte cap rejects whole oversized pages instead of truncating or advancing", async () => {
  const client = new ChangeClient({ baseUrl: "http://127.0.0.1", token: "fixture-token", fetch: async () => new Response("x".repeat(256 * 1024 + 1)) });
  await assert.rejects(client.listChanges(), BridgeError);
});
