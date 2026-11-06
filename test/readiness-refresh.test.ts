import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/storage.ts";
import { createReadinessRefresh } from "../src/readiness-refresh.ts";
import type { ReadinessResult, ReadinessTarget } from "../src/readiness.ts";

const ready: ReadinessResult = { status: "ready", ready: true, message: "ok" };
const notReady: ReadinessResult = { status: "not-ready", ready: false, message: "no" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function add(storage: Storage, id: string, options: { relayNodeId?: string; os?: string } = {}) {
  return storage.registerMachine({ id, name: id, host: `${id}.example.org`, os: options.os ?? "Linux",
    sshPort: 2222, sshUser: "alice", ...(options.relayNodeId ? { relayNodeId: options.relayNodeId } : {}) });
}

// The timer does not advance on wall-clock time. Tests explicitly fire each callback.
class FakeTimers {
  next = 1;
  jobs = new Map<number, { callback: () => void; delay: number }>();
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.next++;
    this.jobs.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>) => { this.jobs.delete(handle as unknown as number); };
  fire() {
    const entry = this.jobs.entries().next().value;
    if (!entry) throw new Error("no timer scheduled");
    this.jobs.delete(entry[0]);
    entry[1].callback();
  }
}

test("refresh verifies pending and not-ready machines, including relay targets", async () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "pending");
    add(storage, "relay", { relayNodeId: "node-42" });
    storage.recordVerification("relay", false);
    const calls: ReadinessTarget[] = [];
    const service = createReadinessRefresh({ storage, verifier: async target => { calls.push(target); return ready; } });
    expect(calls).toHaveLength(0); // Construction is opt-in.
    await service.refresh();
    expect(calls).toEqual([
      { host: "pending.example.org", user: "alice", os: "Linux", sshPort: 2222 },
      { host: "relay.example.org", user: "alice", os: "Linux", sshPort: 2222, relayNodeId: "node-42" },
    ]);
    for (const id of ["pending", "relay"]) {
      const machine = storage.getMachine(id)!;
      expect(machine.status).toBe("ready");
      expect(machine.verifiedAt).not.toBeNull();
      expect(machine.checkedAt).not.toBeNull();
    }
    await service.stop();
  } finally { storage.close(); }
});

test("legacy and unsupported machines fail closed without calling verifier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-legacy-"));
  const path = join(dir, "catalog.sqlite");
  const storage = Storage.open(path);
  try {
    add(storage, "legacy"); add(storage, "unsupported", { os: "FreeBSD" }); add(storage, "normal");
    const db = new Database(path);
    try { db.query("UPDATE machines SET sshUser = NULL WHERE id = ?").run("legacy"); } finally { db.close(); }
    const hosts: string[] = [];
    const service = createReadinessRefresh({ storage, verifier: async target => { hosts.push(target.host); return ready; } });
    await service.refresh();
    expect(hosts).toEqual(["normal.example.org"]);
    expect(storage.getMachine("legacy")!.status).not.toBe("ready");
    expect(storage.getMachine("unsupported")!.status).not.toBe("ready");
    expect(storage.getMachine("normal")!.status).toBe("ready");
    await service.stop();
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("errors and not-ready results fail closed, do not stop other checks, and do not leak secrets in events", async () => {
  const storage = Storage.open(":memory:");
  const secret = "secret-error-and-verifier-message-xyz";
  try {
    for (const id of ["throws", "no", "yes"]) { add(storage, id); storage.recordVerification(id, true); }
    const events: unknown[] = [];
    const service = createReadinessRefresh({ storage, concurrency: 1, onEvent: event => { events.push(event); },
      verifier: async target => {
        if (target.host.startsWith("throws.")) throw new Error(secret);
        if (target.host.startsWith("no.")) return { ...notReady, message: secret };
        return ready;
      } });
    await service.refresh();
    expect(storage.getMachine("throws")!.status).toBe("not-ready");
    expect(storage.getMachine("throws")!.verifiedAt).toBeNull();
    expect(storage.getMachine("no")!.status).toBe("not-ready");
    expect(storage.getMachine("yes")!.status).toBe("ready");
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(secret);
    for (const event of events as Array<Record<string, unknown>>) {
      expect(typeof event.type).toBe("string");
      expect(Object.keys(event).every(key => key === "type" || key === "machineId")).toBe(true);
    }
    await service.stop();
  } finally { storage.close(); }
});

test("a delayed result cannot overwrite a newer verification", async () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "race"); storage.recordVerification("race", true);
    const entered = deferred<void>(); const result = deferred<ReadinessResult>();
    const service = createReadinessRefresh({ storage, verifier: async () => { entered.resolve(); return result.promise; } });
    const cycle = service.refresh();
    await entered.promise;
    expect(storage.getMachine("race")!.status).toBe("ready");
    const newer = storage.beginVerification("race");
    storage.recordVerification("race", false, newer);
    result.resolve(ready);
    await cycle;
    expect(storage.getMachine("race")!.status).toBe("not-ready");
    expect(storage.getMachine("race")!.verifiedAt).toBeNull();
    await service.stop();
  } finally { storage.close(); }
});

test("concurrent refresh calls coalesce and respect the concurrency limit", async () => {
  const storage = Storage.open(":memory:");
  try {
    for (const id of ["one", "two", "three", "four"]) add(storage, id);
    const enteredTwo = deferred<void>(); const gates = Array.from({ length: 4 }, () => deferred<ReadinessResult>());
    let calls = 0; let active = 0; let maxActive = 0;
    const service = createReadinessRefresh({ storage, concurrency: 2, verifier: async () => {
      const i = calls++; active++; maxActive = Math.max(active, maxActive);
      if (calls === 2) enteredTwo.resolve();
      try { return await gates[i].promise; } finally { active--; }
    } });
    const first = service.refresh(); const second = service.refresh();
    await enteredTwo.promise;
    expect(calls).toBe(2);
    for (const gate of gates) gate.resolve(ready);
    await Promise.all([first, second]);
    expect(calls).toBe(4);
    expect(maxActive).toBe(2);
    expect(storage.listMachines().every(machine => machine.status === "ready")).toBe(true);
    await service.stop();
  } finally { storage.close(); }
});

test("stop cancels scheduled work, waits for an in-flight check, and prevents queued checks", async () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "first"); add(storage, "second");
    const timers = new FakeTimers(); const entered = deferred<void>(); const result = deferred<ReadinessResult>();
    let calls = 0; let stopped = false;
    const service = createReadinessRefresh({ storage, timers, concurrency: 1, verifier: async () => {
      calls++; entered.resolve(); return result.promise;
    } });
    service.start();
    const scheduled = [...timers.jobs.keys()][0];
    const cycle = service.refresh();
    await entered.promise;
    const stopping = service.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(timers.jobs.has(scheduled)).toBe(false);
    result.resolve(ready);
    await Promise.all([cycle, stopping]);
    expect(stopped).toBe(true);
    expect(calls).toBe(1);
    expect(timers.jobs.size).toBe(0);
  } finally { storage.close(); }
});

test("start schedules an initial jitter, is idempotent, and stopped instances cannot restart", async () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "one");
    const timers = new FakeTimers();
    let calls = 0; let called = deferred<void>(); let random = 1;
    const service = createReadinessRefresh({ storage, timers, intervalMs: 1000, jitterRatio: 0.2, random: () => random,
      verifier: async () => { calls++; called.resolve(); return ready; } });
    expect(timers.jobs.size).toBe(0);
    service.start(); service.start();
    expect(timers.jobs.size).toBe(1);
    expect([...timers.jobs.values()][0].delay).toBe(200);
    random = 0; // Run the first machine without additional per-machine spread.
    timers.fire();
    await called.promise;
    await service.stop();
    expect(calls).toBe(1);
    expect(timers.jobs.size).toBe(0);
    expect(() => service.start()).toThrow();
    await service.refresh();
    expect(calls).toBe(1);

    // A fresh service can be started with the same caller-owned storage.
    called = deferred<void>();
    const replacement = createReadinessRefresh({ storage, timers, random: () => 0,
      verifier: async () => { calls++; called.resolve(); return ready; } });
    replacement.start();
    expect(timers.jobs.size).toBe(1);
    timers.fire(); await called.promise;
    await replacement.stop();
    expect(calls).toBe(2);
    expect(timers.jobs.size).toBe(0);
  } finally { storage.close(); }
});

test("check timeout aborts its verifier and records not-ready without leaking error text", async () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "timeout"); storage.recordVerification("timeout", true);
    const timers = new FakeTimers();
    const entered = deferred<void>();
    const events: Array<{ type: string; machineId?: string }> = [];
    let signalSeen: AbortSignal | undefined;
    const service = createReadinessRefresh({ storage, timers, checkTimeoutMs: 50,
      onEvent: event => { events.push(event); }, verifier: async (_target, signal) => {
        signalSeen = signal; entered.resolve();
        return new Promise<ReadinessResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("secret-timeout-error")), { once: true });
        });
      } });
    const cycle = service.refresh();
    await entered.promise;
    expect(signalSeen?.aborted).toBe(false);
    expect([...timers.jobs.values()][0].delay).toBe(50);
    timers.fire();
    await cycle;
    expect(signalSeen?.aborted).toBe(true);
    expect(storage.getMachine("timeout")!.status).toBe("not-ready");
    expect(events).toContainEqual({ type: "check-timeout", machineId: "timeout" });
    expect(JSON.stringify(events)).not.toContain("secret-timeout-error");
    await service.stop();
  } finally { storage.close(); }
});


test("late result and wall clock rollback fail closed even if timeout callback was delayed", async () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "late");
    let wall = 1000;
    let mono = 500;
    let outcome = deferred<ReadinessResult>();
    let entered = deferred<void>();
    const events: string[] = [];
    const service = createReadinessRefresh({ storage, checkTimeoutMs: 100,
      clock: { now: () => wall, monotonic: () => mono },
      verifier: () => { entered.resolve(); return outcome.promise; }, onEvent: e => events.push(e.type) });
    const first = service.refresh();
    await entered.promise;
    wall += 101; mono += 101;
    outcome.resolve(ready);
    await first;
    expect(storage.getMachine("late")!.status).toBe("not-ready");
    expect(events).toContain("check-timeout");
    outcome = deferred<ReadinessResult>();
    entered = deferred<void>();
    const second = service.refresh();
    await entered.promise;
    wall -= 10; mono += 1;
    outcome.resolve(ready);
    await second;
    expect(storage.getMachine("late")!.status).toBe("not-ready");
    await service.stop();
  } finally { storage.close(); }
});


test("SQLite evidence persists across close and a new service refreshes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-reopen-"));
  const path = join(dir, "catalog.sqlite");
  let storage = Storage.open(path);
  try {
    add(storage, "persist");
    const first = createReadinessRefresh({ storage, verifier: async () => ready });
    await first.refresh(); await first.stop(); storage.close();
    storage = Storage.open(path);
    expect(storage.getMachine("persist")!.status).toBe("ready");
    const second = createReadinessRefresh({ storage, verifier: async () => notReady });
    await second.refresh(); await second.stop(); storage.close();
    storage = Storage.open(path);
    expect(storage.getMachine("persist")!.status).toBe("not-ready");
    expect(storage.getMachine("persist")!.checkedAt).not.toBeNull();
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("stop deadline reports an uncooperative injected verifier and can be retried after drain", async () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "hung");
    const timers = new FakeTimers();
    const gate = deferred<ReadinessResult>();
    const entered = deferred<void>();
    const events: string[] = [];
    const service = createReadinessRefresh({ storage, timers, onEvent: e => events.push(e.type),
      verifier: () => { entered.resolve(); return gate.promise; } });
    const running = service.refresh();
    await entered.promise;
    const stopping = service.stop();
    // check timer is first, stop deadline is last
    const job = [...timers.jobs.entries()].at(-1)!;
    timers.jobs.delete(job[0]); job[1].callback();
    await expect(stopping).rejects.toThrow("deadline");
    expect(events).toContain("stop-timeout");
    gate.resolve(ready);
    await running;
    await service.stop();
    expect(storage.getMachine("hung")!.status).toBe("not-ready");
    expect(timers.jobs.size).toBe(0);
  } finally { storage.close(); }
});


test("background keeps the original ready evidence only until its original TTL, even across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-ttl-"));
  const path = join(dir, "catalog.sqlite");
  const storage = Storage.open(path, 100);
  let nowSpy: ReturnType<typeof spyOn> | undefined;
  try {
    add(storage, "ttl");
    const before = storage.recordVerification("ttl", true);
    const entered = deferred<void>(); const gate = deferred<ReadinessResult>();
    const service = createReadinessRefresh({ storage, verifier: () => { entered.resolve(); return gate.promise; } });
    const running = service.refresh(); await entered.promise;
    const inFlight = storage.getMachine("ttl")!;
    expect(inFlight.status).toBe("ready");
    expect(inFlight.verifiedAt).toBe(before.verifiedAt);
    expect(inFlight.checkedAt).toBe(before.checkedAt);
    // A fresh connection sees the same old evidence, not a renewed timestamp.
    const reopened = Storage.open(path, 100);
    try {
      expect(reopened.getMachine("ttl")!.verifiedAt).toBe(before.verifiedAt);
      nowSpy = spyOn(Date, "now").mockReturnValue(Date.parse(before.verifiedAt!) + 100);
      expect(reopened.getMachine("ttl")!.status).toBe("not-ready");
      expect(storage.getMachine("ttl")!.status).toBe("not-ready");
      nowSpy.mockRestore(); nowSpy = undefined;
    } finally { reopened.close(); }
    gate.resolve(notReady); await running;
    expect(storage.getMachine("ttl")!.status).toBe("not-ready");
    await service.stop();
  } finally { nowSpy?.mockRestore(); storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("manual verification still invalidates ready evidence immediately", () => {
  const storage = Storage.open(":memory:");
  try {
    add(storage, "manual"); storage.recordVerification("manual", true);
    storage.beginVerification("manual");
    expect(storage.getMachine("manual")!.status).toBe("not-ready");
    expect(storage.getMachine("manual")!.verifiedAt).toBeNull();
  } finally { storage.close(); }
});

test("SQLite write locks retry asynchronously and report exhaustion without losing valid evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-lock-"));
  const path = join(dir, "catalog.sqlite");
  const storage = Storage.open(path);
  const locker = new Database(path);
  let locked = false;
  try {
    add(storage, "locked"); const original = storage.recordVerification("locked", true);
    const events: string[] = []; let calls = 0;
    const service = createReadinessRefresh({ storage, storageRetryMs: 30, storageRetryDelayMs: 5,
      onEvent: e => events.push(e.type), verifier: async () => { calls++; return ready; } });
    locker.exec("BEGIN IMMEDIATE"); locked = true;
    let eventLoopRan = false;
    setTimeout(() => { eventLoopRan = true; }, 0);
    await service.refresh();
    expect(eventLoopRan).toBe(true);
    expect(events).toContain("storage-busy");
    expect(calls).toBe(0);
    expect(storage.getMachine("locked")!.status).toBe("ready");
    expect(storage.getMachine("locked")!.verifiedAt).toBe(original.verifiedAt);
    locker.exec("ROLLBACK"); locked = false;
    events.length = 0;
    locker.exec("BEGIN IMMEDIATE"); locked = true;
    const release = setTimeout(() => { locker.exec("ROLLBACK"); locked = false; }, 10);
    await service.refresh(); clearTimeout(release);
    expect(calls).toBe(1);
    expect(storage.getMachine("locked")!.status).toBe("ready");
    expect(events).not.toContain("storage-busy");
    await service.stop();
  } finally { if (locked) locker.exec("ROLLBACK"); locker.close(); storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SQLite lock during result commit preserves old evidence and retries or reports failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-commit-lock-"));
  const path = join(dir, "catalog.sqlite");
  const storage = Storage.open(path); const locker = new Database(path);
  let locked = false;
  try {
    add(storage, "commit"); const original = storage.recordVerification("commit", true);
    let entered = deferred<void>(); let gate = deferred<ReadinessResult>(); const events: string[] = [];
    const service = createReadinessRefresh({ storage, storageRetryMs: 30, storageRetryDelayMs: 5,
      onEvent: e => events.push(e.type), verifier: () => { entered.resolve(); return gate.promise; } });
    const first = service.refresh(); await entered.promise;
    locker.exec("BEGIN IMMEDIATE"); locked = true; gate.resolve(notReady);
    await first;
    expect(events).toContain("storage-busy");
    expect(storage.getMachine("commit")!.status).toBe("ready");
    expect(storage.getMachine("commit")!.verifiedAt).toBe(original.verifiedAt);
    locker.exec("ROLLBACK"); locked = false;
    entered = deferred<void>(); gate = deferred<ReadinessResult>(); events.length = 0;
    const second = service.refresh(); await entered.promise;
    locker.exec("BEGIN IMMEDIATE"); locked = true; gate.resolve(notReady);
    const release = setTimeout(() => { locker.exec("ROLLBACK"); locked = false; }, 10);
    await second; clearTimeout(release);
    expect(storage.getMachine("commit")!.status).toBe("not-ready");
    expect(events).not.toContain("storage-busy");
    await service.stop();
  } finally { if (locked) locker.exec("ROLLBACK"); locker.close(); storage.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("a result that ages out during SQLite commit retries cannot renew readiness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-lock-age-"));
  const path = join(dir, "catalog.sqlite");
  const storage = Storage.open(path); const locker = new Database(path);
  let locked = false;
  try {
    add(storage, "aging"); storage.recordVerification("aging", true);
    const entered = deferred<void>(); const gate = deferred<ReadinessResult>(); const events: string[] = [];
    let now = 1_000; let mono = 1_000;
    const service = createReadinessRefresh({ storage, checkTimeoutMs: 50, storageRetryMs: 100,
      storageRetryDelayMs: 5, clock: { now: () => now, monotonic: () => mono },
      onEvent: e => events.push(e.type), verifier: () => { entered.resolve(); return gate.promise; } });
    const running = service.refresh(); await entered.promise;
    locker.exec("BEGIN IMMEDIATE"); locked = true; gate.resolve(ready);
    const release = setTimeout(() => { now += 51; mono += 51; locker.exec("ROLLBACK"); locked = false; }, 10);
    await running; clearTimeout(release);
    expect(storage.getMachine("aging")!.status).toBe("not-ready");
    expect(events).toContain("check-timeout");
    await service.stop();
  } finally { if (locked) locker.exec("ROLLBACK"); locker.close(); storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
