import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Storage } from "../src/storage.ts";
import { runReadinessRefreshCli } from "../src/readiness-refresh-cli.ts";
import type { ReadinessResult } from "../src/readiness.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Timers {
  jobs = new Map<number, { fn: () => void; ms: number }>();
  next = 1;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++; this.jobs.set(id, { fn, ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (id: ReturnType<typeof setTimeout>) => { this.jobs.delete(id as unknown as number); };
  fire(ms: number) {
    const job = [...this.jobs].find(([, value]) => value.ms === ms);
    if (!job) throw new Error(`No timer for ${ms}`);
    this.jobs.delete(job[0]); job[1].fn();
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "refresh-cli-"));
  const dbPath = join(dir, "catalog.sqlite");
  const configPath = join(dir, "service.json");
  writeFileSync(configPath, JSON.stringify({ hostname: "127.0.0.1", port: 8080, dbPath, token: "top-secret-token" }), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { dir, dbPath, configPath };
}
const ready: ReadinessResult = { status: "ready", ready: true, message: "private-result" };

test("explicit CLI schedules default 120 second checks, uses real database, drains before close, and redacts target", async () => {
  const f = fixture(); const setup = Storage.open(f.dbPath);
  setup.registerMachine({ id: "private-machine", name: "private-name", host: "secret-target.example", os: "linux", sshUser: "alice" });
  setup.close();
  const signals = new EventEmitter(); const timers = new Timers();
  const started = deferred<void>(); const entered = deferred<void>(); const result = deferred<ReadinessResult>();
  let output = ""; let opened: Storage | undefined; let closed = false; let signal: AbortSignal | undefined;
  try {
    const run = runReadinessRefreshCli([f.configPath], { write: s => { output += s; started.resolve(); }, error: s => { output += s; } }, signals, {
      openStorage: path => { opened = Storage.open(path); const close = opened.close.bind(opened); opened.close = () => { closed = true; close(); }; return opened; },
      refreshOptions: { timers, random: () => 0, verifier: async (_target, s) => { signal = s; entered.resolve(); return result.promise; } },
    });
    await started.promise;
    expect(timers.jobs.size).toBe(1);
    timers.fire(0); await entered.promise;
    expect([...timers.jobs.values()].some(job => job.ms === 108_000)).toBe(true);
    signals.emit("SIGTERM"); signals.emit("SIGINT");
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    result.resolve(ready);
    expect(await run).toBe(0);
    expect(closed).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(timers.jobs.size).toBe(0);
    expect(output).not.toContain("top-secret-token"); expect(output).not.toContain("secret-target");
    expect(output).not.toContain("private-machine"); expect(output).not.toContain("private-result");
    const db = Storage.open(f.dbPath);
    try { expect(db.getMachine("private-machine")?.status).toBe("not-ready"); } finally { db.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("timed out stop returns failure without closing DB even when verifier settles later", async () => {
  const f = fixture(); const setup = Storage.open(f.dbPath);
  setup.registerMachine({ id: "m", name: "m", host: "m.example", os: "linux", sshUser: "alice" }); setup.close();
  const signals = new EventEmitter(); const timers = new Timers();
  const started = deferred<void>(); const entered = deferred<void>(); const done = deferred<ReadinessResult>();
  let storage!: Storage; let closed = false; let output = "";
  try {
    const run = runReadinessRefreshCli([f.configPath], { write: s => { output += s; started.resolve(); }, error: s => { output += s; } }, signals, {
      openStorage: path => { storage = Storage.open(path); const close = storage.close.bind(storage); storage.close = () => { closed = true; close(); }; return storage; },
      refreshOptions: { timers, random: () => 0, stopDeadlineMs: 50, verifier: () => { entered.resolve(); return done.promise; } },
    });
    await started.promise; timers.fire(0); await entered.promise;
    signals.emit("SIGTERM"); await Promise.resolve(); timers.fire(50);
    expect(await run).toBe(1); expect(closed).toBe(false);
    expect(storage.getMachine("m")?.status).toBe("not-ready");
    done.resolve(ready);
    // The cycle is still allowed to record its result against the open database.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(storage.getMachine("m")?.checkedAt).not.toBeNull();
    expect(output).not.toContain("top-secret-token");
    storage.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("rejects malformed and non-private config without opening storage or leaking secrets", async () => {
  const f = fixture(); const signals = new EventEmitter(); let output = ""; let opens = 0;
  const io = { write: (s: string) => { output += s; }, error: (s: string) => { output += s; } };
  const deps = { openStorage: (_path: string) => { opens++; throw new Error("private-db-path"); } };
  try {
    expect(await runReadinessRefreshCli([], io, signals, deps)).toBe(1);
    expect(await runReadinessRefreshCli(["relative.json"], io, signals, deps)).toBe(1);
    if (process.platform !== "win32") {
      chmodSync(f.configPath, 0o644);
      expect(await runReadinessRefreshCli([f.configPath], io, signals, deps)).toBe(1);
    }
    expect(opens).toBe(0); expect(output).not.toContain("top-secret-token");
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("signal during config load prevents database open and checks", async () => {
  const f = fixture(); const signals = new EventEmitter(); let opens = 0;
  try {
    const run = runReadinessRefreshCli([f.configPath], { write: () => {}, error: () => {} }, signals, {
      openStorage: () => { opens++; throw new Error(); },
    });
    signals.emit("SIGINT");
    expect(await run).toBe(0); expect(opens).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
