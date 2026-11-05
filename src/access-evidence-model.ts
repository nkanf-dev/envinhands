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
