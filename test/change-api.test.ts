import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createChangeApi } from "../src/change-api.ts";
import { startAgentBusServer } from "../src/server.ts";
import { ChangeClient } from "../src/change-client.ts";

const registration = { registrationId: "reg-a", agentId: "agent-a", sessionId: "session-a", machineId: "machine-a", signature: "Agent A" };
const change = { requestId: "request-1", operationId: "operation-1", registrationId: "reg-a", targetMachineId: "machine-b",
  resourceId: "/tmp/fixture.txt", action: "write", summary: "Changed a fixture", reason: "Test request", authority: "Isolated test",
  outcome: "success", occurredAt: null, beforeSha256: null, afterSha256: null, evidenceRef: null };

test("immutable registration and change replay survive restart with their original signatures and timestamps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-changes-"));
  const dbPath = join(dir, "fixture.sqlite"), token = randomBytes(32).toString("hex");
  let api = createChangeApi({ dbPath, token });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const result = await api.fetch(new Request(`http://local.test${path}`, { method,
      headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: result.status, body: await result.json() as any };
  };
  try {
    assert.equal((await call("/v1/changes", "POST", change)).status, 404);
    const registered = await call("/v1/agent-registrations", "POST", registration);
    assert.equal(registered.status, 201); assert.equal(registered.body.duplicate, false);
    const replay = await call("/v1/agent-registrations", "POST", registration);
    assert.equal(replay.status, 200); assert.deepEqual(replay.body.registration, registered.body.registration);
    assert.equal((await call("/v1/agent-registrations", "POST", { ...registration, signature: "Someone else" })).status, 409);
    const first = await call("/v1/changes", "POST", change);
    assert.equal(first.status, 201); assert.equal(first.body.record.registration.signature, "Agent A");
    assert.equal(first.body.record.registration.sessionId, "session-a");
    assert.ok(Number.isSafeInteger(first.body.record.sequence));
    assert.ok(Number.isFinite(Date.parse(first.body.record.recordedAt)));
    assert.equal((await call("/v1/changes", "POST", { ...change, summary: "Different" })).status, 409);
    for (const outcome of ["failed", "partial", "unknown"]) {
      assert.equal((await call("/v1/changes", "POST", { ...change, requestId: `request-${outcome}`, outcome })).status, 201);
    }
    api.close(); api.close(); api = createChangeApi({ dbPath, token });
    const repeated = await call("/v1/changes", "POST", Object.fromEntries(Object.entries(change).reverse()));
    assert.equal(repeated.status, 200); assert.deepEqual(repeated.body.record, first.body.record);
    let after = 0;
    const records = [];
    for (let pages = 0; pages < 4; pages++) {
      const page = await call(`/v1/changes?after=${after}&limit=1`);
      assert.equal(page.status, 200); assert.equal(page.body.records.length, 1);
      records.push(...page.body.records);
      assert.ok(page.body.records[0].sequence > after);
      after = page.body.records[0].sequence;
      if (pages === 3) assert.equal(page.body.nextAfter, null);
      else assert.equal(page.body.nextAfter, after);
    }
    assert.deepEqual(records.map(r => r.outcome), ["success", "failed", "partial", "unknown"]);
    assert.deepEqual((await call(`/v1/changes?after=${after}`)).body, { records: [], nextAfter: null });
  } finally { api.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("authentication, exact fields, bounded bodies, explicit queries and closed APIs fail honestly", async () => {
  const token = randomBytes(32).toString("hex");
  const api = createChangeApi({ dbPath: ":memory:", token });
  const call = (path: string, method = "GET", body?: string, auth: string | null = `Bearer ${token}`) => api.fetch(
    new Request(`http://local.test${path}`, { method, headers: auth === null ? {} : { authorization: auth }, ...(body === undefined ? {} : { body }) }));
  try {
    for (const path of ["/v1/agent-registrations", "/v1/changes", "/unknown"])
      for (const auth of [null, "Bearer wrong"]) assert.equal((await call(path, "GET", undefined, auth)).status, 401);
    for (const path of ["/v1/changes?after=", "/v1/changes?limit=101", "/v1/changes?after=1&after=2", "/v1/changes?x=1"])
      assert.equal((await call(path)).status, 400);
    assert.equal((await call("/v1/agent-registrations")).status, 405);
    assert.equal((await call("/v1/changes", "DELETE")).status, 405);
    assert.equal((await call("/v1/changes", "POST", "{")).status, 400);
    assert.equal((await call("/v1/changes", "POST", "x".repeat(16385))).status, 413);
    assert.equal((await call("/v1/agent-registrations", "POST", JSON.stringify({ ...registration, secret: token }))).status, 400);
    assert.equal((await call("/v1/agent-registrations?x=1", "POST", JSON.stringify(registration))).status, 400);
    assert.equal((await call("/unknown")).status, 404);
    api.close(); assert.equal((await call("/v1/changes")).status, 503);
  } finally { api.close(); }
});

test("two API writers share idempotency without duplicating records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-changes-writers-"));
  const dbPath = join(dir, "fixture.sqlite"), token = randomBytes(32).toString("hex");
  const apis = [createChangeApi({ dbPath, token }), createChangeApi({ dbPath, token })];
  const call = (api: typeof apis[number], path: string, body: unknown) => api.fetch(new Request(`http://local.test${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }));
  try {
    const registrations = await Promise.all(apis.map(api => call(api, "/v1/agent-registrations", registration)));
    assert.deepEqual(registrations.map(r => r.status).sort(), [200, 201]);
    const changes = await Promise.all(apis.map(api => call(api, "/v1/changes", change)));
    assert.deepEqual(changes.map(r => r.status).sort(), [200, 201]);
  } finally { for (const api of apis) api.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real loopback listener persists provenance separately from activity and message state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-change-http-"));
  const dbPath = join(dir, "fixture.sqlite"), token = randomBytes(32).toString("hex");
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  const call = (path: string, body?: unknown) => fetch(server!.url + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    assert.equal((await call("/v1/agent-registrations", registration)).status, 201);
    const client = new ChangeClient({ baseUrl: server.url, token, fetch });
    const accepted = await client.recordChange(change as Parameters<ChangeClient["recordChange"]>[0]);
    assert.equal(accepted.duplicate, false);
    assert.equal(accepted.record.registration.sessionId, registration.sessionId);
    assert.equal((await client.listChanges()).records.length, 1);
    assert.equal((await call("/v1/agents/heartbeat", { agentId: "agent-a", machineId: "machine-a" })).status, 200);
    await server.stop(); server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    const page = await (await call("/v1/changes")).json() as any;
    assert.equal(page.records.length, 1); assert.equal(page.records[0].registration.signature, "Agent A");
    assert.equal((await call("/v1/changes", change)).status, 200);
    assert.equal((await call("/v1/machines")).status, 200);
    assert.equal((await call("/v1/agents")).status, 200);
  } finally { await server?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
