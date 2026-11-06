/** Interactive team SSH route selection. Network catalog entries are observations, not trust. */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fetchTransportCatalog, selectCatalogSshRoute } from "./transport-catalog.ts";
import { SshRoutesUnavailable, validSshHostKeyAlias, validSshUser } from "./transports/ssh-routes.ts";
import type { CommandRunner } from "./readiness.ts";

type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;
type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface RouteConnectDependencies {
  fetch?: Fetcher;
  runner?: CommandRunner;
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  signal?: AbortSignal;
  stderr?: (message: string) => void;
  /** Override for platform compatibility tests. */
  platform?: NodeJS.Platform;
  totalBudgetMs?: number;
  probeTimeoutMs?: number;
}

/** Return a process exit code; the parent CLI owns process.exitCode and signal handling. */
export async function runRouteConnectCli(args: readonly string[], deps: RouteConnectDependencies = {}): Promise<number> {
  const err = deps.stderr ?? ((message: string) => process.stderr.write(message + "\n"));
  const env = deps.env ?? process.env;
  const signal = deps.signal;
  const spawn = deps.spawn ?? ((command, argv, options) => nodeSpawn(command, [...argv], options));
  const fail = (message: string, code = 1) => { err(message); return code; };
  if (args.length !== 3 || args[0] !== "connect") return fail("Usage: envinhands connect MACHINE_ID USER", 2);
  const [, machineId, user] = args as [string, string, string];
  // hostKeyAlias must be a locally supplied stable machine ID, not a catalog field.
  if (!validSshHostKeyAlias(machineId) || !validSshUser(user)) return fail("Invalid machine ID or SSH user.", 2);
  if (signal?.aborted) return fail("Connection cancelled.", 130);
  if (!(deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) return fail("Interactive SSH requires a TTY. Run this command in a terminal; check SSH keys, known_hosts and network separately for non-interactive diagnosis.", 2);
  if (!env.ENVINHANDS_URL || !env.ENVINHANDS_TOKEN || !env.ENVINHANDS_SSH_IDENTITY || !env.ENVINHANDS_SSH_KNOWN_HOSTS)
    return fail("Set ENVINHANDS_URL, ENVINHANDS_TOKEN, ENVINHANDS_SSH_IDENTITY and ENVINHANDS_SSH_KNOWN_HOSTS; trust the machine host key locally first.", 2);
  let page;
  try {
    const fetcher: Fetcher = (url, init) => (deps.fetch ?? fetch)(url, {...init, signal});
    const pending = fetchTransportCatalog(env.ENVINHANDS_URL, env.ENVINHANDS_TOKEN, machineId, fetcher);
    page = signal ? await new Promise<Awaited<typeof pending>>((resolvePage, rejectPage) => {
      const cancel = () => { signal.removeEventListener("abort", cancel); rejectPage(new Error("cancelled")); };
      signal.addEventListener("abort", cancel, {once:true});
      pending.then(value => { signal.removeEventListener("abort", cancel); resolvePage(value); }, error => { signal.removeEventListener("abort", cancel); rejectPage(error); });
      if (signal.aborted) cancel();
    }) : await pending;
  } catch { return signal?.aborted ? fail("Connection cancelled.", 130) : fail("Cannot fetch the transport catalog. Check URL, token and network."); }
  if (signal?.aborted) return fail("Connection cancelled.", 130);
  const windows = (deps.platform ?? process.platform) === "win32";
  const relayUrl = env.ENVINHANDS_RELAY_URL, relaySecret = env.ENVINHANDS_RELAY_SECRET;
  let relayReady = !windows && Boolean(env.ENVINHANDS_PROXY_BINARY && isAbsolute(env.ENVINHANDS_PROXY_BINARY) && !/[%\x00-\x1f\x7f]/.test(env.ENVINHANDS_PROXY_BINARY) && relayUrl && relaySecret && !/[\x00-\x1f\x7f]/.test(relaySecret));
  try { const url = new URL(relayUrl ?? ""); if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) relayReady = false; } catch { relayReady = false; }
  // Work around catalog's eager validation of every route: an unsupported or
  // unconfigured relay must not suppress usable direct/P2P routes.
  const skippedRelay = page.routes.some(r => r.kind === "relay" && r.status === "observed") && !relayReady;
  if (!relayReady) page = {...page, routes: page.routes.filter(r => r.kind !== "relay")};
  // Catalog requires an absolute binary path even for direct-only selections.
  const binary = relayReady ? env.ENVINHANDS_PROXY_BINARY! : resolve("envinhands-unused-proxy");
  const access = {user, hostKeyAlias: machineId, identityFile: env.ENVINHANDS_SSH_IDENTITY, knownHostsFile: env.ENVINHANDS_SSH_KNOWN_HOSTS};
  // Never give the catalog bearer token to ssh or the relay proxy.
  const childEnv = {...env}; delete childEnv.ENVINHANDS_TOKEN;
  if (!relayReady) { delete childEnv.ENVINHANDS_RELAY_URL; delete childEnv.ENVINHANDS_RELAY_SECRET; }
  const runner: CommandRunner = deps.runner ?? ((command, argv, timeout) => new Promise(resolveProbe => {
    if (signal?.aborted) return resolveProbe({exitCode:null});
    let child: ChildProcess;
    try { child = spawn(command, argv, {shell:false, stdio:"ignore", env:childEnv}); }
    catch { return resolveProbe({exitCode:null}); }
    let settled = false;
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); resolveProbe({exitCode:code}); };
    const cancel = () => { try { child.kill("SIGKILL"); } catch {} finish(null); };
    const timer = setTimeout(cancel, timeout);
    child.once("error", () => finish(null)); child.once("close", code => finish(code));
    signal?.addEventListener("abort", cancel, {once:true});
    if (signal?.aborted) cancel();
  }));
  // Race injected runners too, so stopping never starts the interactive process.
  const cancellableRunner: CommandRunner = async (command, argv, timeout) => {
    if (!signal) return runner(command, argv, timeout);
    if (signal.aborted) throw new Error("cancelled");
    return new Promise((resolveProbe, rejectProbe) => {
      const cancel = () => { signal.removeEventListener("abort", cancel); rejectProbe(new Error("cancelled")); };
      signal.addEventListener("abort", cancel, {once:true});
      Promise.resolve().then(() => runner(command, argv, timeout)).then(value => { signal.removeEventListener("abort", cancel); resolveProbe(value); }, error => { signal.removeEventListener("abort", cancel); rejectProbe(error); });
      if (signal.aborted) cancel();
    });
  };
  let selected;
  try {
    const budget = deps.totalBudgetMs ?? 60000, timeout = deps.probeTimeoutMs ?? 10000;
    if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error("Invalid probe budget");
    const direct = page.routes.filter(r => r.kind !== "relay"), relay = page.routes.filter(r => r.kind === "relay");
    // Reserve a part of the total probe budget for relay, even when many P2P
    // candidates time out. Never retry the eventual interactive session.
    const split = direct.length > 0 && relay.length > 0 && budget > 1;
    const relayBudget = split ? Math.min(timeout, Math.max(1, Math.floor(budget / 2))) : 0;
    try {
      selected = await selectCatalogSshRoute(split ? {...page, routes:direct} : page, machineId, {access, relayBinaryPath: binary}, {totalBudgetMs:budget-relayBudget, probeTimeoutMs:timeout}, {runner:cancellableRunner});
    } catch (error) {
      if (!(error instanceof SshRoutesUnavailable) || !split || signal?.aborted) throw error;
      try { selected = await selectCatalogSshRoute({...page,routes:relay}, machineId, {access, relayBinaryPath:binary}, {totalBudgetMs:relayBudget, probeTimeoutMs:timeout}, {runner:cancellableRunner}); }
      catch (fallbackError) {
        if (fallbackError instanceof SshRoutesUnavailable) throw new SshRoutesUnavailable([...error.observations, ...fallbackError.observations]);
        throw fallbackError;
      }
    }
  } catch (error) {
    if (signal?.aborted) return fail("Connection cancelled.", 130);
    if (error instanceof SshRoutesUnavailable) return fail(`No verified SSH route (${error.observations.length} probes failed or timed out). Check connectivity, public key and the trusted host key.${skippedRelay ? " Relay unavailable: configure it locally or use a supported platform." : ""}`);
    return fail("Invalid SSH configuration or catalog route. Check local credential paths and relay configuration.");
  }
  if (signal?.aborted) return fail("Connection cancelled.", 130);
  // The selected argv has probe-only -T and -n, and contains no remote command.
  const argv = selected.argv.filter(arg => arg !== "-T" && arg !== "-n");
  argv.splice(2, 0, "-tt");
  return new Promise(resolveExit => {
    let child: ChildProcess;
    try { child = spawn("ssh", argv, {shell:false, stdio:"inherit", env:childEnv}); }
    catch { err("Could not start SSH. Check that ssh is installed."); return resolveExit(1); }
    let settled = false;
    const finish = (code:number) => { if (settled) return; settled = true; signal?.removeEventListener("abort", cancel); resolveExit(code); };
    const cancel = () => { try { child.kill("SIGTERM"); } catch {} finish(130); };
    child.once("error", () => { err("Could not start SSH. Check that ssh is installed."); finish(1); });
    child.once("close", (code, sig) => { if (settled) return; if (code !== 0) err("SSH session ended unsuccessfully; check SSH diagnostics above. The session was not retried."); finish(code ?? (sig ? 128 : 1)); });
    signal?.addEventListener("abort", cancel, {once:true});
    if (signal?.aborted) cancel();
  });
}
