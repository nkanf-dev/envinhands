import { spawn, type ChildProcess } from "node:child_process";
import { buildSshRouteArgv, type SshAccess, type SshRoute } from "./ssh-routes.ts";
import { runCommand, type CommandRunner } from "../readiness.ts";

/** A process launch is not proof that the port mapping or destination is ready. */
export interface UuPortmapOptions {
  device: string;
  localPort: number;
  host?: string;
  port: number;
}

export type UuSpawnRunner = (
  command: string,
  args: string[],
  options: { shell: false; stdio: "ignore"; windowsHide: true },
) => ChildProcess;

export type UuExit =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error" };

export interface UuPortmapProcess {
  /** Settles when the child exits or reports a process error, not when a mapping is ready. */
  exited: Promise<UuExit>;
  /** Request SIGTERM once. True means the request was accepted, not that it exited. */
  stop(): boolean;
}

const defaultRunner: UuSpawnRunner = (command, args, options) => spawn(command, args, options);

function validatePort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Launch the optional external, unofficial uu-remote-linux viewer. It must
 * already be installed and configured. Upstream is GPL-3.0-or-later:
 * https://github.com/VallierDev/uu-remote-linux . Check its license and the
 * UU service terms and obtain any required permission before using it.
 * Only the literal target host 127.0.0.1 is allowed. This does not control the
 * viewer's local listen address or provide authentication or readiness checks.
 */
export async function startUuPortmap(
  options: UuPortmapOptions,
  runner: UuSpawnRunner = defaultRunner,
): Promise<UuPortmapProcess> {
  if (!options || typeof options.device !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.device)) {
    throw new Error("Invalid UU device identifier");
  }
  if (!validatePort(options.localPort) || !validatePort(options.port)) {
    throw new Error("Invalid UU port");
  }
  const host = options.host === undefined ? "127.0.0.1" : options.host;
  if (host !== "127.0.0.1") throw new Error("Invalid UU target host");

  let child: ChildProcess;
  try {
    child = runner("uuremote-viewer", ["portmap", options.device, String(options.localPort), host, String(options.port)], {
      shell: false, stdio: "ignore", windowsHide: true,
    });
  } catch {
    // Do not expose third-party messages, which could contain sensitive information.
    throw new Error("Failed to start UU viewer");
  }

  let resolveExit!: (result: UuExit) => void;
  const exited = new Promise<UuExit>((resolve) => { resolveExit = resolve; });
  let settled = false;
  let terminated = false;
  let started = false;
  let stopRequested = false;
  const finish = (result: UuExit) => {
    if (!settled) { settled = true; resolveExit(result); }
  };
  const stop = (): boolean => {
    if (terminated || stopRequested) return false;
    stopRequested = true;
    try {
      if (child.kill("SIGTERM")) return true;
    } catch { /* Do not expose the third-party error. */ }
    stopRequested = false;
    return false;
  };

  return new Promise<UuPortmapProcess>((resolve, reject) => {
    child.on("error", () => {
      finish({ kind: "error" });
      if (!started) reject(new Error("Failed to start UU viewer"));
      else stop(); // A process error does not necessarily mean that the child exited.
    });
    child.once("exit", (code, signal) => {
      terminated = true;
      finish({ kind: "exit", code, signal });
      if (!started) reject(new Error("Failed to start UU viewer"));
    });
    child.once("spawn", () => {
      if (settled) return;
      started = true;
      resolve({ exited, stop });
    });
  });
}

/** A local endpoint made available by a mapping configured outside this process.
 * The caller is responsible for checking its listen address and access control.
 */
export interface UuMappedSshOptions {
  id: string;
  localPort: number;
  access: SshAccess;
  timeoutMs?: number;
}
export interface UuMappedSshProbe {
  /** Point-in-time SSH trust and user authentication result, not proof of UU. */
  status: "healthy" | "failed";
  route: SshRoute;
  /** Suitable for a new SSH connection; never replay an already-started command. */
  argv: string[];
  /** A strict SSH probe cannot establish the local app's installation or login state. */
  installation: "unknown";
  login: "unknown";
}

/**
 * Probe an operator-created UU port mapping, or a compatible local listener.
 * A successful strict-host-key SSH connection proves the SSH identity and
 * account at that instant. It does NOT prove that the listener belongs to UU,
 * that the UU user is logged in, or that the mapping will remain available.
 * Establish host-key trust independently before calling. On failure, do not
 * reuse an older healthy observation. Re-probe for new connections. No remote
 * work is retried or replayed. This runs only the fixed, harmless SSH `true`.
 */
export async function probeUuMappedSsh(
  options: UuMappedSshOptions, runner: CommandRunner = runCommand,
): Promise<UuMappedSshProbe> {
  if (!options || !validatePort(options.localPort)) throw new Error("Invalid UU local port");
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647 || typeof runner !== "function") {
    throw new Error("Invalid UU SSH probe");
  }
  const route: SshRoute = { id: options.id, host: "127.0.0.1", port: options.localPort };
  const argv = buildSshRouteArgv(route, options.access);
  let status: UuMappedSshProbe["status"] = "failed";
  try {
    if ((await runner("ssh", [...argv, "true"], timeout))?.exitCode === 0) status = "healthy";
  } catch { /* Never forward third-party output or claim readiness. */ }
  return { status, route, argv, installation: "unknown", login: "unknown" };
}


/**
 * Check that the configured non-official viewer starts and handles --help.
 * This does not authenticate the binary or prove the UU app is installed.
 */
export async function probeUuViewerInstallation(
  runner: CommandRunner = runCommand,
): Promise<"available" | "unavailable"> {
  try {
    return (await runner("uuremote-viewer", ["--help"], 5000))?.exitCode === 0 ? "available" : "unavailable";
  } catch { return "unavailable"; }
}

/**
 * Explicit opt-in network call to the unofficial viewer's device-list API.
 * The command reads the viewer's local credentials; its output is discarded.
 * It does not log in or request a QR code. A successful response is a
 * point-in-time indication that the configured viewer's account was accepted.
 * Errors (including offline and expired credentials) are indistinguishable and
 * reported as unknown, never as definitively logged out. This does not prove a
 * particular device or port mapping is available. The viewer's API schema and
 * compatibility are not official contracts and may change without notice.
 */
export async function probeUuViewerAccount(
  runner: CommandRunner = runCommand,
): Promise<"accepted" | "unknown"> {
  try {
    const result = await runner("uuremote-viewer", ["devices", "GET", "/data/my_binded_devices", "/device_id", "/alias"], 15000);
    return result?.exitCode === 0 ? "accepted" : "unknown";
  } catch { return "unknown"; }
}
