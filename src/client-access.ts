import { ENCODED_WINDOWS_ADMIN_CHECK } from "./windows-readiness.ts";
import { createHash } from "node:crypto";
import { selectSshRoute, type SshRoute, type SshAccess } from "./transports/ssh-routes.ts";
import { runCommand, type CommandRunner } from "./readiness.ts";
import type { AgentRegistrationInput } from "./change-model.ts";
import { parseRegistration } from "./change-model.ts";

export interface ClientAccessEvidence {
  registrationId: string;
  agentId: string;
  sessionId: string;
  targetMachineId: string;
  routeId: string;
  sshIdentityRef: string;
  hostKeyAlias: string;
  os: "linux" | "macos" | "windows";
  checkedAt: string;
  expiresAt: string;
  ready: boolean;
  status: "ready" | "not-ready";
  verificationScope: "actual-client-ssh-identity-and-route";
}
/** Local observation, not a server-authenticated proof or delegated access grant. */
export async function verifyClientAccess(options: {
  registration: AgentRegistrationInput; targetMachineId: string; os: "linux" | "macos" | "windows";
  routes: SshRoute[]; access: SshAccess; priority: string[]; totalBudgetMs: number; ttlMs?: number;
}, dependencies: { runner?: CommandRunner; now?: () => number } = {}): Promise<ClientAccessEvidence> {
  const registered = parseRegistration(options.registration), ttl = options.ttlMs ?? 300000;
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(options.targetMachineId) || /[\r\n]/.test(options.targetMachineId) ||
      !["linux", "macos", "windows"].includes(options.os) || !Number.isSafeInteger(ttl) || ttl < 1 ||
      !Number.isSafeInteger(options.totalBudgetMs) || options.totalBudgetMs < 1) throw new Error("Invalid access verification");
  const runner = dependencies.runner ?? runCommand, now = dependencies.now ?? Date.now;
  const deadline = now() + options.totalBudgetMs;
  const selected = await selectSshRoute(options.routes, options.access, { priority: options.priority, totalBudgetMs: options.totalBudgetMs }, { runner, now });
  const command = options.os === "windows" ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_WINDOWS_ADMIN_CHECK] : ["sudo", "-n", "true"];
  let ready = false;
  const remaining = Math.floor(deadline - now());
  if (remaining > 0) {
    try { ready = (await runner("ssh", [...selected.argv, ...command], Math.min(remaining, 15000))).exitCode === 0; }
    catch { /* Actual identity/privilege failure is not readiness. */ }
  }
  const checked = now();
  return { registrationId: registered.registrationId, agentId: registered.agentId, sessionId: registered.sessionId,
    targetMachineId: options.targetMachineId, routeId: selected.route.id,
    sshIdentityRef: createHash("sha256").update(JSON.stringify({ user: options.access.user,
      identityFile: options.access.identityFile ?? null, knownHostsFile: options.access.knownHostsFile ?? null,
      hostKeyAlias: options.access.hostKeyAlias })).digest("hex"),
    hostKeyAlias: options.access.hostKeyAlias, os: options.os, checkedAt: new Date(checked).toISOString(),
    expiresAt: new Date(checked + ttl).toISOString(), ready, status: ready ? "ready" : "not-ready",
    verificationScope: "actual-client-ssh-identity-and-route" };
}
/** Check caller, route, identity and freshness together; heartbeat cannot renew this. */
export function isClientAccessFresh(evidence: ClientAccessEvidence, expected: Pick<ClientAccessEvidence,
  "registrationId" | "sessionId" | "agentId" | "targetMachineId" | "routeId" | "sshIdentityRef" | "hostKeyAlias">, now = Date.now()): boolean {
  return evidence.ready === true && evidence.status === "ready" && Number.isFinite(now) &&
    Number.isFinite(Date.parse(evidence.checkedAt)) && Number.isFinite(Date.parse(evidence.expiresAt)) &&
    Date.parse(evidence.checkedAt) <= now && now < Date.parse(evidence.expiresAt) &&
    Object.entries(expected).every(([key, value]) => evidence[key as keyof ClientAccessEvidence] === value);
}
