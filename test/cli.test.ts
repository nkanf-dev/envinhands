import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli, type CliDependencies } from "../src/cli.ts";
import { startAgentBusServer } from "../src/server.ts";
import { createRelayServer } from "../src/relay.ts";

function context() {
  const signals = new EventEmitter();
  let output = "";
  return { signals, stderr: { write(s: string) { output += s; } }, output: () => output };
}

describe("CLI validation and isolation", () => {
  test("rejects extra arguments and malformed configuration without revealing them", async () => {
    const c = context();
    const leak = "secret-do-not-print";
    expect(await runCli(["server", leak], { ENVINHANDS_TOKEN: leak }, c)).toBe(1);
    expect(await runCli(["server"], { ENVINHANDS_TOKEN: leak, ENVINHANDS_PORT: "87oops" }, c)).toBe(1);
    expect(await runCli(["node", "../bad"], { ENVINHANDS_RELAY_SECRET: leak }, c)).toBe(1);
    expect(await runCli(["proxy", "n"], { ENVINHANDS_RELAY_URL: `ws://user:${leak}@localhost/`, ENVINHANDS_RELAY_SECRET: leak }, c)).toBe(1);
    expect(c.output()).not.toContain(leak);
  });
  test("requires secrets and checks port range", async () => {
    const c = context();
    expect(await runCli(["server"], {}, c)).toBe(1);
    expect(await runCli(["relay"], {}, c)).toBe(1);
    expect(await runCli(["node", "n"], { ENVINHANDS_RELAY_URL: "wss://example.org", ENVINHANDS_RELAY_SECRET: "s", ENVINHANDS_SSH_PORT: "0" }, c)).toBe(1);
    expect(await runCli(["relay"], { ENVINHANDS_RELAY_SECRET: "s", ENVINHANDS_RELAY_PORT: "65536" }, c)).toBe(1);
  });
  test("help explains TLS, stdout and no automatic key setup", async () => {
    const c = context();
    expect(await runCli(["--help"], {}, c)).toBe(0);
    expect(c.output()).toContain("wss://");
    expect(c.output()).toContain("stdout carries SSH bytes only");
    expect(c.output()).toContain("does not configure SSH keys");
  });
  test("proxy passes environment settings and hides errors, never writes stdout", async () => {
    const c = context();
    let captured: unknown;
    const startProxy: CliDependencies["startProxy"] = async (opts) => { captured = opts; throw new Error("secret-do-not-print"); };
    const result = await runCli(["proxy", "node-1"], { ENVINHANDS_RELAY_URL: "wss://relay.example", ENVINHANDS_RELAY_SECRET: "secret-do-not-print" }, { ...c, startProxy });
    expect(result).toBe(1);
    expect(captured).toEqual({ relayUrl: "wss://relay.example", nodeId: "node-1", secret: "secret-do-not-print" });
    expect(c.output()).toContain("Command failed");
    expect(c.output()).not.toContain("secret-do-not-print");
  });
  test("node starts reconnecting runtime with defaults and cleans up on signal", async () => {
    const c = context();
    let resolve!: () => void;
    const finished = new Promise<void>(r => { resolve = r; });
    let captured: unknown, closes = 0;
    const startNode: CliDependencies["startNode"] = (opts) => {
      captured = opts;
      return { ready: Promise.resolve(), finished, close() { closes++; resolve(); } };
    };
    const result = runCli(["node", "n"], { ENVINHANDS_RELAY_URL: "ws://localhost:8788", ENVINHANDS_RELAY_SECRET: "s" }, { ...c, startNode });
    c.signals.emit("SIGTERM"); c.signals.emit("SIGINT");
    expect(await result).toBe(0);
    expect(captured).toEqual({ relayUrl: "ws://localhost:8788", nodeId: "n", secret: "s", sshPort: 22 });
    expect(closes).toBe(1);
    expect(c.signals.listenerCount("SIGTERM")).toBe(0);
    expect(c.output()).toContain("wss://");
  });
});

test("real loopback bus CLI starts, authenticates, and releases its port on SIGTERM", async () => {
  const c = context();
  const dir = mkdtempSync(join(tmpdir(), "env-cli-"));
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  const startServer: CliDependencies["startServer"] = options => { server = startAgentBusServer(options); return server; };
  const task = runCli(["server"], { ENVINHANDS_TOKEN: "test-token", ENVINHANDS_HOST: "127.0.0.1", ENVINHANDS_PORT: "0", ENVINHANDS_DB: join(dir, "db.sqlite") }, { ...c, startServer });
  try {
    expect(server).toBeDefined();
    const url = server!.url;
    expect((await fetch(url + "/v1/agents")).status).toBe(401);
    expect((await fetch(url + "/v1/agents", { headers: { authorization: "Bearer test-token" } })).status).toBe(200);
    c.signals.emit("SIGTERM");
    expect(await task).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
    expect(c.output()).not.toContain("test-token");
  } finally { c.signals.emit("SIGTERM"); await task; rmSync(dir, { recursive: true, force: true }); }
});

test("real loopback relay CLI requires its bearer secret and stops on SIGINT", async () => {
  const c = context();
  let server: ReturnType<typeof createRelayServer> | undefined;
  const startRelay: CliDependencies["startRelay"] = options => { server = createRelayServer(options); return server; };
  const task = runCli(["relay"], { ENVINHANDS_RELAY_SECRET: "relay-test-token", ENVINHANDS_RELAY_HOST: "127.0.0.1", ENVINHANDS_RELAY_PORT: "0" }, { ...c, startRelay });
  try {
    expect(server).toBeDefined();
    const url = `http://127.0.0.1:${server!.port}/node?id=n`;
    expect((await fetch(url)).status).toBe(401);
    c.signals.emit("SIGINT");
    expect(await task).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
    expect(c.output()).not.toContain("relay-test-token");
  } finally { c.signals.emit("SIGINT"); await task; }
});


test("proxy executable sends errors to stderr and leaves stdout empty", async () => {
  const secret = "secret-process-test";
  const child = Bun.spawn([process.execPath, "src/cli.ts", "proxy", "n"], {
    cwd: process.cwd(),
    env: { ...process.env, ENVINHANDS_RELAY_URL: "ws://127.0.0.1:1", ENVINHANDS_RELAY_SECRET: secret },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("Command failed");
  expect(stderr).not.toContain(secret);
});

test("unexpected runtime failure closes the runtime without leaking errors", async () => {
  const c = context();
  let closes = 0;
  const startNode: CliDependencies["startNode"] = () => ({
    ready: Promise.resolve(), finished: Promise.reject(new Error("sensitive failure")), close() { closes++; },
  });
  expect(await runCli(["node", "n"], { ENVINHANDS_RELAY_URL: "wss://relay.example", ENVINHANDS_RELAY_SECRET: "s" }, { ...c, startNode })).toBe(1);
  expect(closes).toBe(1);
  expect(c.output()).not.toContain("sensitive failure");
  expect(c.signals.listenerCount("SIGTERM")).toBe(0);
});


describe("register CLI", () => {
  const args = ["register", "--id", "node-1", "--name", "Node One", "--host", "host.example", "--os", "linux", "--ssh-user", "admin", "--ssh-port", "2222"];
  const env = { ENVINHANDS_URL: "https://example.org", ENVINHANDS_TOKEN: "secret-register-token", ENVINHANDS_AGENT_ID: "cli-test", ENVINHANDS_MACHINE_ID: "client", ENVINHANDS_SESSION_ID: "cli-session", ENVINHANDS_AUDIT_SIGNATURE: "CLI test" };
  function ctx() { let stdout = ""; const c = context(); return { ...c, stdout: { write(s: string) { stdout += s; } }, out: () => stdout }; }
  function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
  test("creates pending then verifies and reports ready only", async () => {
    const c = ctx(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake: CliDependencies["fetch"] = async (url, init) => { calls.push({ url: String(url), init }); return calls.length === 1 ? json({ machine: { status: "pending" } }, 202) : json({ machine: { status: "ready" }, verificationScope: "server" }); };
    expect(await runCli(args, env, { ...c, fetch: fake })).toBe(0);
    expect(c.out()).toContain("successful");
    expect(calls.map(x => x.url)).toEqual(["https://example.org/v1/machines", "https://example.org/v1/machines/node-1/verify"]);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ id: "node-1", name: "Node One", host: "host.example", os: "linux", sshUser: "admin", sshPort: 2222 });
    expect(calls[0]!.init!.redirect).toBe("error");
    expect(calls[1]!.init!.body).toBeUndefined();
    expect(c.out() + c.output()).not.toContain(env.ENVINHANDS_TOKEN);
  });
  test("passes a validated relay node to the registration API", async () => {
    const c = ctx(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake: CliDependencies["fetch"] = async (url, init) => { calls.push({ url: String(url), init }); return calls.length === 1 ? json({ machine: { status: "pending" } }, 202) : json({ machine: { status: "ready" } }); };
    expect(await runCli([...args, "--relay-node", "node-1"], env, { ...c, fetch: fake })).toBe(0);
    expect(JSON.parse(String(calls[0]!.init!.body)).relayNodeId).toBe("node-1");
    expect(await runCli([...args, "--relay-node", "../unsafe"], env, { ...c, fetch: fake })).toBe(1);
    expect(calls.length).toBe(2);
  });
  test("pending and unsupported verification fail without deleting record", async () => {
    const c = ctx(); const calls: string[] = [];
    const fake: CliDependencies["fetch"] = async (url) => { calls.push(String(url)); return calls.length === 1 ? json({ machine: { status: "pending" } }, 202) : json({ machine: { status: "pending" }, verificationScope: "server" }); };
    expect(await runCli(args, env, { ...c, fetch: fake })).toBe(1);
    expect(c.output()).toContain("not-ready"); expect(c.out()).not.toContain("successful"); expect(calls.length).toBe(2);
  });
  test("conflict never verifies or alters existing record", async () => {
    const c = ctx(); let calls = 0;
    const fake: CliDependencies["fetch"] = async () => { calls++; return json({ error: "conflict" }, 409); };
    expect(await runCli(args, env, { ...c, fetch: fake })).toBe(1);
    expect(calls).toBe(1); expect(c.output()).toContain("already exists");
  });
  test("rejects unsafe and injected URLs before fetching, allows explicit insecure override with warning", async () => {
    let calls = 0; const fake: CliDependencies["fetch"] = async () => { calls++; return json({}, 500); };
    for (const url of ["http://192.168.1.1", "https://user:secret-register-token@example.org", "https://example.org/path", "https://example.org/?q=x", "https://example.org/#x", "https://example.org\\@evil.com"]) {
      const c = ctx(); expect(await runCli(args, { ...env, ENVINHANDS_URL: url }, { ...c, fetch: fake })).toBe(1);
      expect(c.output()).not.toContain(env.ENVINHANDS_TOKEN);
    }
    expect(calls).toBe(0);
    const c = ctx(); await runCli(args, { ...env, ENVINHANDS_URL: "http://192.168.1.1", ENVINHANDS_ALLOW_INSECURE_HTTP: "1" }, { ...c, fetch: fake });
    expect(c.output()).toContain("Warning: insecure HTTP"); expect(calls).toBe(1);
  });
  test("rejects option/path injection, duplicates and invalid ports without leaking arguments", async () => {
    const c = ctx(); let calls = 0; const fake: CliDependencies["fetch"] = async () => { calls++; return json({}, 202); };
    for (const bad of [[...args, "--id", "other"], args.map(x => x === "node-1" ? "../evil?x=1" : x), args.map(x => x === "2222" ? "22;evil" : x), [...args, "--token", env.ENVINHANDS_TOKEN]])
      expect(await runCli(bad, env, { ...c, fetch: fake })).toBe(1);
    expect(calls).toBe(0); expect(c.output()).not.toContain(env.ENVINHANDS_TOKEN);
  });
  test("timeouts and thrown errors are redacted, even if fetch ignores abort", async () => {
    const c = ctx(); let signal: AbortSignal | undefined;
    const fake: CliDependencies["fetch"] = async (_url, init) => { signal = init?.signal ?? undefined; return await new Promise<Response>(() => {}); };
    expect(await runCli(args, env, { ...c, fetch: fake, requestTimeoutMs: 10 })).toBe(1);
    expect(signal?.aborted).toBe(true); expect(c.output()).toContain("not-ready");
    const fail: CliDependencies["fetch"] = async () => { throw new Error(env.ENVINHANDS_TOKEN); };
    expect(await runCli(args, env, { ...c, fetch: fail })).toBe(1); expect(c.output()).not.toContain(env.ENVINHANDS_TOKEN);
  });
  test("oversized response fails closed", async () => {
    const c = ctx(); const fake: CliDependencies["fetch"] = async () => new Response("x".repeat(16385), { status: 202 });
    expect(await runCli(args, env, { ...c, fetch: fake })).toBe(1); expect(c.out()).not.toContain("successful");
  });
});


describe("tmux over relay CLI", () => {
  const env = { ENVINHANDS_RELAY_URL: "wss://relay.example", ENVINHANDS_RELAY_SECRET: "relay-secret-do-not-print", ENVINHANDS_PROXY_BINARY: "/opt/envin hands/it's%cli" };
  const ready = { stdinIsTTY: true, stdoutIsTTY: true, platform: "linux" as const, compiled: false };
  test("passes builder argv and inherited environment without exposing the secret", async () => {
    const c = context(); let captured: string[] = []; let passedEnv: NodeJS.ProcessEnv | undefined;
    const runSsh: CliDependencies["runSsh"] = async (argv, childEnv) => { captured = argv; passedEnv = childEnv; return 23; };
    const status = await runCli(["tmux", "node-1", "job_1", "alice"], env, { ...c, ...ready, runSsh });
    if (process.platform === "win32") {
      expect(status).toBe(1); expect(captured).toEqual([]);
      expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      return;
    }
    expect(status).toBe(23);
    expect(captured.slice(0, 4)).toEqual(["ssh", "-tt", "-o", "StrictHostKeyChecking=yes"]);
    expect(captured).toContain("-l"); expect(captured).toContain("alice");
    expect(captured).toContain("ProxyCommand='/opt/envin hands/it'\\''s%%cli' proxy 'node-1'");
    expect(captured.slice(-5)).toEqual(["tmux", "new-session", "-A", "-s", "envinhands-job_1"]);
    expect(captured.join(" ")).not.toContain(env.ENVINHANDS_RELAY_SECRET);
    expect(passedEnv).toBe(env); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
  });
  test("requires TTYs, valid environment, safe arguments and compiled executable", async () => {
    const c = context(); let calls = 0;
    const runSsh: CliDependencies["runSsh"] = async () => { calls++; return 0; };
    const cases: Array<[string[], NodeJS.ProcessEnv, Partial<CliDependencies>]> = [
      [["tmux", "n", "s"], env, { stdinIsTTY: false }],
      [["tmux", "n", "s"], env, { stdoutIsTTY: false }],
      [["tmux", "n", "s"], env, { platform: "win32" }],
      [["tmux", "n"], env, {}], [["tmux", "n", "s", "u", "extra"], env, {}],
      [["tmux", "../n", "s"], env, {}], [["tmux", "n", "s;bad"], env, {}],
      [["tmux", "n", "s", "-bad"], env, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_PROXY_BINARY: "relative" }, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_PROXY_BINARY: undefined }, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_RELAY_SECRET: undefined }, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_RELAY_URL: "wss://user:password@host" }, {}],
    ];
    for (const [args, e, override] of cases) expect(await runCli(args, e, { ...c, ...ready, ...override, runSsh })).toBe(1);
    expect(calls).toBe(0); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
  });
  test("compiled mode uses execPath, failures are redacted, plaintext warns", async () => {
    const c = context(); let argv: string[] = [];
    const runSsh: CliDependencies["runSsh"] = async a => { argv = a; throw new Error(env.ENVINHANDS_RELAY_SECRET); };
    expect(await runCli(["tmux", "n", "s"], { ...env, ENVINHANDS_PROXY_BINARY: undefined, ENVINHANDS_RELAY_URL: "ws://localhost" }, { ...c, ...ready, compiled: true, execPath: "/opt/cli", runSsh })).toBe(1);
    if (process.platform === "win32") {
      expect(argv).toEqual([]); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      return;
    }
    expect(argv.join(" ")).toContain("'/opt/cli'"); expect(c.output()).toContain("Warning");
    expect(c.output()).toContain("Command failed"); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
  });
  test("real runner launches fake local ssh directly, inherits env and forwards exit status", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "fake ssh "));
    try {
      const resultFile = join(dir, "result");
      writeFileSync(join(dir, "ssh"), '#!/bin/sh\nprintf "%s" "$ENVINHANDS_RELAY_SECRET" > "$RESULT_FILE"\nexit 17\n', { mode: 0o755 });
      const c = context();
      expect(await runCli(["tmux", "n", "s"], { ...env, PATH: dir, RESULT_FILE: resultFile }, { ...c, ...ready })).toBe(17);
      expect(readFileSync(resultFile, "utf8")).toBe(env.ENVINHANDS_RELAY_SECRET);
      expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      expect(c.signals.listenerCount("SIGINT")).toBe(0); expect(c.signals.listenerCount("SIGTERM")).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("missing ssh executable is redacted and removes signal handlers", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "no-ssh-"));
    try {
      const c = context();
      expect(await runCli(["tmux", "n", "s"], { ...env, PATH: dir }, { ...c, ...ready })).toBe(1);
      expect(c.output()).toContain("Command failed"); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      expect(c.signals.listenerCount("SIGINT")).toBe(0); expect(c.signals.listenerCount("SIGTERM")).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("signal is forwarded to ssh and handlers are removed", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "fake-ssh-"));
    try {
      writeFileSync(join(dir, "ssh"), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o755 });
      for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
        const c = context();
        const task = runCli(["tmux", "n", "s"], { ...env, PATH: dir }, { ...c, ...ready });
        c.signals.emit(signal);
        expect(await task).toBe(status);
        expect(c.signals.listenerCount("SIGINT")).toBe(0); expect(c.signals.listenerCount("SIGTERM")).toBe(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
