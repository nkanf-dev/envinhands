import { spawn, type ChildProcess } from "node:child_process";

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
 * Launch the optional external UU viewer. It must already be installed and configured.
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
