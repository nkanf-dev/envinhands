import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintSshIdentity, verifyClientAccess, isClientAccessFresh } from "../src/client-access.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
const fingerprint = async () => "SHA256:" + "A".repeat(43);
const registration = { registrationId: "reg", agentId: "agent", sessionId: "session", machineId: "client", signature: "Agent" };
const options = { registration, targetMachineId: "vm", os: "linux" as const, routes: [{ id: "route", host: "localhost" }],
  access: { user: "agent", hostKeyAlias: "trusted.host", identityFile: join(tmpdir(), "fixture-identity") }, priority: ["route"], totalBudgetMs: 10000, ttlMs: 100 };

test("admin evidence belongs only to actual client registration, route and bounded time", async () => {
  const calls: Array<readonly string[]> = [];
  const evidence = await verifyClientAccess(options, { fingerprint, now: () => 1000,
    runner: async (_cmd, args) => { calls.push(args); return { exitCode: 0 }; } });
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].slice(-2), ["echo", "envinhands-probe"]);
  assert.equal(calls[1].at(-1), `sudo -n -- /bin/sh -c 'test "$(/usr/bin/id -u)" -eq 0'`); assert.equal(evidence.ready, true);
  const expected = { registrationId: evidence.registrationId, agentId: evidence.agentId, sessionId: evidence.sessionId,
    targetMachineId: evidence.targetMachineId, routeId: evidence.routeId, sshIdentityRef: evidence.sshIdentityRef, sshUser: evidence.sshUser, hostKeyAlias: evidence.hostKeyAlias };
  assert.equal(isClientAccessFresh(evidence, expected, 1099), true);
  assert.equal(isClientAccessFresh(evidence, expected, 1100), false);
  assert.equal(isClientAccessFresh(evidence, { ...expected, sessionId: "another" }, 1000), false);
  assert.equal(isClientAccessFresh(evidence, { ...expected, routeId: "another" }, 1000), false);
});

test("SSH success with admin failure never becomes client ready, Windows reuses the effective token check", async () => {
  let calls = 0;
  const evidence = await verifyClientAccess(options, { fingerprint, now: () => 1000, runner: async () => ({ exitCode: ++calls === 1 ? 0 : 1 }) });
  assert.equal(evidence.ready, false); assert.equal(evidence.status, "not-ready");
  const args: Array<readonly string[]> = [];
  const windows = await verifyClientAccess({ ...options, os: "windows" }, { fingerprint, now: () => 1000,
    runner: async (_cmd, argv) => { args.push(argv); return { exitCode: 0 }; } });
  assert.equal(windows.ready, true);
  const script = Buffer.from(args[1].at(-1)!, "base64").toString("utf16le");
  assert.match(script, /WindowsIdentity/); assert.match(script, /IsInRole/); assert.doesNotMatch(script, /RunAs|Start-Process/);
});


test("actual selected public identity changes when a key is replaced at the same path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "access-public-key-"));
  try {
    const identity = join(dir, "identity");
    const makeKey = () => {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = pair.publicKey.export({ format: "jwk" });
      const field = (bytes: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); };
      const mpint = (value: string) => { const bytes = Buffer.from(value, "base64url"); return field(bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes); };
      const blob = Buffer.concat([field(Buffer.from("ssh-rsa")), mpint(jwk.e!), mpint(jwk.n!)]);
      return { privatePem: pair.privateKey.export({ type: "pkcs1", format: "pem" }), publicText: "ssh-rsa " + blob.toString("base64"), fingerprint: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "") };
    };
    const firstKey = makeKey(), replacement = makeKey();
    await writeFile(identity, firstKey.privatePem, { mode: 0o600 }); await writeFile(identity + ".pub", firstKey.publicText);
    const first = firstKey.fingerprint;
    const firstEvidence = await verifyClientAccess({ ...options, access: { ...options.access, identityFile: identity } }, { fingerprint: async () => first, now: () => 1000, runner: async () => ({ exitCode: 0 }) });
    await writeFile(identity, replacement.privatePem); // A stale .pub remains: derive the selected file, not that stale sibling.
    const second = await fingerprintSshIdentity(identity, 10000); assert.equal(second, replacement.fingerprint); assert.notEqual(first, second);
    assert.equal(await readFile(identity + ".pub", "utf8"), firstKey.publicText);
    const expected = { registrationId: firstEvidence.registrationId, agentId: firstEvidence.agentId, sessionId: firstEvidence.sessionId, targetMachineId: firstEvidence.targetMachineId,
      routeId: firstEvidence.routeId, sshIdentityRef: second, sshUser: firstEvidence.sshUser, hostKeyAlias: firstEvidence.hostKeyAlias };
    assert.equal(isClientAccessFresh(firstEvidence, expected, 1001), false);
    let checks = 0;
    const changedDuring = await verifyClientAccess(options, { now: () => 1000, runner: async () => ({ exitCode: 0 }), fingerprint: async () => ++checks === 1 ? first : second });
    assert.equal(changedDuring.ready, false);
    await assert.rejects(verifyClientAccess({ ...options, access: { user: "agent", hostKeyAlias: "trusted.host" } }, { fingerprint, runner: async () => ({ exitCode: 0 }) }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Characterization only: these tests expose an unresolved fail-open behavior, not a fix.
// A caller that submits only returned evidence has nothing to submit after these failures.
test("KNOWN BUG: post-ready route and fingerprint failures return no scoped negative", async () => {
  const ready = await verifyClientAccess(options, { fingerprint, now: () => 1000, runner: async () => ({ exitCode: 0 }) });
  const expected = { registrationId: ready.registrationId, agentId: ready.agentId, sessionId: ready.sessionId,
    targetMachineId: ready.targetMachineId, routeId: ready.routeId, sshIdentityRef: ready.sshIdentityRef,
    sshUser: ready.sshUser, hostKeyAlias: ready.hostKeyAlias };
  for (const exitCode of [255, 1]) { // SSH host-key/authentication and general route failure.
    await assert.rejects(verifyClientAccess(options, { fingerprint, now: () => 1001, runner: async () => ({ exitCode }) }));
    assert.equal(isClientAccessFresh(ready, expected, 1001), true); // stale positive still authorizes
  }
  let ran = false;
  await assert.rejects(verifyClientAccess(options, { now: () => 1001, fingerprint: async () => { throw new Error("unreadable"); },
    runner: async () => { ran = true; return { exitCode: 0 }; } }));
  assert.equal(ran, false); // unknown identity is not a failed SSH probe or a fingerprint
  assert.equal(isClientAccessFresh(ready, expected, 1001), true);
});

test("KNOWN BUG: failed route before successful alternate is omitted", async () => {
  const routes = [{ id: "first", host: "one.local" }, { id: "second", host: "two.local" }];
  const calls: string[] = [];
  const result = await verifyClientAccess({ ...options, routes, priority: ["first", "second"] }, {
    fingerprint, now: () => 1000, runner: async (_cmd, argv) => {
      const host = argv[argv.indexOf("--") + 1]; calls.push(host);
      return { exitCode: host === "one.local" ? 255 : 0 };
    },
  });
  assert.deepEqual(calls, ["one.local", "two.local", "two.local"]);
  assert.equal(result.routeId, "second"); assert.equal(result.ready, true);
  // No result exists for the attempted failed first route.
});

test("KNOWN BUG: all route probes failing produce no negative evidence", async () => {
  const routes = [{ id: "first", host: "one.local" }, { id: "second", host: "two.local" }];
  const calls: string[] = [];
  await assert.rejects(verifyClientAccess({ ...options, routes, priority: ["first", "second"] }, {
    fingerprint, now: () => 1000, runner: async (_cmd, argv) => {
      calls.push(argv[argv.indexOf("--") + 1]); return { exitCode: 255 };
    },
  }));
  assert.deepEqual(calls, ["one.local", "two.local"]);
});
