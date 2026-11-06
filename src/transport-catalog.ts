/** Team-shared, untrusted route observations. They are not SSH trust or commands. */
import { Database } from "bun:sqlite";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { bearerAuth, fields, HttpError, json, response, bodyBytes } from "./http.ts";
import { buildSshRouteArgv, selectSshRoute, type SshRoute, type SshAccess } from "./transports/ssh-routes.ts";
import type { CommandRunner } from "./readiness.ts";

export type TransportKind = "direct" | "easytier" | "frp" | "relay" | "uu";
export interface TransportObservation {
  machineId: string; routeId: string; kind: TransportKind; controller: string;
  host?: string; port?: number; relayNodeId?: string;
  priority: number; observedAt: number; ttlMs: number;
}
export type TransportRecord = TransportObservation & { status: "observed" | "unknown" };
export interface TransportCatalogPage { machineId: string; routes: TransportRecord[] }
const MAX_ROUTES = 64, MAX_TTL = 86400000;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(v);
const validHost = (v: unknown): v is string => typeof v === "string" && v.length <= 253 && (isIP(v) !== 0 || v.split(".").every(p => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(p)));
function parse(value: unknown, now: number): TransportObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400,"Invalid route");
  const v = value as Record<string, unknown>;
  fields(v, ["machineId","routeId","kind","controller","host","port","relayNodeId","priority","observedAt","ttlMs"]);
  if (!id(v.machineId) || !id(v.routeId) || !id(v.controller) || !["direct","easytier","frp","relay","uu"].includes(v.kind as string) ||
      !Number.isSafeInteger(v.priority) || (v.priority as number) < 0 || (v.priority as number) > 10000 ||
      !Number.isSafeInteger(v.observedAt) || (v.observedAt as number) < 0 || (v.observedAt as number) > now ||
      !Number.isSafeInteger(v.ttlMs) || (v.ttlMs as number) < 1 || (v.ttlMs as number) > MAX_TTL) throw new HttpError(400,"Invalid route");
  if (v.kind === "relay") {
    if (!id(v.relayNodeId) || v.host !== undefined || v.port !== undefined) throw new HttpError(400,"Invalid relay");
  } else if (!validHost(v.host) || !Number.isInteger(v.port) || (v.port as number) < 1 || (v.port as number) > 65535 || v.relayNodeId !== undefined) throw new HttpError(400,"Invalid endpoint");
  return v as unknown as TransportObservation;
}
/**
 * API is mountable with fetch and owns one SQLite connection until close().
 * A persistent filename is required by default. Set allowInMemory to use an
 * isolated, volatile :memory: database; its contents are lost on close().
 * Expired observations remain visible as unknown until a full catalog needs a
 * slot, when one expired observation of that machine is removed. Eviction also
 * removes its timestamp; stale-write protection does not survive that eviction.
 */
export function createTransportCatalogApi(options: { dbPath: string; token: string; now?: () => number; allowInMemory?: boolean }) {
  const auth = bearerAuth(options.token), now = options.now ?? Date.now;
  if (!options.dbPath || (options.dbPath === ":memory:" && options.allowInMemory !== true)) throw new Error("A persistent SQLite filename is required");
  const db = new Database(options.dbPath, {create:true, strict:true});
  try { db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS transport_catalog (machine_id TEXT NOT NULL, route_id TEXT NOT NULL, observed_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(machine_id,route_id));`); }
  catch(e) { db.close(); throw e; }
  const put = db.transaction((v: TransportObservation, at: number) => {
    const row = db.query<{observed_at:number}, [string,string]>("SELECT observed_at FROM transport_catalog WHERE machine_id=? AND route_id=?").get(v.machineId,v.routeId);
    if (row && row.observed_at > v.observedAt) throw new HttpError(409,"Stale observation");
    if (!row) {
      const count = db.query<{n:number}, [string]>("SELECT count(*) AS n FROM transport_catalog WHERE machine_id=?").get(v.machineId)!.n;
      if (count >= MAX_ROUTES) {
        // Make only one slot, and only by removing an expired observation for
        // this machine. The immediate transaction serializes this with updates
        // from other connections; active routes must never be evicted.
        const removed = db.query(`DELETE FROM transport_catalog WHERE rowid = (
          SELECT rowid FROM transport_catalog WHERE machine_id = ?
          AND observed_at + json_extract(payload, '$.ttlMs') <= ?
          ORDER BY observed_at + json_extract(payload, '$.ttlMs'), route_id LIMIT 1
        )`).run(v.machineId, at);
        if (removed.changes === 0) throw new HttpError(409,"Too many routes for machine");
      }
    }
    db.query("INSERT INTO transport_catalog VALUES(?,?,?,?) ON CONFLICT(machine_id,route_id) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload").run(v.machineId,v.routeId,v.observedAt,JSON.stringify(v));
  });
  let closed = false;
  return { async fetch(request: Request): Promise<Response> {
    try {
      if (closed) return response(503,{error:"Catalog closed"});
      if (!auth(request)) return response(401,{error:"Unauthorized"},{"www-authenticate":"Bearer"});
      const url = new URL(request.url);
      if (url.pathname !== "/v1/transport-catalog") return response(404,{error:"Not found"});
      if (request.method === "POST") {
        if (url.search) throw new HttpError(400,"Unexpected query");
        const body = await json(request);
        const at = now();
        const v = parse(body, at); put.immediate(v, at); return response(200,{ok:true});
      }
      if (request.method !== "GET") return response(405,{error:"Method not allowed"},{allow:"GET, POST"});
      if ([...url.searchParams.keys()].some(k => k !== "machineId") || url.searchParams.getAll("machineId").length !== 1 || !id(url.searchParams.get("machineId"))) throw new HttpError(400,"Invalid query");
      const machineId = url.searchParams.get("machineId")!;
      const rows = db.query<{payload:string},[string]>("SELECT payload FROM transport_catalog WHERE machine_id=? ORDER BY route_id LIMIT 64").all(machineId);
      const t = now(), routes = rows.map(row => { const v = JSON.parse(row.payload) as TransportObservation; return {...v,status: v.observedAt + v.ttlMs > t ? "observed" : "unknown"}; });
      return response(200,{machineId,routes});
    } catch(e) { if (e instanceof HttpError) return response(e.status,{error:e.message}); return response(500,{error:"Internal error"}); }
  }, close() { if (!closed) { closed=true; db.close(); } } };
}

/** Fetch only a bounded machine-scoped result; token is never put in a URL. */
export async function fetchTransportCatalog(baseUrl: string, token: string, machineId: string, fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch): Promise<TransportCatalogPage> {
  if (!id(machineId) || !token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error("Invalid catalog request");
  const url = new URL("/v1/transport-catalog",baseUrl); url.searchParams.set("machineId",machineId);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("Catalog requires HTTPS or loopback HTTP");
  const res = await fetcher(url, {headers:{authorization:`Bearer ${token}`}, redirect:"error"});
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  const bytes = await bodyBytes(res, 65536); let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); } catch { throw new Error("Invalid catalog response"); }
  return validatePage(data,machineId,Date.now());
}
function validatePage(data: unknown, machineId: string, now: number): TransportCatalogPage {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid catalog response");
  const d = data as Record<string,unknown>; fields(d,["machineId","routes"]);
  if (d.machineId !== machineId || !Array.isArray(d.routes) || d.routes.length > MAX_ROUTES) throw new Error("Invalid catalog response");
  const seen = new Set<string>();
  const routes = d.routes.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid catalog route");
    const {status,...rest} = raw as Record<string,unknown>;
    if (status !== "observed" && status !== "unknown") throw new Error("Invalid catalog status");
    const v = parse(rest,now);
    if (v.machineId !== machineId || seen.has(v.routeId)) throw new Error("Invalid catalog machine or duplicate route");
    seen.add(v.routeId);
    return {...v,status: status === "observed" && v.observedAt + v.ttlMs > now ? "observed" as const : "unknown" as const};
  });
  return {machineId,routes};
}
/** Only local, pre-established trust material is accepted. Never execute uploaded data. */
export function transportCatalogCandidates(page: TransportCatalogPage, machineId: string, local: {access: SshAccess & {identityFile:string; knownHostsFile:string}; relayBinaryPath:string}, now = Date.now()): {routes:SshRoute[]; priority:string[]} {
  if (!id(machineId) || !local?.access?.identityFile || !local.access.knownHostsFile || !local.relayBinaryPath || !isAbsolute(local.relayBinaryPath) || /[%\x00-\x1f\x7f]/.test(local.relayBinaryPath)) throw new Error("Local SSH trust and compiled relay binary required");
  const valid = validatePage(page,machineId,now);
  const ranked = valid.routes.filter(v => v.status === "observed").sort((a,b) => Number(a.kind === "relay") - Number(b.kind === "relay") || a.priority - b.priority || a.routeId.localeCompare(b.routeId));
  const routes: SshRoute[] = ranked.map(v => v.kind === "relay" ? {id:v.routeId,host:local.access.hostKeyAlias,relay:{relayNodeId:v.relayNodeId!,binaryPath:local.relayBinaryPath}} : {id:v.routeId,host:v.host!,port:v.port!});
  // Validate trust even with no observations; never rely on SSH ambient config.
  buildSshRouteArgv({id:"validation",host:local.access.hostKeyAlias},local.access);
  for (const route of routes) buildSshRouteArgv(route,local.access);
  return {routes,priority:routes.map(r=>r.id)};
}
/** Probes 'true' only. The caller starts a task once and must not replay it on failure. */
export async function selectCatalogSshRoute(page: TransportCatalogPage, machineId: string, local: {access:SshAccess & {identityFile:string;knownHostsFile:string};relayBinaryPath:string}, options: {totalBudgetMs:number;probeTimeoutMs?:number}, dependencies: {runner?:CommandRunner;now?:()=>number} = {}) {
  const c = transportCatalogCandidates(page,machineId,local,dependencies.now?.() ?? Date.now());
  return selectSshRoute(c.routes,local.access,{...options,priority:c.priority},dependencies);
}
