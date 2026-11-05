import { isIP } from "node:net";

/** Only structured SSH options are supported. Arbitrary SSH flags are not accepted. */
export interface TmuxSessionOptions {
  host: string;
  sessionKey: string;
  user?: string;
  port?: number;
}

function validHost(host: unknown): host is string {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  // Unbracketed IP literals are passed directly to ssh. Scoped IPv6 is not supported.
  if (!host.includes("%") && isIP(host)) return true;
  return host.split(".").every((label) =>
    label.length > 0 && label.length <= 63 &&
    !/[^A-Za-z0-9-]/.test(label) &&
    /^[A-Za-z0-9]/.test(label) && /[A-Za-z0-9]$/.test(label)
  );
}

/**
 * Build argv, including argv[0], without launching a process or contacting a host.
 * Run argv[0] with argv.slice(1) and shell: false, with a suitable interactive tty.
 * OpenSSH joins the remote command arguments for a remote shell, so all values in
 * that command are restricted to shell-safe characters. SSH configuration and its
 * known-hosts files still apply; strict checking requires the host key to be trusted.
 *
 * Reattachment requires the same tmux server/session to remain alive. It is not
 * persistence across machine restart. Windows/WSL support is not assumed.
 */
export function buildTmuxSshArgv(options: TmuxSessionOptions): string[] {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some((key) => !["host", "sessionKey", "user", "port"].includes(key))) {
    throw new Error("Invalid tmux session options");
  }
  const { host, sessionKey, user, port } = options;
  if (!validHost(host)) throw new Error("Invalid SSH host");
  if (typeof sessionKey !== "string" || sessionKey.length < 1 || sessionKey.length > 64 ||
      /[^A-Za-z0-9_-]/.test(sessionKey) || !/^[A-Za-z0-9]/.test(sessionKey)) {
    throw new Error("Invalid session key");
  }
  if (user !== undefined && (typeof user !== "string" || user.length < 1 || user.length > 32 ||
      /[^A-Za-z0-9_.-]/.test(user) || !/^[A-Za-z_]/.test(user))) {
    throw new Error("Invalid SSH user");
  }
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Invalid SSH port");
  }
  const argv = ["ssh", "-tt", "-o", "StrictHostKeyChecking=yes"];
  if (user !== undefined) argv.push("-l", user);
  if (port !== undefined) argv.push("-p", String(port));
  argv.push(host, "tmux", "new-session", "-A", "-s", `envinhands-${sessionKey}`);
  return argv;
}
