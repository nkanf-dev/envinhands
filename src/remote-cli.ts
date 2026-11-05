import { runLocalExecution, type LocalExecution } from "./local-execution.ts";
import { runRemoteExecution, type RemoteExecution } from "./remote-execution.ts";
import { ChangeSpool } from "./change-spool.ts";
import { isAbsolute } from "node:path";
import type { ChangeCliIO } from "./change-cli.ts";

export async function runRemoteCli(args: string[], env: NodeJS.ProcessEnv, io: Pick<ChangeCliIO, "readInput" | "write" | "error">): Promise<number> {
  try {
    const local = args.length === 1 && args[0] === "--local";
    if ((!local && args.length !== 0) || !env.ENVINHANDS_CHANGE_SPOOL || !isAbsolute(env.ENVINHANDS_CHANGE_SPOOL)) throw new Error();
    const input = await io.readInput();
    if (new TextEncoder().encode(input).length > 16384 || (env.ENVINHANDS_TOKEN && input.includes(env.ENVINHANDS_TOKEN))) throw new Error();
    const value = JSON.parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !(local ? ["registration", "change", "executable", "args", "cwd", "timeoutMs"] :
          ["registration", "change", "routes", "access", "priority", "probeBudgetMs", "command", "timeoutMs"]).includes(key))) throw new Error();
    const spool = new ChangeSpool(env.ENVINHANDS_CHANGE_SPOOL);
    const result = local ? await runLocalExecution({ ...value, spool } as LocalExecution) : await runRemoteExecution({ ...value, spool } as RemoteExecution);
    io.write(JSON.stringify({ untrusted: true, result }) + "\n");
    return result.outcome === "success" && result.locallyRecorded ? 0 : 1;
  } catch {
    io.error("Execution failed or was not recorded. Inspect local audit state; never blindly rerun an uncertain command.\n");
    return 1;
  }
}
