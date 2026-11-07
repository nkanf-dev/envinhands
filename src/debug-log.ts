import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, truncateSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

export type DebugLevel = "debug" | "info" | "warn" | "error";
/** Metadata only: never pass terminal data, request bodies, credentials or exceptions. */
export interface DebugFields {
  machineId?: string; sessionId?: string; connectionId?: string;
  durationMs?: number; retry?: number; transport?: string; errorCategory?: string;
  status?: string; bytesIn?: number; bytesOut?: number; bytesWritten?: number;
  lastInMs?: number; lastOutMs?: number; lastWriteMs?: number; closeCode?: number; peerCode?: number;
}
export interface DebugLogOptions {
  /** A dedicated directory with a trusted, non-writable parent; one writer process per directory. */
  directory: string;
  component: string;
  level?: DebugLevel;
  maxLineBytes?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  rotateMs?: number;
  knownSecrets?: readonly string[];
  /** Called with a fixed category only; callback errors are ignored. */
  onFailure?: (category: "configuration" | "unsafe_path" | "io") => void;
  now?: () => number;
}
export interface DebugLogger {
  log(level: DebugLevel, event: string, fields?: DebugFields): void;
  debug(event: string, fields?: DebugFields): void;
  info(event: string, fields?: DebugFields): void;
  warn(event: string, fields?: DebugFields): void;
  error(event: string, fields?: DebugFields): void;
  /** Counts rejected records and I/O failures, without exposing exception text. */
  status(): { failures: number; lastFailure?: "configuration" | "unsafe_path" | "io" };
  close(): void;
}
const levels: Record<DebugLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const active = new Set<string>();
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const keys = ["machineId", "sessionId", "connectionId", "transport", "errorCategory", "status"] as const;
const numbers = ["durationMs", "retry", "bytesIn", "bytesOut", "bytesWritten", "lastInMs", "lastOutMs", "lastWriteMs", "closeCode", "peerCode"] as const;
type Failure = "configuration" | "unsafe_path" | "io";
class UnsafePath extends Error {}

/**
 * Synchronous, bounded JSONL metadata logger. One process owns each dedicated
 * directory; use different directories for server/node and separate replicas.
 * Calls serialize in a JS isolate. Do not share a directory across processes or
 * worker threads: rotation is not a cross-process locking protocol. Supply only
 * trusted, generated IDs and constant event names, never arbitrary user text.
 * Known-secret redaction is defense in depth, not a general secret detector. Parent path
 * must be trusted against replacement by other users. No Windows ACL guarantee:
 * Windows is rejected rather than treating chmod as access control.
 */
export function createDebugLogger(options: DebugLogOptions): DebugLogger {
  let failures = 0, lastFailure: Failure | undefined, disabled = false, closed = false, ownsDirectory = false;
  const dir = resolve(options.directory), path = join(dir, "events.jsonl");
  const maxLine = options.maxLineBytes ?? 4096, maxFile = options.maxFileBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5, maxTotal = options.maxTotalBytes ?? maxFile * maxFiles;
  const rotateMs = options.rotateMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  let openedAt = 0;
  const fail = (kind: Failure) => { failures++; lastFailure = kind; try { options.onFailure?.(kind); } catch {} };
  const secrets = (options.knownSecrets ?? []).filter(s => typeof s === "string" && s.length > 0);
  const safeToken = (v: unknown): string | undefined => {
    if (typeof v !== "string" || !tokenPattern.test(v) || v.includes("..")) return undefined;
    if (secrets.some(s => v.includes(s))) return "REDACTED";
    return v;
  };
  const checkDir = () => {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o7777) !== 0o700 ||
        (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new UnsafePath();
  };
  const openSafe = (p: string) => {
    const fd = openSync(p, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const st = fstatSync(fd), link = lstatSync(p);
      if (!st.isFile() || st.nlink !== 1 || st.dev !== link.dev || st.ino !== link.ino ||
          (st.mode & 0o7777) !== 0o600 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new UnsafePath();
      return fd;
    } catch (e) { closeSync(fd); throw e; }
  };
  const exists = (p: string) => { try { lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
  const checkFile = (p: string) => { const fd = openSafe(p); closeSync(fd); };
  const rotate = () => {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? path : `${path}.${i - 1}`, to = `${path}.${i}`;
      if (exists(to)) { checkFile(to); unlinkSync(to); }
      if (exists(from)) { checkFile(from); renameSync(from, to); }
    }
    // maxFiles=1 discards the old active file.
    if (maxFiles === 1 && exists(path)) { checkFile(path); unlinkSync(path); }
    openedAt = now();
  };
  const trim = (incoming: number) => {
    let total = incoming;
    for (let i = 0; i < maxFiles; i++) {
      const p = i === 0 ? path : `${path}.${i}`;
      if (!exists(p)) continue;
      checkFile(p);
      total += lstatSync(p).size;
    }
    for (let i = maxFiles - 1; i >= 1 && total > maxTotal; i--) {
      const p = `${path}.${i}`;
      if (exists(p)) { checkFile(p); const size = lstatSync(p).size; unlinkSync(p); total -= size; }
    }
    if (total > maxTotal) throw new Error("limit");
  };
  try {
    if (process.platform === "win32" || !constants.O_NOFOLLOW) throw new UnsafePath();
    if (!safeToken(options.component) || !(options.level === undefined || options.level in levels) ||
        !Number.isInteger(maxLine) || maxLine < 256 || !Number.isInteger(maxFile) || maxFile < maxLine ||
        maxFile > 64 * 1024 * 1024 || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100 || !Number.isInteger(maxTotal) || maxTotal < maxFile ||
        !Number.isFinite(rotateMs) || rotateMs <= 0 || active.has(dir)) throw new Error("config");
    if (!exists(dir)) mkdirSync(dir, { mode: 0o700 });
    checkDir();
    // Strictly reject unknown entries: accidental reuse could otherwise defeat retention.
    if (readdirSync(dir).some(n => !/^events\.jsonl(?:\.[1-9][0-9]*)?$/.test(n))) throw new UnsafePath();
    for (const n of readdirSync(dir)) {
      const match = /^events\.jsonl\.([1-9][0-9]*)$/.exec(n);
      if (match && Number(match[1]) >= maxFiles) { const p = join(dir, n); checkFile(p); unlinkSync(p); }
    }
    if (exists(path)) {
      checkFile(path);
      // A crash can leave a partial JSONL tail; keep complete records only.
      const st = lstatSync(path);
      if (st.size > maxFile) { rotate(); }
      else if (st.size) {
        const data = readFileSync(path); const end = data.lastIndexOf(10);
        if (end !== data.length - 1) truncateSync(path, end + 1);
      }
    }
    openedAt = exists(path) ? lstatSync(path).mtimeMs : now();
    trim(0); active.add(dir); ownsDirectory = true;
  } catch (e) { disabled = true; fail(e instanceof UnsafePath ? "unsafe_path" : (e as NodeJS.ErrnoException).code ? "io" : "configuration"); }
  const log = (level: DebugLevel, event: string, fields: DebugFields = {}) => {
    if (disabled || closed || !(level in levels) || levels[level] < levels[options.level ?? "debug"]) return;
    try {
      const ev = safeToken(event), component = safeToken(options.component);
      if (!ev || !component) { fail("configuration"); return; }
      const record: Record<string, unknown> = { timestamp: new Date(now()).toISOString(), level, component, event: ev };
      for (const key of keys) { const value = safeToken(fields[key]); if (value !== undefined) record[key] = value; }
      for (const key of numbers) { const v = fields[key]; if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) record[key] = v; }
      const line = Buffer.from(JSON.stringify(record) + "\n");
      if (line.length > maxLine) { fail("configuration"); return; }
      checkDir();
      const size = exists(path) ? (checkFile(path), lstatSync(path).size) : 0;
      if (size && (size + line.length > maxFile || now() - openedAt >= rotateMs)) rotate();
      trim(line.length);
      const fd = openSafe(path);
      try {
        // A short/failed write may have left a partial record. Stop writing until
        // restart repairs the tail; never append onto a possibly broken line.
        try { if (writeSync(fd, line) !== line.length) throw new Error("short write"); }
        catch (e) { disabled = true; throw e; }
      } finally { closeSync(fd); }
    } catch (e) { fail(e instanceof UnsafePath ? "unsafe_path" : "io"); }
  };
  return { log, debug: (e, f) => log("debug", e, f), info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f), error: (e, f) => log("error", e, f),
    status: () => ({ failures, ...(lastFailure ? { lastFailure } : {}) }),
    close: () => { if (!closed) { closed = true; if (ownsDirectory) { active.delete(dir); ownsDirectory = false; } } } };
}
