/** Same-origin declared mutation identity; no retries or body/credential copying. */
import { randomUUID } from "node:crypto";
import { parseRegistration, type AgentRegistrationInput } from "./change-model.ts";
import type { Fetcher } from "./prime-bridge.ts";
export function createSignedFetch(options: {baseUrl: string; registration: () => AgentRegistrationInput; fetch: Fetcher; operationId?: () => string}): Fetcher {
  const origin = new URL(options.baseUrl).origin;
  return async (input, init) => {
    const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (requestUrl.origin !== origin || method !== "POST" || !requestUrl.pathname.startsWith("/v1/") ||
        ["/v1/changes", "/v1/agent-registrations"].includes(requestUrl.pathname)) return options.fetch(input, init);
    const headers = new Headers(typeof input === "object" && "headers" in input ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (!headers.has("x-envinhands-registration")) {
      const registration = parseRegistration(options.registration());
      headers.set("x-envinhands-registration", Buffer.from(JSON.stringify(registration)).toString("base64url"));
      headers.set("x-envinhands-operation-id", (options.operationId ?? randomUUID)());
    } else if (!headers.has("x-envinhands-operation-id")) {
      throw new Error("Declared mutation identity requires its operation ID");
    }
    return options.fetch(input, {...init, headers, redirect: "error"});
  };
}
