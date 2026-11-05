#!/usr/bin/env bun
/** Explicit CLI entry point. Importing this module never starts a listener. */
import { startAgentBusServer } from "./server.ts";
import { createRelayServer } from "./relay.ts";
import { startNodeRuntime } from "./node-runtime.ts";
import { startSshProxy } from "./ssh-proxy.ts";

const help = `Usage: bun src/cli.ts <server|relay|node NODE_ID|proxy NODE_ID>

server: ENVINHANDS_TOKEN (required), ENVINHANDS_HOST (default 0.0.0.0),
        ENVINHANDS_PORT (default 8787), ENVINHANDS_DB (default envinhands.sqlite).
relay:  ENVINHANDS_RELAY_SECRET (required), ENVINHANDS_RELAY_HOST (default 0.0.0.0),
        ENVINHANDS_RELAY_PORT (default 8788).
node:   ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET (required),
        ENVINHANDS_SSH_PORT (default 22; local 127.0.0.1 only).
proxy:  ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET (required).
        Use as an OpenSSH ProxyCommand; stdout carries SSH bytes only.

Pass secrets in environment variables, never in command-line arguments.
Plain ws:// exposes the relay secret and traffic: use only on a trusted network.
For public networks, use wss:// with TLS termination. The server also needs HTTPS
termination on untrusted networks. This prototype uses a shared secret; TLS alone
does not provide per-node authorization. It does not configure SSH keys or sudo.
`;

interface SignalSource {
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
}
const defaults: CliDependencies = {
  startServer: startAgentBusServer, startRelay: createRelayServer,
  startNode: startNodeRuntime, startProxy: startSshProxy,
  signals: process, stderr: process.stderr,
};
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

/** Run a command. Dependencies and environment are injectable for tests. */
export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CliDependencies> = {}): Promise<number> {
  const deps = { ...defaults, ...overrides };
  const error = (text: string) => deps.stderr.write(text + "\n");
  const [command, id] = args;
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
