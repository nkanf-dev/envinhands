import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startAgentBusServer } from "../src/server.ts";
import { CollaborationClient } from "../src/collaboration-client.ts";
import { runCollaborationCli } from "../src/collaboration-cli.ts";

test("portable collaboration client uses real HTTP messages, discovery and resource notes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-collab-")), token = randomBytes(32).toString("hex");
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  try {
    server = startAgentBusServer({ dbPath: join(dir, "fixture.sqlite"), token, hostname: "127.0.0.1", port: 0 });
    const client = new CollaborationClient({ baseUrl: server.url, token, fetch });
    await client.heartbeat({ agentId: "a", machineId: "host" });
    assert.equal((await client.listAgents())[0].status, "observed"); assert.deepEqual(await client.listMachines(), []);
    const input = { requestId: "m", from: "a", to: "b", text: "Actual collaboration" };
    await client.send(input); await client.send(input);
    assert.deepEqual(await client.pull("b"), [input]); assert.deepEqual(await client.pull("b"), [input]);
    await client.ack("m"); assert.deepEqual(await client.pull("b"), []);
    const first = await client.addNote("project", "a", "Shared fixture experience");
    const second = await client.addNote("project", "a", "Shared fixture experience");
    assert.notEqual(first.id, second.id); assert.deepEqual(await client.readNotes("project"), [first, second]);
    const output: string[] = [], errors: string[] = [];
    const io = { readInput: async () => JSON.stringify({ to: "b" }), write: (s: string) => output.push(s), error: (s: string) => errors.push(s), fetch };
    assert.equal(await runCollaborationCli(["agents"], { ENVINHANDS_URL: server.url, ENVINHANDS_TOKEN: token }, io), 0);
    assert.equal(JSON.parse(output[0]).untrusted, true); assert.deepEqual(errors, []);
    assert.equal(await runCollaborationCli(["agents"], { ENVINHANDS_URL: server.url, ENVINHANDS_TOKEN: "wrong" }, io), 1);
  } finally { await server?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
