#!/usr/bin/env bun
/** Explicit CLI entry point. Importing this module never starts a listener. */
import {runRemotePublishCli} from "./remote-publish-cli.ts";
import { runFilesCli } from "./files-cli.ts";
import { runProvisionCli } from "./provision-cli.ts";
import { signedCliFetch, cliRegistration } from "./cli-registration.ts";
import { createTeamNodeOnboard } from "./team-node-onboard.ts";
import { userInfo } from "node:os";
import { isAbsolute, win32 } from "node:path";
import { runServiceCli } from "./service-cli.ts";
import { runPrimeProfileCli } from "./prime-profile-cli.ts";
import { runTeamConfigCli } from "./team-config-cli.ts";
import { runTeamStatusCli } from "./team-status-cli.ts";
import { verifyClientAccess } from "./client-access.ts";
import { fetchTransportCatalog, transportCatalogCandidates } from "./transport-catalog.ts";
import type { CommandRunner } from "./readiness.ts";
import { validSshUser, type SshRoute } from "./transports/ssh-routes.ts";
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

const help = `Usage: envinhands <command> [arguments]

Commands:
  status [--json|--format table]       Show team status
  machines [--json|--format table]     List machines
  connect MACHINE_ID [USER]            Open an SSH session
  exec [--local]                      Execute a command from JSON stdin
  register FLAGS                      Register and verify a machine
  device register|inventory           Register or list devices
  collaborate COMMAND                 Use collaboration commands
  files COMMAND [HOST]                Use shared files
  change COMMAND                      Record or upload changes
  verify-access [sync]                Verify client access
  team-config [--replace]             Store team settings
  node NODE_ID                        Start a relay node
  server                              Start the control server
  relay                               Start the relay server
  proxy NODE_ID                       Open a relay proxy
  tmux NODE_ID SESSION_KEY [USER]      Open a tmux session
  publish PROFILE_JSON                Publish a service
  provision                           Apply local provisioning
  service CONFIG_JSON                 Start the control service
  prime-profile ENV_ROOT [PRIME_ROOT]  Generate a Prime profile
  access PROFILE_JSON                 Forward the control service

Register: --id ID --name NAME --host HOST --os OS --ssh-user USER
          [--ssh-port PORT] [--relay-node NODE_ID]

Environment: ENVINHANDS_URL, ENVINHANDS_TOKEN, ENVINHANDS_MACHINE_ID,
  ENVINHANDS_RELAY_URL, ENVINHANDS_RELAY_SECRET, ENVINHANDS_PROXY_BINARY,
  ENVINHANDS_SSH_IDENTITY, ENVINHANDS_SSH_KNOWN_HOSTS,
  ENVINHANDS_TEAM_AUTO_KEYS, ENVINHANDS_SSH_HOST_PUBLIC_KEY.
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
  verifyClientAccess: typeof verifyClientAccess;
  clientAccessRunner?: CommandRunner;
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
  createTeamNodeOnboard, verifyClientAccess, currentUserHome: () => userInfo().homedir,
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
  const validUser = values["--os"]!.toLowerCase() === "windows"
    ? validSshUser(values["--ssh-user"])
    : /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(values["--ssh-user"]!);
  if (!nodeIdPattern.test(values["--id"]!) || !validUser ||
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

async function responseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error("Invalid response size");
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, {once:true});
  if (signal?.aborted) abort();
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
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  if (signal?.aborted) throw new Error("Aborted");
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}

class RegisterError extends Error {
  constructor(readonly code: string) { super(code); }
}
function registerFailure(deps: CliDependencies, code: string): number {
  deps.stderr.write(JSON.stringify({ok:false,error:{code}}) + "\n"); return 1;
}
/** Run a noninteractive SSH probe with the caller's environment, not global state. */
function registerRunner(env: NodeJS.ProcessEnv): CommandRunner {
  const childEnv = {...env};
  delete childEnv.ENVINHANDS_TOKEN;
  delete childEnv.ENVINHANDS_ACCEPTANCE_API_KEY;
  return (command, args, timeoutMs) => new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, [...args], {shell:false,stdio:"ignore",env:childEnv}); }
    catch { resolve({exitCode:null}); return; }
    let settled = false;
    const finish = (exitCode:number|null) => { if (settled) return; settled=true; clearTimeout(timer); resolve({exitCode}); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(null); }, timeoutMs);
    child.once("error", () => finish(null)); child.once("close", code => finish(code));
  });
}
async function register(args: string[], env: NodeJS.ProcessEnv, deps: CliDependencies, home:string): Promise<number> {
  const data = registerArgs(args);
  const origin = apiUrl(env, () => {});
  const token = required(env, "ENVINHANDS_TOKEN");
  if (/\s|[\x00-\x1f\x7f]/.test(token)) throw new RegisterError("E_TEAM_CONFIG");
  const signedFetch = signedCliFetch(env, deps.fetch);
  const request = async (path: string, method:"GET"|"POST", body?: string): Promise<{ status: number; data: unknown }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        const response = await signedFetch(origin + path, {method, redirect:"error", signal:controller.signal,
          headers: {authorization:`Bearer ${token}`, ...(body === undefined ? {} : {"content-type":"application/json"})}, body});
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return {status:response.status,data:null}; }
        return {status:response.status,data:await responseJson(response, controller.signal)};
      })(), new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RegisterError("E_NETWORK"));},deps.requestTimeoutMs);})]);
    } catch (err) { if (err instanceof RegisterError) throw err; throw new RegisterError("E_NETWORK"); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const created = await request("/v1/machines", "POST", JSON.stringify(data));
  if (created.status === 409) {
    const list = await request("/v1/machines?includePending=true&includeNotReady=true", "GET");
    if (list.status !== 200 || !list.data || typeof list.data !== "object" || !Array.isArray((list.data as {machines?:unknown}).machines)) throw new RegisterError("E_DIRECTORY");
    const matches = ((list.data as {machines:unknown[]}).machines).filter((x): x is Record<string,unknown> => !!x && typeof x === "object" && (x as Record<string,unknown>).id === data.id);
    const existing = matches[0];
    if (matches.length !== 1 || !existing) throw new RegisterError("E_DIRECTORY");
    if ((existing.relayNodeId ?? null) !== (data.relayNodeId ?? null)) throw new RegisterError("E_NODE_CONFLICT");
    // Keep the existing record unchanged and verify its actual endpoint.
    if (typeof existing.host !== "string" || typeof existing.os !== "string" ||
        typeof existing.sshUser !== "string" || typeof existing.name !== "string" ||
        !Number.isInteger(existing.sshPort)) throw new RegisterError("E_DIRECTORY");
    try {
      const actual = registerArgs(["--id",String(data.id),"--name",existing.name,"--host",existing.host,
        "--os",existing.os,"--ssh-user",existing.sshUser,"--ssh-port",String(existing.sshPort),
        ...(typeof existing.relayNodeId === "string" ? ["--relay-node",existing.relayNodeId] : [])]);
      Object.assign(data,actual);
    } catch { throw new RegisterError("E_DIRECTORY"); }
  } else if (created.status !== 202) throw new RegisterError(created.status === 401 || created.status === 403 ? "E_AUTH" : "E_REGISTER");
  const verified = await request(`/v1/machines/${encodeURIComponent(String(data.id))}/verify`, "POST");
  const value = verified.data as {machine?:{status?:unknown}} | null;
  if (verified.status !== 200 || value?.machine?.status !== "ready") throw new RegisterError("E_SERVER_VERIFY");
  const ssh = await resolveTeamSshEnv({env,home,platform:deps.platform});
  if (!ssh.env.ENVINHANDS_SSH_IDENTITY) throw new RegisterError("E_SSH_KEY");
  if (!ssh.env.ENVINHANDS_SSH_KNOWN_HOSTS) throw new RegisterError("E_HOSTKEY");
  const os = String(data.os).toLowerCase();
  if (os !== "linux" && os !== "macos" && os !== "windows") throw new RegisterError("E_OS");
  const access = {user:String(data.sshUser),hostKeyAlias:String(data.id),identityFile:ssh.env.ENVINHANDS_SSH_IDENTITY,knownHostsFile:ssh.env.ENVINHANDS_SSH_KNOWN_HOSTS};
  const direct:SshRoute={id:"registered-direct",host:String(data.host),port:Number(data.sshPort ?? 22)};
  let routes:SshRoute[]=[direct];
  const binary=ssh.env.ENVINHANDS_PROXY_BINARY ?? (deps.compiled ? deps.execPath : undefined);
  try {
    const ac=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const page=await Promise.race([fetchTransportCatalog(origin,token,String(data.id),(url,init)=>deps.fetch(url,{...init,signal:ac.signal})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(new Error());},deps.requestTimeoutMs);})]);
      const relayReady=!!binary && (deps.platform === "win32" ? win32.isAbsolute(binary) : isAbsolute(binary)) && !/[%\x00-\x1f\x7f]/.test(binary) && !!env.ENVINHANDS_RELAY_URL && !!env.ENVINHANDS_RELAY_SECRET;
      const filtered={...page,routes:page.routes.filter(r=>r.kind!=="relay" || relayReady)};
      const found=transportCatalogCandidates(filtered,String(data.id),{access,relayBinaryPath:relayReady ? binary! : "/unused-envinhands-proxy"});
      routes=[...found.routes.filter(r=>r.id!==direct.id),direct];
    } finally {if(timer!==undefined)clearTimeout(timer);ac.abort();}
  } catch { /* A missing route catalog does not remove the registered direct route. */ }
  try {
    const result=await deps.verifyClientAccess({registration:cliRegistration(env),targetMachineId:String(data.id),os,routes,access,priority:routes.map(r=>r.id),totalBudgetMs:60000},{runner:deps.clientAccessRunner ?? registerRunner(ssh.env)});
    if (!result.ready || result.status !== "ready") throw new RegisterError("E_SSH");
  } catch (err) { if (err instanceof RegisterError) throw err; throw new RegisterError("E_SSH"); }
  deps.stdout.write(JSON.stringify({ok:true,data:{id:data.id,status:"ready"},meta:{}})+"\n");
  return 0;
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
    } finally {
      // Release any unconsumed bounded response and its deadline on every exit.
      // The interactive SSH has already ended (or been cancelled) at this point.
      controller.abort();
      deps.signals.removeListener("SIGINT", cancel); deps.signals.removeListener("SIGTERM", cancel);
    }
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
    try {
      const team = await teamEnv();
      if (team.diagnostic) return registerFailure(deps, team.diagnostic);
      if (!team.env.ENVINHANDS_URL || !team.env.ENVINHANDS_TOKEN) return registerFailure(deps, "E_TEAM_CONFIG");
      const actor = {...team.env};
      // The actor machine is the local client, never the target being registered.
      if (!actor.ENVINHANDS_MACHINE_ID) throw new UsageError("E_ACTOR: set ENVINHANDS_MACHINE_ID.");
      actor.ENVINHANDS_AGENT_ID ??= "cli-" + createHash("sha256").update(actor.ENVINHANDS_MACHINE_ID).digest("hex");
      actor.ENVINHANDS_SESSION_ID ??= randomUUID();
      actor.ENVINHANDS_AUDIT_SIGNATURE ??= "EnvInHands CLI registration";
      try { cliRegistration(actor); } catch { throw new UsageError("E_ACTOR: invalid client identity."); }
      return await register(args.slice(1), actor, deps, teamHome);
    }
    catch (err) {
      return registerFailure(deps, err instanceof RegisterError ? err.code : err instanceof UsageError && err.message.startsWith("E_ACTOR") ? "E_ACTOR" : err instanceof UsageError ? "E_USAGE" : "E_REGISTER");
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
