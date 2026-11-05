/** Portable explicit collaboration client, independent of a Prime checkout. */
import { PrimeBridge, BridgeError } from "./prime-bridge.ts";

export interface ResourceNote { id: string; resourceId: string; author: string; text: string; createdAt: string }
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
