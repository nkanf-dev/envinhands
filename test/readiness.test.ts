import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("unknown platforms are unsupported without running a process", async () => {
  let called = false;
  const runner: CommandRunner = async () => { called = true; return { exitCode: 0 }; };
  for (const os of ["freebsd", "Darwin", ""]) {
    const result = await checkAdminReadiness({ ...target, os }, runner);
    assert.equal(result.status, "unsupported"); assert.equal(result.ready, false);
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


test("relay ProxyCommand quotes its absolute binary path and never contains credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "readiness-"));
  const binary = join(dir, "proxy ' $(touch PWNED)");
  const keys = ["ENVINHANDS_PROXY_BINARY", "ENVINHANDS_RELAY_URL", "ENVINHANDS_RELAY_SECRET"] as const;
  const saved = keys.map(k => process.env[k]);
  try {
    await writeFile(binary, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    await chmod(binary, 0o700);
    process.env.ENVINHANDS_PROXY_BINARY = binary;
    process.env.ENVINHANDS_RELAY_URL = "wss://relay.example.org";
    process.env.ENVINHANDS_RELAY_SECRET = "unique-secret-not-for-argv";
    let args: readonly string[] = [];
    const result = await checkAdminReadiness({ ...target, relayNodeId: "node-1" }, async (_cmd, a) => { args = a; return { exitCode: 0 }; });
    assert.equal(result.ready, true);
    const option = args.find(a => a.startsWith("ProxyCommand="));
    assert.ok(option);
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("ConnectTimeout=10"));
    assert.deepEqual(args.slice(-3), ["sudo", "-n", "true"]);
    assert.ok(!args.join(" ").includes(process.env.ENVINHANDS_RELAY_SECRET));
    assert.ok(!args.join(" ").includes(process.env.ENVINHANDS_RELAY_URL));
    assert.equal(option, "ProxyCommand=exec '" + dir + "/proxy " + "'\\''" + " $(touch PWNED)' proxy node-1");
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});

test("relay configuration and node IDs fail closed before invoking SSH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "readiness-"));
  const binary = join(dir, "proxy");
  const keys = ["ENVINHANDS_PROXY_BINARY", "ENVINHANDS_RELAY_URL", "ENVINHANDS_RELAY_SECRET"] as const;
  const saved = keys.map(k => process.env[k]);
  try {
    await writeFile(binary, "#!/bin/sh\nexit 0\n"); await chmod(binary, 0o700);
    const setGood = () => { process.env.ENVINHANDS_PROXY_BINARY = binary; process.env.ENVINHANDS_RELAY_URL = "wss://relay.example.org"; process.env.ENVINHANDS_RELAY_SECRET = "secret"; };
    let called = false;
    const runner: CommandRunner = async () => { called = true; return { exitCode: 0 }; };
    for (const node of ["", "-bad;id", "node;id", "$(id)", "abc%h", "a b", "a\nb", null]) {
      setGood(); assert.equal((await checkAdminReadiness({ ...target, relayNodeId: node as string }, runner)).ready, false);
    }
    for (const patch of [
      { ENVINHANDS_PROXY_BINARY: "" }, { ENVINHANDS_PROXY_BINARY: "relative" },
      { ENVINHANDS_PROXY_BINARY: join(dir, "missing") }, { ENVINHANDS_PROXY_BINARY: join(dir, "x%h") },
      { ENVINHANDS_RELAY_URL: "" }, { ENVINHANDS_RELAY_URL: "https://example.org" },
      { ENVINHANDS_RELAY_URL: "wss://user:pass@example.org" }, { ENVINHANDS_RELAY_URL: "wss://example.org/?key=secret" },
      { ENVINHANDS_RELAY_SECRET: "" }, { ENVINHANDS_RELAY_SECRET: "x\ny" },
    ]) {
      setGood(); Object.assign(process.env, patch);
      assert.equal((await checkAdminReadiness({ ...target, relayNodeId: "node-1" }, runner)).ready, false, JSON.stringify(patch));
    }
    assert.equal(called, false);
    setGood();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      assert.equal((await checkAdminReadiness({ ...target, relayNodeId: "node-1" }, runner)).ready, false);
      assert.equal(called, false);
    } finally { Object.defineProperty(process, "platform", platform); }
    assert.equal((await checkAdminReadiness({ ...target, relayNodeId: "node-1" }, async () => ({ exitCode: 1 }))).ready, false);
    // Old records still use direct SSH without any relay configuration.
    delete process.env.ENVINHANDS_PROXY_BINARY; delete process.env.ENVINHANDS_RELAY_URL; delete process.env.ENVINHANDS_RELAY_SECRET;
    assert.equal((await checkAdminReadiness(target, runner)).ready, true);
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});
