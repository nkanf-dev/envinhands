import { spawn } from "node:child_process";

export interface ProcessReceipt { started: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; outputTruncated: boolean }
/** One owned child, argv not shell. Timeout does not prove descendant/remote work stopped. */
export function runOwnedProcess(executable: string, args: string[], timeoutMs: number, cwd?: string): Promise<ProcessReceipt> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let started = false, settled = false, outputTruncated = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let captured = 0;
    const capture = (destination: Buffer[], chunk: Buffer) => {
      const available = Math.max(0, 65536 - captured);
      destination.push(chunk.subarray(0, available));
      captured += Math.min(available, chunk.length);
      if (chunk.length > available) outputTruncated = true;
    };
    child.stdout.on("data", chunk => capture(stdout, chunk));
    child.stderr.on("data", chunk => capture(stderr, chunk));
    const receipt = (exitCode: number | null, timedOut: boolean): ProcessReceipt => ({ started, exitCode, timedOut,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), outputTruncated });
    child.once("spawn", () => { started = true; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill("SIGKILL"); resolve(receipt(null, true));
    }, timeoutMs);
    child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Command could not start")); } });
    child.once("close", exitCode => { if (!settled) { settled = true; clearTimeout(timer); resolve(receipt(exitCode, false)); } });
  });
}
