import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSpool } from "../src/change-spool.ts";
import { ChangeClient } from "../src/change-client.ts";

const registration = { registrationId: "reg-a", agentId: "agent-a", sessionId: "session-a", machineId: "machine-a", signature: "Agent A" };
const change = { requestId: "request-1", operationId: "operation-1", registrationId: "reg-a", targetMachineId: "machine-b",
  resourceId: "/tmp/fixture", action: "write", summary: "Updated fixture", reason: "Test", authority: "Test request", outcome: "unknown" as const,
  occurredAt: null, beforeSha256: null, afterSha256: null, evidenceRef: null };

test("spool durably saves exact request IDs, detects conflicting local reuse and recovers after uncertain upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-spool-")), spool = new ChangeSpool(join(dir, "pending"));
  try {
    await Promise.all([spool.enqueue(registration, change), spool.enqueue(registration, change)]);
    const files = await readdir(spool.directory); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    const contents = await readFile(join(spool.directory, files[0]), "utf8");
    assert.deepEqual(JSON.parse(contents), { registration, change });
    await assert.rejects(spool.enqueue(registration, { ...change, summary: "Different" }), /conflict/);
    const failing = new ChangeClient({ baseUrl: "http://127.0.0.1", token: "secret-fixture", fetch: (async () => { throw new Error("Network unavailable"); }) });
    await assert.rejects(spool.flush(failing));
    assert.deepEqual(await readdir(spool.directory), files);
    assert.equal(contents.includes("secret-fixture"), false);
    const calls: string[] = [];
    const client = new ChangeClient({ baseUrl: "http://127.0.0.1", token: "secret-fixture", fetch: (async (url) => {
      calls.push(String(url));
      return Response.json(String(url).endsWith("agent-registrations") ?
        { registration: { ...registration, registeredAt: "2026-11-05T18:00:00.000Z" }, duplicate: true } :
        { record: { ...change, sequence: 1, recordedAt: "2026-11-05T18:00:00.000Z",
          registration: { ...registration, registeredAt: "2026-11-05T18:00:00.000Z" } }, duplicate: true });
    }) });
    assert.deepEqual(await new ChangeSpool(spool.directory).flush(client), { synced: ["request-1"], pending: 0 });
    assert.equal(calls.length, 2); assert.deepEqual(await readdir(spool.directory), []);
    assert.deepEqual(await spool.flush(client), { synced: [], pending: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("case-sensitive protocol IDs remain distinct on a case-insensitive client filesystem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-spool-case-")), spool = new ChangeSpool(dir);
  try {
    await spool.enqueue(registration, change);
    await spool.enqueue(registration, { ...change, requestId: "REQUEST-1" });
    assert.equal((await readdir(dir)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
