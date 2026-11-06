import { randomUUID } from "node:crypto";
import { verifyClientAccess } from "./client-access.ts";
import { AccessEvidenceClient, type AccessCheckResult } from "./access-evidence-client.ts";
import { parseAccessCheckCommit, parseAccessCheckScope, type AccessCheckScope } from "./access-evidence-model.ts";
import { ChangeClient } from "./change-client.ts";
import { createSignedFetch } from "./signed-fetch.ts";
import { parseRegistration } from "./change-model.ts";
import type { ChangeCliIO } from "./change-cli.ts";

/** Online v2 verification. A recovery envelope contains no key bytes or bearer token.
 * It can be supplied to `verify-access sync` on the same registered client.
 * Server state is a shared-bearer declaration, not authenticated client identity. */
export async function runAccessCli(args: string[], env: NodeJS.ProcessEnv, io: Pick<ChangeCliIO, "readInput" | "write" | "error"> & Partial<Pick<ChangeCliIO,"fetch">>, deps: {verify?: typeof verifyClientAccess} = {}): Promise<number> {
  let recovery: {scope:AccessCheckScope;generation:string;result:AccessCheckResult} | undefined;
  let beginId: string | undefined;
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== "sync")) throw new Error();
    const input = await io.readInput(), token = env.ENVINHANDS_TOKEN, baseUrl = env.ENVINHANDS_URL;
    if (new TextEncoder().encode(input).length > 16384 || !token || !baseUrl || input.includes(token)) throw new Error();
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error();
    const value = JSON.parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).includes(token)) throw new Error();
    const registration = parseRegistration(value.registration);
    const fetcher = io.fetch ?? globalThis.fetch;
    const signed = createSignedFetch({baseUrl,registration:()=>registration,fetch:fetcher});
    const client = new AccessEvidenceClient({baseUrl,token,fetch:signed});
    // Only replay the identical idempotent commit. Never retry a 4xx conflict.
    const commit = async (item: NonNullable<typeof recovery>) => {
      try { await client.commit(item.scope, item.generation, item.result); }
      catch (error) {
        const status = (error as {status?: unknown})?.status;
        if (typeof status === "number" && status < 500) throw error;
        await client.commit(item.scope, item.generation, item.result);
      }
    };
    if (args[0] === "sync") {
      if (Object.keys(value).some(key => !["registration", "recovery"].includes(key))) throw new Error();
      const parsed = parseAccessCheckCommit({action:"commit", ...value.recovery});
      const scope = parsed.scope;
      if (scope.registrationId !== registration.registrationId || scope.agentId !== registration.agentId || scope.sessionId !== registration.sessionId) throw new Error();
      recovery = {scope,generation:parsed.generation,result:parsed.result ?? {status:"unknown"}};
      await commit(recovery);
      const current = await client.current(scope);
      // Sync does not recheck local key/host state. Never claim fresh local readiness.
      io.write(JSON.stringify({synced:true,ready:false,current,assurance:"shared-bearer declaration; sync is not a fresh client check",next:"Run a new verify-access check for current local readiness."})+"\n");
      return 0;
    }
    if (Object.keys(value).some(key => !["registration", "targetMachineId", "os", "routes", "access", "priority", "totalBudgetMs", "ttlMs", "operationId"].includes(key))) throw new Error();
    const scope = parseAccessCheckScope({registrationId:registration.registrationId,agentId:registration.agentId,sessionId:registration.sessionId,targetMachineId:value.targetMachineId});
    beginId = value.operationId ?? randomUUID();
    await new ChangeClient({baseUrl,token,fetch:fetcher}).register(registration);
    // No SSH command, nor identity fingerprint, is run before begin is acknowledged.
    const beganMonotonic = performance.now();
    const begun = await client.begin(beginId!, scope);
    if (begun.duplicate) {
      io.write(JSON.stringify({ready:false,synced:true,operationId:beginId,status:"duplicate",next:"Use a new operationId to make a fresh read-only check; do not replay the old attempt."})+"\n");
      return 1;
    }
    let result: AccessCheckResult = {status:"unknown"};
    try {
      const {operationId:_operationId,...options} = value;
      const observed = await (deps.verify ?? verifyClientAccess)({...options,registration});
      // The server's begin time predates the SSH observation. Starting TTL there
      // is conservative and avoids trusting the Agent's skewed wall clock.
      const ttl = value.ttlMs ?? 300000, elapsed = performance.now() - beganMonotonic;
      if (Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 300000 && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < ttl) {
        const base = Date.parse(begun.begunAt);
        result = {...observed, checkedAt:new Date(base).toISOString(), expiresAt:new Date(base + ttl).toISOString()};
      }
    } catch { /* Fingerprint, route and timeout failures must invalidate earlier readiness. */ }
    recovery = {scope,generation:begun.generation,result};
    await commit(recovery);
    const current = await client.current(scope);
    const same = current.generation === begun.generation && current.evidence !== null && result.status !== "unknown" && JSON.stringify(current.evidence) === JSON.stringify(result);
    const ready = same && current.status === "ready" && result.status !== "unknown";
    io.write(JSON.stringify({ready,synced:true,operationId:beginId,current,assurance:"actual client SSH observation; shared bearer is not strong client identity",...(!ready?{next:"Check the local identity, trusted host key, SSH login and noninteractive administrator access, then retry with a new operationId."}:{})})+"\n");
    return ready ? 0 : 1;
  } catch (error) {
    const upgrade = error instanceof Error && /(?:clock upgrade|upgrade the service)/.test(error.message);
    const output = {ready:false,synced:false,status:"unknown",...(beginId?{operationId:beginId}:{}),...(recovery?{recovery}:{}),
      next:upgrade ? "Upgrade the service for v2 nonce and server-clock support, then run a new check." : recovery ? "Save recovery and use verify-access sync with the same registration, then run a new check. Expired, superseded or pre-restart checks require a new operationId." : "Reconnect and run a new check. Until its begin reaches the server, a previous remote observation may remain valid until expiry."};
    io.write(JSON.stringify(output)+"\n");
    return 1;
  }
}
