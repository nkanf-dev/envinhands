import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
