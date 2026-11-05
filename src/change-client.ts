/** Explicit provenance client; callers retain original request IDs after uncertain writes. */
import { PrimeBridge, BridgeError } from "./prime-bridge.ts";
import { parseRegistration, parseChange, parseChangeQuery, type AgentRegistrationInput, type AgentRegistration,
  type ChangeInput, type ChangeRecord, type ChangePage } from "./change-model.ts";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function registration(value: unknown): AgentRegistration {
  if (!object(value) || !timestamp(value.registeredAt)) throw new BridgeError("Invalid change response");
  const { registeredAt, ...input } = value;
  return { ...parseRegistration(input), registeredAt };
}
function record(value: unknown): ChangeRecord {
  if (!object(value) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || !timestamp(value.recordedAt))
    throw new BridgeError("Invalid change response");
  const { sequence, recordedAt, registration: signedBy, ...input } = value;
  const parsed = parseChange(input), registered = registration(signedBy);
  if (registered.registrationId !== parsed.registrationId) throw new BridgeError("Invalid change response");
  return { ...parsed, sequence: sequence as number, recordedAt, registration: registered };
}
export class ChangeClient extends PrimeBridge {
  async register(input: AgentRegistrationInput): Promise<{ registration: AgentRegistration; duplicate: boolean }> {
    const value = parseRegistration(input);
    const result = await this.request("/v1/agent-registrations", "POST", value, true, 256 * 1024);
    try {
      if (!object(result) || typeof result.duplicate !== "boolean") throw new Error();
      const registered = registration(result.registration);
      const { registeredAt, ...echo } = registered;
      if (JSON.stringify(echo) !== JSON.stringify(value)) throw new Error();
      return { registration: registered, duplicate: result.duplicate };
    } catch { throw new BridgeError("Invalid change response"); }
  }
  async recordChange(input: ChangeInput): Promise<{ record: ChangeRecord; duplicate: boolean }> {
    const value = parseChange(input);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) throw new BridgeError("Change request too large");
    const result = await this.request("/v1/changes", "POST", value, true, 256 * 1024);
    try {
      if (!object(result) || typeof result.duplicate !== "boolean") throw new Error();
      const saved = record(result.record);
      const { sequence, recordedAt, registration, ...echo } = saved;
      if (JSON.stringify(echo) !== JSON.stringify(value)) throw new Error();
      return { record: saved, duplicate: result.duplicate };
    } catch { throw new BridgeError("Invalid change response"); }
  }
  /** Read only: no implicit cursor advancement, processing acknowledgement or truncation. */
  async listChanges(after = 0, limit = 10): Promise<ChangePage> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    parseChangeQuery(query);
    const result = await this.request(`/v1/changes?${query}`, "GET", undefined, true, 256 * 1024);
    try {
      if (!object(result) || !Array.isArray(result.records) || result.records.length > limit ||
          !(result.nextAfter === null || Number.isSafeInteger(result.nextAfter))) throw new Error();
      const records = result.records.map(record);
      let previous = after;
      for (const saved of records) {
        if (saved.sequence <= previous) throw new Error();
        previous = saved.sequence;
      }
      if (result.nextAfter !== null && (records.length !== limit || result.nextAfter !== previous)) throw new Error();
      return { records, nextAfter: result.nextAfter as number | null };
    } catch { throw new BridgeError("Invalid change response"); }
  }
}
