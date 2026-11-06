/**
 * Verify an already-configured SSH account. This does not register a machine,
 * install keys, grant sudo, or provision administrator privileges. A ready
 * result is only a point-in-time observation for the specified account.
 * The caller must establish trust in the host key before calling this function.
 */
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { checkWindowsAdminReadiness } from "./windows-readiness.ts";

export interface ReadinessTarget {
  host: string;
  user: string;
  os: string;
  sshPort?: number;
  relayNodeId?: string;
}

export type ReadinessResult =
  | { status: "ready"; ready: true; message: string }
  | { status: "not-ready" | "unsupported"; ready: false; message: string };

/** A runner must execute argv directly, never through a local shell. */
export type CommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<{ exitCode: number | null }>;

const TIMEOUT_MS = 15_000;
const NOT_READY: ReadinessResult = { status: "not-ready", ready: false,
  message: "SSH or non-interactive sudo verification failed; check connectivity, trusted host key, authentication and sudo configuration." };

/** Default runner: no shell, terminal, inherited stdin, or captured output. */
export const runCommand: CommandRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  let settled = false;
  const child = spawn(command, [...args], { shell: false, stdio: "ignore" });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { child.kill("SIGKILL"); } catch { /* still fail closed */ }
    resolve({ exitCode: null });
  }, timeoutMs);
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ exitCode: code });
  });
});

function validHost(host: unknown): host is string {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (isIP(host)) return true;
  // DNS names only: no SSH options, URI syntax, shell metacharacters, or spaces.
  return host.split(".").every((part) => part.length > 0 && part.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part));
}

// OpenSSH expands percent tokens in ProxyCommand before the shell sees quoting.
// Reject percent in the binary path, even inside single quotes.
export async function relayProxy(nodeId: unknown): Promise<string | undefined> {
  if (process.platform === "win32" || typeof nodeId !== "string" ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(nodeId)) return undefined;
  const binary = process.env.ENVINHANDS_PROXY_BINARY;
  const relayUrl = process.env.ENVINHANDS_RELAY_URL;
  const secret = process.env.ENVINHANDS_RELAY_SECRET;
  if (!binary || !isAbsolute(binary) || /[%\x00-\x1f\x7f]/.test(binary) ||
      !relayUrl || /[\r\n\x00]/.test(relayUrl) || !secret || /[\r\n\x00]/.test(secret)) return undefined;
  try {
    const url = new URL(relayUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    if (!(await stat(binary)).isFile()) return undefined;
    await access(binary, constants.X_OK);
  } catch { return undefined; }
  // One POSIX shell word, including when the path contains a quote or spaces.
  const quoted = `'${binary.replace(/'/g, "'\\''")}'`;
  return `ProxyCommand=${quoted} proxy ${nodeId}`;
}

/**
 * Use the local SSH client's normal known-hosts files, with strict checking.
 * Unknown or changed host keys fail; this function never accepts them. The
 * client's existing SSH configuration and credentials remain in effect.
 * The SSH remote command is a fixed literal, not interpolated user input.
 */
export async function checkAdminReadiness(target: ReadinessTarget, runner: CommandRunner = runCommand): Promise<ReadinessResult> {
  if (!target || typeof target.os !== "string") return NOT_READY;
  const os = target.os.toLowerCase();
  if (os === "windows") return checkWindowsAdminReadiness(target, runner);
  if (os !== "linux" && os !== "macos") return { status: "unsupported", ready: false,
    message: "Administrator verification is supported only for Linux, macOS, and Windows." };
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
    "sudo", "-n", "true"];
  try {
    const result = await runner("ssh", args, TIMEOUT_MS);
    if (result && result.exitCode === 0) return { status: "ready", ready: true,
      message: "SSH and non-interactive sudo succeeded at the time of this check." };
  } catch { /* Spawn, transport, or runner failures must not imply readiness. */ }
  return NOT_READY;
}
