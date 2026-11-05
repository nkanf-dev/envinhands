import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAdminReadiness } from "../src/readiness.ts";
import type { CommandRunner, ReadinessTarget } from "../src/readiness.ts";

const target: ReadinessTarget = { host: "nas.example.org", user: "alice", os: "Linux" };

test("Linux and macOS use fixed, non-interactive SSH and sudo arguments", async () => {
  const calls: Array<{ command: string; args: readonly string[]; timeout: number }> = [];
  const runner: CommandRunner = async (command, args, timeout) => {
    calls.push({ command, args, timeout }); return { exitCode: 0 };
  };
  assert.equal((await checkAdminReadiness(target, runner)).status, "ready");
  assert.equal((await checkAdminReadiness({ ...target, os: "macOS", host: "::1", sshPort: 2222 }, runner)).ready, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].args, ["-T", "-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", "22", "-l", "alice", "--", "nas.example.org", "sudo", "-n", "true"]);
  assert.equal(calls[0].timeout, 15000);
  assert.equal(calls[1].args[calls[1].args.indexOf("-p") + 1], "2222");
  assert.equal(calls[1].args[calls[1].args.indexOf("--") + 1], "::1");
  for (const call of calls) assert.ok(!call.args.some((a) => /StrictHostKeyChecking=(no|off|accept-new)/i.test(a)));
});

test("Windows and unknown platforms are unsupported without running a process", async () => {
  let called = false;
  const runner: CommandRunner = async () => { called = true; return { exitCode: 0 }; };
  for (const os of ["Windows", "freebsd", "Darwin", ""]) {
    const result = await checkAdminReadiness({ ...target, os }, runner);
    assert.equal(result.status, "unsupported"); assert.equal(result.ready, false);
    if (os === "Windows") assert.match(result.message, /not implemented/i);
  }
  assert.equal(called, false);
});

test("untrusted target values cannot become shell or ssh options", async () => {
  let called = false;
  const runner: CommandRunner = async () => { called = true; return { exitCode: 0 }; };
  for (const patch of [
    { host: "x;touch /tmp/pwned" }, { host: "$(whoami)" }, { host: "-oProxyCommand=evil" },
    { host: "ssh://example.org" }, { host: "a b" }, { host: "a\nfoo" },
    { user: "alice;id" }, { user: "-oProxyCommand=evil" }, { user: "a@host" },
    { sshPort: 0 }, { sshPort: 65536 }, { sshPort: NaN }, { sshPort: 1.5 },
  ]) {
    const result = await checkAdminReadiness({ ...target, ...patch }, runner);
    assert.equal(result.ready, false, JSON.stringify(patch));
  }
  assert.equal(called, false);
});

test("nonzero, signal, malformed results and runner errors fail closed", async () => {
  for (const exitCode of [1, 127, 255, null]) {
    const result = await checkAdminReadiness(target, async () => ({ exitCode }));
    assert.equal(result.status, "not-ready"); assert.equal(result.ready, false);
  }
  assert.equal((await checkAdminReadiness(target, async () => { throw new Error("not found"); })).ready, false);
  assert.equal((await checkAdminReadiness(target, async () => undefined as never)).ready, false);
});
