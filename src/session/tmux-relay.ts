import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { buildTmuxSshArgv } from "./tmux.ts";

export interface TmuxRelayOptions {
  nodeId: string;
  sessionKey: string;
  user?: string;
  /** Absolute path to the compiled envinhands executable. Defaults to process.execPath. */
  binaryPath?: string;
  /** SSH executable, passed as argv[0], never interpreted by a shell. */
  sshExecutable?: string;
  /** Test/target platform; Windows is unsupported regardless of this value. */
  platform?: NodeJS.Platform;
}

/** Quote an argument for the POSIX shell and OpenSSH's %-token expansion. */
function quoteProxyArgument(value: string): string {
  return "'" + value.replaceAll("%", "%%").replaceAll("'", "'\\''") + "'";
}

/**
 * Construct SSH argv only. Launch argv[0] with argv.slice(1), shell: false and
 * inherited environment and terminal streams. The child proxy inherits
 * ENVINHANDS_RELAY_URL and ENVINHANDS_RELAY_SECRET; neither belongs in argv.
 * The default binary is correct only when the caller is the compiled CLI.
 * Use wss:// for untrusted networks; the relay uses a shared secret.
 *
 * The deterministic host name is the OpenSSH known-hosts identity for this
 * node ID, not a DNS lookup. Trust its real SSH host key out of band first.
 * Different relays using the same node ID share that identity. SSH's own
 * configuration and known-hosts files still apply. No Windows shell support.
 */
export function buildTmuxRelayArgv(options: TmuxRelayOptions): string[] {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some((key) => !["nodeId", "sessionKey", "user", "binaryPath", "sshExecutable", "platform"].includes(key))) {
    throw new Error("Invalid tmux relay options");
  }
  if (process.platform === "win32" || options.platform === "win32") {
    throw new Error("Windows is unsupported for SSH ProxyCommand");
  }
  const { nodeId, sessionKey, user, sshExecutable = "ssh", binaryPath = process.execPath } = options;
  if (typeof nodeId !== "string" || nodeId.length < 1 || nodeId.length > 128 ||
      !/^[A-Za-z0-9_-]/.test(nodeId) || /[^A-Za-z0-9._-]/.test(nodeId)) {
    throw new Error("Invalid node id");
  }
  if (typeof binaryPath !== "string" || !isAbsolute(binaryPath) || /[\x00-\x1f\x7f]/.test(binaryPath)) {
    throw new Error("Invalid absolute binary path");
  }
  if (typeof sshExecutable !== "string" || !sshExecutable || /[\x00-\x1f\x7f]/.test(sshExecutable)) {
    throw new Error("Invalid SSH executable");
  }
  const hash = createHash("sha256").update(nodeId, "utf8").digest("hex");
  const host = `envinhands-${hash.slice(0, 32)}.${hash.slice(32)}`;
  const argv = buildTmuxSshArgv({ host, sessionKey, user });
  argv[0] = sshExecutable;
  argv.splice(4, 0, "-o", `ProxyCommand=${quoteProxyArgument(binaryPath)} proxy ${quoteProxyArgument(nodeId)}`);
  return argv;
}
