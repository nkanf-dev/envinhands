import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRemoteExecution } from "../src/remote-execution.ts";
import { ChangeSpool } from "../src/change-spool.ts";
import { runRemoteCli } from "../src/remote-cli.ts";
const registration = { registrationId: "reg", agentId: "agent", sessionId: "session", machineId: "host", signature: "Agent" };
const change = { operationId: "op", registrationId: "reg", targetMachineId: "vm", resourceId: "/tmp/fixture", action: "exec",
  summary: "Execute approved command", reason: "Test", authority: "Test request", beforeSha256: null, afterSha256: null, evidenceRef: null };

test("unavailable SSH route produces an unknown result with durable evidence and no command replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-remote-test-"));
  try {
    const result = await runRemoteExecution({ registration, change, routes: [{ id: "missing", host: "127.0.0.1", port: 1 }],
      access: { user: "fixture", hostKeyAlias: "fixture.local" }, priority: ["missing"], probeBudgetMs: 100,
      command: "echo must-not-run", timeoutMs: 100, spool: new ChangeSpool(dir) });
    assert.equal(result.outcome, "unknown"); assert.equal(result.routeId, null);
    assert.equal(result.locallyRecorded, true); assert.equal(result.synced, false);
    assert.equal((await readdir(dir)).filter(name => name.endsWith(".json")).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("remote CLI rejects credential-bearing input and missing local evidence boundary before work", async () => {
  let reads = 0;
  const errors: string[] = [];
  const io = { readInput: async () => { reads++; return "secret-token"; }, write: () => { throw new Error(); }, error: (s: string) => errors.push(s) };
  assert.equal(await runRemoteCli([], {}, io), 1); assert.equal(reads, 0);
  assert.equal(await runRemoteCli([], { ENVINHANDS_CHANGE_SPOOL: tmpdir(), ENVINHANDS_TOKEN: "secret-token" }, io), 1);
  assert.equal(reads, 1); assert.ok(errors.every(s => !s.includes("secret-token")));
});
