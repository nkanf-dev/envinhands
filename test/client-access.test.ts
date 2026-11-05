import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyClientAccess, isClientAccessFresh } from "../src/client-access.ts";
const registration = { registrationId: "reg", agentId: "agent", sessionId: "session", machineId: "client", signature: "Agent" };
const options = { registration, targetMachineId: "vm", os: "linux" as const, routes: [{ id: "route", host: "localhost" }],
  access: { user: "agent", hostKeyAlias: "trusted.host" }, priority: ["route"], totalBudgetMs: 10000, ttlMs: 100 };

test("admin evidence belongs only to actual client registration, route and bounded time", async () => {
  const calls: Array<readonly string[]> = [];
  const evidence = await verifyClientAccess(options, { now: () => 1000,
    runner: async (_cmd, args) => { calls.push(args); return { exitCode: 0 }; } });
  assert.equal(calls.length, 2); assert.equal(calls[0].at(-1), "true");
  assert.deepEqual(calls[1].slice(-3), ["sudo", "-n", "true"]); assert.equal(evidence.ready, true);
  const expected = { registrationId: evidence.registrationId, agentId: evidence.agentId, sessionId: evidence.sessionId,
    targetMachineId: evidence.targetMachineId, routeId: evidence.routeId, sshIdentityRef: evidence.sshIdentityRef, hostKeyAlias: evidence.hostKeyAlias };
  assert.equal(isClientAccessFresh(evidence, expected, 1099), true);
  assert.equal(isClientAccessFresh(evidence, expected, 1100), false);
  assert.equal(isClientAccessFresh(evidence, { ...expected, sessionId: "another" }, 1000), false);
  assert.equal(isClientAccessFresh(evidence, { ...expected, routeId: "another" }, 1000), false);
});

test("SSH success with admin failure never becomes client ready, Windows reuses the effective token check", async () => {
  let calls = 0;
  const evidence = await verifyClientAccess(options, { now: () => 1000, runner: async () => ({ exitCode: ++calls === 1 ? 0 : 1 }) });
  assert.equal(evidence.ready, false); assert.equal(evidence.status, "not-ready");
  const args: Array<readonly string[]> = [];
  const windows = await verifyClientAccess({ ...options, os: "windows" }, { now: () => 1000,
    runner: async (_cmd, argv) => { args.push(argv); return { exitCode: 0 }; } });
  assert.equal(windows.ready, true);
  const script = Buffer.from(args[1].at(-1)!, "base64").toString("utf16le");
  assert.match(script, /WindowsIdentity/); assert.match(script, /IsInRole/); assert.doesNotMatch(script, /RunAs|Start-Process/);
});
