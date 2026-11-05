/** Real SSH probes for new connections. Never retry a started remote command. */
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { selectTransport, type TransportCandidate } from "./policy.ts";
import { runCommand, type CommandRunner } from "../readiness.ts";

export interface SshRoute {
  id: string;
  host: string;
  port?: number;
  /** Optional preconfigured jump host. Authentication stays in local SSH config. */
  jump?: string;
}
export interface SshAccess {
  user: string;
  /** The same trusted known_hosts name across every path, never accept-new. */
  hostKeyAlias: string;
  identityFile?: string;
  knownHostsFile?: string;
}
export interface RouteObservation { routeId: string; exitCode: number | null; status: "healthy" | "failed" }
export interface SelectedSshRoute { route: SshRoute; argv: string[]; observations: RouteObservation[] }
function host(value: string): boolean {
  return typeof value === "string" && !/[\x00-\x20\x7f]/.test(value) && value.length <= 253 && (isIP(value) !== 0 ||
    value.split(".").every(p => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(p)));
}
export function buildSshRouteArgv(route: SshRoute, access: SshAccess): string[] {
  if (!route || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(route.id) || /[\r\n]/.test(route.id) || !host(route.host) ||
      !Number.isInteger(route.port ?? 22) || (route.port ?? 22) < 1 || (route.port ?? 22) > 65535 ||
      !access || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(access.user) || /[\r\n]/.test(access.user) || !host(access.hostKeyAlias) ||
      (route.jump !== undefined && !host(route.jump))) throw new Error("Invalid SSH route");
  const args = ["-T", "-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
    "-o", `HostKeyAlias=${access.hostKeyAlias}`];
  for (const [option, value] of [["IdentityFile", access.identityFile], ["UserKnownHostsFile", access.knownHostsFile]]) {
    if (value === undefined) continue;
    if (!isAbsolute(value) || /[\x00-\x1f\x7f%]/.test(value)) throw new Error("Invalid SSH credential path");
    args.push("-o", `${option}=${value}`);
  }
  if (access.identityFile) args.push("-o", "IdentitiesOnly=yes");
  if (route.jump) args.push("-J", route.jump);
  args.push("-p", String(route.port ?? 22), "-l", access.user, "--", route.host);
  return args;
}
/** Probe authentication + host trust via true. Total budget bounds all attempts. */
export async function selectSshRoute(routes: readonly SshRoute[], access: SshAccess, options: {
  priority: readonly string[]; totalBudgetMs: number; probeTimeoutMs?: number;
}, dependencies: { runner?: CommandRunner; now?: () => number } = {}): Promise<SelectedSshRoute> {
  const timeout = options.probeTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(options.totalBudgetMs) || options.totalBudgetMs < 1 ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error("Invalid probe budget");
  // Validate every route before running even the first probe.
  const argv = new Map<string, string[]>();
  for (const route of routes) {
    if (argv.has(route.id)) throw new Error("Duplicate SSH route");
    argv.set(route.id, buildSshRouteArgv(route, access));
  }
  const ranked = [...routes].sort((a, b) => {
    const ai = options.priority.indexOf(a.id), bi = options.priority.indexOf(b.id);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
  });
  const now = dependencies.now ?? Date.now, runner = dependencies.runner ?? runCommand;
  const deadline = now() + options.totalBudgetMs, observations: RouteObservation[] = [];
  const candidates: TransportCandidate[] = [];
  for (const route of ranked) {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) break;
    let exitCode: number | null = null;
    try { exitCode = (await runner("ssh", [...argv.get(route.id)!, "true"], Math.min(remaining, timeout))).exitCode; }
    catch { /* A failed probe never authorizes connection or command replay. */ }
    const status = exitCode === 0 ? "healthy" : "failed";
    observations.push({ routeId: route.id, exitCode, status });
    candidates.push({ id: route.id, source: "ssh", enabled: true, configured: true, probe: { status, checkedAt: now() } });
    if (status === "healthy") {
      const selected = selectTransport(candidates, { priority: options.priority, maxAgeMs: options.totalBudgetMs, now: now() });
      return { route: route, argv: argv.get(selected.id)!, observations };
    }
  }
  throw new SshRoutesUnavailable(observations);
}
export class SshRoutesUnavailable extends Error {
  constructor(readonly observations: RouteObservation[]) { super("No verified SSH route within the probe budget"); }
}
