import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import attribution from "../src/integrations/prime-attribution.ts";
import { startAgentBusServer } from "../src/server.ts";
import { ChangeClient } from "../src/change-client.ts";

type Host = Parameters<typeof attribution>[0];
type Handler = (event: never, ctx: never) => Promise<unknown>;
const keys = ["ENVINHANDS_AGENT_ID", "ENVINHANDS_MACHINE_ID", "ENVINHANDS_AUDIT_SIGNATURE", "ENVINHANDS_CHANGE_SPOOL", "ENVINHANDS_URL", "ENVINHANDS_TOKEN"] as const;
function fixture(cwd = process.cwd()) {
  const handlers = new Map<string, Handler>(); const statuses: string[] = [], notices: string[] = [];
  attribution({ on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as Host);
  const ctx = { cwd, sessionManager: { getSessionId: () => "actual-fixture-session" }, ui: { setStatus: (_key: string, value: string) => { statuses.push(value); }, notify: (value: string) => { notices.push(value); } } };
  return { statuses, notices, emit: (name: string, event: unknown) => handlers.get(name)!(event as never, ctx as never) };
}
test("tool hooks persist intent before actual work, retain only input hashes and publish ordered observations", async () => {
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]])); const dir = await mkdtemp(join(tmpdir(), "env-attribution-"));
  const token = randomBytes(32).toString("hex"), secret = "private-code-or-output-not-for-audit";
  const server = startAgentBusServer({ dbPath: join(dir, "bus.sqlite"), token, hostname: "127.0.0.1", port: 0 });
  try {
    Object.assign(process.env, { ENVINHANDS_AGENT_ID: "observer", ENVINHANDS_MACHINE_ID: "host", ENVINHANDS_AUDIT_SIGNATURE: "Observer", ENVINHANDS_CHANGE_SPOOL: join(dir, "spool"), ENVINHANDS_URL: server.url, ENVINHANDS_TOKEN: token });
    const host = fixture(), path = join(dir, "owned.txt");
    const call = { type: "tool_call", toolCallId: "edit-1", toolName: "edit", input: { path, old: secret, new: "new value" } };
    assert.equal(await host.emit("tool_call", call), undefined);
    const intents = await readdir(join(dir, "spool")); assert.equal(intents.length, 1);
    const intent = JSON.parse(await readFile(join(dir, "spool", intents[0]), "utf8"));
    assert.equal(intent.registration.sessionId, "actual-fixture-session"); assert.equal(intent.change.resourceId, path); assert.equal(intent.change.outcome, "unknown");
    await writeFile(path, "new value");
    await host.emit("tool_result", { ...call, type: "tool_result", content: [{ type: "text", text: secret }], isError: false });
    const raw = (await Promise.all((await readdir(join(dir, "spool"))).map(name => readFile(join(dir, "spool", name), "utf8")))).join("");
    assert.equal(raw.includes(secret), false); assert.equal(raw.includes(token), false); assert.equal(raw.includes("new value"), false); assert.match(raw, /input-sha256:/);
    await host.emit("agent_end", {});
    const client = new ChangeClient({ baseUrl: server.url, token, fetch }); const page = await client.listChanges();
    assert.deepEqual(page.records.map(record => record.outcome), ["unknown", "success"]); assert.equal(page.records[0].action, "tool-execution-observation");
    assert.equal(await readFile(path, "utf8"), "new value"); assert.deepEqual(await readdir(join(dir, "spool")), []);
    assert.match(host.statuses.at(-1)!, /service-receipted/);
    await host.emit("tool_call", { type: "tool_call", toolCallId: "own-audit", toolName: "envinhands_record_change", input: {} });
    await host.emit("tool_call", { type: "tool_call", toolCallId: "own-exec", toolName: "envinhands_execute", input: {} });
    assert.deepEqual(await readdir(join(dir, "spool")), []);
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
});

test("failed intent blocks work, unknown custom resources stay call references, and absent service stays pending", async () => {
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]])); const dir = await mkdtemp(join(tmpdir(), "env-attribution-pending-"));
  try {
    Object.assign(process.env, { ENVINHANDS_AGENT_ID: "observer", ENVINHANDS_MACHINE_ID: "host", ENVINHANDS_AUDIT_SIGNATURE: "Observer", ENVINHANDS_CHANGE_SPOOL: join(dir, "blocked") });
    delete process.env.ENVINHANDS_URL; delete process.env.ENVINHANDS_TOKEN; await writeFile(join(dir, "blocked"), "file");
    let host = fixture(); assert.equal((await host.emit("tool_call", { type: "tool_call", toolCallId: "blocked", toolName: "bash", input: { command: "not executed" } }) as {block:boolean}).block, true);
    process.env.ENVINHANDS_CHANGE_SPOOL = join(dir, "spool"); host = fixture();
    const call = { type: "tool_call", toolCallId: "python-1", toolName: "ipython", input: { code: "private code" } };
    await host.emit("tool_call", call); await host.emit("tool_result", { ...call, type: "tool_result", content: [{ type: "text", text: "private output" }], isError: true });
    await host.emit("agent_end", {});
    const records = await Promise.all((await readdir(join(dir, "spool"))).map(async name => JSON.parse(await readFile(join(dir, "spool", name), "utf8"))));
    assert.equal(records.length, 2); assert.ok(records.every(record => record.change.resourceId.startsWith("tool-call:"))); assert.ok(records.some(record => record.change.outcome === "failed"));
    assert.match(host.statuses.at(-1)!, /pending locally/); assert.equal(JSON.stringify(records).includes("private code"), false);
  } finally { await rm(dir, { recursive: true, force: true }); for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
});

test("same-host relative edits identify their actual workdirs without storing edit content", async () => {
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]])); const dir = await mkdtemp(join(tmpdir(), "env-attribution-workdirs-"));
  try {
    Object.assign(process.env, { ENVINHANDS_AGENT_ID: "observer", ENVINHANDS_MACHINE_ID: "host", ENVINHANDS_AUDIT_SIGNATURE: "Observer", ENVINHANDS_CHANGE_SPOOL: join(dir, "spool") });
    delete process.env.ENVINHANDS_URL; delete process.env.ENVINHANDS_TOKEN;
    const expected: string[] = [], hashes: string[] = [];
    for (const name of ["workspace-a", "workspace-b"]) {
      const cwd = join(dir, name); await mkdir(cwd); const host = fixture(cwd), path = join(cwd, "config.json");
      const call = { type: "tool_call", toolCallId: name, toolName: "edit", input: { path: "config.json", oldText: "private-before", newText: "private-after" } };
      assert.equal(await host.emit("tool_call", call), undefined);
      const intents = await Promise.all((await readdir(join(dir, "spool"))).map(async file => JSON.parse(await readFile(join(dir, "spool", file), "utf8"))));
      assert.ok(intents.some(item => item.change.resourceId === path && item.change.outcome === "unknown"));
      await writeFile(path, "private-after");
      await host.emit("tool_result", { ...call, type: "tool_result", content: [{ type: "text", text: "private-output" }], isError: false });
      expected.push(path); hashes.push("input-sha256:" + createHash("sha256").update(JSON.stringify(call.input)).digest("hex"));
    }
    const records = await Promise.all((await readdir(join(dir, "spool"))).map(async file => JSON.parse(await readFile(join(dir, "spool", file), "utf8"))));
    assert.equal(records.length, 4); assert.deepEqual([...new Set(records.map(item => item.change.resourceId))].sort(), expected.sort());
    assert.ok(records.every(item => hashes.includes(item.change.evidenceRef))); assert.equal(JSON.stringify(records).includes("private-after"), false);
  } finally { await rm(dir, { recursive: true, force: true }); for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
});
