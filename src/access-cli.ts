import { verifyClientAccess } from "./client-access.ts";
import type { ChangeCliIO } from "./change-cli.ts";

export async function runAccessCli(args: string[], env: NodeJS.ProcessEnv, io: Pick<ChangeCliIO, "readInput" | "write" | "error">): Promise<number> {
  try {
    if (args.length !== 0) throw new Error();
    const input = await io.readInput();
    if (new TextEncoder().encode(input).length > 16384 || (env.ENVINHANDS_TOKEN && input.includes(env.ENVINHANDS_TOKEN))) throw new Error();
    const value = JSON.parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["registration", "targetMachineId", "os", "routes", "access", "priority", "totalBudgetMs", "ttlMs"].includes(key))) throw new Error();
    const evidence = await verifyClientAccess(value);
    io.write(JSON.stringify({ untrusted: true, evidence, assurance: "local actual-client observation, not an authenticated server proof" }) + "\n");
    return evidence.ready ? 0 : 1;
  } catch {
    io.error("Client access verification failed; no administrator readiness was established.\n"); return 1;
  }
}
