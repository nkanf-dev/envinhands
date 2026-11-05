/** Declared provenance, not cryptographic signatures or mutation interception. */
export interface AgentRegistrationInput {
  registrationId: string;
  agentId: string;
  sessionId: string;
  machineId: string;
  signature: string;
}
export interface AgentRegistration extends AgentRegistrationInput { registeredAt: string }
export type ChangeOutcome = "success" | "failed" | "partial" | "unknown";
export interface ChangeInput {
  requestId: string;
  operationId: string;
  registrationId: string;
  targetMachineId: string;
  resourceId: string;
  action: string;
  summary: string;
  reason: string;
  authority: string;
  outcome: ChangeOutcome;
  occurredAt: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  evidenceRef: string | null;
}
export interface ChangeRecord extends ChangeInput {
  sequence: number;
  recordedAt: string;
  registration: AgentRegistration;
}
export interface ChangePage { records: ChangeRecord[]; nextAfter: number | null }

export class ChangeInputError extends Error {}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)))
    throw new ChangeInputError("Invalid fields");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value))
    throw new ChangeInputError(`Invalid ${name}`);
  return value;
}
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value) || /[\r\n]/.test(value))
    throw new ChangeInputError(`Invalid ${name}`);
  return value;
}
function hash(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) throw new ChangeInputError(`Invalid ${name}`);
  return value;
}
export function parseRegistration(value: unknown): AgentRegistrationInput {
  const v = object(value, ["registrationId", "agentId", "sessionId", "machineId", "signature"]);
  return { registrationId: id(v.registrationId, "registrationId"), agentId: id(v.agentId, "agentId"),
    sessionId: id(v.sessionId, "sessionId"), machineId: id(v.machineId, "machineId"), signature: text(v.signature, "signature", 200) };
}
export function parseChange(value: unknown): ChangeInput {
  const v = object(value, ["requestId", "operationId", "registrationId", "targetMachineId", "resourceId", "action",
    "summary", "reason", "authority", "outcome", "occurredAt", "beforeSha256", "afterSha256", "evidenceRef"]);
  if (!["success", "failed", "partial", "unknown"].includes(v.outcome as string)) throw new ChangeInputError("Invalid outcome");
  if (v.occurredAt !== null && (typeof v.occurredAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.occurredAt) ||
      !Number.isFinite(Date.parse(v.occurredAt)) || new Date(v.occurredAt).toISOString() !== v.occurredAt))
    throw new ChangeInputError("Invalid occurredAt");
  return { requestId: id(v.requestId, "requestId"), operationId: id(v.operationId, "operationId"),
    registrationId: id(v.registrationId, "registrationId"), targetMachineId: id(v.targetMachineId, "targetMachineId"),
    resourceId: text(v.resourceId, "resourceId", 2048), action: text(v.action, "action", 100),
    summary: text(v.summary, "summary", 2000, true), reason: text(v.reason, "reason", 2000, true),
    authority: text(v.authority, "authority", 2000, true), outcome: v.outcome as ChangeOutcome,
    occurredAt: v.occurredAt as string | null, beforeSha256: hash(v.beforeSha256, "beforeSha256"),
    afterSha256: hash(v.afterSha256, "afterSha256"), evidenceRef: v.evidenceRef === null ? null : text(v.evidenceRef, "evidenceRef", 2048) };
}
/** Decimal cursors and explicit bounded pages; reject typos instead of ignoring them. */
export function parseChangeQuery(params: URLSearchParams): { after: number; limit: number } {
  if ([...params.keys()].some(key => !["after", "limit"].includes(key)) ||
      params.getAll("after").length > 1 || params.getAll("limit").length > 1) throw new ChangeInputError("Invalid query");
  const parse = (key: string, fallback: number): number => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ChangeInputError(`Invalid ${key}`);
    return Number(raw);
  };
  const after = parse("after", 0), limit = parse("limit", 100);
  if (limit < 1 || limit > 100) throw new ChangeInputError("Invalid limit");
  return { after, limit };
}
