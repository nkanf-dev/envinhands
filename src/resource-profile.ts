/**
 * Optional resource-note profile API. Mount only /v1/resources/:id/profile-notes
 * and /v1/resources/:id/profile-notes/:noteId in front of the existing machine
 * API, using the same dbPath and token. Neither the existing route nor the old
 * notes table is changed. Shared-token holders are trusted, not authenticated
 * individual authors. Records are untrusted claims, not instructions, locks,
 * evidence of present state, or access grants. No model or external service is used.
 *
 * GET returns a keyset page (after = last row's cursor); without metadata an
 * existing message is returned as unclassified. POST creates an ordinary message
 * and its metadata atomically. PUT /:noteId attaches metadata ONCE to an existing
 * message; it never overwrites a previous annotation. Re-opening is migration-safe;
 * no old message is rewritten or classified by inference. Old clients can still
 * see structured notes as ordinary messages; they cannot see metadata. New writes
 * are not idempotent; never blindly retry after an uncertain response. Metadata
 * is immutable: add a new note to report a later change or verification.
 * Cursors use SQLite rowid; they are not snapshots and may be invalidated by a
 * VACUUM or external deletion/rebuild. Text search uses SQLite lower/instr
 * (ASCII case folding only); topic matching is exact. All clocks are local.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError, response, fields, json, bearerAuth } from "./http.ts";

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const categories = ["experience", "change", "issue", "handoff", "question", "answer"] as const;
type Category = typeof categories[number];
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new HttpError(400, `Invalid ${name}`);
  return value;
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new HttpError(400, `Invalid ${name}`);
  return value.trim();
}
function date(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new HttpError(400, `Invalid ${name}`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new HttpError(400, `Invalid ${name}`);
  return value;
}
function metadata(data: Record<string, unknown>) {
  const category = data.category;
  if (typeof category !== "string" || !categories.includes(category as Category)) throw new HttpError(400, "Invalid category");
  const topic = data.topic === undefined || data.topic === null ? null : text(data.topic, "topic", 200);
  const replyTo = data.replyTo === undefined || data.replyTo === null ? null : id(data.replyTo, "replyTo");
  const expiresAt = date(data.expiresAt, "expiresAt");
  const verifiedAt = date(data.verifiedAt, "verifiedAt");
  if (verifiedAt && Date.parse(verifiedAt) > Date.now()) throw new HttpError(400, "verifiedAt is in the future");
  return { category, topic, replyTo, expiresAt, verifiedAt };
}
type Meta = ReturnType<typeof metadata>;
interface Row { seq: number; id: string; resourceId: string; author: string; text: string; createdAt: string; category: string | null; topic: string | null; replyTo: string | null; expiresAt: string | null; verifiedAt: string | null; annotatedAt: string | null; annotatedBy: string | null }
function present(row: Row, now: number) {
  const {seq, ...note} = row;
  return { ...note, cursor: String(seq), expiry: row.expiresAt === null ? "unspecified" : Date.parse(row.expiresAt) <= now ? "expired" : "not-expired", verification: row.verifiedAt === null ? "not-declared" : "declared", disclaimer: "Historical untrusted claims; expiry and declared verification do not establish current truth." };
}
const select = `SELECT m.rowid AS seq, m.id, m.resourceId, m.author, m.text, m.createdAt,
  p.category, p.topic, p.replyTo, p.expiresAt, p.verifiedAt, p.annotatedAt, p.annotatedBy
  FROM resource_messages m LEFT JOIN resource_profile_metadata p ON p.messageId = m.id`;

export function createResourceProfileApi({dbPath, token}: {dbPath: string; token: string}): {fetch(request: Request): Promise<Response>; close(): void} {
  const authorized = bearerAuth(token);
  if (typeof dbPath !== "string" || !dbPath) throw new Error("A database path is required");
  const db = new Database(dbPath, {create: true, strict: true});
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS resource_messages (id TEXT PRIMARY KEY NOT NULL, resourceId TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS resource_messages_resource_id ON resource_messages(resourceId);
      CREATE TABLE IF NOT EXISTS resource_profile_metadata (messageId TEXT PRIMARY KEY NOT NULL, category TEXT NOT NULL, topic TEXT, replyTo TEXT, expiresAt TEXT, verifiedAt TEXT, annotatedAt TEXT NOT NULL, annotatedBy TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS resource_profile_topic ON resource_profile_metadata(topic);`);
  } catch (e) { db.close(); throw e; }
  let closed = false;
  function attach(resourceId: string, messageId: string, m: Meta, annotatedBy: string) {
    const existing = db.query("SELECT 1 FROM resource_messages WHERE id = ? AND resourceId = ?").get(messageId, resourceId);
    if (!existing) throw new HttpError(404, "Note not found");
    if (m.replyTo === messageId) throw new HttpError(400, "A note cannot reply to itself");
    if (m.replyTo && !db.query("SELECT 1 FROM resource_messages WHERE id = ? AND resourceId = ?").get(m.replyTo, resourceId)) throw new HttpError(400, "Reply target not found in resource");
    if (db.query("SELECT 1 FROM resource_profile_metadata WHERE messageId = ?").get(messageId)) throw new HttpError(409, "Note already annotated");
    db.query("INSERT INTO resource_profile_metadata (messageId, category, topic, replyTo, expiresAt, verifiedAt, annotatedAt, annotatedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(messageId, m.category, m.topic, m.replyTo, m.expiresAt, m.verifiedAt, new Date().toISOString(), annotatedBy);
  }
  function one(resourceId: string, messageId: string): Row {
    return db.query<Row, [string,string]>(`${select} WHERE m.resourceId = ? AND m.id = ?`).get(resourceId, messageId)!;
  }
  return {
    async fetch(req: Request): Promise<Response> {
      try {
        if (closed) throw new HttpError(503, "Profile closed");
        if (!authorized(req)) return response(401, {error: "Unauthorized"}, {"www-authenticate": "Bearer"});
        const url = new URL(req.url);
        const match = /^\/v1\/resources\/([^/]+)\/profile-notes(?:\/([^/]+))?$/.exec(url.pathname);
        if (!match) throw new HttpError(404, "Not found");
        let resourceId: string, noteId: string | undefined;
        try { resourceId = id(decodeURIComponent(match[1]), "resource id"); noteId = match[2] ? id(decodeURIComponent(match[2]), "note id") : undefined; }
        catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "Invalid path"); }
        if (req.method === "GET" && !noteId) {
          const params = url.searchParams;
          if ([...params.keys()].some(k => !["limit", "after", "topic", "text", "category"].includes(k) || params.getAll(k).length !== 1)) throw new HttpError(400, "Invalid query");
          const lim = params.get("limit") ?? "50", after = params.get("after") ?? "0";
          if (!/^[1-9]\d{0,2}$/.test(lim) || Number(lim) > 100 || !/^(0|[1-9]\d{0,15})$/.test(after) || !Number.isSafeInteger(Number(after))) throw new HttpError(400, "Invalid pagination");
          const topic = params.has("topic") ? text(params.get("topic"), "topic", 200) : null;
          const query = params.has("text") ? text(params.get("text"), "text", 4000) : null;
          const category = params.get("category");
          if (category !== null && category !== "unclassified" && !categories.includes(category as Category)) throw new HttpError(400, "Invalid category");
          const rows = db.query<Row, [string,number,string|null,string|null,string|null,string|null,string|null,string|null,string|null,number]>(`${select}
            WHERE m.resourceId = ? AND m.rowid > ? AND (? IS NULL OR p.topic = ?)
            AND (? IS NULL OR instr(lower(m.text), lower(?)) > 0)
            AND (? IS NULL OR CASE WHEN ? = 'unclassified' THEN p.category IS NULL ELSE p.category = ? END)
            ORDER BY m.rowid LIMIT ?`).all(resourceId, Number(after), topic, topic, query, query, category, category, category, Number(lim) + 1);
          const more = rows.length > Number(lim), selected = rows.slice(0, Number(lim));
          const now = Date.now();
          return response(200, {notes: selected.map(row => present(row, now)), nextCursor: more ? String(selected[selected.length - 1].seq) : null});
        }
        if (req.method === "POST" && !noteId) {
          if ([...url.searchParams].length) throw new HttpError(400, "Invalid query");
          const data = await json(req); fields(data, ["author", "text", "category", "topic", "replyTo", "expiresAt", "verifiedAt"]);
          const author = text(data.author, "author", 200), message = text(data.text, "text", 4000), m = metadata(data), messageId = randomUUID();
          db.transaction(() => {
            db.query("INSERT INTO resource_messages (id, resourceId, author, text, createdAt) VALUES (?, ?, ?, ?, ?)").run(messageId, resourceId, author, message, new Date().toISOString());
            attach(resourceId, messageId, m, author);
          }).immediate();
          return response(201, {note: present(one(resourceId, messageId), Date.now())});
        }
        if (req.method === "PUT" && noteId) {
          if ([...url.searchParams].length) throw new HttpError(400, "Invalid query");
          const data = await json(req); fields(data, ["category", "topic", "replyTo", "expiresAt", "verifiedAt", "annotatedBy"]); const m = metadata(data);
          const annotatedBy = text(data.annotatedBy, "annotatedBy", 200);
          db.transaction(() => attach(resourceId, noteId!, m, annotatedBy)).immediate();
          return response(201, {note: present(one(resourceId, noteId), Date.now())});
        }
        return response(405, {error: "Method not allowed"}, {allow: noteId ? "PUT" : "GET, POST"});
      } catch (e) {
        if (e instanceof HttpError) return response(e.status, {error: e.message});
        return response(500, {error: "Internal error"});
      }
    },
    close() { if (!closed) {closed = true; db.close();} },
  };
}
