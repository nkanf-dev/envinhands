#!/usr/bin/env bun
/** Explicit CLI entry point. Importing this module never starts a listener. */
import {runRemotePublishCli} from "./remote-publish-cli.ts";
import { runFilesCli } from "./files-cli.ts";
import { runProvisionCli } from "./provision-cli.ts";
import { signedCliFetch, cliRegistration } from "./cli-registration.ts";
import { createTeamNodeOnboard } from "./team-node-onboard.ts";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { runServiceCli } from "./service-cli.ts";
import { runPrimeProfileCli } from "./prime-profile-cli.ts";
import { runTeamConfigCli } from "./team-config-cli.ts";
import { runTeamStatusCli } from "./team-status-cli.ts";
import { resolveTeamCliEnv, resolveTeamSshEnv, resolveTeamSshUser } from "./team-cli-defaults.ts";
import { runRouteConnectCli } from "./route-connect-cli.ts";
import { startRouteAdvertiser } from "./route-advertiser.ts";
import { createHash, randomUUID } from "node:crypto";
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
import type { DebugLogger } from "./debug-log.ts";
import { createProcessDebugLogger } from "./process-debug-log.ts";
export { debugLogWriterName, reapDebugLogs, createProcessDebugLogger } from "./process-debug-log.ts";

const help = `Usage: bun src/cli.ts <status [--json|--format table]|machines [--json|--format table]|connect MACHINE_ID [USER]|team-config [--replace]|publish PROFILE_JSON|files hosts|files resources [HOST]|files list [HOST]|files read [HOST]|files write [HOST]|files inspect [HOST]|provision|service CONFIG_JSON|prime-profile ENV_ROOT [PRIME_ROOT]|access PROFILE_JSON|device register|device inventory|collaborate COMMAND|verify-access|exec|change register|change record|change list [AFTER] [LIMIT]|change enqueue|change flush|server|relay|node NODE_ID|proxy NODE_ID|tmux NODE_ID SESSION_KEY [USER]|register FLAGS>

publish: outbound strict SSH reverse publication of a local loopback service to
         approved SSH host loopback only; private JSON profile, no public bind.
files: optional HOST selects private ENVINHANDS_SHARED_HOSTS catalog; hosts lists IDs.
       Discover selected roots, list one directory level, read/write work files; JSON resourceId/path, write also text and
       expectedSha256 (null only creates missing file); signed writes, no blind overwrite.
       write returns hostId/operationId/status; inspect reads that original operation.
provision: explicit local owner-confirmed OS key/admin apply or revoke JSON stdin;
           requires existing administrator context, identity env and durable spool.
service: starts persistent control service from private absolute JSON config;
         signed mutations required, config/DB preserved on SIGINT/SIGTERM.
prime-profile: emits normal opt-in Prime settings with collaboration, audit, execution,
               read-only files and explicit project skills; no credential or config writes.
team-config: persist ENVINHANDS_URL/TOKEN and optional ENVINHANDS_MACHINE_ID for
             prime-agent-team native mesh; --replace explicitly changes existing config.
status/machines: show control and machine catalog status as JSON or --format table.
connect: discover and probe candidate SSH routes, then open one interactive session;
         uses explicit environment or private Team defaults; USER may come from Team identities.
         Requires a trusted host key, SSH identity and a TTY.
access: encrypted SSH forwarding to configured loopback control service;
        one absolute JSON profile path, emits local URL, stop with SIGINT/SIGTERM.
device: register reads JSON id/host and optional SSH fields; collects local OS/name.
        Default registers pending metadata only. inventory includes failed/stale devices.
collaborate: heartbeat|agents|send|pull|ack|machines|notes|add-note|
        profile-notes list|profile-notes add|profile-notes reply.
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
        With control URL and token, Linux/macOS automatically synchronize team
        keys with full-team trust in the current user's home. Set
        ENVINHANDS_TEAM_AUTO_KEYS=0 to disable. ENVINHANDS_SSH_HOST_PUBLIC_KEY
        can override the absolute public host-key path; verify sshd uses it.
        Windows automatic key synchronization is not implemented. Synchronization
        does not establish SSH or administrator readiness.
proxy:  ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET (required).
        Use as an OpenSSH ProxyCommand; stdout carries SSH bytes only.
tmux:   ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET required. Set
        ENVINHANDS_PROXY_BINARY to the absolute path of the compiled CLI when
        running from source. Requires interactive stdin and stdout, local ssh,
        remote ssh/tmux, and a host key verified out of band. Windows unsupported.
        A disconnected connection cannot establish the task outcome.

Debug metadata JSONL: ENVINHANDS_LOG_DIR selects a private parent directory;
otherwise ~/.local/state/envinhands is used. Each process gets a separate directory.
On startup, verified stopped-writer directories are pruned after seven days or
when verified logs exceed 256 MiB. Live and unsafe entries are never deleted. Cleanup is limited to the same
Linux boot and PID namespace; older/unknown namespaces are retained. Therefore
these limits are best effort, not a global disk quota.
Logging is unavailable on Windows until a secure ACL implementation exists;
the service continues with an explicit warning.

Pass secrets in environment variables, never in command-line arguments.
Plain ws:// exposes the relay secret and traffic: use only on a trusted network.
For public networks, use wss:// with TLS termination. The server also needs HTTPS
termination on untrusted networks. This prototype uses a shared secret; TLS alone
does not provide per-node authorization. Node team synchronization may configure SSH keys; it does not configure sudo.
`;

export interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export interface CliDependencies {
  startServer: typeof startAgentBusServer;
  startRelay: typeof createRelayServer;
  startNode: typeof startNodeRuntime;
  startRouteAdvertiser: typeof startRouteAdvertiser;
  createTeamNodeOnboard: typeof createTeamNodeOnboard;
  currentUserHome: () => string;
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
  /** Test-only home override for private Team defaults. */
  teamHome?: string;
  runSsh: (argv: string[], env: NodeJS.ProcessEnv, signals: SignalSource) => Promise<number>;
}
const defaults: CliDependencies = {
  startServer: startAgentBusServer, startRelay: createRelayServer,
  startNode: startNodeRuntime, startRouteAdvertiser, startProxy: startSshProxy,
  createTeamNodeOnboard, currentUserHome: () => userInfo().homedir,
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
  const signedFetch = signedCliFetch(env, deps.fetch);
  if (/\s|[\x00-\x1f\x7f]/.test(token)) throw new UsageError("Invalid ENVINHANDS_TOKEN.");
  const request = async (path: string, body?: string): Promise<{ status: number; data: unknown }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Timeout")); }, deps.requestTimeoutMs); });
    try {
      return await Promise.race([(async () => {
        const response = await signedFetch(origin + path, { method: "POST", redirect: "error", signal: controller.signal,
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
  deps.stderr.write("Registration incomplete: server SSH/admin verification passed, but each agent's SSH identity and administrator access remain unverified. The machine record was kept. Configure the agent key and host trust, then run verify-access from each agent; no key or sudo setup was performed automatically.\n");
  return 1;
}

/** Run a command. Dependencies and environment are injectable for tests. */
export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CliDependencies> = {}): Promise<number> {
  const deps = { ...defaults, ...overrides };
  const error = (text: string) => deps.stderr.write(text + "\n");
  const [command, id] = args;
  if (command === "publish") return runRemotePublishCli(args.slice(1), {write:text=>deps.stdout.write(text),error:text=>deps.stderr.write(text)}, deps.signals);
  if (command === "service") return runServiceCli(args.slice(1), {write:text=>deps.stdout.write(text),error:text=>deps.stderr.write(text)}, deps.signals, { env, platform: deps.platform });
  if (command === "prime-profile") return runPrimeProfileCli(args.slice(1), {write:text=>deps.stdout.write(text),error:text=>deps.stderr.write(text)});
  if (command === "team-config") return runTeamConfigCli(args.slice(1), env, {stdout:text=>deps.stdout.write(text),stderr:text=>deps.stderr.write(text)});
  // A missing home never falls back to the real account or touches a Team file.
  const teamHome = deps.teamHome ?? (deps.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) ?? "";
  const teamEnv = async () => {
    if (teamHome) return resolveTeamCliEnv({env, home: teamHome, platform: deps.platform});
    const partial = (env.ENVINHANDS_URL !== undefined) !== (env.ENVINHANDS_TOKEN !== undefined);
    const partialRelay = (env.ENVINHANDS_RELAY_URL !== undefined) !== (env.ENVINHANDS_RELAY_SECRET !== undefined);
    return {env: {...env}, source: partial ? "partial" as const : "none" as const,
      diagnostic: partial ? "E_TEAM_CONFIG_PARTIAL" : undefined,
      relayDiagnostic: partialRelay ? "E_RELAY_CONFIG_PARTIAL" : undefined};
  };
  if (command === "status" || command === "machines") {
    const team = await teamEnv();
    return runTeamStatusCli(args, team.env, {
      fetch: deps.fetch,
      write: text => deps.stdout.write(text),
      error: text => deps.stderr.write(text),
      readInput: async () => "",
    }, { timeoutMs: deps.requestTimeoutMs, team: {home: teamHome, platform: deps.platform} });
  }
  if (command === "connect") {
    if (args.length < 2 || args.length > 3) { error("Usage: envinhands connect MACHINE_ID [USER]"); return 2; }
    if (!deps.stdinIsTTY || !deps.stdoutIsTTY) { error("E_TTY: connect requires a TTY."); return 2; }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    deps.signals.on("SIGINT", cancel); deps.signals.on("SIGTERM", cancel);
    try {
      // The deadline covers headers and body consumption, including fetchers
      // that ignore abort. Own the body reader so cancellation wakes consumers.
      const boundedFetch: CliDependencies["fetch"] = async (url, init) => {
        const request = new AbortController();
        let done = false, reader: { cancel(): Promise<unknown> } | undefined;
        let output: ReadableStreamDefaultController<Uint8Array> | undefined;
        let rejectWait: (error: Error) => void = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
          init?.signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          if (done) return;
          done = true; request.abort(); cleanup();
          if (reader) void reader.cancel().catch(() => {});
          try { output?.error(new Error("request cancelled")); } catch {}
          rejectWait(new Error("request cancelled"));
        };
        controller.signal.addEventListener("abort", abort, {once:true});
        init?.signal?.addEventListener("abort", abort, {once:true});
        const interrupted = new Promise<never>((_, reject) => { rejectWait = reject; });
        timer = setTimeout(abort, deps.requestTimeoutMs);
        if (controller.signal.aborted || init?.signal?.aborted) abort();
        const pending = Promise.resolve().then(() => {
          if (done) throw new Error("request cancelled");
          return deps.fetch(url, {...init, signal:request.signal});
        }).then(response => {
          if (done) { void response.body?.cancel().catch(() => {}); throw new Error("request cancelled"); }
          return response;
        });
        let response: Response;
        try { response = await Promise.race([pending, interrupted]); }
        catch (err) { if (!done) { done = true; cleanup(); request.abort(); } throw err; }
        if (!response.body) { done = true; cleanup(); return response; }
        let source: { read(): Promise<{done: boolean; value?: Uint8Array}>; cancel(): Promise<unknown> };
        try { source = response.body.getReader(); reader = source; }
        catch (err) { done = true; cleanup(); request.abort(); throw err; }
        const body = new ReadableStream<Uint8Array>({
          start(c) { output = c; },
          async pull(c) {
            try {
              const next = await source.read();
              if (done) return;
              if (next.done) { done = true; cleanup(); c.close(); }
              else c.enqueue(next.value!);
            } catch {
              if (!done) { done = true; cleanup(); request.abort(); c.error(new Error("response body failed")); }
            }
          },
          cancel() {
            if (!done) { done = true; cleanup(); request.abort(); void source.cancel().catch(() => {}); }
          },
        });
        return new Response(body, {status:response.status, statusText:response.statusText, headers:response.headers});
      };
      const team = await teamEnv();
      if (team.diagnostic) { error(team.diagnostic); return 1; }
      if (team.relayDiagnostic) error(team.relayDiagnostic);
      const ssh = await resolveTeamSshEnv({env: team.env, home: teamHome, platform: deps.platform});
      if (ssh.diagnostic) error(ssh.diagnostic);
      const safeProxyBinary = (value: string | undefined): value is string =>
        !!value && isAbsolute(value) && !/[%\x00-\x1f\x7f]/.test(value);
      if (ssh.env.ENVINHANDS_PROXY_BINARY === undefined && deps.compiled && safeProxyBinary(deps.execPath))
        ssh.env.ENVINHANDS_PROXY_BINARY = deps.execPath;
      if (deps.platform !== "win32" && ssh.env.ENVINHANDS_RELAY_URL && ssh.env.ENVINHANDS_RELAY_SECRET && !safeProxyBinary(ssh.env.ENVINHANDS_PROXY_BINARY))
        error("E_RELAY_BINARY: set ENVINHANDS_PROXY_BINARY to an absolute compiled CLI path.");
      const resolvedUser = await resolveTeamSshUser({machineId: args[1]!, user: args[2], env: ssh.env,
        fetch: (url, init) => boundedFetch(url, init), signal: controller.signal});
      if (!resolvedUser.user) { error(resolvedUser.diagnostic ?? "E_SSH_USER"); return controller.signal.aborted ? 130 : 1; }
      return await runRouteConnectCli(["connect", args[1]!, resolvedUser.user], {
        env: ssh.env, isTTY: deps.stdinIsTTY && deps.stdoutIsTTY, signal: controller.signal,
        stderr: text => deps.stderr.write(text + "\n"),
        fetch: (url, init) => boundedFetch(url, init), platform: deps.platform,
      });
    } finally { deps.signals.removeListener("SIGINT", cancel); deps.signals.removeListener("SIGTERM", cancel); }
  }
  if (command === "access") return runRemoteAccessCli(args.slice(1), {write:text=>deps.stdout.write(text),error:text=>deps.stderr.write(text)}, deps.signals);
  if (command === "change" || command === "exec" || command === "verify-access" || command === "collaborate" || command === "device" || command === "provision" || command === "files") {
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
          if (size > (command === "files" ? 68 * 1024 : 16384)) throw new Error("Input too large");
          chunks.push(bytes);
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      },
    };
    let resourceEnv = env;
    if (command !== "provision") {
      const team = await teamEnv();
      resourceEnv = team.env;
      if (team.diagnostic) error(team.diagnostic);
    }
    return command === "files" ? runFilesCli(args.slice(1), resourceEnv, io) : command === "provision" ? runProvisionCli(args.slice(1), env, io) : command === "device" ? runDeviceCli(args.slice(1), resourceEnv, io) : command === "collaborate" ? runCollaborationCli(args.slice(1), resourceEnv, io) : command === "change" ? runChangeCli(args.slice(1), resourceEnv, io) : command === "verify-access" ? runAccessCli(args.slice(1), resourceEnv, io) : runRemoteCli(args.slice(1), resourceEnv, io);
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
  let logger: DebugLogger | undefined;
  const setupLogger = (component: string, secrets: string[]) => {
    logger = createProcessDebugLogger(component, secrets, env, error, deps.platform, true);
  };
  const onEvent = (event: string, fields: import("./debug-log.ts").DebugFields) => { logger?.debug(event, fields); };
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
      setupLogger("node", [secret, env.ENVINHANDS_TOKEN ?? ""]);
      // Catalog observations are optional and never gate the relay node. Each
      // observation is untrusted until an SSH client verifies it with its own key.
      let advertiser: ReturnType<typeof startRouteAdvertiser> | undefined;
      const controller = "node-" + createHash("sha256").update(id!).digest("hex");
      const attribution = { ...env, ENVINHANDS_MACHINE_ID: id!, ENVINHANDS_AGENT_ID: controller,
        ENVINHANDS_SESSION_ID: randomUUID(), ENVINHANDS_AUDIT_SIGNATURE: "EnvInHands node route observer" };
      if (env.ENVINHANDS_URL && env.ENVINHANDS_TOKEN) {
        try {
          const signed = signedCliFetch(attribution, deps.fetch);
          advertiser = deps.startRouteAdvertiser({ baseUrl: env.ENVINHANDS_URL, token: env.ENVINHANDS_TOKEN,
            machineId: id!, relayNodeId: id!, controller, sshPort,
            easytierInterfaces: (env.ENVINHANDS_EASYTIER_INTERFACES ?? "").split(",").map(x => x.trim()).filter(Boolean),
            onEvent: (event, fields) => logger?.debug("route_" + event, {machineId:id!, durationMs:fields.delayMs})
          }, {fetch: (target, init) => signed(target, init)});
        } catch {
          // Invalid or temporarily unavailable catalog setup must not stop SSH relay.
          logger?.error("route_advertiser_error", {machineId:id!, errorCategory:"configuration"});
          error("Automatic route publication could not start; check the control URL and node environment. Relay remains available.");
        }
      } else if (env.ENVINHANDS_URL || env.ENVINHANDS_TOKEN) {
        error("Set both ENVINHANDS_URL and ENVINHANDS_TOKEN to enable automatic route publication. Relay remains available.");
      }
      const nodeEvent: typeof onEvent = (event, fields) => {
        onEvent(event, fields);
        if (event === "node_registered") advertiser?.setRelayConnected(true);
        else if (event === "node_disconnected") advertiser?.setRelayConnected(false);
      };
      let runtime: ReturnType<typeof startNodeRuntime>;
      try { runtime = deps.startNode({ relayUrl: url, nodeId: id!, secret, sshPort, onEvent:nodeEvent }); }
      catch (err) { advertiser?.stop(); throw err; }
      // Onboarding is independent of relay registration and never gates it.
      let onboarding: ReturnType<typeof createTeamNodeOnboard> | undefined;
      let onboardingCleanup: Promise<void> | undefined;
      if (env.ENVINHANDS_URL && env.ENVINHANDS_TOKEN && env.ENVINHANDS_TEAM_AUTO_KEYS !== "0") {
        if (deps.platform !== "linux" && deps.platform !== "darwin") {
          error("E_TEAM_SYNC: synchronization is unsupported on this platform.");
        } else {
          try {
            const home = deps.currentUserHome();
            const hostPublicKeyPath = env.ENVINHANDS_SSH_HOST_PUBLIC_KEY ?? (deps.platform === "darwin"
              ? "/private/etc/ssh/ssh_host_ed25519_key.pub" : "/etc/ssh/ssh_host_ed25519_key.pub");
            if (!isAbsolute(hostPublicKeyPath) || hostPublicKeyPath.split("/").includes("..") || /[\x00-\x1f\x7f]/.test(hostPublicKeyPath)) throw new Error();
            // Check the same URL and bearer rules used by control commands.
            const baseUrl = apiUrl(env, error);
            const token = required(env, "ENVINHANDS_TOKEN");
            if (/\s|[\x00-\x1f\x7f]/.test(token)) throw new Error();
            onboarding = deps.createTeamNodeOnboard({ home, deviceId: id!, hostPublicKeyPath,
              baseUrl, token, registration: cliRegistration(attribution), fullTeamTrust: true,
              fetch: (target, init) => deps.fetch(target, init),
              onStatus: status => {
                if (status.code !== "synchronized" && status.code !== "host-pins-recovered") {
                  logger?.error("team_onboard_incomplete", {machineId:id!, errorCategory:"onboarding"});
                  error("E_TEAM_SYNC: synchronization incomplete; retrying.");
                }
              },
            });
            onboarding.start();
          } catch {
            const failed = onboarding;
            onboarding = undefined;
            if (failed) onboardingCleanup = Promise.resolve().then(() => failed.stop()).catch(() => {});
            logger?.error("team_onboard_error", {machineId:id!, errorCategory:"configuration"});
            error("E_TEAM_SYNC: synchronization could not start.");
          }
        }
      }
      // ready may reject when stopped before first registration. Retry is handled by the runtime.
      void runtime.ready.catch(() => {});
      return await untilSignal(deps.signals, async () => {
        try { runtime.close(); }
        finally { try { await onboarding?.stop(); await onboardingCleanup; } finally { advertiser?.stop(); } }
      }, runtime.finished);
    }
    if (command === "server") {
      const token = required(env, "ENVINHANDS_TOKEN");
      const dbPath = env.ENVINHANDS_DB ?? "envinhands.sqlite";
      if (!dbPath || /[\x00-\x1f\x7f]/.test(dbPath)) throw new UsageError("Invalid ENVINHANDS_DB.");
      setupLogger("server", [token]);
      const instance = deps.startServer({ token, dbPath, onEvent, hostname: hostname(env, "ENVINHANDS_HOST"), port: port(env, "ENVINHANDS_PORT", "8787", true) });
      error("Experimental HTTP listener started. Use HTTPS termination on untrusted networks.");
      return await untilSignal(deps.signals, () => instance.stop());
    }
    const relaySecret = required(env, "ENVINHANDS_RELAY_SECRET");
    setupLogger("relay", [relaySecret]);
    const instance = deps.startRelay({ secret: relaySecret, onEvent, hostname: hostname(env, "ENVINHANDS_RELAY_HOST"), port: port(env, "ENVINHANDS_RELAY_PORT", "8788", true) });
    error("Relay started. Plain ws:// is for trusted networks only; use wss:// with TLS on public networks. Shared-secret access is not per-node authorization.");
    return await untilSignal(deps.signals, () => instance.stop());
  } catch (err) {
    // Never print underlying errors: they may contain a URL, secret, argv or path.
    logger?.error("component_failed", { errorCategory: "startup_or_runtime" });
    error(err instanceof UsageError ? err.message : "Command failed.");
    return 1;
  } finally {
    logger?.close();
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
