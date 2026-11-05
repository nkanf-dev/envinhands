import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSshRouteArgv, selectSshRoute, SshRoutesUnavailable } from "../src/transports/ssh-routes.ts";
const access = { user: "agent", hostKeyAlias: "trusted-host" };

test("real probe orchestration tries preferred route then falls back, keeping the same host trust identity", async () => {
  const calls: Array<readonly string[]> = [];
  const result = await selectSshRoute([{ id: "backup", host: "10.0.0.2" }, { id: "primary", host: "10.0.0.1" }], access,
    { priority: ["primary", "backup"], totalBudgetMs: 20000 }, { now: () => 0,
      runner: async (_command, args) => { calls.push(args); return { exitCode: calls.length === 1 ? 255 : 0 }; } });
  assert.equal(result.route.id, "backup"); assert.deepEqual(result.observations.map(o => o.status), ["failed", "healthy"]);
  for (const args of calls) {
    assert.ok(args.includes("StrictHostKeyChecking=yes")); assert.ok(args.includes("HostKeyAlias=trusted-host"));
    assert.equal(args.at(-1), "true"); assert.ok(args.includes("BatchMode=yes"));
  }
  assert.equal(result.argv.includes("true"), false); // No remote task was run by route selection.
});

test("total budget stops probing and a caller never receives an unverified route", async () => {
  let time = 0, calls = 0;
  await assert.rejects(selectSshRoute([{ id: "one", host: "10.0.0.1" }, { id: "two", host: "10.0.0.2" }], access,
    { priority: [], totalBudgetMs: 10 }, { now: () => time,
      runner: async (_cmd, _args, timeout) => { assert.equal(timeout, 10); calls++; time = 10; return { exitCode: 255 }; } }), SshRoutesUnavailable);
  assert.equal(calls, 1);
});

test("unsafe host, route IDs, alias and credential paths fail before any SSH process", async () => {
  for (const host of ["-bad", "host;id", "x\n", "a b", "ssh://host"])
    assert.throws(() => buildSshRouteArgv({ id: "r", host }, access));
  assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost" }, { ...access, hostKeyAlias: "-oUnsafe" }));
  assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost" }, { ...access, identityFile: "relative" }));
  let called = false;
  await assert.rejects(selectSshRoute([{ id: "r", host: "localhost" }, { id: "r", host: "localhost" }], access,
    { priority: [], totalBudgetMs: 100 }, { runner: async () => { called = true; return { exitCode: 0 }; } }));
  assert.equal(called, false);
});
