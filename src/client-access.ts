import { ENCODED_WINDOWS_ADMIN_CHECK } from "./windows-readiness.ts";
import { createHash } from "node:crypto";
import { selectSshRoute, type SshRoute, type SshAccess } from "./transports/ssh-routes.ts";
import { runCommand, type CommandRunner } from "./readiness.ts";
import type { AgentRegistrationInput } from "./change-model.ts";
import { parseRegistration } from "./change-model.ts";

export type { ClientAccessEvidence } from "./access-evidence-model.ts";
import { publicKeyFingerprint, type ClientAccessEvidence } from "./access-evidence-model.ts";
import { isAbsolute } from "node:path";
import { runOwnedProcess } from "./process-runner.ts";

/** Derives public output with OpenSSH; JavaScript never opens private key bytes. */
export async function fingerprintSshIdentity(identityFile: string, timeoutMs: number): Promise<string> {
  if (!isAbsolute(identityFile) || /[\x00-\x1f\x7f%]/.test(identityFile)) throw new Error("An explicit absolute SSH identity file is required");
  const result = await runOwnedProcess("ssh-keygen", ["-y", "-P", "", "-f", identityFile], timeoutMs);
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) throw new Error("SSH public identity could not be derived");
  const [algorithm, encoded] = result.stdout.trim().split(/\s+/);
  const blob = Buffer.from(encoded ?? "", "base64");
  if (!algorithm || blob.length < 4 || blob.readUInt32BE(0) > blob.length - 4 || blob.subarray(4, 4 + blob.readUInt32BE(0)).toString() !== algorithm) throw new Error("Invalid SSH public identity");
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}
/** Fixed remote command; OpenSSH sends it to the remote shell verbatim.
 * Success proves this particular noninteractive root shell command, not all sudo rules. */
export const UNIX_ROOT_SHELL_CHECK = `sudo -n -- /bin/sh -c 'test "$(/usr/bin/id -u)" -eq 0'`;
/** Local observation, not a server-authenticated proof or delegated access grant. */
export async function verifyClientAccess(options: {
  registration: AgentRegistrationInput; targetMachineId: string; os: "linux" | "macos" | "windows";
  routes: SshRoute[]; access: SshAccess; priority: string[]; totalBudgetMs: number; ttlMs?: number;
}, dependencies: { runner?: CommandRunner; now?: () => number; monotonic?: () => number; fingerprint?: typeof fingerprintSshIdentity } = {}): Promise<ClientAccessEvidence> {
  const registered = parseRegistration(options.registration), ttl = options.ttlMs ?? 300000;
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(options.targetMachineId) || /[\r\n]/.test(options.targetMachineId) ||
      !["linux", "macos", "windows"].includes(options.os) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300000 || !options.access.identityFile || !isAbsolute(options.access.identityFile) ||
      !Number.isSafeInteger(options.totalBudgetMs) || options.totalBudgetMs < 1) throw new Error("Invalid access verification");
  const runner = dependencies.runner ?? runCommand, now = dependencies.now ?? Date.now;
  const monotonic = dependencies.monotonic ?? (dependencies.now ? dependencies.now : () => performance.now());
  const deadline = monotonic() + options.totalBudgetMs;
  const fingerprint = dependencies.fingerprint ?? fingerprintSshIdentity;
  const identity = publicKeyFingerprint(await fingerprint(options.access.identityFile!, Math.min(options.totalBudgetMs, 10000)));
  const probeBudget = Math.floor(deadline - monotonic());
  if (probeBudget <= 0) throw new Error("Access verification budget expired before SSH probe");
  const selected = await selectSshRoute(options.routes, options.access, { priority: options.priority, totalBudgetMs: probeBudget }, { runner, now: monotonic });
  const command = options.os === "windows" ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_WINDOWS_ADMIN_CHECK] : [UNIX_ROOT_SHELL_CHECK];
  let ready = false;
  const remaining = Math.floor(deadline - monotonic());
  if (remaining > 0) {
    try { ready = (await runner("ssh", [...selected.argv, ...command], Math.min(remaining, 15000))).exitCode === 0; }
    catch { /* Actual identity/privilege failure is not readiness. */ }
  }
  const afterKeyBudget = Math.floor(deadline - monotonic());
  if (afterKeyBudget <= 0) ready = false;
  else { try { if (publicKeyFingerprint(await fingerprint(options.access.identityFile!, Math.min(afterKeyBudget, 10000))) !== identity) ready = false; } catch { ready = false; } }
  if (monotonic() >= deadline) ready = false;
  const checked = now();
  return { registrationId: registered.registrationId, agentId: registered.agentId, sessionId: registered.sessionId,
    targetMachineId: options.targetMachineId, routeId: selected.route.id,
    sshIdentityRef: identity, sshUser: options.access.user,
    hostKeyAlias: options.access.hostKeyAlias, os: options.os, checkedAt: new Date(checked).toISOString(),
    expiresAt: new Date(checked + ttl).toISOString(), ready, status: ready ? "ready" : "not-ready",
    verificationScope: "actual-client-ssh-identity-and-route" };
}
/** Check caller, route, identity and freshness together; heartbeat cannot renew this. */
export function isClientAccessFresh(evidence: ClientAccessEvidence, expected: Pick<ClientAccessEvidence,
  "registrationId" | "sessionId" | "agentId" | "targetMachineId" | "routeId" | "sshIdentityRef" | "sshUser" | "hostKeyAlias">, now = Date.now()): boolean {
  return evidence.ready === true && evidence.status === "ready" && Number.isFinite(now) &&
    Number.isFinite(Date.parse(evidence.checkedAt)) && Number.isFinite(Date.parse(evidence.expiresAt)) &&
    Date.parse(evidence.checkedAt) <= now && now < Date.parse(evidence.expiresAt) &&
    Object.entries(expected).every(([key, value]) => evidence[key as keyof ClientAccessEvidence] === value);
}
