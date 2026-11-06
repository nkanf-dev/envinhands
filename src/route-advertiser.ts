/** Publish unverified local route observations. This is not an SSH reachability check. */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { TransportObservation } from "./transport-catalog.ts";

type Interfaces = ReturnType<typeof networkInterfaces>;
type Timer = ReturnType<typeof setTimeout>;
type Fetcher = (input: URL, init: RequestInit) => Promise<Response>;
export interface RouteAdvertiserOptions {
  baseUrl: string;
  token: string;
  machineId: string;
  /** Stable, distinct identifier for each controller advertising this machine. */
  controller: string;
  relayNodeId: string;
  sshPort?: number;
  /** Exact interface names explicitly trusted as EasyTier. Others are direct. */
  easytierInterfaces?: readonly string[];
  intervalMs?: number;
  ttlMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
  /** Categories only; never contains route addresses, tokens or exception text. */
  onEvent?: (event: "published" | "retry", fields: { count?: number; delayMs?: number }) => void;
}
export interface RouteAdvertiserDependencies {
  /** Supply signedCliFetch (or equivalent) when server mutation policy requires it. */
  fetch?: Fetcher;
  networkInterfaces?: () => Interfaces;
  random?: () => number;
  setTimeout?: (callback: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
function routeId(controller: string, kind: string, endpoint: string): string {
  return "auto-" + createHash("sha256").update(JSON.stringify([controller, kind, endpoint])).digest("hex");
}

/** Starts immediately but never waits for the service. Call stop on node shutdown. */
export function startRouteAdvertiser(options: RouteAdvertiserOptions, deps: RouteAdvertiserDependencies = {}) {
  const {baseUrl, token, machineId, controller, relayNodeId} = options;
  const interval = options.intervalMs ?? 60_000, ttl = options.ttlMs ?? 180_000;
  const initial = options.retryInitialMs ?? 1_000, max = options.retryMaxMs ?? 60_000;
  const timeout = options.requestTimeoutMs ?? 10_000, port = options.sshPort ?? 22;
  if (![machineId,controller,relayNodeId].every(x => ID.test(x)) || !token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error("Invalid route advertiser identity");
  if (!integer(interval,1,86_399_999) || !integer(ttl,interval+1,86_400_000) || !integer(initial,1,2_147_483_647) || !integer(max,initial,2_147_483_647) || !integer(timeout,1,2_147_483_647) || !integer(port,1,65535)) throw new Error("Invalid route advertiser timing or port");
  const url = new URL("/v1/transport-catalog",baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("Catalog requires HTTPS or loopback HTTP");
  if (url.username || url.password) throw new Error("Catalog URL must not contain credentials");
  const getInterfaces = deps.networkInterfaces ?? networkInterfaces, fetcher = deps.fetch ?? fetch;
  const setTimer: NonNullable<RouteAdvertiserDependencies["setTimeout"]> = deps.setTimeout ?? setTimeout;
  const clearTimer: NonNullable<RouteAdvertiserDependencies["clearTimeout"]> = deps.clearTimeout ?? clearTimeout;
  const easytier = new Set(options.easytierInterfaces ?? []);
  const random = deps.random ?? Math.random;
  let stopped = false, relayConnected = false, generation = 0, failures = 0;
  let timer: Timer | undefined, active: AbortController | undefined;
  const emit = (event: "published" | "retry", fields: {count?:number;delayMs?:number}) => { try { options.onEvent?.(event,fields); } catch {} };
  function schedule(ms: number) {
    if (stopped) return;
    timer = setTimer(() => { timer = undefined; void run(generation); },ms);
  }
  function reschedule() {
    if (stopped) return;
    generation++;
    active?.abort();
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    schedule(0);
  }
  async function request(target: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw new Error("cancelled");
    const local = new AbortController();
    let rejectAbort!: (e: Error) => void;
    const cancelled = new Promise<never>((_,reject) => { rejectAbort = reject; });
    const abort = () => { local.abort(); rejectAbort(new Error("cancelled")); };
    signal.addEventListener("abort",abort,{once:true});
    const deadline = setTimer(abort,timeout);
    try { return await Promise.race([fetcher(target,{...init,signal:local.signal,redirect:"error"}),cancelled]); }
    finally { clearTimer(deadline); signal.removeEventListener("abort",abort); }
  }
  async function run(epoch: number) {
    const ac = new AbortController(); active = ac;
    const valid = () => !stopped && generation === epoch && !ac.signal.aborted;
    try {
      const getUrl = new URL(url); getUrl.searchParams.set("machineId",machineId);
      const headers = {authorization:`Bearer ${token}`,"cache-control":"no-store"};
      const response = await request(getUrl,{headers,cache:"no-store"},ac.signal);
      if (!valid()) return;
      if (!response.ok) throw new Error("catalog unavailable");
      // The server Date is rounded down to seconds. It is deliberately not advanced
      // using the local clock: local time may be arbitrarily ahead of the server.
      const date = response.headers.get("date"), observedAt = date ? Date.parse(date) : NaN;
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("server clock unavailable");
      const interfaces = getInterfaces();
      const routes = new Map<string,TransportObservation>();
      for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries ?? []) {
          const host = entry.address;
          if (entry.internal || !isIP(host) || host.includes("%") || host === "0.0.0.0" || host === "::" || host === "::1" || /^127\./.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) || /^ff/i.test(host)) continue;
          const kind = easytier.has(name) ? "easytier" : "direct";
          const id = routeId(controller,kind,JSON.stringify([host,port]));
          routes.set(id,{machineId,routeId:id,controller,kind,host,port,priority:kind === "easytier" ? 50 : 100,observedAt,ttlMs:ttl});
        }
      }
      const sorted = [...routes.values()].sort((a,b)=>a.routeId.localeCompare(b.routeId));
      // Reserve one slot for relay even with a very large interface list.
      const batch = sorted.slice(0,63);
      if (relayConnected) batch.push({machineId,routeId:routeId(controller,"relay",relayNodeId),controller,kind:"relay",relayNodeId,priority:1000,observedAt,ttlMs:ttl});
      for (const route of batch) {
        if (!valid()) return;
        const result = await request(url,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(route)},ac.signal);
        if (!valid()) return;
        if (!result.ok) throw new Error("catalog unavailable");
      }
      if (!valid()) return;
      failures = 0; emit("published",{count:batch.length}); schedule(interval);
    } catch {
      if (!valid()) return;
      const base = Math.min(max,initial * 2 ** Math.min(failures++,30));
      let sample = 0.5; try { sample = random(); } catch {}
      if (!Number.isFinite(sample)) sample = 0.5;
      const delayMs = Math.max(1,Math.floor(base * (0.8 + 0.2 * Math.max(0,Math.min(1,sample)))));
      emit("retry",{delayMs}); schedule(delayMs);
    } finally { if (active === ac) active = undefined; }
  }
  schedule(0);
  return {
    /** True only after actual registration; false as soon as its control socket closes. */
    setRelayConnected(connected: boolean) { if (relayConnected !== connected) { relayConnected = connected; reschedule(); } },
    /** Call on network or other local state changes to refresh without waiting. */
    refresh: reschedule,
    stop() { if (stopped) return; stopped = true; generation++; active?.abort(); if (timer !== undefined) { clearTimer(timer); timer = undefined; } },
  };
}
