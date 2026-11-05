import { test } from "node:test";
import assert from "node:assert/strict";
import { runChangeCli } from "../src/change-cli.ts";

const registration = { registrationId: "reg-1", agentId: "agent-1", sessionId: "session-1", machineId: "host-1", signature: "Agent One" };
test("portable change command records explicit registration and lists without implicit cursor writes", async () => {
  const output: string[] = [], errors: string[] = [], calls: string[] = [];
  const io = { readInput: async () => JSON.stringify(registration), write: (s: string) => output.push(s), error: (s: string) => errors.push(s),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      return Response.json(init?.method === "POST" ? { registration: { ...registration, registeredAt: "2026-11-05T18:00:00.000Z" }, duplicate: false } : { records: [], nextAfter: null });
    }) };
  const env = { ENVINHANDS_URL: "http://127.0.0.1:8787", ENVINHANDS_TOKEN: "fixture-token" };
  assert.equal(await runChangeCli(["register"], env, io), 0);
  assert.equal(JSON.parse(output[0]).untrusted, true);
  assert.equal(JSON.parse(output[0]).receipt.registration.signature, "Agent One");
  assert.equal(await runChangeCli(["list", "5", "1"], env, io), 0);
  assert.ok(calls[1].endsWith("?after=5&limit=1")); assert.deepEqual(errors, []);
});

test("portable command refuses secrets, unsafe endpoints and uncertain failures without printing sensitive input", async () => {
  const errors: string[] = [], output: string[] = [];
  let calls = 0;
  const env = { ENVINHANDS_URL: "http://127.0.0.1", ENVINHANDS_TOKEN: "fixture-token" };
  const io = { readInput: async () => JSON.stringify({ ...registration, signature: "fixture-token" }),
    write: (s: string) => output.push(s), error: (s: string) => errors.push(s),
    fetch: (async () => { calls++; return Response.json({}, { status: 409 }); }) };
  assert.equal(await runChangeCli(["register"], env, io), 1); assert.equal(calls, 0);
  assert.equal(await runChangeCli(["list"], { ...env, ENVINHANDS_URL: "http://remote.example" }, io), 1); assert.equal(calls, 0);
  assert.equal(await runChangeCli(["list", "01"], env, io), 1); assert.equal(calls, 0);
  assert.equal(await runChangeCli(["list"], env, io), 1); assert.equal(calls, 1);
  assert.equal(output.length, 0); assert.ok(errors.every(s => !s.includes(env.ENVINHANDS_TOKEN)));
});


test("offline enqueue needs no network credentials and reports pending rather than server success", async () => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "env-change-cli-"));
  const output: string[] = [], errors: string[] = [];
  const change = { requestId: "request-1", operationId: "op-1", registrationId: registration.registrationId,
    targetMachineId: "host-2", resourceId: "/tmp/file", action: "write", summary: "Changed fixture", reason: "Test", authority: "Test request",
    outcome: "unknown", occurredAt: null, beforeSha256: null, afterSha256: null, evidenceRef: null };
  try {
    assert.equal(await runChangeCli(["enqueue"], { ENVINHANDS_CHANGE_SPOOL: directory }, {
      readInput: async () => JSON.stringify({ registration, change }), write: s => output.push(s), error: s => errors.push(s),
      fetch: async () => { throw new Error("Network must not be called"); },
    }), 0);
    assert.deepEqual(JSON.parse(output[0]), { storedLocally: true, synced: false, requestId: "request-1" });
    assert.equal((await readdir(directory)).length, 1); assert.deepEqual(errors, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
