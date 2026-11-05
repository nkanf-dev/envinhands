import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalExecution } from "../src/local-execution.ts";
import { ChangeSpool } from "../src/change-spool.ts";
const registration = { registrationId: "reg", agentId: "agent", sessionId: "session", machineId: "host", signature: "Agent" };
const change = { operationId: "local-op", registrationId: "reg", targetMachineId: "host", resourceId: "fixture.txt", action: "write-file",
  summary: "Update requested fixture", reason: "Test", authority: "Isolated fixture", beforeSha256: null, afterSha256: null, evidenceRef: null };

test("real local command writes once with pre-existing signed evidence and a separate outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-local-exec-"));
  try {
    const spool = new ChangeSpool(join(dir, "spool"));
    const script = `const fs=require('node:fs');if(fs.readdirSync('spool').filter(n=>n.endsWith('.json')).length!==1)process.exit(9);fs.writeFileSync('fixture.txt','value');console.log('actual-value');`;
    const result = await runLocalExecution({ registration, change, executable: process.execPath, args: ["-e", script], cwd: dir, timeoutMs: 10000, spool });
    assert.equal(result.started, true); assert.equal(result.exitCode, 0); assert.equal(result.outcome, "success");
    assert.equal(result.stdout.trim(), "actual-value"); assert.equal(result.outputTruncated, false);
    assert.equal(result.locallyRecorded, true); assert.equal(result.synced, false);
    assert.equal(await readFile(join(dir, "fixture.txt"), "utf8"), "value");
    assert.equal((await readdir(spool.directory)).filter(name => name.endsWith(".json")).length, 2);
    await assert.rejects(runLocalExecution({ registration, change: { ...change, targetMachineId: "another-host" }, executable: process.execPath,
      args: [], cwd: dir, timeoutMs: 100, spool }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
