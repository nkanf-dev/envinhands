/**
 * Point-in-time check of the effective administrator token in this SSH session.
 * It does not elevate, change the host, or prove the identity or privileges of
 * any other Agent/session. Callers must first trust the host key.
 */
import { isIP } from "node:net";
import { relayProxy, runCommand, SSH_TIMEOUT_MS, SSH_CONNECT_TIMEOUT_OPTION } from "./readiness.ts";
import type { CommandRunner, ReadinessResult, ReadinessTarget } from "./readiness.ts";

const NOT_READY: ReadinessResult = { status: "not-ready", ready: false,
  message: "Windows SSH administrator token verification failed; check connectivity, trusted host key, authentication and the effective session token." };

// EncodedCommand avoids remote-shell quoting and is made only from this fixed
// script, never from target fields. IsInRole checks the current token's enabled
// Administrators SID, rather than querying the account's group memberships.
const SCRIPT = `$ErrorActionPreference = 'Stop'
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity) { exit 1 }
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }
  exit 1
} catch { exit 1 }`;
export const ENCODED_WINDOWS_ADMIN_CHECK = Buffer.from(SCRIPT, "utf16le").toString("base64");

function validHost(host: unknown): host is string {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (isIP(host)) return true;
  return host.split(".").every((part) => part.length > 0 && part.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part));
}

/** Use the normal SSH known-hosts files. Never accept an unknown host key. */
export async function checkWindowsAdminReadiness(target: ReadinessTarget, runner: CommandRunner = runCommand): Promise<ReadinessResult> {
  if (!target || typeof target.os !== "string") return NOT_READY;
  if (target.os.toLowerCase() !== "windows") return { status: "unsupported", ready: false,
    message: "This check supports only Windows administrator tokens." };
  const port = target.sshPort === undefined ? 22 : target.sshPort;
  if (!validHost(target.host) || typeof target.user !== "string" || target.user.length > 64 ||
      !/^[A-Za-z0-9_]/.test(target.user) || /[^A-Za-z0-9_. -]/.test(target.user) || /[ .]$/.test(target.user) ||
      !Number.isInteger(port) || port < 1 || port > 65535 || typeof runner !== "function") return NOT_READY;
  const proxyOptions: string[] = [];
  if (target.relayNodeId !== undefined) {
    const proxy = await relayProxy(target.relayNodeId);
    if (!proxy) return NOT_READY;
    proxyOptions.push("-o", proxy);
  }
  const args = ["-T", "-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", SSH_CONNECT_TIMEOUT_OPTION, ...proxyOptions, "-p", String(port), "-l", target.user, "--", target.host,
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_WINDOWS_ADMIN_CHECK];
  const start = performance.now();
  try {
    const result = await runner("ssh", args, SSH_TIMEOUT_MS);
    const sshDurationMs = Math.round(performance.now() - start);
    if (result && result.exitCode === 0 && !result.timedOut) return { status: "ready", ready: true, sshDurationMs,
      message: `The checked SSH session had an effective Windows administrator token at the time of this check; this does not verify any other Agent or session. SSH duration: ${sshDurationMs} ms.` };
    if (result?.timedOut) return { ...NOT_READY, sshDurationMs, timeoutStage: "ssh-process",
      message: `Windows SSH process timed out after ${sshDurationMs} ms; connection versus remote command stage is unknown.` };
    return { ...NOT_READY, sshDurationMs, message: `${NOT_READY.message} SSH duration: ${sshDurationMs} ms.` };
  } catch { /* Fail closed on process, transport, and runner errors. */
    const sshDurationMs = Math.round(performance.now() - start);
    return { ...NOT_READY, sshDurationMs, message: `${NOT_READY.message} SSH duration: ${sshDurationMs} ms.` };
  }
}
