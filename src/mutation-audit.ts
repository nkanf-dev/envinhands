/** Durable server-side boundary for API mutations, not an OS-wide monitor. */
import { createHash, randomUUID } from "node:crypto";
import { createChangeStore } from "./change-store.ts";
import { parseRegistration, type AgentRegistrationInput } from "./change-model.ts";
import { bearerAuth, response, bodyBytes } from "./http.ts";

export function createMutationAudit(options: {dbPath: string; token: string; machineId: string; requireSignedMutations?: boolean}) {
  const store = createChangeStore(options.dbPath), authorized = bearerAuth(options.token);
  const service = parseRegistration({registrationId: "service-" + randomUUID(), agentId: "envinhands-service",
    sessionId: randomUUID(), machineId: options.machineId, signature: "EnvInHands service; original caller unregistered"});
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    async dispatch(request: Request, next: (request: Request) => Response | Promise<Response>): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" || request.method === "HEAD" || ["/v1/changes", "/v1/agent-registrations"].includes(url.pathname)) return next(request);
      if (!authorized(request)) return response(401, {error: "Unauthorized"});
      let registration: AgentRegistrationInput, operationId: string;
      const encoded = request.headers.get("x-envinhands-registration");
      try {
        if (encoded) {
          if (encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
          registration = parseRegistration(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
          operationId = request.headers.get("x-envinhands-operation-id") ?? "";
          if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error();
        } else {
          if (options.requireSignedMutations) return response(400, {error: "Registered Agent attribution is required for mutations"});
          registration = service; operationId = randomUUID();
        }
        if (JSON.stringify(registration).includes(options.token)) throw new Error();
        store.register(registration);
      } catch { return response(400, {error: "Invalid mutation attribution"}); }
      const at = new Date().toISOString();
      let resourceId = url.pathname, bodyHash: string | null = null;
      const bodyLimit = url.pathname === "/v1/shared-files" ? 68 * 1024 : 16 * 1024;
      if (url.pathname === "/v1/access-evidence" && encoded) {
        try {
          const bytes = await bodyBytes(request.clone(), bodyLimit);
          const value = JSON.parse(new TextDecoder().decode(bytes)) as {action?: unknown; scope?: {registrationId?: unknown;agentId?: unknown;sessionId?: unknown}; evidence?: {registrationId?: unknown;agentId?: unknown;sessionId?: unknown}};
          // V2 uses scope for both begin and commit. Its handler validates exact
          // fields and also checks any committed result against that scope.
          const identity = value.action === "begin" || value.action === "commit" ? value.scope : value.evidence;
          if (!identity || identity.registrationId !== registration.registrationId || identity.agentId !== registration.agentId || identity.sessionId !== registration.sessionId)
            return response(409, {error: "Access observation identity does not match request attribution"});
        } catch { return response(400, {error: "Invalid access observation body"}); }
      }
      try {
        const bytes = await bodyBytes(request.clone(), bodyLimit);
        bodyHash = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength && url.pathname === "/v1/shared-files") {
          const value = JSON.parse(new TextDecoder().decode(bytes)) as {resourceId?:unknown;path?:unknown};
          if (typeof value.resourceId === "string" && typeof value.path === "string") resourceId = "shared-file:" + value.resourceId + "/" + value.path;
        }
        if (bytes.byteLength && ["/v1/machines", "/v1/messages", "/v1/agents/heartbeat"].includes(url.pathname)) {
          const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
          const key = url.pathname === "/v1/machines" ? value.id : url.pathname === "/v1/messages" ? value.requestId : value.agentId;
          if (typeof key === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(key)) resourceId += "/" + key;
        }
      } catch { /* The real handler validates/rejects invalid or oversized bodies. */ }
      if (resourceId.includes(options.token) || resourceId.length > 2048 || /[\x00-\x1f\x7f]/.test(resourceId)) resourceId = "api-request:" + hash(url.pathname);
      const common = {operationId, registrationId: registration.registrationId, targetMachineId: options.machineId, resourceId,
        action: "api-mutation", summary: `${request.method} API mutation`, reason: "Registered client API request",
        authority: encoded ? "Shared bearer plus declared client registration; not strong identity authentication" : "Legacy bearer request; original actor unknown",
        beforeSha256: null, afterSha256: null, evidenceRef: bodyHash ? "request-body-sha256:" + bodyHash : null};
      let intentId: string;
      try {
        // Do not copy request bodies, credentials or messages into audit records.
        intentId = randomUUID();
        store.append({...common, requestId: intentId, outcome: "unknown", occurredAt: at});
      } catch { return response(503, {error: "Mutation intent could not be persisted; operation not dispatched"}); }
      let result: Response;
      try { result = await next(request); }
      catch { result = response(500, {error: "Mutation failed; effects may be unknown"}); }
      let snapshots: {beforeSha256:string|null;afterSha256:string|null} = {beforeSha256:null,afterSha256:null};
      if (url.pathname === "/v1/shared-files" && result.ok) {
        try {
          const value = await result.clone().json() as {beforeSha256?:unknown;afterSha256?:unknown};
          const valid = (value:unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
          snapshots = {beforeSha256:valid(value.beforeSha256)?value.beforeSha256:null,afterSha256:valid(value.afterSha256)?value.afterSha256:null};
        } catch { /* No hashes inferred from an unreadable response. */ }
      }
      try {
        store.append({...common, ...snapshots, requestId: randomUUID(), outcome: result.ok ? "success" : result.status < 500 ? "failed" : "unknown",
          occurredAt: new Date().toISOString(), evidenceRef: `intent:${intentId};http-status:${result.status};request-path-sha256:${hash(resourceId)}`});
      } catch { return response(503, {error: "Mutation completion was not recorded; effects may exist, inspect original operation before retry"}); }
      return result;
    },
    close() { store.close(); },
  };
}
