import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

export interface RatholeOptions {
  role: "client" | "server";
  /** Path to an existing local configuration file prepared by the caller. */
  configPath: string;
}

export type RatholeSpawnRunner = (
  command: string,
  args: string[],
  options: { shell: false; stdio: "ignore"; windowsHide: true },
) => ChildProcess;

/** An error event does not necessarily mean the child has exited. */
export type RatholeOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error" };

export interface RatholeProcess {
  /** First exit or process error. An error is not proof that the child exited. */
  exited: Promise<RatholeOutcome>;
  /** Request SIGTERM once; true means accepted, not that the process exited. */
  stop(): boolean;
}

const defaultRunner: RatholeSpawnRunner = (command, args, options) => spawn(command, args, options);

/**
 * Start an already-installed rathole with a caller-prepared local config file.
 * Resolution means the OS spawned a process, not that a tunnel is connected or
 * healthy. No health probe is provided. The caller must secure the configuration,
 * credentials and encryption; this wrapper does not validate their contents.
 * The config path appears in argv, so it must not itself contain credentials.
 * Child output and third-party error messages are deliberately suppressed.
 */
export async function startRathole(
  options: RatholeOptions,
  runner: RatholeSpawnRunner = defaultRunner,
): Promise<RatholeProcess> {
  if (!options || (options.role !== "client" && options.role !== "server") ||
      typeof options.configPath !== "string" || options.configPath.length === 0 ||
      options.configPath.includes("\0")) {
    throw new Error("Invalid rathole options");
  }

  let child: ChildProcess;
  try {
    // An absolute path cannot be mistaken for a command-line option, including
    // when a relative filename begins with a dash. No config contents go in argv.
    child = runner("rathole", [`--${options.role}`, resolve(options.configPath)], {
      shell: false, stdio: "ignore", windowsHide: true,
    });
  } catch {
    throw new Error("Failed to start rathole");
  }

  let resolveExit!: (outcome: RatholeOutcome) => void;
  const exited = new Promise<RatholeOutcome>((resolve) => { resolveExit = resolve; });
  let settled = false;
  let terminated = false;
  let started = false;
  let stopRequested = false;
  const finish = (outcome: RatholeOutcome) => {
    if (!settled) { settled = true; resolveExit(outcome); }
  };
  const stop = (): boolean => {
    if (terminated || stopRequested) return false;
    stopRequested = true;
    try {
      if (child.kill("SIGTERM")) return true;
    } catch { /* Do not expose a third-party error. */ }
    stopRequested = false;
    return false;
  };

  return new Promise<RatholeProcess>((resolve, reject) => {
    child.on("error", () => {
      finish({ kind: "error" });
      if (!started) reject(new Error("Failed to start rathole"));
      else stop(); // An error alone does not prove termination.
    });
    child.once("exit", (code, signal) => {
      terminated = true;
      finish({ kind: "exit", code, signal });
      if (!started) reject(new Error("Failed to start rathole"));
    });
    child.once("spawn", () => {
      if (settled) return;
      started = true;
      resolve({ exited, stop });
    });
  });
}
