/**
 * Experimental persistence-only agent bus. This module does not listen on a
 * socket or provide TLS. Put a trusted TLS/authenticating boundary in front of
 * it before any network use. Every holder of the shared token can impersonate
 * any agent, read its queue, and acknowledge its messages.
 *
 * A successful send means only that the bus durably accepted the message; it
 * does not mean delivery or processing. GET does not claim messages, so repeats
 * and concurrent processing are possible. Consumers must be idempotent using
 * requestId and acknowledge only after processing. Acknowledged IDs are retained
 * to preserve send idempotency, including across restarts. State grows without
 * automatic cleanup, and queue reads are not paginated.
 *
 * POST /v1/agents/heartbeat accepts {agentId, machineId, task?}; omission of
 * task clears it. GET /v1/agents reports status "observed" and server receipt
 * time lastHeartbeatAt. That status does not mean the agent is still online.
 * POST /v1/messages accepts {requestId, from, to, text}; 201 means newly
 * accepted and 200 means an identical retry. 409 means an ID conflict.
 * GET /v1/messages?to=... returns all unacknowledged messages, without claiming
 * them. POST /v1/messages/<percent-encoded-requestId>/ack takes no body and is
 * idempotent. IDs are case-sensitive; messages may be sent to unknown agents.
 * Request bodies are limited to 16 KiB, identifiers to 128 UTF-8 bytes, task
 * to 2048 bytes and text to 8192 bytes. Fields must be nonempty strings;
 * unrecognized JSON fields are rejected. Request IDs are retained indefinitely.
 */
import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BODY = 16 * 1024;
const MAX_ID = 128;
const MAX_TASK = 2048;
const MAX_TEXT = 8192;
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function bytes(s: string): number { return encoder.encode(s).byteLength; }
function id(v: unknown, name: string): string {
  // Quotes and other punctuation are valid. SQL values are always bound.
  if (typeof v !== "string" || !v.trim() || bytes(v) > MAX_ID || /[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, `Invalid ${name}`);
  return v;
}
function text(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || !v.trim() || bytes(v) > max || v.includes("\u0000")) throw new HttpError(400, `Invalid ${name}`);
  return v;
}
function fields(data: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(data).some((k) => !allowed.includes(k))) throw new HttpError(400, "Unexpected field");
}
async function bodyBytes(req: Request): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new HttpError(400, "Invalid Content-Length");
    if (Number(declared) > MAX_BODY) throw new HttpError(413, "Request body too large");
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function json(req: Request): Promise<Record<string, unknown>> {
  const raw = await bodyBytes(req);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new HttpError(400, "Expected a JSON object"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed as Record<string, unknown>;
}
type Message = { requestId: string; from: string; to: string; text: string; createdAt: string; acknowledgedAt: string | null };



/** token must be a nonempty bearer token; dbPath is a SQLite filename or :memory:. */
export function createAgentBus({ dbPath, token }: { dbPath: string; token: string }): { fetch(request: Request): Promise<Response>; close(): void } {
  if (typeof token !== "string" || !token || /\s|[\u0000-\u001f\u007f]/.test(token)) throw new Error("A nonempty bearer token without whitespace is required");
  if (typeof dbPath !== "string" || !dbPath) throw new Error("A database path is required");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, task TEXT,
        last_heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        request_id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(recipient, acknowledged_at, created_at);`);
  } catch (err) { db.close(); throw err; }

  const findMessage = db.query<Message, [string]>(`SELECT request_id AS requestId, sender AS "from", recipient AS "to", text, created_at AS createdAt, acknowledged_at AS acknowledgedAt FROM messages WHERE request_id = ?`);
  const send = db.transaction((requestId: string, from: string, to: string, messageText: string): { message: Message; duplicate: boolean } => {
    const inserted = db.query(`INSERT OR IGNORE INTO messages (request_id, sender, recipient, text, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(requestId, from, to, messageText, new Date().toISOString()).changes;
    const message = findMessage.get(requestId)!;
    if (message.from !== from || message.to !== to || message.text !== messageText) throw new HttpError(409, "requestId already used with different content");
    return { message, duplicate: inserted === 0 };
  });
  const ack = db.transaction((requestId: string): Message => {
    db.query(`UPDATE messages SET acknowledged_at = ? WHERE request_id = ? AND acknowledged_at IS NULL`).run(new Date().toISOString(), requestId);
    const message = findMessage.get(requestId);
    if (!message) throw new HttpError(404, "Message not found");
    return message;
  });
  let closed = false;
  return {
    async fetch(req: Request): Promise<Response> {
      try {
        if (closed) return response(503, { error: "Bus closed" });
        const actual = createHash("sha256").update(req.headers.get("authorization") ?? "").digest();
        if (!timingSafeEqual(actual, expected)) return response(401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === "/v1/agents/heartbeat") {
          if (req.method !== "POST") return response(405, { error: "Method not allowed" }, { allow: "POST" });
          const data = await json(req); fields(data, ["agentId", "machineId", "task"]);
          const agentId = id(data.agentId, "agentId");
          const machineId = id(data.machineId, "machineId");
          const task = data.task === undefined ? null : text(data.task, "task", MAX_TASK);
          const lastHeartbeatAt = new Date().toISOString();
          db.query(`INSERT INTO agents (agent_id, machine_id, task, last_heartbeat_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET machine_id = excluded.machine_id, task = excluded.task, last_heartbeat_at = excluded.last_heartbeat_at`).run(agentId, machineId, task, lastHeartbeatAt);
          return response(200, { agent: { agentId, machineId, task, status: "observed", lastHeartbeatAt } });
        }
        if (path === "/v1/agents") {
          if (req.method !== "GET") return response(405, { error: "Method not allowed" }, { allow: "GET" });
          const agents = db.query(`SELECT agent_id AS agentId, machine_id AS machineId, task, 'observed' AS status, last_heartbeat_at AS lastHeartbeatAt FROM agents ORDER BY agent_id`).all();
          return response(200, { agents });
        }
        if (path === "/v1/messages") {
          if (req.method === "POST") {
            const data = await json(req); fields(data, ["requestId", "from", "to", "text"]);
            const result = send(id(data.requestId, "requestId"), id(data.from, "from"), id(data.to, "to"), text(data.text, "text", MAX_TEXT));
            return response(result.duplicate ? 200 : 201, { status: "accepted", duplicate: result.duplicate, message: result.message });
          }
          if (req.method === "GET") {
            const values = url.searchParams.getAll("to");
            if (values.length !== 1 || [...url.searchParams.keys()].some((k) => k !== "to")) throw new HttpError(400, "Expected one to parameter");
            const to = id(values[0], "to");
            const messages = db.query<Message, [string]>(`SELECT request_id AS requestId, sender AS "from", recipient AS "to", text, created_at AS createdAt, acknowledged_at AS acknowledgedAt FROM messages WHERE recipient = ? AND acknowledged_at IS NULL ORDER BY created_at, request_id`).all(to);
            return response(200, { messages });
          }
          return response(405, { error: "Method not allowed" }, { allow: "GET, POST" });
        }
        const match = /^\/v1\/messages\/([^/]+)\/ack$/.exec(path);
        if (match) {
          if (req.method !== "POST") return response(405, { error: "Method not allowed" }, { allow: "POST" });
          let requestId: string;
          try { requestId = id(decodeURIComponent(match[1]), "requestId"); }
          catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "Invalid requestId"); }
          const raw = await bodyBytes(req);
          if (raw.byteLength !== 0) throw new HttpError(400, "Ack does not accept a body");
          return response(200, { status: "acknowledged", message: ack(requestId) });
        }
        return response(404, { error: "Not found" });
      } catch (err) {
        if (err instanceof HttpError) return response(err.status, { error: err.message });
        // Never return or log database errors, request bodies, or credentials.
        return response(500, { error: "Internal error" });
      }
    },
    close(): void { if (!closed) { closed = true; db.close(); } },
  };
}
