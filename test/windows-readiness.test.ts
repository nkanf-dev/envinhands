import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAdminReadiness } from "../src/readiness.ts";
import { checkWindowsAdminReadiness } from "../src/windows-readiness.ts";
import type { CommandRunner, ReadinessTarget } from "../src/readiness.ts";

const target: ReadinessTarget = { host: "host.example.org", user: "alice", os: "Windows" };

test("success checks a fixed effective token command over non-interactive SSH", async () => {
  const calls: Array<{ command: string; args: readonly string[]; timeout: number }> = [];
  const runner: CommandRunner = async (command, args, timeout) => {
    calls.push({ command, args, timeout }); return { exitCode: 0 };
  };
  const result = await checkWindowsAdminReadiness(target, runner);
  assert.equal(result.status, "ready");
  assert.match(result.message, /time of this check/);
  assert.match(result.message, /other Agent or session/);
  const { command, args, timeout } = calls[0];
  assert.equal(command, "ssh"); assert.equal(timeout, 15_000);
  assert.deepEqual(args.slice(0, -1), ["-T", "-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", "22", "-l", "alice", "--", "host.example.org", "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
  assert.match(script, /WindowsIdentity\]::GetCurrent\(\)/);
  assert.match(script, /WindowsPrincipal/);
  assert.match(script, /IsInRole\(\[System.Security.Principal.WindowsBuiltInRole\]::Administrator\)/);
  assert.match(script, /exit 0/); assert.match(script, /exit 1/);
  assert.doesNotMatch(script, /Start-Process|RunAs|Get-LocalGroupMember/i);
  await checkWindowsAdminReadiness({ ...target, host: "::1", user: "bob", sshPort: 2222, os: "windows" }, runner);
  assert.equal(calls[1].args.at(-1), args.at(-1));
  assert.equal(calls[1].args[calls[1].args.indexOf("-p") + 1], "2222");
});

test("non-admin, timeout, SSH errors, and malformed results fail closed", async () => {
  for (const exitCode of [1, 127, 255, null]) {
    const result = await checkWindowsAdminReadiness(target, async () => ({ exitCode }));
    assert.equal(result.status, "not-ready"); assert.equal(result.ready, false);
  }
  assert.equal((await checkWindowsAdminReadiness(target, async () => { throw Error("spawn failure"); })).ready, false);
  assert.equal((await checkWindowsAdminReadiness(target, async () => undefined as never)).ready, false);
});

test("rejects untrusted SSH arguments before calling runner", async () => {
  let called = false;
  const runner: CommandRunner = async () => { called = true; return { exitCode: 0 }; };
  for (const patch of [
    { host: "x;touch /tmp/pwned" }, { host: "$(whoami)" }, { host: "-oProxyCommand=evil" },
    { host: "ssh://example.org" }, { host: "a b" }, { host: "a\nfoo" }, { host: "a..b" },
    { user: "alice;id" }, { user: "-oProxyCommand=evil" }, { user: "a@host" }, { user: "alice\n" },
    { sshPort: 0 }, { sshPort: 65536 }, { sshPort: NaN }, { sshPort: 1.5 },
  ]) {
    assert.equal((await checkWindowsAdminReadiness({ ...target, ...patch }, runner)).ready, false, JSON.stringify(patch));
  }
  assert.equal(called, false);
});

test("unsupported OS, invalid types and invalid runner do not report readiness", async () => {
  let called = false;
  const runner: CommandRunner = async () => { called = true; return { exitCode: 0 }; };
  assert.equal((await checkWindowsAdminReadiness({ ...target, os: "Linux" }, runner)).status, "unsupported");
  assert.equal((await checkWindowsAdminReadiness(null as never, runner)).ready, false);
  assert.equal((await checkWindowsAdminReadiness({ ...target, os: null } as never, runner)).ready, false);
  assert.equal((await checkWindowsAdminReadiness({ ...target, host: null } as never, runner)).ready, false);
  assert.equal((await checkWindowsAdminReadiness(target, null as never)).ready, false);
  assert.equal(called, false);
});


test("the main readiness gate delegates Windows checks and preserves failure results", async () => {
  for (const exitCode of [0, 1, 255, null]) {
    const calls: Array<{ command: string; args: readonly string[]; timeout: number }> = [];
    const runner: CommandRunner = async (command, args, timeout) => {
      calls.push({ command, args, timeout }); return { exitCode };
    };
    const expected = await checkWindowsAdminReadiness(target, runner);
    const actual = await checkAdminReadiness({ ...target, os: "wInDoWs" }, runner);
    assert.deepEqual(actual, expected);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(actual.ready, exitCode === 0);
  }
  assert.equal((await checkAdminReadiness(target, async () => { throw Error("ssh failed"); })).ready, false);
  assert.equal((await checkAdminReadiness({ ...target, host: "-bad" }, async () => { throw Error("must not run"); })).ready, false);
});

test("Windows relay uses the shared POSIX proxy and the same fixed token check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "windows-readiness-"));
  const binary = join(dir, "proxy ' $(touch PWNED)");
  const keys = ["ENVINHANDS_PROXY_BINARY", "ENVINHANDS_RELAY_URL", "ENVINHANDS_RELAY_SECRET"] as const;
  const saved = keys.map(k => process.env[k]);
  try {
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o700);
    process.env.ENVINHANDS_PROXY_BINARY = binary;
    process.env.ENVINHANDS_RELAY_URL = "wss://relay.example.org";
    process.env.ENVINHANDS_RELAY_SECRET = "unique-secret-not-for-argv";
    const calls: Array<{ command: string; args: readonly string[]; timeout: number }> = [];
    const runner: CommandRunner = async (command, args, timeout) => { calls.push({ command, args, timeout }); return { exitCode: 0 }; };
    assert.equal((await checkAdminReadiness(target, runner)).ready, true);
    const mainRelay = await checkAdminReadiness({ ...target, relayNodeId: "node-1" }, runner);
    const windowsRelay = await checkWindowsAdminReadiness({ ...target, relayNodeId: "node-1" }, runner);
    if (process.platform === "win32") {
      // Direct SSH is supported; only the POSIX relay path must be refused.
      assert.equal(mainRelay.status, "not-ready");
      assert.equal(mainRelay.ready, false);
      assert.equal(windowsRelay.status, "not-ready");
      assert.equal(windowsRelay.ready, false);
      assert.equal(calls.length, 1);
      return;
    }
    assert.equal(mainRelay.ready, true);
    assert.equal(windowsRelay.ready, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], calls[1]);
    assert.equal(calls[1].command, "ssh");
    assert.equal(calls[1].timeout, 15_000);
    const args = [...calls[1].args];
    const proxyIndex = args.findIndex(a => a.startsWith("ProxyCommand="));
    assert.ok(proxyIndex > 0);
    assert.equal(args[proxyIndex - 1], "-o");
    assert.equal(args[proxyIndex], "ProxyCommand='" + dir + "/proxy " + "'\\''" + " $(touch PWNED)' proxy node-1");
    assert.ok(!args.join(" ").includes(process.env.ENVINHANDS_RELAY_SECRET));
    assert.ok(!args.join(" ").includes(process.env.ENVINHANDS_RELAY_URL));
    args.splice(proxyIndex - 1, 2);
    assert.deepEqual(args, calls[0].args);
    assert.equal((await checkAdminReadiness({ ...target, relayNodeId: "node-1" }, async () => ({ exitCode: 1 }))).ready, false);
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows relay fails closed before SSH for bad configuration, node IDs and local win32", async () => {
  const dir = await mkdtemp(join(tmpdir(), "windows-readiness-"));
  const binary = join(dir, "proxy");
  const keys = ["ENVINHANDS_PROXY_BINARY", "ENVINHANDS_RELAY_URL", "ENVINHANDS_RELAY_SECRET"] as const;
  const saved = keys.map(k => process.env[k]);
  try {
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o700);
    const setGood = () => { process.env.ENVINHANDS_PROXY_BINARY = binary; process.env.ENVINHANDS_RELAY_URL = "wss://relay.example.org"; process.env.ENVINHANDS_RELAY_SECRET = "secret"; };
    let calls = 0;
    const runner: CommandRunner = async () => { calls++; return { exitCode: 0 }; };
    for (const node of ["", "node;id", "$(id)", "abc%h", "a b", "a\nb", null]) {
      setGood();
      for (const check of [checkAdminReadiness, checkWindowsAdminReadiness]) {
        const result = await check({ ...target, relayNodeId: node as string }, runner);
        assert.equal(result.status, "not-ready", String(node));
      }
    }
    for (const patch of [
      { ENVINHANDS_PROXY_BINARY: "" }, { ENVINHANDS_PROXY_BINARY: "relative" },
      { ENVINHANDS_PROXY_BINARY: join(dir, "missing") }, { ENVINHANDS_PROXY_BINARY: join(dir, "x%h") },
      { ENVINHANDS_RELAY_URL: "" }, { ENVINHANDS_RELAY_URL: "https://example.org" },
      { ENVINHANDS_RELAY_URL: "wss://user:pass@example.org" }, { ENVINHANDS_RELAY_URL: "wss://example.org/?key=secret" },
      { ENVINHANDS_RELAY_SECRET: "" }, { ENVINHANDS_RELAY_SECRET: "x\ny" },
    ]) {
      setGood(); Object.assign(process.env, patch);
      for (const check of [checkAdminReadiness, checkWindowsAdminReadiness]) {
        const result = await check({ ...target, relayNodeId: "node-1" }, runner);
        assert.equal(result.status, "not-ready", JSON.stringify(patch));
      }
    }
    assert.equal(calls, 0);
    setGood();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      for (const check of [checkAdminReadiness, checkWindowsAdminReadiness]) {
        assert.equal((await check({ ...target, relayNodeId: "node-1" }, runner)).status, "not-ready");
      }
      assert.equal(calls, 0);
      assert.equal((await checkAdminReadiness(target, runner)).ready, true);
      assert.equal(calls, 1);
    } finally { Object.defineProperty(process, "platform", platform); }
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});
