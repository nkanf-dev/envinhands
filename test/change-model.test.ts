import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistration, parseChange, parseChangeQuery } from "../src/change-model.ts";

const registration = { registrationId: "reg-1", agentId: "agent-a", sessionId: "session-1", machineId: "host-a", signature: "Agent A" };
const change = { requestId: "request-1", operationId: "operation-1", registrationId: "reg-1", targetMachineId: "host-b",
  resourceId: "/tmp/work/file.txt", action: "write", summary: "Changed fixture", reason: "User task", authority: "Current user request",
  outcome: "success", occurredAt: "2026-11-05T18:00:00.000Z", beforeSha256: null, afterSha256: "a".repeat(64), evidenceRef: null };

test("registration is exact and preserves a declared signature, not an authenticated identity", () => {
  assert.deepEqual(parseRegistration(registration), registration);
  assert.equal(parseRegistration({ ...registration, signature: " Agent A " }).signature, " Agent A ");
  for (const patch of [{ signature: " " }, { signature: "x\n" }, { agentId: ".hidden" }, { registrationId: "bad/id" },
    { signature: "a".repeat(201) }, { sessionId: null }, { sessionId: "session\n" }, { token: "secret" }])
    assert.throws(() => parseRegistration({ ...registration, ...patch }));
  for (const value of [null, [], {}, { ...registration, signature: undefined }]) assert.throws(() => parseRegistration(value));
});

test("changes preserve all outcomes, honest null history and canonical field order", () => {
  assert.deepEqual(parseChange(change), change);
  for (const outcome of ["success", "failed", "partial", "unknown"])
    assert.equal(parseChange({ ...change, outcome, occurredAt: null, beforeSha256: null, afterSha256: null }).outcome, outcome);
  assert.deepEqual(parseChange(Object.fromEntries(Object.entries(change).reverse())), change);
  assert.equal(parseChange({ ...change, summary: "Before\nAfter\tvalue" }).summary, "Before\nAfter\tvalue");
  assert.equal(parseChange({ ...change, resourceId: "C:\\work\\file.txt" }).resourceId, "C:\\work\\file.txt");
});

test("timestamps, hashes, exact keys and unsafe or oversized text reject before storage", () => {
  for (const occurredAt of ["2026-02-30T12:00:00.000Z", "2026-11-05T18:00:00Z", "2026-11-05T18:00:00.000+00:00", "not-a-date", 0])
    assert.throws(() => parseChange({ ...change, occurredAt }));
  for (const patch of [{ beforeSha256: "A".repeat(64) }, { afterSha256: "a".repeat(63) }, { afterSha256: "a".repeat(64) + "\n" }, { evidenceRef: " " },
    { evidenceRef: "x\n" }, { resourceId: "x\0" }, { action: "x\t" }, { summary: "x\r" }, { outcome: "delivered" },
    { reason: "a".repeat(2001) }, { resourceId: "a".repeat(2049) }, { evidenceRef: "a".repeat(2049) },
    { requestId: "bad/id" }, { registrationId: "" }, { extra: true }]) assert.throws(() => parseChange({ ...change, ...patch }));
  const { authority, ...missing } = change;
  assert.throws(() => parseChange(missing));
});

test("pagination uses exact decimal cursors and a bounded explicit page", () => {
  assert.deepEqual(parseChangeQuery(new URLSearchParams()), { after: 0, limit: 100 });
  assert.deepEqual(parseChangeQuery(new URLSearchParams("after=5&limit=1")), { after: 5, limit: 1 });
  for (const query of ["after=", "after=-1", "after=01", "after=1.0", "after=1e3", "after=9007199254740992", "after=1&after=2",
    "limit=0", "limit=101", "limit=", "limit=2&limit=3", "typo=1"]) assert.throws(() => parseChangeQuery(new URLSearchParams(query)));
});
