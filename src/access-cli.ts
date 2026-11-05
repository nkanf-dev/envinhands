import { randomUUID } from "node:crypto";
import { verifyClientAccess } from "./client-access.ts";
import { AccessEvidenceClient } from "./access-evidence-client.ts";
import { ChangeClient } from "./change-client.ts";
import { createSignedFetch } from "./signed-fetch.ts";
import { parseRegistration } from "./change-model.ts";
import type { ChangeCliIO } from "./change-cli.ts";

export async function runAccessCli(args: string[], env: NodeJS.ProcessEnv, io: Pick<ChangeCliIO, "readInput" | "write" | "error"> & Partial<Pick<ChangeCliIO,"fetch">>): Promise<number> {
  try {
    if (args.length !== 0) throw new Error();
    const input = await io.readInput();
    if (new TextEncoder().encode(input).length > 16384 || (env.ENVINHANDS_TOKEN && input.includes(env.ENVINHANDS_TOKEN))) throw new Error();
    const value = JSON.parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["registration", "targetMachineId", "os", "routes", "access", "priority", "totalBudgetMs", "ttlMs"].includes(key))) throw new Error();
    const registration = parseRegistration(value.registration);
    const evidence = await verifyClientAccess({...value,registration});
    let synced = false;
    if (env.ENVINHANDS_URL && env.ENVINHANDS_TOKEN) {
      const baseUrl = env.ENVINHANDS_URL, token = env.ENVINHANDS_TOKEN, fetcher = io.fetch ?? globalThis.fetch;
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname))) throw new Error();
      await new ChangeClient({baseUrl,token,fetch:fetcher}).register(registration);
      const signed = createSignedFetch({baseUrl,registration:()=>registration,fetch:fetcher});
      await new AccessEvidenceClient({baseUrl,token,fetch:signed}).submit(randomUUID(),evidence);
      synced = true;
    }
    io.write(JSON.stringify({ untrusted: true, evidence, synced, assurance: "actual local SSH/public-key observation; server persists a declaration, not a delegated cryptographic proof" }) + "\n");
    return evidence.ready ? 0 : 1;
  } catch {
    io.error("Client access verification or synchronization failed; no service administrator readiness was established.\n"); return 1;
  }
}
