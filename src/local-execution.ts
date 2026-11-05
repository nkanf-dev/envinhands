import { runOwnedProcess } from "./process-runner.ts";
import { isAbsolute } from "node:path";
import { runAuditedOperation } from "./audited-operation.ts";
import type { AgentRegistrationInput, ChangeInput } from "./change-model.ts";
import type { ChangeSpool } from "./change-spool.ts";

export interface LocalExecution {
  registration: AgentRegistrationInput;
  change: Omit<ChangeInput, "requestId" | "outcome" | "occurredAt">;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  spool: ChangeSpool;
}
/** Authorized local argv execution, with the same audit boundary as remote work. */
export async function runLocalExecution(options: LocalExecution) {
  if (typeof options.executable !== "string" || !options.executable || /[\x00\r\n]/.test(options.executable) ||
      !Array.isArray(options.args) || options.args.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
      typeof options.cwd !== "string" || !isAbsolute(options.cwd) ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647 ||
      options.change.targetMachineId !== options.registration.machineId) throw new Error("Invalid local execution target");
  let started = false, exitCode: number | null = null, timedOut = false;
  const audit = await runAuditedOperation(options.registration, options.change, options.spool, async () => {
    const completion = await runOwnedProcess(options.executable, options.args, options.timeoutMs, options.cwd);
    started = completion.started;
    exitCode = completion.exitCode; timedOut = completion.timedOut;
    return { outcome: exitCode === 0 ? "success" : exitCode === null ? "unknown" : "failed" };
  });
  return { ...audit, started, exitCode, timedOut };
}
