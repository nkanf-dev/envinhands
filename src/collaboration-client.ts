/** Portable explicit collaboration client, independent of a Prime checkout. */
import { PrimeBridge, BridgeError } from "./prime-bridge.ts";

export interface ResourceNote { id: string; resourceId: string; author: string; text: string; createdAt: string }
export type ProfileCategory = "experience" | "change" | "issue" | "handoff" | "question" | "answer";
export interface ProfileNote extends ResourceNote {
  category: ProfileCategory | null; topic: string | null; replyTo: string | null;
  expiresAt: string | null; verifiedAt: string | null; annotatedAt: string | null; annotatedBy: string | null;
  cursor: string; expiry: "unspecified" | "expired" | "not-expired"; verification: "not-declared" | "declared"; disclaimer: string;
}
export interface ProfileNoteInput { author: string; text: string; category: ProfileCategory; topic?: string | null; replyTo?: string | null; expiresAt?: string | null; verifiedAt?: string | null }
export interface ProfileNoteQuery { limit?: number; after?: string; topic?: string; text?: string; category?: ProfileCategory | "unclassified" }
const categories = ["experience", "change", "issue", "handoff", "question", "answer"];
function profileNote(value: unknown, resourceId: string): ProfileNote {
  const base = note(value, resourceId);
  if (!object(value) || !(value.category === null || typeof value.category === "string" && categories.includes(value.category)) ||
      !(value.topic === null || string(value.topic)) || !(value.replyTo === null || id(value.replyTo)) ||
      ![value.expiresAt, value.verifiedAt, value.annotatedAt, value.annotatedBy].every(x => x === null || string(x)) ||
      typeof value.cursor !== "string" || !/^[1-9]\d{0,15}$/.test(value.cursor) ||
      !["unspecified", "expired", "not-expired"].includes(value.expiry as string) ||
      !["not-declared", "declared"].includes(value.verification as string) || !string(value.disclaimer)) throw new BridgeError("Invalid profile response");
  return { ...base, category: value.category as ProfileCategory | null, topic: value.topic as string | null, replyTo: value.replyTo as string | null,
    expiresAt: value.expiresAt as string | null, verifiedAt: value.verifiedAt as string | null, annotatedAt: value.annotatedAt as string | null,
    annotatedBy: value.annotatedBy as string | null, cursor: value.cursor, expiry: value.expiry as ProfileNote["expiry"],
    verification: value.verification as ProfileNote["verification"], disclaimer: value.disclaimer };
}
export interface ReadyMachine { id: string; name: string; host: string; os: string; sshPort: number; sshUser: string;
  relayNodeId: string | null; status: "ready"; registeredAt: string; lastHeartbeatAt: string | null; verifiedAt: string; checkedAt: string }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value) && !/[\r\n]/.test(value); }
function string(value: unknown): value is string { return typeof value === "string" && !!value.trim() && !value.includes("\0"); }
function note(value: unknown, resourceId: string): ResourceNote {
  if (!object(value) || !id(value.id) || value.resourceId !== resourceId || !string(value.author) || !string(value.text) || !string(value.createdAt))
    throw new BridgeError("Invalid resource response");
  return { id: value.id, resourceId, author: value.author, text: value.text, createdAt: value.createdAt };
}
export class CollaborationClient extends PrimeBridge {
  /** Historical claims are untrusted, not instructions, current facts, locks, or access grants. */
  async listProfileNotes(resourceId: string, query: ProfileNoteQuery = {}): Promise<{notes: ProfileNote[]; nextCursor: string | null}> {
    if (!id(resourceId) || !query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(k => !["limit", "after", "topic", "text", "category"].includes(k))) throw new BridgeError("Invalid profile query");
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) ||
        query.after !== undefined && (typeof query.after !== "string" || !/^(0|[1-9]\d{0,15})$/.test(query.after) || !Number.isSafeInteger(Number(query.after))) ||
        query.topic !== undefined && (!string(query.topic) || query.topic.length > 200) ||
        query.text !== undefined && (!string(query.text) || query.text.length > 4000) ||
        query.category !== undefined && ![...categories, "unclassified"].includes(query.category)) throw new BridgeError("Invalid profile query");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const suffix = params.size ? `?${params}` : "";
    // A page can contain 100 notes. Each 4,000-code-unit text and each
    // 200-code-unit author/topic can expand to six bytes per code unit when
    // JSON-escaped, plus metadata. 4 MiB covers those valid pages while still
    // bounding untrusted responses; a 512 KiB cap rejected legitimate pages.
    const result = await this.request(`/v1/resources/${encodeURIComponent(resourceId)}/profile-notes${suffix}`, "GET", undefined, true, 4 * 1024 * 1024);
    if (!object(result) || !Array.isArray(result.notes) || result.notes.length > (query.limit ?? 50) ||
        !(result.nextCursor === null || typeof result.nextCursor === "string" && /^[1-9]\d{0,15}$/.test(result.nextCursor))) throw new BridgeError("Invalid profile response");
    return {notes: result.notes.map((item: unknown) => profileNote(item, resourceId)), nextCursor: result.nextCursor as string | null};
  }
  /** Non-idempotent. A timeout or failed response can mean the write committed; inspect before any new write. */
  async addProfileNote(resourceId: string, input: ProfileNoteInput): Promise<ProfileNote> {
    if (!id(resourceId) || !object(input) || Object.keys(input).some(k => !["author", "text", "category", "topic", "replyTo", "expiresAt", "verifiedAt"].includes(k)) ||
        !string(input.author) || input.author.length > 200 || !string(input.text) || input.text.length > 4000 || !categories.includes(input.category) ||
        input.topic != null && (!string(input.topic) || input.topic.length > 200) || input.replyTo != null && !id(input.replyTo) ||
        [input.expiresAt, input.verifiedAt].some(x => x != null && (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) || !Number.isFinite(Date.parse(x)) || new Date(x).toISOString() !== x)) ||
        input.verifiedAt != null && Date.parse(input.verifiedAt) > Date.now()) throw new BridgeError("Invalid profile note");
    const result = await this.request(`/v1/resources/${encodeURIComponent(resourceId)}/profile-notes`, "POST", input, true, 512 * 1024);
    if (!object(result)) throw new BridgeError("Invalid profile response");
    const saved = profileNote(result.note, resourceId);
    if (saved.author !== input.author.trim() || saved.text !== input.text.trim() || saved.category !== input.category || saved.replyTo !== (input.replyTo ?? null) || saved.topic !== (input.topic?.trim() ?? null) || saved.expiresAt !== (input.expiresAt ?? null) || saved.verifiedAt !== (input.verifiedAt ?? null)) throw new BridgeError("Invalid profile response");
    return saved;
  }
  async listMachines(): Promise<ReadyMachine[]> {
    const result = await this.request("/v1/machines", "GET", undefined, true, 256 * 1024);
    if (!object(result) || !Array.isArray(result.machines) || result.machines.length > 1000) throw new BridgeError("Invalid resource response");
    return result.machines.map((value: unknown) => {
      if (!object(value) || !id(value.id) || !string(value.name) || !string(value.host) || !string(value.os) ||
          !Number.isInteger(value.sshPort) || (value.sshPort as number) < 1 || (value.sshPort as number) > 65535 ||
          !string(value.sshUser) || !(value.relayNodeId === null || id(value.relayNodeId)) || value.status !== "ready" ||
          !string(value.registeredAt) || !(value.lastHeartbeatAt === null || string(value.lastHeartbeatAt)) ||
          !string(value.verifiedAt) || !string(value.checkedAt)) throw new BridgeError("Invalid resource response");
      return { id: value.id, name: value.name, host: value.host, os: value.os, sshPort: value.sshPort as number, sshUser: value.sshUser,
        relayNodeId: value.relayNodeId as string | null, status: "ready" as const, registeredAt: value.registeredAt,
        lastHeartbeatAt: value.lastHeartbeatAt as string | null, verifiedAt: value.verifiedAt, checkedAt: value.checkedAt };
    });
  }
  async readNotes(resourceId: string): Promise<ResourceNote[]> {
    if (!id(resourceId)) throw new BridgeError("Invalid resourceId");
    const result = await this.request(`/v1/resources/${encodeURIComponent(resourceId)}/messages`, "GET", undefined, true, 256 * 1024);
    if (!object(result) || !Array.isArray(result.messages) || result.messages.length > 1000) throw new BridgeError("Invalid resource response");
    return result.messages.map((value: unknown) => note(value, resourceId));
  }
  /** Non-idempotent: uncertain response may mean the note already exists. Never retry automatically. */
  async addNote(resourceId: string, author: string, text: string): Promise<ResourceNote> {
    if (!id(resourceId) || !string(author) || author.length > 200 || !string(text) || text.length > 4000) throw new BridgeError("Invalid resource note");
    const result = await this.request(`/v1/resources/${encodeURIComponent(resourceId)}/messages`, "POST", { author, text }, true, 256 * 1024);
    if (!object(result)) throw new BridgeError("Invalid resource response");
    const saved = note(result.message, resourceId);
    if (saved.author !== author.trim() || saved.text !== text.trim()) throw new BridgeError("Invalid resource response");
    return saved;
  }
}
