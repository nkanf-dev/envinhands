import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSpool } from "../src/change-spool.ts";
import { runAuditedOperation } from "../src/audited-operation.ts";
const registration = { registrationId: "reg-a", agentId: "a", sessionId: "session", machineId: "host", signature: "Agent A" };
const metadata = { operationId: "operation", registrationId: "reg-a", targetMachineId: "host", resourceId: "fixture", action: "write",
  summary: "Update fixture", reason: "Test", authority: "Test request", beforeSha256: null, afterSha256: null, evidenceRef: null };

test("durable intent exists before mutation and completion appends a distinct signed event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-audited-"));
  const spool = new ChangeSpool(join(dir, "spool"));
  let calls = 0;
  try {
    const result = await runAuditedOperation(registration, metadata, spool, async () => {
      calls++;
      const names = await readdir(spool.directory); assert.equal(names.length, 1);
      const initial = JSON.parse(await readFile(join(spool.directory, names[0]), "utf8"));
      assert.equal(initial.change.outcome, "unknown"); assert.equal(initial.registration.signature, "Agent A");
      await writeFile(join(dir, "fixture"), "new value");
      return { outcome: "success" };
    });
    assert.equal(calls, 1); assert.equal(result.outcome, "success"); assert.equal(result.synced, false);
    assert.equal(result.locallyRecorded, true); assert.notEqual(result.completedRequestId, result.startedRequestId);
    assert.equal((await readdir(spool.directory)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("no durable intent means no mutation; callback errors leave honest unknown effects without retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-audited-fail-"));
  let calls = 0;
  try {
    const blocked = join(dir, "not-directory"); await writeFile(blocked, "file");
    await assert.rejects(runAuditedOperation(registration, metadata, new ChangeSpool(blocked), async () => { calls++; return { outcome: "success" }; }));
    assert.equal(calls, 0);
    const result = await runAuditedOperation(registration, metadata, new ChangeSpool(join(dir, "spool")), async () => {
      calls++; throw new Error("Unknown remote effect");
    });
    assert.equal(calls, 1); assert.equal(result.outcome, "unknown"); assert.equal(result.locallyRecorded, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
