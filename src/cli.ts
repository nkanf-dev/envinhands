#!/usr/bin/env bun
/** Explicit CLI entry point. Importing this module never starts a listener. */
import { runPrimeProfileCli } from "./prime-profile-cli.ts";
import { runRemoteAccessCli } from "./remote-access-cli.ts";
import { runDeviceCli } from "./device-cli.ts";
import { runCollaborationCli } from "./collaboration-cli.ts";
import { runAccessCli } from "./access-cli.ts";
import { runRemoteCli } from "./remote-cli.ts";
import { runChangeCli } from "./change-cli.ts";
import { startAgentBusServer } from "./server.ts";
import { createRelayServer } from "./relay.ts";
import { startNodeRuntime } from "./node-runtime.ts";
import { startSshProxy } from "./ssh-proxy.ts";
import { buildTmuxRelayArgv } from "./session/tmux-relay.ts";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const help = `Usage: bun src/cli.ts <prime-profile ENV_ROOT PRIME_ROOT|access PROFILE_JSON|device register|device inventory|collaborate COMMAND|verify-access|exec|change register|change record|change list [AFTER] [LIMIT]|change enqueue|change flush|server|relay|node NODE_ID|proxy NODE_ID|tmux NODE_ID SESSION_KEY [USER]|register FLAGS>

prime-profile: emits normal opt-in Prime settings with collaboration, audit, execution,
               read-only files and explicit project skills; no credential or config writes.
access: encrypted SSH forwarding to configured loopback control service;
        one absolute JSON profile path, emits local URL, stop with SIGINT/SIGTERM.
device: register reads JSON id/host and optional SSH fields; collects local OS/name.
        Default registers pending metadata only. inventory includes failed/stale devices.
collaborate: heartbeat|agents|send|pull|ack|machines|notes|add-note.
        JSON stdin except agents/machines; explicit actions, no automatic execution.
verify-access: JSON stdin; verify this client SSH identity/path and real admin,
        not the service identity. Non-ready exits 1 with explicit evidence.
exec:   Authorized command JSON on stdin; --local for local argv execution.
        Remote mode: strict SSH path probe/fallback,
        executes once, leaves local signed intent/outcome in ENVINHANDS_CHANGE_SPOOL.
        Output/exit is evidence, not a promise of rollback or no remote effects.
change: JSON stdin for register/record, JSON stdout receipts. ENVINHANDS_URL
        and ENVINHANDS_TOKEN required; HTTPS or encrypted loopback forward only.
        enqueue accepts {registration,change} on stdin, stores locally offline.
        flush uploads pending records. Both require absolute ENVINHANDS_CHANGE_SPOOL.
        Explicit records are not automatic capture of every resource mutation.
register: --id ID --name NAME --host HOST --os OS --ssh-user USER [--ssh-port PORT] [--relay-node NODE_ID]
          ENVINHANDS_URL and ENVINHANDS_TOKEN required. HTTPS required except
          loopback HTTP; ENVINHANDS_ALLOW_INSECURE_HTTP=1 permits other HTTP
          with a warning. Registration may remain pending; no keys or sudo are configured.
server: ENVINHANDS_TOKEN (required), ENVINHANDS_HOST (default 0.0.0.0),
        ENVINHANDS_PORT (default 8787), ENVINHANDS_DB (default envinhands.sqlite).
relay:  ENVINHANDS_RELAY_SECRET (required), ENVINHANDS_RELAY_HOST (default 0.0.0.0),
        ENVINHANDS_RELAY_PORT (default 8788).
node:   ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET (required),
        ENVINHANDS_SSH_PORT (default 22; local 127.0.0.1 only).
proxy:  ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET (required).
        Use as an OpenSSH ProxyCommand; stdout carries SSH bytes only.
tmux:   ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET required. Set
        ENVINHANDS_PROXY_BINARY to the absolute path of the compiled CLI when
        running from source. Requires interactive stdin and stdout, local ssh,
        remote ssh/tmux, and a host key verified out of band. Windows unsupported.
        A disconnected connection cannot establish the task outcome.

Pass secrets in environment variables, never in command-line arguments.
Plain ws:// exposes the relay secret and traffic: use only on a trusted network.
For public networks, use wss:// with TLS termination. The server also needs HTTPS
termination on untrusted networks. This prototype uses a shared secret; TLS alone
does not provide per-node authorization. It does not configure SSH keys or sudo.
`;

export interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export interface CliDependencies {
  startServer: typeof startAgentBusServer;
  startRelay: typeof createRelayServer;
  startNode: typeof startNodeRuntime;
  startProxy: typeof startSshProxy;
  signals: SignalSource;
  stderr: { write(text: string): unknown };
  stdout: { write(text: string): unknown };
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requestTimeoutMs: number;
  platform: NodeJS.Platform;
  compiled: boolean;
  execPath: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  runSsh: (argv: string[], env: NodeJS.ProcessEnv, signals: SignalSource) => Promise<number>;
}
const defaults: CliDependencies = {
  startServer: startAgentBusServer, startRelay: createRelayServer,
  startNode: startNodeRuntime, startProxy: startSshProxy,
  signals: process, stderr: process.stderr, stdout: process.stdout,
  fetch: globalThis.fetch, requestTimeoutMs: 20_000,
  platform: process.platform, compiled: Bun.main.startsWith("/$bunfs/"), execPath: process.execPath,
  stdinIsTTY: !!process.stdin.isTTY, stdoutIsTTY: !!process.stdout.isTTY,
  runSsh: runSshProcess,
};
/** Run SSH directly, keeping the terminal and inherited environment intact. */
function runSshProcess(argv: string[], env: NodeJS.ProcessEnv, signals: SignalSource): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { shell: false, stdio: "inherit", env });
    const onInt = () => { child.kill("SIGINT"); };
    const onTerm = () => { child.kill("SIGTERM"); };
    signals.on("SIGINT", onInt);
    signals.on("SIGTERM", onTerm);
    const cleanup = () => {
      signals.removeListener("SIGINT", onInt);
      signals.removeListener("SIGTERM", onTerm);
    };
    child.once("error", err => { cleanup(); reject(err); });
    child.once("close", (code, signal) => {
      cleanup();
      resolve(code ?? (signal && signal in osConstants.signals
        ? 128 + osConstants.signals[signal as keyof typeof osConstants.signals] : 1));
    });
  });
}

const nodeIdPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
class UsageError extends Error {}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || /[\r\n]/.test(value)) throw new UsageError(`Set ${name}.`);
  return value;
}
function port(env: NodeJS.ProcessEnv, name: string, fallback: string, allowZero = false): number {
  const value = env[name] ?? fallback;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`Invalid ${name}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > 65535)
    throw new UsageError(`Invalid ${name}.`);
  return parsed;
}
function hostname(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name] ?? "0.0.0.0";
  if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new UsageError(`Invalid ${name}.`);
  return value;
}
function relayUrl(env: NodeJS.ProcessEnv): string {
  const raw = required(env, "ENVINHANDS_RELAY_URL");
  try {
    const u = new URL(raw);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      throw new Error();
    return raw;
  } catch { throw new UsageError("Invalid ENVINHANDS_RELAY_URL (use ws:// or wss:// without credentials, query, or fragment)."); }
}

const registerFlags = new Set(["--id", "--name", "--host", "--os", "--ssh-user", "--ssh-port", "--relay-node"]);
const MAX_RESPONSE_BYTES = 16 * 1024;

function registerArgs(args: string[]): Record<string, string | number> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!registerFlags.has(flag!) || flag! in values || !value || value.startsWith("--") || /[\x00-\x1f\x7f]/.test(value))
      throw new UsageError("Invalid register arguments. Use --help for usage; never pass secrets as arguments.");
    values[flag!] = value;
  }
  if (!["--id", "--name", "--host", "--os", "--ssh-user"].every(k => values[k]))
    throw new UsageError("Missing register arguments. Use --help for usage.");
  if (!nodeIdPattern.test(values["--id"]!) || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(values["--ssh-user"]!) ||
      values["--name"]!.trim().length === 0 || values["--name"]!.length > 200 ||
      values["--host"]!.trim().length === 0 || values["--host"]!.length > 253 ||
      values["--os"]!.trim().length === 0 || values["--os"]!.length > 100)
    throw new UsageError("Invalid register arguments.");
  const data: Record<string, string | number> = { id: values["--id"]!, name: values["--name"]!, host: values["--host"]!, os: values["--os"]!, sshUser: values["--ssh-user"]! };
  if (values["--ssh-port"] !== undefined) data.sshPort = port({ PORT: values["--ssh-port"] }, "PORT", "22");
  if (values["--relay-node"] !== undefined) {
    if (!nodeIdPattern.test(values["--relay-node"])) throw new UsageError("Invalid relay node ID.");
    data.relayNodeId = values["--relay-node"];
  }
  return data;
}

function apiUrl(env: NodeJS.ProcessEnv, warn: (s: string) => void): string {
  const raw = required(env, "ENVINHANDS_URL");
  let url: URL;
  try {
    if (!/^https?:\/\/[^\s\x00-\x1f\x7f\\/?#@]+\/?$/i.test(raw)) throw new Error();
    url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !/^https?:\/\//i.test(raw)) throw new Error();
  } catch { throw new UsageError("Invalid ENVINHANDS_URL (use an HTTP(S) origin without credentials, path, query, or fragment)."); }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    if (env.ENVINHANDS_ALLOW_INSECURE_HTTP !== "1") throw new UsageError("Insecure HTTP rejected; use HTTPS or set ENVINHANDS_ALLOW_INSECURE_HTTP=1 to explicitly allow plaintext HTTP.");
    warn("Warning: insecure HTTP exposes the bearer token and machine data on the network.");
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error("Invalid response size");
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw new Error("Response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}

async function register(args: string[], env: NodeJS.ProcessEnv, deps: CliDependencies): Promise<number> {
  const data = registerArgs(args);
  const origin = apiUrl(env, text => deps.stderr.write(text + "\n"));
  const token = required(env, "ENVINHANDS_TOKEN");
  if (/\s|[\x00-\x1f\x7f]/.test(token)) throw new UsageError("Invalid ENVINHANDS_TOKEN.");
  const request = async (path: string, body?: string): Promise<{ status: number; data: unknown }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Timeout")); }, deps.requestTimeoutMs); });
    try {
      return await Promise.race([(async () => {
        const response = await deps.fetch(origin + path, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body });
        if (response.status === 409) { void response.body?.cancel().catch(() => {}); return { status: 409, data: null }; }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return { status: response.status, data: null }; }
        return { status: response.status, data: await responseJson(response) };
      })(), timeout]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const created = await request("/v1/machines", JSON.stringify(data));
  if (created.status === 409) { deps.stderr.write("Registration not-ready: machine already exists (409); no changes made. Confirm its state before retrying.\n"); return 1; }
  if (created.status !== 202) { deps.stderr.write("Registration not-ready: server did not accept the request; a pending record may exist.\n"); return 1; }
  const verified = await request(`/v1/machines/${encodeURIComponent(String(data.id))}/verify`);
  const value = verified.data as { machine?: { status?: unknown } } | null;
  if (verified.status !== 200 || value?.machine?.status !== "ready") {
    deps.stderr.write("Registration not-ready: verification failed or is unsupported; the record may remain pending. No automatic key or sudo setup was performed.\n"); return 1;
  }
  deps.stdout.write("Registration successful: machine is ready. Verification used the server's SSH identity only; verify each agent separately. No SSH key or sudo setup was performed.\n");
  return 0;
}

/** Run a command. Dependencies and environment are injectable for tests. */
export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CliDependencies> = {}): Promise<number> {
  const deps = { ...defaults, ...overrides };
  const error = (text: string) => deps.stderr.write(text + "\n");
  const [command, id] = args;
  if (command === "prime-profile") return runPrimeProfileCli(args.slice(1), {write:text=>deps.stdout.write(text),error:text=>deps.stderr.write(text)});
  if (command === "access") return runRemoteAccessCli(args.slice(1), {write:text=>deps.stdout.write(text),error:text=>deps.stderr.write(text)}, deps.signals);
  if (command === "change" || command === "exec" || command === "verify-access" || command === "collaborate" || command === "device") {
    const io = {
      fetch: deps.fetch,
      write: (text: string) => deps.stdout.write(text),
      error: (text: string) => deps.stderr.write(text),
      readInput: async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of process.stdin) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > 16384) throw new Error("Input too large");
          chunks.push(bytes);
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      },
    };
    return command === "device" ? runDeviceCli(args.slice(1), env, io) : command === "collaborate" ? runCollaborationCli(args.slice(1), env, io) : command === "change" ? runChangeCli(args.slice(1), env, io) : command === "verify-access" ? runAccessCli(args.slice(1), env, io) : runRemoteCli(args.slice(1), env, io);
  }
  if (command === "tmux") {
    try {
      if (args.length < 3 || args.length > 4) throw new UsageError("Invalid tmux arguments. Use --help for usage.");
      if (deps.platform === "win32") throw new UsageError("tmux via relay is unsupported on Windows.");
      if (!deps.stdinIsTTY || !deps.stdoutIsTTY) throw new UsageError("tmux requires interactive stdin and stdout TTYs.");
      const url = relayUrl(env);
      required(env, "ENVINHANDS_RELAY_SECRET");
      const binaryPath = env.ENVINHANDS_PROXY_BINARY ?? (deps.compiled ? deps.execPath : undefined);
      if (!binaryPath) throw new UsageError("Set ENVINHANDS_PROXY_BINARY to the absolute path of the compiled CLI.");
      let argv: string[];
      try { argv = buildTmuxRelayArgv({ nodeId: id!, sessionKey: args[2]!, user: args[3], binaryPath, platform: deps.platform }); }
      catch { throw new UsageError("Invalid tmux arguments or ENVINHANDS_PROXY_BINARY."); }
      if (new URL(url).protocol === "ws:") error("Warning: ws:// is plaintext; use only on a trusted network. Use wss:// with TLS on public networks.");
      return await deps.runSsh(argv, env, deps.signals);
    } catch (err) {
      error(err instanceof UsageError ? err.message : "Command failed.");
      return 1;
    }
  }
  if (command === "register") {
    try { return await register(args.slice(1), env, deps); }
    catch (err) {
      error(err instanceof UsageError ? err.message : "Registration not-ready: request failed or timed out; a pending record may exist. No changes were rolled back.");
      return 1;
    }
  }
  if (args.length === 1 && (command === "--help" || command === "-h")) { deps.stderr.write(help); return 0; }
  if (!command || !["server", "relay", "node", "proxy"].includes(command) ||
      ((command === "node" || command === "proxy") ? args.length !== 2 || !nodeIdPattern.test(id ?? "") : args.length !== 1)) {
    error("Invalid command or arguments. Use --help for usage; never pass secrets as arguments."); return 1;
  }
  try {
    if (command === "proxy" || command === "node") {
      const url = relayUrl(env);
      const secret = required(env, "ENVINHANDS_RELAY_SECRET");
      if (new URL(url).protocol === "ws:") error("Warning: ws:// is plaintext; use only on a trusted network. Use wss:// with TLS on public networks.");
      if (command === "proxy") {
        await deps.startProxy({ relayUrl: url, nodeId: id!, secret });
        return 0;
      }
      const sshPort = port(env, "ENVINHANDS_SSH_PORT", "22");
      const runtime = deps.startNode({ relayUrl: url, nodeId: id!, secret, sshPort });
      // ready may reject when stopped before first registration. Retry is handled by the runtime.
      void runtime.ready.catch(() => {});
      return await untilSignal(deps.signals, () => runtime.close(), runtime.finished);
    }
    if (command === "server") {
      const token = required(env, "ENVINHANDS_TOKEN");
      const dbPath = env.ENVINHANDS_DB ?? "envinhands.sqlite";
      if (!dbPath || /[\x00-\x1f\x7f]/.test(dbPath)) throw new UsageError("Invalid ENVINHANDS_DB.");
      const instance = deps.startServer({ token, dbPath, hostname: hostname(env, "ENVINHANDS_HOST"), port: port(env, "ENVINHANDS_PORT", "8787", true) });
      error("Experimental HTTP listener started. Use HTTPS termination on untrusted networks.");
      return await untilSignal(deps.signals, () => instance.stop());
    }
    const instance = deps.startRelay({ secret: required(env, "ENVINHANDS_RELAY_SECRET"), hostname: hostname(env, "ENVINHANDS_RELAY_HOST"), port: port(env, "ENVINHANDS_RELAY_PORT", "8788", true) });
    error("Relay started. Plain ws:// is for trusted networks only; use wss:// with TLS on public networks. Shared-secret access is not per-node authorization.");
    return await untilSignal(deps.signals, () => instance.stop());
  } catch (err) {
    // Never print underlying errors: they may contain a URL, secret, argv or path.
    error(err instanceof UsageError ? err.message : "Command failed.");
    return 1;
  }
}

/** Wait for termination, clean up once, and remove handlers even on failure. */
async function untilSignal(signals: SignalSource, close: () => void | Promise<void>, finished?: Promise<void>): Promise<number> {
  let onSignal!: () => void;
  const interrupted = new Promise<"signal">((resolve) => { onSignal = () => resolve("signal"); });
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  try {
    let result: "signal" | "finished";
    try {
      result = await (finished ? Promise.race([interrupted, finished.then(() => "finished" as const)]) : interrupted);
    } finally {
      await close();
    }
    if (finished) await finished;
    return result === "signal" ? 0 : 1;
  } finally {
    signals.removeListener("SIGINT", onSignal);
    signals.removeListener("SIGTERM", onSignal);
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
