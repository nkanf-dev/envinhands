/**
 * Native mesh protocol v1 over the existing EnvInHands agent bus.
 *
 * Wire: qualified identity is nm1- + SHA-256(JSON.stringify([hostId,agentId])).
 * POST /v1/native-mesh/agents writes {hostId,agentId,parentId,name,state};
 * GET /v1/native-mesh/agents?limit=100 returns version 2 pages with agents,
 * nextCursor and a persistent revision. Continue with after and revision. A 409
 * means registrations changed; restart discovery. Paging is not a lease or a
 * liveness check. The unparameterized legacy list is bounded and may return 413.
 * Upgrade all servers before clients. Do not run old and new servers writing the
 * same database, or modify registrations directly in SQLite: only writes via
 * this version of the server update the revision. Such writes break snapshot
 * detection. Discovery has one timeoutMs deadline (default 10 seconds), and
 * across all retries reads at most 32 MiB and validates at most 100,000 records.
 * parentId is a qualified identity or null. Null means a root. Registrations are
 * observations, not leases or proof of life. Identities must be stable and
 * globally unique per host/incarnation; never reuse an ID for another session.
 * No TTL or cleanup is provided. lastHeartbeatAt is server receipt time, not
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
import { createHash } from "node:crypto";
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
  try { db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS native_mesh_agents_v1 (
    id TEXT PRIMARY KEY, host_id TEXT NOT NULL, agent_id TEXT NOT NULL, parent_id TEXT,
    name TEXT NOT NULL, state TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_mesh_revision_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO native_mesh_revision_v2 VALUES (1, 0)`); }
  catch (error) { db.close(); throw error; }
  let closed = false;
  return {
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
          if (!legacy && (rawLimit === null || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit) ||
              (after === null) !== (expected === null) || (after !== null && !qid(after)) ||
              (expected !== null && !/^(0|[1-9][0-9]{0,18})$/.test(expected)))) throw new HttpError(400, "Invalid pagination");
          const limit = legacy ? MAX_PAGE : Number(rawLimit);
          // The revision and rows must be read from the same SQLite snapshot.
          return db.transaction(() => {
            const revision = (db.query("SELECT CAST(revision AS TEXT) AS revision FROM native_mesh_revision_v2 WHERE singleton=1").get() as {revision: string}).revision;
            if (expected !== null && expected !== revision) throw new HttpError(409, "Discovery changed");
            // Test byte lengths in SQLite before transferring any column to JS.
            // This also bounds memory if a corrupt or external writer inserted huge values.
            const size = ["id", "host_id", "agent_id", "parent_id", "name", "state", "last_heartbeat_at"]
              .map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
            const safe = (column: string, alias: string) => `CASE WHEN (${size}) <= ${MAX_BYTES} THEN ${column} ELSE NULL END AS ${alias}`;
            const rows = db.query(`SELECT ${safe("id", "id")},${safe("host_id", "hostId")},${safe("agent_id", "agentId")},${safe("parent_id", "parentId")},${safe("name", "name")},${safe("state", "state")},${safe("last_heartbeat_at", "lastHeartbeatAt")},'observed' AS status, (${size}) > ${MAX_BYTES} AS oversized FROM native_mesh_agents_v1 WHERE id > ? ORDER BY id LIMIT ?`).all(after ?? "", limit + 1) as ({id: string; oversized: number})[];
            if (rows.some(row => row.oversized)) throw new HttpError(413, "Observation too large");
            for (const row of rows) delete (row as {oversized?: number}).oversized;
            if (legacy) {
              if (rows.length > MAX_PAGE || Buffer.byteLength(JSON.stringify({agents: rows})) > MAX_BYTES) throw new HttpError(413, "Discovery requires pagination");
              return response(200, {agents: rows});
            }
            const agents = rows.slice(0, limit);
            let more = rows.length > limit;
            while (true) {
              const body = {version: 2, agents, nextCursor: more && agents.length ? agents[agents.length - 1]!.id : null, revision};
              if (Buffer.byteLength(JSON.stringify(body)) <= MAX_BYTES) return response(200, body);
              if (agents.length <= 1) throw new HttpError(413, "Observation too large");
              agents.pop(); more = true;
            }
          })();
        }
        if (req.method !== "POST") return response(405, {error: "Method not allowed"}, {allow: "GET, POST"});
        const data = await json(req);
        fields(data, ["hostId","agentId","parentId","name","state"]);
        const r = data as unknown as MeshRegistration;
        try { validateRegistration(r); } catch { throw new HttpError(400, "Invalid registration"); }
        const id = qualifiedAgentId(r.hostId, r.agentId), lastHeartbeatAt = new Date().toISOString();
        db.transaction(() => {
          db.query(`INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,state=excluded.state,last_heartbeat_at=excluded.last_heartbeat_at`)
            .run(id,r.hostId,r.agentId,r.parentId,r.name,r.state,lastHeartbeatAt);
          db.query("UPDATE native_mesh_revision_v2 SET revision=revision+1 WHERE singleton=1").run();
        })();
        return response(200, {agent: {...r,id,lastHeartbeatAt,status:"observed"}});
      } catch (error) {
        return error instanceof HttpError ? response(error.status, {error:error.message}) : response(500, {error:"Internal error"});
      }
    },
    close() { if (!closed) {closed = true; db.close();} },
  };
}
class MeshBridge extends PrimeBridge {
  async register(r: MeshRegistration): Promise<void> { await this.request("/v1/native-mesh/agents", "POST", r); }
  async observations(after?: string, revision?: string): Promise<unknown> {
    const params = new URLSearchParams({limit: String(MAX_PAGE)});
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
  /** A changing registry can force a restart; this is not a liveness check. */
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
    const scan = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await this.discoverOnce(bus, budget); }
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
  private async discoverOnce(bus: MeshBridge, budget: {bytes: number; records: number}): Promise<MeshObservation[]> {
    const results: MeshObservation[] = [], seen = new Set<string>();
    let after: string | undefined, revision: string | undefined;
    while (true) {
      const result = await bus.observations(after, revision);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid observations");
      const page = result as Record<string, unknown>;
      if (!Array.isArray(page.agents)) throw new Error("Invalid observations");
      budget.records += page.agents.length;
      if (budget.records > MAX_SCAN_RECORDS) throw new Error("Discovery record budget exceeded");
      const legacy = page.version === undefined;
      if (legacy && (after !== undefined || "nextCursor" in page || "revision" in page)) throw new Error("Invalid observations");
      if (!legacy && (page.version !== 2 || page.agents.length > MAX_PAGE || typeof page.revision !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(page.revision) ||
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
