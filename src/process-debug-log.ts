import { homedir } from "node:os";
import { mkdirSync, lstatSync, readdirSync, openSync, closeSync, readSync, readFileSync, readlinkSync, fstatSync, unlinkSync, rmdirSync, constants as fsConstants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createDebugLogger, type DebugLogger } from "./debug-log.ts";

/** Namespace identity prevents mistaking another container/host's live PID for a dead one. */
function writerNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const ns = /^pid:\[([0-9]+)\]$/.exec(readlinkSync("/proc/self/ns/pid"));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(boot) || !ns) return undefined;
    return `${boot}-${ns[1]}`;
  } catch { return undefined; }
}
export function debugLogWriterName(component: string, pid = process.pid): string {
  return `${component}-${pid}-${crypto.randomUUID()}-${writerNamespace() ?? "unknown"}`;
}

/** Best-effort retention of our stopped CLI writers. The base directory must be
 * trusted against replacement by other users, as required by createDebugLogger.
 * Unknown, unsafe, malformed and live-process directories are never removed. */
export function reapDebugLogs(base: string, limits: { now?: number; maxAgeMs?: number; maxTotalBytes?: number } = {}) {
  const now = limits.now ?? Date.now(), maxAge = limits.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxTotal = limits.maxTotalBytes ?? 256 * 1024 * 1024;
  let failures = 0, removed = 0;
  const namespace = writerNamespace();
  if (!namespace) return { removed: 0, failures: 1 };
  type Candidate = { path: string; pid: number; mtime: number; size: number; dev: number; ino: number; files: Array<{ path: string; dev: number; ino: number }> };
  const candidates: Candidate[] = [];
  const gone = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
  };
  const owner = (st: import("node:fs").Stats) => typeof process.getuid !== "function" || st.uid === process.getuid();
  try {
    for (const name of readdirSync(base)) {
      const match = /^(server|relay|node)-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]+)$/.exec(name);
      if (!match || match[4] !== namespace) continue;
      const pid = Number(match[2]), dir = join(base, name);
      if (!Number.isSafeInteger(pid) || pid > 2147483647) { failures++; continue; }
      try {
        const ds = lstatSync(dir);
        if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o7777) !== 0o700 || !owner(ds)) { failures++; continue; }
        const names = readdirSync(dir);
        if (!names.length || names.length > 100 || names.some(n => !/^events\.jsonl(?:\.[1-9][0-9]*)?$/.test(n))) { failures++; continue; }
        const files: Candidate["files"] = [];
        let size = 0, mtime = ds.mtimeMs;
        for (const n of names) {
          const path = join(dir, n), st = lstatSync(path);
          if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600 || !owner(st) || st.size > 64 * 1024 * 1024 || st.size === 0) throw new Error("unsafe");
          const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            const opened = fstatSync(fd);
            if (opened.dev !== st.dev || opened.ino !== st.ino) throw new Error("changed");
            const buf = Buffer.alloc(Math.min(st.size, 4096)); const count = readSync(fd, buf, 0, buf.length, 0);
            const text = buf.subarray(0, count).toString("utf8"), newline = text.indexOf("\n");
            if (newline < 0) throw new Error("invalid");
            const record = JSON.parse(text.slice(0, newline));
            if (record.component !== match[1] || typeof record.event !== "string" || typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) throw new Error("invalid");
          } finally { closeSync(fd); }
          size += st.size; mtime = Math.max(mtime, st.mtimeMs);
          files.push({ path, dev: st.dev, ino: st.ino });
        }
        candidates.push({ path: dir, pid, mtime, size, dev: ds.dev, ino: ds.ino, files });
      } catch (e) { if (!gone(e)) failures++; }
    }
    let total = candidates.reduce((sum, c) => sum + c.size, 0);
    candidates.sort((a, b) => a.mtime - b.mtime);
    for (const c of candidates) {
      if (now - c.mtime <= maxAge && total <= maxTotal) continue;
      if (alive(c.pid)) continue;
      try {
        const ds = lstatSync(c.path);
        if (ds.dev !== c.dev || ds.ino !== c.ino || !ds.isDirectory() || ds.isSymbolicLink() || alive(c.pid)) throw new Error("changed");
        for (const f of c.files) {
          const st = lstatSync(f.path);
          if (st.dev !== f.dev || st.ino !== f.ino || !st.isFile() || st.nlink !== 1 || alive(c.pid)) throw new Error("changed");
          unlinkSync(f.path);
        }
        rmdirSync(c.path); total -= c.size; removed++;
      } catch (e) { if (!gone(e)) failures++; }
    }
  } catch (e) { if (!gone(e)) failures++; }
  return { removed, failures };
}

/** Shared metadata logger for the CLI and formal service. Never include exception text. */
export function createProcessDebugLogger(component: string, secrets: readonly string[], env: NodeJS.ProcessEnv,
  error: (message: string) => void, platform: NodeJS.Platform = process.platform, announce = false): DebugLogger | undefined {
  let failures = 0;
  const fault = (category: string) => { failures++; error(`Logging fault (${category}); count=${failures}. Service continues without reliable debug records.`); };
  // Remain fail-closed until Windows ACL and no-reparse guarantees exist. Even a
  // failing diagnostics sink must not stop the service on this fallback path.
  if (platform === "win32") { try { fault("unsupported_windows_acl"); } catch {} return; }
  try {
    const base = env.ENVINHANDS_LOG_DIR ?? join(env.HOME || homedir(), ".local", "state", "envinhands");
    if (!isAbsolute(base)) { fault("configuration"); return; }
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const st = lstatSync(base);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) { fault("unsafe_path"); return; }
    const retention = reapDebugLogs(base);
    if (retention.failures) { failures += retention.failures; error(`Logging retention fault; count=${failures}. Unsafe or unreadable entries were kept.`); }
    const logger = createDebugLogger({ directory: join(base, debugLogWriterName(component)), component, knownSecrets: secrets, onFailure: fault });
    if (!logger.status().failures) {
      logger.info("retention_completed", { retry: retention.removed, status: retention.failures ? "partial" : "complete" });
      if (retention.failures) logger.warn("retention_fault", { retry: retention.failures, errorCategory: "cleanup" });
      if (announce) error("Debug metadata logging enabled (private JSONL with bounded rotation).");
    }
    return logger;
  } catch { fault("io"); return; }
}
