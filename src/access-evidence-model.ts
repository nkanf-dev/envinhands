/** Shared-bearer access observations are declarations, not cryptographic proofs. */
import { parseChangeQuery } from "./change-model.ts";
export interface ClientAccessEvidence {
  registrationId: string;
  agentId: string;
  sessionId: string;
  targetMachineId: string;
  routeId: string;
  sshIdentityRef: string;
  sshUser: string;
  hostKeyAlias: string;
  os: "linux" | "macos" | "windows";
  checkedAt: string;
  expiresAt: string;
  ready: boolean;
  status: "ready" | "not-ready";
  verificationScope: "actual-client-ssh-identity-and-route";
}
export interface AccessEvidenceInput { requestId: string; evidence: ClientAccessEvidence }
export interface AccessEvidenceQuery { registrationId: string; targetMachineId: string; routeId?: string; sshIdentityRef?: string; after: number; limit: number }
export class AccessEvidenceInputError extends Error {}
export function accessId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value) || /[\r\n]/.test(value)) throw new AccessEvidenceInputError("Invalid access ID");
  return value;
}
export function publicKeyFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value) || /[\r\n]/.test(value)) throw new AccessEvidenceInputError("Invalid public key fingerprint");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new AccessEvidenceInputError("Invalid access time");
  return value;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new AccessEvidenceInputError("Invalid access fields");
  return value as Record<string, unknown>;
}
export function parseAccessEvidence(value: unknown): ClientAccessEvidence {
  const v = exact(value, ["registrationId", "agentId", "sessionId", "targetMachineId", "routeId", "sshIdentityRef", "sshUser", "hostKeyAlias", "os", "checkedAt", "expiresAt", "ready", "status", "verificationScope"]);
  const checkedAt = timestamp(v.checkedAt), expiresAt = timestamp(v.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(checkedAt) || Date.parse(expiresAt) - Date.parse(checkedAt) > 300000 || typeof v.ready !== "boolean" || v.status !== (v.ready ? "ready" : "not-ready") ||
      !["linux", "macos", "windows"].includes(String(v.os)) || v.verificationScope !== "actual-client-ssh-identity-and-route" ||
      typeof v.sshUser !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(v.sshUser) || /[\r\n]/.test(v.sshUser) ||
      typeof v.hostKeyAlias !== "string" || !v.hostKeyAlias || v.hostKeyAlias.length > 253 || /[\x00-\x20\x7f]/.test(v.hostKeyAlias)) throw new AccessEvidenceInputError("Invalid access observation");
  return { registrationId: accessId(v.registrationId), agentId: accessId(v.agentId), sessionId: accessId(v.sessionId), targetMachineId: accessId(v.targetMachineId), routeId: accessId(v.routeId),
    sshIdentityRef: publicKeyFingerprint(v.sshIdentityRef), sshUser: v.sshUser, hostKeyAlias: v.hostKeyAlias, os: v.os as ClientAccessEvidence["os"], checkedAt, expiresAt, ready: v.ready,
    status: v.status as ClientAccessEvidence["status"], verificationScope: "actual-client-ssh-identity-and-route" };
}
export function parseAccessEvidenceInput(value: unknown): AccessEvidenceInput {
  const v = exact(value, ["requestId", "evidence"]); return { requestId: accessId(v.requestId), evidence: parseAccessEvidence(v.evidence) };
}
export function parseAccessEvidenceQuery(params: URLSearchParams): AccessEvidenceQuery {
  const allowed = ["registrationId", "targetMachineId", "routeId", "sshIdentityRef", "after", "limit"];
  if ([...params.keys()].some(key => !allowed.includes(key)) || allowed.some(key => params.getAll(key).length > 1)) throw new AccessEvidenceInputError("Invalid access query");
  let page: { after: number; limit: number };
  try { const q = new URLSearchParams(); for (const key of ["after", "limit"]) if (params.has(key)) q.set(key, params.get(key)!); page = parseChangeQuery(q); }
  catch { throw new AccessEvidenceInputError("Invalid access page"); }
  return { registrationId: accessId(params.get("registrationId")), targetMachineId: accessId(params.get("targetMachineId")), ...page,
    ...(params.has("routeId") ? { routeId: accessId(params.get("routeId")) } : {}), ...(params.has("sshIdentityRef") ? { sshIdentityRef: publicKeyFingerprint(params.get("sshIdentityRef")) } : {}) };
}

/**
 * V2 is opt-in and separate from legacy append-only observations. The client must
 * begin online before starting each check; failed begin, commit, or current read
 * means unknown locally. Never use a cached ready when the service is unavailable.
 * Read current online and match the returned evidence to the intended route, key,
 * user and host before using ready; scope alone is not sufficient. A beginId is
 * unique per attempt and retries return the original generation, even if superseded.
 * Legacy consumers remain unsafe for readiness. Client/server routing and consumers
 * must be integrated and migrated before NAS use. Shared bearer is not identity proof.
 */
export interface AccessCheckScope { registrationId: string; agentId: string; sessionId: string; targetMachineId: string }
export function parseAccessCheckScope(value: unknown): AccessCheckScope {
  const v = exact(value, ["registrationId", "agentId", "sessionId", "targetMachineId"]);
  return { registrationId: accessId(v.registrationId), agentId: accessId(v.agentId), sessionId: accessId(v.sessionId), targetMachineId: accessId(v.targetMachineId) };
}
export function parseAccessCheckBegin(value: unknown) {
  const v = exact(value, ["action", "beginId", "scope"]);
  if (v.action !== "begin") throw new AccessEvidenceInputError("Invalid check action");
  return { beginId: accessId(v.beginId), scope: parseAccessCheckScope(v.scope) };
}
export function parseAccessCheckCommit(value: unknown) {
  const v = exact(value, ["action", "generation", "scope", "result"]);
  if (v.action !== "commit") throw new AccessEvidenceInputError("Invalid check action");
  const result = v.result && typeof v.result === "object" && !Array.isArray(v.result) && (v.result as Record<string, unknown>).status === "unknown"
    ? (exact(v.result, ["status"]), null) : parseAccessEvidence(v.result);
  return { generation: accessId(v.generation), scope: parseAccessCheckScope(v.scope), result };
}
export function parseAccessCheckQuery(params: URLSearchParams): AccessCheckScope {
  const keys = ["view", "registrationId", "agentId", "sessionId", "targetMachineId"];
  if ([...params.keys()].some(k => !keys.includes(k)) || keys.some(k => params.getAll(k).length !== 1) || params.get("view") !== "current") throw new AccessEvidenceInputError("Invalid check query");
  return parseAccessCheckScope(Object.fromEntries(keys.slice(1).map(k => [k, params.get(k)])));
}
