/**
 * Point-in-time check of the effective administrator token in this SSH session.
 * It does not elevate, change the host, or prove the identity or privileges of
 * any other Agent/session. Callers must first trust the host key.
 */
import { isIP } from "node:net";
import { relayProxy, runCommand } from "./readiness.ts";
import type { CommandRunner, ReadinessResult, ReadinessTarget } from "./readiness.ts";

const TIMEOUT_MS = 15_000;
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
const ENCODED_SCRIPT = Buffer.from(SCRIPT, "utf16le").toString("base64");

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
  if (!validHost(target.host) || typeof target.user !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(target.user) ||
      !Number.isInteger(port) || port < 1 || port > 65535 || typeof runner !== "function") return NOT_READY;
  const proxyOptions: string[] = [];
  if (target.relayNodeId !== undefined) {
    const proxy = await relayProxy(target.relayNodeId);
    if (!proxy) return NOT_READY;
    proxyOptions.push("-o", proxy);
  }
  const args = ["-T", "-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10", ...proxyOptions, "-p", String(port), "-l", target.user, "--", target.host,
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT];
  try {
    const result = await runner("ssh", args, TIMEOUT_MS);
    if (result && result.exitCode === 0) return { status: "ready", ready: true,
      message: "The checked SSH session had an effective Windows administrator token at the time of this check; this does not verify any other Agent or session." };
  } catch { /* Fail closed on process, transport, and runner errors. */ }
  return NOT_READY;
}
