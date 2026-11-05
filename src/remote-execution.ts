import { runOwnedProcess } from "./process-runner.ts";
import { buildSshRouteArgv, selectSshRoute, type SshRoute, type SshAccess } from "./transports/ssh-routes.ts";
import { runAuditedOperation } from "./audited-operation.ts";
import { ChangeSpool } from "./change-spool.ts";
import { parseRegistration, type AgentRegistrationInput, type ChangeInput } from "./change-model.ts";

export interface RemoteExecution {
  registration: AgentRegistrationInput;
  change: Omit<ChangeInput, "requestId" | "outcome" | "occurredAt">;
  routes: SshRoute[];
  access: SshAccess;
  priority: string[];
  probeBudgetMs: number;
  command: string;
  timeoutMs: number;
  spool: ChangeSpool;
}
/** Executes one authorized remote command, never retries after a command started. */
export async function runRemoteExecution(options: RemoteExecution) {
  parseRegistration(options.registration);
  if (!Array.isArray(options.routes) || !Array.isArray(options.priority) ||
      !options.priority.every(id => typeof id === "string")) throw new Error("Invalid routes");
  for (const route of options.routes) buildSshRouteArgv(route, options.access);
  if (typeof options.command !== "string" || !options.command.trim() || options.command.includes("\0") ||
      new TextEncoder().encode(options.command).length > 8192 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647)
    throw new Error("Invalid remote command");
  let routeId: string | null = null, exitCode: number | null = null, timedOut = false, started = false;
  const audit = await runAuditedOperation(options.registration, options.change, options.spool, async () => {
    const selected = await selectSshRoute(options.routes, options.access,
      { priority: options.priority, totalBudgetMs: options.probeBudgetMs });
    routeId = selected.route.id;
    const completion = await runOwnedProcess("ssh", [...selected.argv, options.command], options.timeoutMs);
    started = completion.started;
    exitCode = completion.exitCode; timedOut = completion.timedOut;
    // SSH255 or timeout can follow a real side effect, so report unknown, not failed/retryable.
    return { outcome: exitCode === 0 ? "success" : exitCode === 255 || exitCode === null ? "unknown" : "failed" };
  });
  return { ...audit, routeId, started, exitCode, timedOut };
}
