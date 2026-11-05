import {createSignedFetch} from "./signed-fetch.ts";
import type {Fetcher} from "./prime-bridge.ts";
import {createHash} from "node:crypto";
import {parseRegistration, type AgentRegistrationInput} from "./change-model.ts";
/** Explicit per-client environment identity; no process/hostname identity guessing. */
export function cliRegistration(env: NodeJS.ProcessEnv): AgentRegistrationInput {
  const {ENVINHANDS_AGENT_ID:agentId,ENVINHANDS_MACHINE_ID:machineId,ENVINHANDS_SESSION_ID:sessionId,ENVINHANDS_AUDIT_SIGNATURE:signature}=env;
  const identity={agentId,machineId,sessionId,signature};
  return parseRegistration({registrationId:"cli-"+createHash("sha256").update(JSON.stringify(identity)).digest("hex"),...identity});
}

export function signedCliFetch(env: NodeJS.ProcessEnv, fetcher: Fetcher): Fetcher {
  const registration = cliRegistration(env);
  if (!env.ENVINHANDS_URL) throw new Error("Control service URL is required");
  return createSignedFetch({baseUrl: env.ENVINHANDS_URL, registration: () => registration, fetch: fetcher});
}
