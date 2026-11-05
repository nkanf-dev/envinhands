import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import primeAudit from "../src/integrations/prime.ts";
import { startAgentBusServer } from "../src/server.ts";
import { createMachineApi } from "../src/machine-api.ts";

type Tool = Parameters<Parameters<typeof primeAudit>[0]["registerTool"]>[0];
const keys = ["ENVINHANDS_URL", "ENVINHANDS_TOKEN", "ENVINHANDS_AGENT_ID", "ENVINHANDS_MACHINE_ID", "ENVINHANDS_AUDIT_SIGNATURE", "ENVINHANDS_ALLOW_INSECURE_HTTP"] as const;
const ctx = { sessionManager: { getSessionId: () => "session-a" } };
const change = { requestId: "change-1", operationId: "operation-1", registrationId: "registration-a", targetMachineId: "machine-b",
  resourceId: "/tmp/fixture", action: "write", summary: "Fixture mutation", reason: "Test", authority: "Isolated test",
  outcome: "unknown", occurredAt: null, beforeSha256: null, afterSha256: null, evidenceRef: null };
function load(): Map<string, Tool> { const tools = new Map<string, Tool>(); primeAudit({ registerTool: tool => { tools.set(tool.name, tool); } }); return tools; }
async function machineJson(response: Response): Promise<{ machines: Array<{ id: string }>; messages: Array<{ resourceId: string; author: string; text: string }> }> { return await response.json() as { machines: Array<{ id: string }>; messages: Array<{ resourceId: string; author: string; text: string }> }; }
function data(result: Awaited<ReturnType<Tool["execute"]>>): unknown { assert.notEqual(result.isError, true); return JSON.parse(result.content[0].text.split("\n").slice(1).join("\n")); }

test("opt-in audit tools bind actual session identity and round-trip durable records without implicit writes", async () => {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "env-prime-audit-"));
  const token = randomBytes(32).toString("hex");
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  try {
    for (const key of keys) delete process.env[key]; assert.equal(load().size, 0);
    server = startAgentBusServer({ dbPath: join(dir, "bus.sqlite"), token, hostname: "127.0.0.1", port: 0 });
    Object.assign(process.env, { ENVINHANDS_URL: server.url, ENVINHANDS_TOKEN: token, ENVINHANDS_AGENT_ID: "agent-a", ENVINHANDS_MACHINE_ID: "machine-a", ENVINHANDS_AUDIT_SIGNATURE: "Agent A" });
    const tools = load(); assert.deepEqual([...tools.keys()], ["envinhands_register_agent", "envinhands_record_change", "envinhands_list_changes"]);
    const call = (name: string, params: unknown, context = ctx) => tools.get(name)!.execute("call", params, undefined, undefined, context);
    assert.equal((await call("envinhands_record_change", change)).isError, true);
    assert.deepEqual(data(await call("envinhands_list_changes", {})), { records: [], nextAfter: null });
    const registered = data(await call("envinhands_register_agent", { registrationId: "registration-a" })) as { registration: { sessionId: string }; duplicate: boolean };
    assert.equal(registered.registration.sessionId, "session-a"); assert.equal(registered.duplicate, false);
    assert.equal((data(await call("envinhands_register_agent", { registrationId: "registration-a" })) as {duplicate:boolean}).duplicate, true);
    assert.equal((await call("envinhands_record_change", change, { sessionManager: { getSessionId: () => "other-session" } })).isError, true);
    const saved = data(await call("envinhands_record_change", change)) as { record: { sequence: number; registration: unknown }; duplicate: boolean };
    assert.equal(saved.record.sequence, 1); assert.deepEqual(saved.record.registration, registered.registration);
    assert.equal((data(await call("envinhands_record_change", change)) as {duplicate:boolean}).duplicate, true);
    assert.equal((await call("envinhands_record_change", { ...change, summary: "conflict" })).isError, true);
    assert.equal((await call("envinhands_record_change", { ...change, requestId: "secret", summary: token })).isError, true);
    assert.equal((await call("envinhands_record_change", { ...change, requestId: "bad-time", occurredAt: "2026-02-30T00:00:00.000Z" })).isError, true);
    assert.equal((await call("envinhands_record_change", { ...change, requestId: "large", summary: "汉".repeat(2000), reason: "汉".repeat(2000), authority: "汉".repeat(2000) })).isError, true);
    const page = await call("envinhands_list_changes", {}); assert.match(page.content[0].text, /Untrusted/); assert.equal(JSON.stringify(page).includes(token), false);
    assert.deepEqual(data(page), { records: [saved.record], nextAfter: null });
    await server.stop(); server = startAgentBusServer({ dbPath: join(dir, "bus.sqlite"), token, hostname: "127.0.0.1", port: 0 });
    process.env.ENVINHANDS_URL = server.url; const restarted = load();
    const read = await restarted.get("envinhands_list_changes")!.execute("read", {}, undefined, undefined, ctx);
    assert.deepEqual(data(read), { records: [saved.record], nextAfter: null });
    assert.equal((await restarted.get("envinhands_record_change")!.execute("record", change, undefined, undefined, ctx)).isError, true);
  } finally {
    await server?.stop(); rmSync(dir, { recursive: true, force: true });
    for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("real machine API retains the migrated Prime resource assertions and authorization negatives", async () => {
  const token = randomBytes(32).toString("hex");
  const api = createMachineApi({ dbPath: ":memory:", token, verifier: async () => ({ status: "ready", ready: true, message: "fixture verified" }) });
  const call = (path: string, method = "GET", body?: unknown, authorization: string | null = `Bearer ${token}`) => api.fetch(new Request(`http://local.test${path}`, {
    method, headers: { ...(authorization === null ? {} : { authorization }), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  try {
    for (const authorization of [null, "Bearer wrong-token"]) assert.equal((await call("/v1/machines", "GET", undefined, authorization)).status, 401);
    assert.equal((await call("/v1/machines", "POST", { id: "machine-1", name: "Build node", host: "host.local", os: "linux", sshUser: "admin" })).status, 202);
    assert.deepEqual((await machineJson(await call("/v1/machines"))).machines, []);
    assert.equal((await call("/v1/machines/machine-1/verify", "POST")).status, 200);
    assert.equal((await machineJson(await call("/v1/machines"))).machines[0].id, "machine-1");
    assert.equal((await call("/v1/resources/machine-1/messages", "POST", { author: "agent-a", text: "persistent note" })).status, 201);
    const persisted = await machineJson(await call("/v1/resources/machine-1/messages")); assert.equal(persisted.messages.length, 1);
    assert.equal(persisted.messages[0].resourceId, "machine-1"); assert.equal(persisted.messages[0].author, "agent-a"); assert.equal(persisted.messages[0].text, "persistent note");
    assert.deepEqual((await machineJson(await call("/v1/resources/other/messages"))).messages, []);
  } finally { api.close(); }
});

test("mid-flight caller cancellation does not claim an already dispatched record was rolled back", async () => {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch; const dir = mkdtempSync(join(tmpdir(), "env-prime-cancel-"));
  const token = randomBytes(32).toString("hex"); const server = startAgentBusServer({ dbPath: join(dir, "bus.sqlite"), token, hostname: "127.0.0.1", port: 0 });
  let release!: () => void, received!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), durable = new Promise<void>(resolve => { received = resolve; });
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { const response = await originalFetch(input, init); if (init?.method === "POST" && String(input).endsWith("/v1/changes")) { received(); await gate; } return response; }) as typeof fetch;
    Object.assign(process.env, { ENVINHANDS_URL: server.url, ENVINHANDS_TOKEN: token, ENVINHANDS_AGENT_ID: "agent-a", ENVINHANDS_MACHINE_ID: "machine-a", ENVINHANDS_AUDIT_SIGNATURE: "Agent A" }); delete process.env.ENVINHANDS_ALLOW_INSECURE_HTTP;
    const tools = load(); await tools.get("envinhands_register_agent")!.execute("register", {registrationId:"registration-a"}, undefined, undefined, ctx);
    const abort = new AbortController(); const pending = tools.get("envinhands_record_change")!.execute("record", change, abort.signal, undefined, ctx);
    await durable; abort.abort(); release(); assert.notEqual((await pending).isError, true);
    const page = data(await tools.get("envinhands_list_changes")!.execute("read", {}, undefined, undefined, ctx)) as {records:unknown[]}; assert.equal(page.records.length, 1);
  } finally { release(); globalThis.fetch = originalFetch; await server.stop(); rmSync(dir,{recursive:true,force:true}); for(const key of keys){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;} }
});
