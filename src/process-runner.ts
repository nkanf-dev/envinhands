import { spawn } from "node:child_process";

export interface ProcessReceipt { started: boolean; exitCode: number | null; timedOut: boolean }
/** One owned child, argv not shell. Timeout never proves its remote/descendant work stopped. */
export function runOwnedProcess(executable: string, args: string[], timeoutMs: number, cwd?: string): Promise<ProcessReceipt> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", process.stderr, process.stderr] });
    let started = false, settled = false;
    child.once("spawn", () => { started = true; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill("SIGKILL"); resolve({ started, exitCode: null, timedOut: true });
    }, timeoutMs);
    child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Command could not start")); } });
    child.once("close", exitCode => { if (!settled) { settled = true; clearTimeout(timer); resolve({ started, exitCode, timedOut: false }); } });
  });
}
