/**
 * Native mesh protocol v1 over the existing EnvInHands agent bus.
 *
 * Wire: qualified identity is nm1- + SHA-256(JSON.stringify([hostId,agentId])).
 * POST /v1/native-mesh/agents writes {hostId,agentId,parentId,name,state};
 * GET /v1/native-mesh/agents?limit=100 returns version 2 pages with agents,
 * nextCursor and an opaque numeric revision. Continue with after and revision.
 * Each scan is an immutable, bounded in-memory snapshot from one SQLite read
 * transaction. Heartbeat times can be stale. Identity, parent, name or state
 * changes invalidate continued scans and prevent reuse of an older snapshot.
 * Snapshots expire after 30 seconds and are local to this server instance; a 409
 * means restart discovery (including topology change, expiry, restart, or routing to another
 * instance). Paging is not a lease or a liveness check. The unparameterized
 * legacy list is bounded and may return 413.
 * Clients negotiate the first page limit with older servers. Route subsequent pages to the same server.
 * Every page is authenticated using the shared bearer token; that token does not
 * identify individual agents. Discovery has one timeoutMs deadline (default
 * 10 seconds), and
 * across all retries reads at most 32 MiB and validates at most 100,000 records.
 * parentId is a qualified identity or null. Null means a root. Registrations are
 * observations, not leases or proof of life. Identities must be stable and
 * globally unique per host/incarnation; never reuse an ID for another session.
 * No registration TTL or cleanup is provided. lastHeartbeatAt is receipt time, not
 * current liveness. POST updates parent/name/state and receipt time for an ID.
 * name/state are required; state is active or inactive, parentId may be null.
 *
 * Messages use bus from/to qualified IDs, text as-is, and requestId = nm1m- +
 * SHA-256(JSON.stringify([qualifiedSender,callerMessageId])). The caller MUST
 * persist its message ID and payload before sending; retries use identical
 * inputs even after uncertain outcomes. Accepted means only bus persistence.
 * Bus IDs and acknowledged tombstones are retained indefinitely. Pull does
 * not claim: concurrent or repeated delivery is possible. The receiving
 * adapter MUST idempotently persist by requestId into the actual native inbox
 * BEFORE acknowledge, and reconcile retries after crashes. Never ack merely
 * because delivery was attempted or a worker was notified. No exactly-once
 * model processing or atomic transaction across the two stores is promised.
 *
 * Discovery family filtering is a compatibility convenience, not authorization:
 * parent, direct children, and siblings (including roots) are reachable. Stale,
 * malformed, incomplete or forged registrations are possible; observation is
 * never proof of online status. Shared bearer credentials permit impersonation,
 * reading and acking any mailbox. Use a trusted service and TLS; bearer tokens
 * and declared registration signatures do not establish cryptographic identity.
 * Caller supplies a fetch adapter with required mutation attribution headers if
 * the service uses its default requireSignedMutations=true configuration.
 * No polling, daemon integration, durable outbox or native inbox is provided.
 */
import { createHash, randomBytes } from "node:crypto";
import { PrimeBridge, BridgeError, type BridgeOptions, type BusMessage } from "../prime-bridge.ts";
import { Database } from "bun:sqlite";
import { bearerAuth, response, json, fields, HttpError } from "../http.ts";

export type MeshState = "active" | "inactive";
export interface MeshRegistration { hostId: string; agentId: string; parentId: string | null; name: string; state: MeshState }
export interface MeshObservation extends MeshRegistration { id: string; lastHeartbeatAt: string; status: "observed" }
const MAX_PAGE = 100, MAX_BYTES = 2 * 1024 * 1024, MAX_SCAN_BYTES = 32 * 1024 * 1024, MAX_SCAN_RECORDS = 100_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function component(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 128 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid mesh identity");
}
function qid(value: unknown): value is string { return typeof value === "string" && /^nm1-[0-9a-f]{64}$/.test(value); }
export function qualifiedAgentId(hostId: string, agentId: string): string {
  component(hostId); component(agentId); return "nm1-" + digest([hostId, agentId]);
}
export function meshRequestId(senderId: string, messageId: string): string {
  if (!qid(senderId)) throw new Error("Invalid sender");
  component(messageId); return "nm1m-" + digest([senderId, messageId]);
}
function validateRegistration(r: MeshRegistration): void {
  if (!r || typeof r !== "object") throw new Error("Invalid registration");
  component(r.hostId); component(r.agentId); component(r.name);
  if (r.parentId !== null && !qid(r.parentId)) throw new Error("Invalid parent");
  if (r.parentId === qualifiedAgentId(r.hostId, r.agentId)) throw new Error("Self parent");
  if (r.state !== "active" && r.state !== "inactive") throw new Error("Invalid state");
}
export function familyReachable(self: MeshObservation, other: MeshObservation): boolean {
  if (self.id === other.id) return false;
  return self.parentId === other.id || other.parentId === self.id || self.parentId === other.parentId;
}
/** Mount this handler at /v1/native-mesh/agents. Existing server does NOT mount it. */
export function createNativeMeshApi(options: {dbPath: string; token: string}) {
  const authorized = bearerAuth(options.token);
  if (!options.dbPath) throw new Error("Invalid database path");
  const db = new Database(options.dbPath, {create: true, strict: true});
  try {
    db.exec("PRAGMA busy_timeout=5000");
    // Triggers also cover old server versions and other SQLite connections that
    // write this table. They run in the same transaction as the registration.
    // CHECK rejects integer overflow instead of silently wrapping the epoch.
    db.transaction(() => db.exec(`CREATE TABLE IF NOT EXISTS native_mesh_agents_v1 (
      id TEXT PRIMARY KEY, host_id TEXT NOT NULL, agent_id TEXT NOT NULL, parent_id TEXT,
      name TEXT NOT NULL, state TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_mesh_revision_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO native_mesh_revision_v2 VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS native_mesh_topology_revision_v3 (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision >= 0));
      INSERT OR IGNORE INTO native_mesh_topology_revision_v3 VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS native_mesh_topology_insert_v3 AFTER INSERT ON native_mesh_agents_v1 BEGIN
        UPDATE native_mesh_topology_revision_v3 SET revision=revision+1 WHERE singleton=1;
        SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT,'Missing topology revision') END;
      END;
      CREATE TRIGGER IF NOT EXISTS native_mesh_topology_delete_v3 AFTER DELETE ON native_mesh_agents_v1 BEGIN
        UPDATE native_mesh_topology_revision_v3 SET revision=revision+1 WHERE singleton=1;
        SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT,'Missing topology revision') END;
      END;
      CREATE TRIGGER IF NOT EXISTS native_mesh_topology_update_v3 AFTER UPDATE ON native_mesh_agents_v1
      WHEN OLD.id IS NOT NEW.id OR OLD.host_id IS NOT NEW.host_id OR OLD.agent_id IS NOT NEW.agent_id
        OR OLD.parent_id IS NOT NEW.parent_id OR OLD.name IS NOT NEW.name OR OLD.state IS NOT NEW.state BEGIN
        UPDATE native_mesh_topology_revision_v3 SET revision=revision+1 WHERE singleton=1;
        SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT,'Missing topology revision') END;
      END;
      CREATE TABLE IF NOT EXISTS native_mesh_audit_dedup_v2 (
        id TEXT PRIMARY KEY, actor_hash TEXT NOT NULL, declaration_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_mesh_audit_install_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1));
      -- Atomically discard any pre-migration bindings, once. Existing audit
      -- records and the earlier optimization table are never deleted.
      DELETE FROM native_mesh_audit_dedup_v2 WHERE NOT EXISTS (SELECT 1 FROM native_mesh_audit_install_v2 WHERE singleton=1);
      INSERT OR IGNORE INTO native_mesh_audit_install_v2 VALUES (1);
      -- Old servers and external SQLite writers must invalidate bindings too.
      CREATE TRIGGER IF NOT EXISTS native_mesh_audit_insert_v2 AFTER INSERT ON native_mesh_agents_v1 BEGIN
        DELETE FROM native_mesh_audit_dedup_v2 WHERE id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS native_mesh_audit_delete_v2 AFTER DELETE ON native_mesh_agents_v1 BEGIN
        DELETE FROM native_mesh_audit_dedup_v2 WHERE id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS native_mesh_audit_update_v2 AFTER UPDATE ON native_mesh_agents_v1
      WHEN OLD.id IS NOT NEW.id OR OLD.host_id IS NOT NEW.host_id OR OLD.agent_id IS NOT NEW.agent_id
        OR OLD.parent_id IS NOT NEW.parent_id OR OLD.name IS NOT NEW.name OR OLD.state IS NOT NEW.state BEGIN
        DELETE FROM native_mesh_audit_dedup_v2 WHERE id=OLD.id OR id=NEW.id;
      END;`))();
  }
  catch (error) { db.close(); throw error; }
  let closed = false;
  const pendingAudit = new WeakMap<Request, {id:string; declaration:string; revision:string; topology:string}>();
  const auditRevision = () => {
    const row = db.query("SELECT CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END AS revision FROM native_mesh_revision_v2 WHERE singleton=1").get() as {revision:string|null}|null;
    if (!row || row.revision === null) throw new Error("Invalid audit revision");
    return row.revision;
  };
  async function candidate(req: Request) {
    if (closed || req.method !== "POST" || new URL(req.url).pathname !== "/v1/native-mesh/agents" || !authorized(req)) return null;
    try {
      const data = await json(req);
      fields(data, ["hostId","agentId","parentId","name","state"]);
      const r = data as unknown as MeshRegistration;
      validateRegistration(r);
      return {r, id: qualifiedAgentId(r.hostId, r.agentId), declaration: digest([r.hostId,r.agentId,r.parentId,r.name,r.state])};
    } catch { return null; }
  }
  // Bound retained data, count and lifetime. The accounting includes two bytes per
  // JSON byte and a per-record allowance for JS strings/array entries. It is not
  // an exact V8/Bun heap measurement. Oversized scans fail, never truncate.
  const MAX_SNAPSHOTS = 48, MAX_SNAPSHOT_RECORDS = 20_000;
  const MAX_SNAPSHOT_MEMORY = 8 * 1024 * 1024, MAX_TOTAL_MEMORY = 256 * 1024 * 1024;
  const SNAPSHOT_TTL_MS = 30_000, SNAPSHOT_REUSE_MS = 10_000;
  type Snapshot = {rows: string[]; ids: string[]; topology: string; cursors: Map<number, Uint8Array>; memory: number; created: number; expires: number; timer?: ReturnType<typeof setTimeout>};
  const snapshots = new Map<string, Snapshot>();
  let retainedMemory = 0;
  const discard = (key: string) => {
    const snapshot = snapshots.get(key);
    if (snapshot) { snapshots.delete(key); retainedMemory -= snapshot.memory; if (snapshot.timer) clearTimeout(snapshot.timer); }
  };
  const purge = () => { for (const [key, snapshot] of snapshots) if (performance.now() >= snapshot.expires) discard(key); };
  const newRevision = () => {
    let key: string;
    do { key = (randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn).toString(); } while (snapshots.has(key));
    return key;
  };
  const size = ["id", "host_id", "agent_id", "parent_id", "name", "state", "last_heartbeat_at"]
    .map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
  // Guard character counts before CAST to BLOB: even corrupt externally-written
  // multi-gigabyte TEXT must not be copied into a JS value or a giant SQL blob.
  const excessiveChars = ["id", "host_id", "agent_id", "parent_id", "name", "state", "last_heartbeat_at"]
    .map(column => `coalesce(length(${column}),0) > ${MAX_BYTES}`).join(" OR ");
  // SQLite length(TEXT) stops at NUL. Reject embedded NUL before relying on
  // length or converting TEXT to BLOB, including externally corrupted rows.
  const containsNul = ["id", "host_id", "agent_id", "parent_id", "name", "state", "last_heartbeat_at"]
    .map(column => `instr(${column}, char(0)) > 0`).join(" OR ");
  const oversized = `CASE WHEN ${containsNul} THEN 2 WHEN ${excessiveChars} THEN 1 WHEN (${size}) > ${MAX_BYTES} THEN 1 ELSE 0 END`;
  const safe = (column: string, alias: string) => `CASE WHEN (${oversized}) = 0 THEN ${column} ELSE NULL END AS ${alias}`;
  const columns = `${safe("id", "id")},${safe("host_id", "hostId")},${safe("agent_id", "agentId")},${safe("parent_id", "parentId")},${safe("name", "name")},${safe("state", "state")},${safe("last_heartbeat_at", "lastHeartbeatAt")},'observed' AS status, (${oversized}) AS oversized`;
  function currentTopology(): string {
    const row = db.query("SELECT CASE WHEN typeof(revision)='integer' AND revision >= 0 THEN CAST(revision AS TEXT) END AS revision FROM native_mesh_topology_revision_v3 WHERE singleton=1").get() as {revision: string | null} | null;
    if (!row || row.revision === null) throw new HttpError(500, "Invalid topology revision");
    return row.revision;
  }
  function readSnapshot(revision: string, limit: number, emergencyLegacy = false): {snapshot: Snapshot; page: Response} {
    const deadline = performance.now() + 1000;
    const budgeted = emergencyLegacy;
    const checkDeadline = () => { if (budgeted && performance.now() >= deadline) throw new HttpError(503, "Discovery time budget exceeded"); };
    return db.transaction(() => {
      // Establish the SQLite snapshot before reading rows, so revision and rows
      // are guaranteed to represent the same committed state.
      const topology = currentTopology();
      const rows: string[] = [], ids: string[] = [];
      let memory = 0, legacyBytes = Buffer.byteLength('{"agents":[]}');
      checkDeadline();
      for (const raw of db.query(`SELECT ${columns} FROM native_mesh_agents_v1 ORDER BY id`).iterate()) {
        checkDeadline();
        const row = raw as Record<string, unknown>;
        if (row.oversized === 2) throw new HttpError(500, "Invalid observation in database");
        if (row.oversized) throw new HttpError(413, "Observation too large");
        delete row.oversized;
        const registration = {hostId: row.hostId, agentId: row.agentId, parentId: row.parentId, name: row.name, state: row.state} as MeshRegistration;
        try { validateRegistration(registration); } catch { throw new HttpError(500, "Invalid observation in database"); }
        if (row.id !== qualifiedAgentId(registration.hostId, registration.agentId) || typeof row.lastHeartbeatAt !== "string" || Buffer.byteLength(row.lastHeartbeatAt) > 64 || !Number.isFinite(Date.parse(row.lastHeartbeatAt))) throw new HttpError(500, "Invalid observation in database");
        const encoded = JSON.stringify(row);
        legacyBytes += Buffer.byteLength(encoded) + (rows.length ? 1 : 0);
        if (emergencyLegacy && (legacyBytes >= MAX_BYTES || rows.length >= 10_000)) emergencyLegacy = false;
        memory += 2 * Buffer.byteLength(encoded) + 256;
        if (rows.length >= MAX_SNAPSHOT_RECORDS || memory > MAX_SNAPSHOT_MEMORY) throw new HttpError(413, "Discovery snapshot too large");
        rows.push(encoded); ids.push(row.id as string);
      }
      const snapshot: Snapshot = {rows, ids, topology, cursors: new Map(), memory, created: 0, expires: 0};
      if (emergencyLegacy) {
        checkDeadline();
        const body = '{"agents":[' + rows.join(",") + ']}';
        const page = new Response(body, {status:200, headers:{"content-type":"application/json; charset=utf-8", "cache-control":"no-store"}});
        checkDeadline();
        return {snapshot, page};
      }
      // Construct the first response while the same read transaction is still
      // active, as for continuation pages and the previous v2 implementation.
      return {snapshot, page: snapshotPage(snapshot, revision, 0, limit)};
    })();
  }
  function snapshotPage(snapshot: Snapshot, revision: string, start: number, limit: number): Response {
    let index = start;
    // Add each pre-encoded record once, with exact UTF-8 bytes for the
    // envelope and cursor. This avoids re-serializing an expanding page.
    let recordsBytes = 0;
    while (index < snapshot.rows.length && index - start < limit) {
      const next = Buffer.byteLength(snapshot.rows[index]!) + (index > start ? 1 : 0);
      const candidateCursor = index + 1 < snapshot.rows.length ? snapshot.ids[index]! : null;
      const envelopeBytes = Buffer.byteLength(JSON.stringify({version: 2, agents: [], nextCursor: candidateCursor, revision}));
      if (envelopeBytes + recordsBytes + next >= MAX_BYTES) {
        if (index === start) throw new HttpError(413, "Observation too large");
        break;
      }
      recordsBytes += next; index++;
    }
    const agents = snapshot.rows.slice(start, index).map(row => JSON.parse(row) as MeshObservation);
    const nextCursor = index < snapshot.rows.length ? agents[agents.length - 1]!.id : null;
    // Build the response before issuing its cursor. Failure must not authorize
    // a cursor that the caller did not receive.
    const page = response(200, {version: 2, agents, nextCursor, revision});
    if (nextCursor !== null) {
      let issued = snapshot.cursors.get(limit);
      if (!issued) {
        // Account for the byte buffer and a conservative allowance for the
        // typed array and Map entry. This is not an exact heap measurement.
        const bytes = Math.ceil(snapshot.rows.length / 8), cost = bytes + 256;
        const retained = snapshots.get(revision) === snapshot;
        if (snapshot.memory + cost > MAX_SNAPSHOT_MEMORY ||
            retainedMemory + (retained ? cost : snapshot.memory + cost) > MAX_TOTAL_MEMORY)
          throw new HttpError(503, "Discovery snapshot capacity exhausted");
        issued = new Uint8Array(bytes);
        snapshot.cursors.set(limit, issued);
        snapshot.memory += cost;
        if (retained) retainedMemory += cost;
      }
      const bit = index - 1;
      issued[bit >> 3] = issued[bit >> 3]! | (1 << (bit & 7));
    }
    return page;
  }
  return {
    async tryAuditedHeartbeat(req: Request, actor: string): Promise<Response | null> {
      const c = await candidate(req);
      if (!c) return null;
      try {
        return db.transaction(() => {
          auditRevision(); currentTopology();
          const at = new Date().toISOString(), r = c.r;
          const changed = db.query(`UPDATE native_mesh_agents_v1 SET last_heartbeat_at=?
            WHERE id=? AND host_id=? AND agent_id=? AND parent_id IS ? AND name=? AND state=?
            AND EXISTS (SELECT 1 FROM native_mesh_audit_dedup_v2 WHERE id=? AND actor_hash=? AND declaration_hash=?)`)
            .run(at,c.id,r.hostId,r.agentId,r.parentId,r.name,r.state,c.id,digest(actor),c.declaration).changes;
          if (!changed) return null;
          db.query("UPDATE native_mesh_revision_v2 SET revision=revision+1 WHERE singleton=1").run();
          auditRevision();
          return response(200, {agent: {...r,id:c.id,lastHeartbeatAt:at,status:"observed"}});
        }).immediate();
      } catch { return null; }
    },
    async rememberAuditedHeartbeat(req: Request, actor: string): Promise<void> {
      const c = pendingAudit.get(req);
      pendingAudit.delete(req);
      if (!c || closed) return;
      try {
        // v2 changes on server writes; v3 catches external topology writes,
        // including ABA. Both must still match the committed audited write.
        db.query(`INSERT INTO native_mesh_audit_dedup_v2 (id,actor_hash,declaration_hash)
          SELECT ?,?,? WHERE (SELECT CAST(revision AS TEXT) FROM native_mesh_revision_v2 WHERE singleton=1)=?
          AND (SELECT CAST(revision AS TEXT) FROM native_mesh_topology_revision_v3 WHERE singleton=1)=?
          ON CONFLICT(id) DO UPDATE SET actor_hash=excluded.actor_hash,declaration_hash=excluded.declaration_hash`)
          .run(c.id,digest(actor),c.declaration,c.revision,c.topology);
      } catch { /* No binding is safer than an unconfirmed binding. */ }
    },
    async fetch(req: Request): Promise<Response> {
      try {
        if (closed) return response(503, {error: "Closed"});
        if (!authorized(req)) return response(401, {error: "Unauthorized"});
        if (new URL(req.url).pathname !== "/v1/native-mesh/agents") return response(404, {error: "Not found"});
        if (req.method === "GET") {
          const params = new URL(req.url).searchParams;
          const legacy = [...params].length === 0;
          if (!legacy && ([...params.keys()].some(k => !["limit", "after", "revision"].includes(k)) ||
              ["limit", "after", "revision"].some(k => params.getAll(k).length > 1))) throw new HttpError(400, "Invalid pagination");
          const rawLimit = params.get("limit"), after = params.get("after"), expected = params.get("revision");
          if (!legacy && (rawLimit === null || !/^(?:[1-9][0-9]{0,2}|1000|4000)$/.test(rawLimit) ||
              (after === null) !== (expected === null) || (after !== null && !qid(after)) ||
              (expected !== null && !/^(0|[1-9][0-9]{0,18})$/.test(expected)))) throw new HttpError(400, "Invalid pagination");
          const limit = legacy ? MAX_PAGE : Number(rawLimit);
          if (legacy) {
            return db.transaction(() => {
              const rows = db.query(`SELECT ${columns} FROM native_mesh_agents_v1 WHERE id > ? ORDER BY id LIMIT ?`).all("", MAX_PAGE + 1) as Record<string, unknown>[];
              if (rows.some(row => row.oversized)) throw new HttpError(413, "Observation too large");
              for (const row of rows) delete row.oversized;
              if (rows.length > MAX_PAGE || Buffer.byteLength(JSON.stringify({agents: rows})) > MAX_BYTES) throw new HttpError(413, "Discovery requires pagination");
              return response(200, {agents: rows});
            })();
          }
          purge();
          if (expected !== null) {
            const snapshot = snapshots.get(expected);
            if (!snapshot) throw new HttpError(409, "Discovery snapshot expired");
            return db.transaction(() => {
              if (currentTopology() !== snapshot.topology) { discard(expected); throw new HttpError(409, "Discovery topology changed"); }
              // Find the exact issued cursor for this limit. No guessed or
              // unissued position may skip data, even on a shared snapshot.
              let low = 0, high = snapshot.ids.length;
              while (low < high) { const mid = (low + high) >>> 1; if (snapshot.ids[mid]! < after!) low = mid + 1; else high = mid; }
              const issued = snapshot.cursors.get(limit);
              if (snapshot.ids[low] !== after || !issued || !(issued[low >> 3]! & (1 << (low & 7)))) throw new HttpError(400, "Invalid pagination");
              return snapshotPage(snapshot, expected, low + 1, limit);
            })();
          }
          // Shared scans must be rechecked against the database on every first
          // page as well. This prevents reuse after an identity/family change.
          const cached = rawLimit === "100" ? undefined : db.transaction(() => {
            const topology = currentTopology(), now = performance.now();
            for (const [revision, snapshot] of snapshots) {
              if (snapshot.topology !== topology) { discard(revision); continue; }
              if (now - snapshot.created < SNAPSHOT_REUSE_MS) return snapshotPage(snapshot, revision, 0, limit);
            }
            return undefined;
          })();
          if (cached) return cached;
          if (snapshots.size >= MAX_SNAPSHOTS) throw new HttpError(503, "Discovery snapshot capacity exhausted");
          const revision = newRevision();
          const {snapshot, page} = readSnapshot(revision, limit, rawLimit === "100");
          if (snapshot.cursors.size) {
            if (retainedMemory + snapshot.memory > MAX_TOTAL_MEMORY) throw new HttpError(503, "Discovery snapshot capacity exhausted");
            snapshot.created = performance.now();
            snapshot.expires = snapshot.created + SNAPSHOT_TTL_MS;
            snapshots.set(revision, snapshot); retainedMemory += snapshot.memory;
            snapshot.timer = setTimeout(() => discard(revision), SNAPSHOT_TTL_MS);
            snapshot.timer.unref();
          }
          return page;
        }
        if (req.method !== "POST") return response(405, {error: "Method not allowed"}, {allow: "GET, POST"});
        const data = await json(req);
        fields(data, ["hostId","agentId","parentId","name","state"]);
        const r = data as unknown as MeshRegistration;
        try { validateRegistration(r); } catch { throw new HttpError(400, "Invalid registration"); }
        const id = qualifiedAgentId(r.hostId, r.agentId), lastHeartbeatAt = new Date().toISOString();
        const generation = db.transaction(() => {
          db.query(`INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,state=excluded.state,last_heartbeat_at=excluded.last_heartbeat_at`)
            .run(id,r.hostId,r.agentId,r.parentId,r.name,r.state,lastHeartbeatAt);
          db.query("UPDATE native_mesh_revision_v2 SET revision=revision+1 WHERE singleton=1").run();
          // Invalid epochs only disable the optimization; do not alter the
          // existing handler's successful mutation semantics.
          try { return {revision:auditRevision(),topology:currentTopology()}; }
          catch { return null; }
        })();
        if (generation) pendingAudit.set(req, {id, declaration:digest([r.hostId,r.agentId,r.parentId,r.name,r.state]), ...generation});
        return response(200, {agent: {...r,id,lastHeartbeatAt,status:"observed"}});
      } catch (error) {
        return error instanceof HttpError ? response(error.status, {error:error.message}) : response(500, {error:"Internal error"});
      }
    },
    close() { if (!closed) {closed = true; for (const key of snapshots.keys()) discard(key); db.close();} },
  };
}
class MeshBridge extends PrimeBridge {
  async register(r: MeshRegistration): Promise<void> { await this.request("/v1/native-mesh/agents", "POST", r); }
  async observations(limit: number, after?: string, revision?: string): Promise<unknown> {
    const params = new URLSearchParams({limit: String(limit)});
    if (after !== undefined && revision !== undefined) { params.set("after", after); params.set("revision", revision); }
    return this.request(`/v1/native-mesh/agents?${params}`, "GET", undefined, true, MAX_BYTES);
  }
}
export class NativeMesh {
  private readonly bus: MeshBridge;
  private readonly options: BridgeOptions;
  constructor(options: BridgeOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS or loopback HTTP");
    this.bus = new MeshBridge(options);
    this.options = {...options};
  }
  async register(registration: MeshRegistration): Promise<void> {
    validateRegistration(registration);
    const {hostId, agentId, parentId, name, state} = registration;
    await this.bus.register({hostId, agentId, parentId, name, state});
  }
  /** A scan reads one bounded, possibly stale snapshot; it is not a liveness check. */
  async discover(): Promise<MeshObservation[]> {
    const controller = new AbortController();
    const budget = {bytes: 0, records: 0};
    const fetcher: BridgeOptions["fetch"] = async (input, init) => {
      if (controller.signal.aborted) throw new BridgeError("Discovery timed out");
      const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
      const res = await this.options.fetch(input, {...init, signal});
      if (controller.signal.aborted) { void res.body?.cancel(); throw new BridgeError("Discovery timed out"); }
      if (!res.ok || !res.body) return res;
      const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          budget.bytes += chunk.byteLength;
          if (budget.bytes > MAX_SCAN_BYTES) throw new Error("Discovery byte budget exceeded");
          stream.enqueue(chunk);
        },
      }));
      return new Response(body, {status: res.status, statusText: res.statusText, headers: res.headers});
    };
    const bus = new MeshBridge({...this.options, fetch: fetcher});
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Negotiate only before any page is accepted. Keep the selected limit across
    // snapshot retries; a continuation error must never silently downgrade it.
    const paging = {limit: 4000, negotiating: true};
    const scan = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await this.discoverOnce(bus, budget, paging); }
        catch (error) { if (!(error instanceof BridgeError && error.status === 409) || attempt === 2) throw error; }
      }
      throw new Error("Discovery changed");
    };
    try {
      return await Promise.race([
        scan(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BridgeError("Discovery timed out")); }, this.options.timeoutMs ?? 10000); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  private async discoverOnce(bus: MeshBridge, budget: {bytes: number; records: number}, paging: {limit: number; negotiating: boolean}): Promise<MeshObservation[]> {
    const results: MeshObservation[] = [], seen = new Set<string>();
    let after: string | undefined, revision: string | undefined;
    while (true) {
      let result: unknown;
      try {
        result = await bus.observations(paging.limit, after, revision);
        paging.negotiating = false;
      } catch (error) {
        if (paging.negotiating && error instanceof BridgeError && error.status === 400 && paging.limit > 100) {
          paging.limit = paging.limit === 4000 ? 1000 : 100;
          continue;
        }
        paging.negotiating = false;
        throw error;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid observations");
      const page = result as Record<string, unknown>;
      if (!Array.isArray(page.agents)) throw new Error("Invalid observations");
      budget.records += page.agents.length;
      if (budget.records > MAX_SCAN_RECORDS) throw new Error("Discovery record budget exceeded");
      const legacy = page.version === undefined;
      if (legacy && (after !== undefined || "nextCursor" in page || "revision" in page)) throw new Error("Invalid observations");
      if (!legacy && (page.version !== 2 || page.agents.length > paging.limit || typeof page.revision !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(page.revision) ||
          (revision !== undefined && page.revision !== revision) || !(page.nextCursor === null || qid(page.nextCursor)))) throw new Error("Invalid observations");
      let last = after;
      for (const item of page.agents) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid observations");
        const record = item as Record<string, unknown>;
        const r = {hostId: record.hostId, agentId: record.agentId, parentId: record.parentId, name: record.name, state: record.state} as MeshRegistration;
        try { validateRegistration(r); } catch { throw new Error("Invalid observations"); }
        if (record.id !== qualifiedAgentId(r.hostId, r.agentId) || record.status !== "observed" || typeof record.lastHeartbeatAt !== "string" || !Number.isFinite(Date.parse(record.lastHeartbeatAt)) || seen.has(record.id as string) ||
            (!legacy && last !== undefined && (record.id as string) <= last)) throw new Error("Invalid observations");
        last = record.id as string; seen.add(last);
        results.push({...r, id: last, lastHeartbeatAt: record.lastHeartbeatAt, status: "observed"});
      }
      if (legacy || page.nextCursor === null) return results;
      if (!page.agents.length || page.nextCursor !== last) throw new Error("Invalid observations");
      after = last; revision = page.revision as string;
    }
  }
  /** Caller resolves reachability against trusted native family metadata before send. */
  async send(input: {senderId: string; recipientId: string; messageId: string; text: string}): Promise<void> {
    if (!qid(input.senderId) || !qid(input.recipientId)) throw new Error("Invalid mesh recipient or sender");
    await this.bus.send({requestId: meshRequestId(input.senderId, input.messageId), from: input.senderId, to: input.recipientId, text: input.text});
  }
  async pull(recipientId: string): Promise<BusMessage[]> {
    if (!qid(recipientId)) throw new Error("Invalid recipient");
    return (await this.bus.pull(recipientId)).filter(m => qid(m.from) && /^nm1m-[0-9a-f]{64}$/.test(m.requestId));
  }
  /** Only after idempotent durable native-inbox persistence. */
  async ack(requestId: string): Promise<void> {
    if (!/^nm1m-[0-9a-f]{64}$/.test(requestId)) throw new Error("Invalid message ID");
    await this.bus.ack(requestId);
  }
}
