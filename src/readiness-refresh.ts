/**
 * Optional background re-verification. Construction alone starts no timers or SSH.
 * Each check uses the server SSH identity and trusted host keys, not a heartbeat.
 * The supplied Storage belongs to the caller and must outlive stop().
 */
import { spawn } from "node:child_process";
import { checkAdminReadiness, type CommandRunner, type ReadinessTarget, type ReadinessResult } from "./readiness.ts";
import { Storage, type StoredMachine } from "./storage.ts";

type Timer = ReturnType<typeof setTimeout>;
export interface RefreshTimers {
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}
export type RefreshEvent =
  | { type: "check-start" | "check-ready" | "check-not-ready" | "check-error" | "check-timeout"; machineId: string; sshDurationMs?: number; timeoutStage?: "ssh-process" | "refresh" }
  | { type: "cycle-error" | "stop-timeout" | "storage-busy"; machineId?: string };
export interface ReadinessRefreshOptions {
  storage: Storage;
  /** Injected verifiers must honor abort and settle promptly; never use for untrusted plugins. */
  verifier?: (target: ReadinessTarget, signal: AbortSignal) => Promise<ReadinessResult>;
  intervalMs?: number;
  jitterRatio?: number;
  concurrency?: number;
  checkTimeoutMs?: number;
  stopDeadlineMs?: number;
  /** Asynchronous SQLite lock retry window. No synchronous busy waiting. */
  storageRetryMs?: number;
  storageRetryDelayMs?: number;
  timers?: RefreshTimers;
  random?: () => number;
  /** Wall and monotonic milliseconds; injectable for deterministic tests. */
  clock?: { now(): number; monotonic(): number };
  /** Check events report observed outcomes, not proof the CAS committed; no secrets are emitted. */
  onEvent?: (event: RefreshEvent) => void;
}

/**
 * Kill the SSH process group on timeout/stop, including its relay ProxyCommand.
 * Unlike a Promise.race timeout, resolve only after the child has actually closed.
 */
function sshRunner(signal: AbortSignal): CommandRunner {
  return (command, args, timeoutMs) => new Promise((resolve, reject) => {
    if (signal.aborted) { resolve({ exitCode: null }); return; }
    const group = process.platform !== "win32";
    const child = spawn(command, [...args], { shell: false, stdio: "ignore", detached: group });
    let timedOut = false;
    let killed = false;
    const kill = () => {
      killed = true;
      try { if (group && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* process already gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    // Close follows error and guarantees the child handle has been reaped.
    let spawnError: Error | undefined;
    child.once("error", error => { spawnError = error; });
    child.once("close", code => {
      // A relay descendant must not survive even if ssh exits first.
      if (group && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ } }
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (spawnError && !killed) reject(spawnError);
      else resolve({ exitCode: killed ? null : code, timedOut });
    });
    if (signal.aborted) kill();
  });
}

/** Explicitly call start() to enable recurring SSH checks. */
export function createReadinessRefresh(options: ReadinessRefreshOptions): {
  start(): void; refresh(): Promise<void>; stop(): Promise<void>;
} {
  const { storage, onEvent } = options;
  const interval = options.intervalMs ?? 120_000;
  const jitter = options.jitterRatio ?? 0.1;
  const concurrency = options.concurrency ?? 3;
  const timeout = options.checkTimeoutMs ?? 50_000;
  const deadline = options.stopDeadlineMs ?? 55_000;
  const retryMs = options.storageRetryMs ?? 500;
  const retryDelay = options.storageRetryDelayMs ?? 25;
  if (!storage || !Number.isFinite(interval) || interval < 1 || interval > 2_147_483_647 ||
      !Number.isFinite(jitter) || jitter < 0 || jitter > 0.5 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isFinite(timeout) || timeout < 1 || timeout > 2_147_483_647 ||
      !Number.isFinite(deadline) || deadline < 1 || deadline > 2_147_483_647 ||
      !Number.isInteger(retryMs) || retryMs < 0 || retryMs > 10_000 ||
      !Number.isInteger(retryDelay) || retryDelay < 1 || retryDelay > 1_000) throw new Error("Invalid refresh options");
  const timers: RefreshTimers = options.timers ?? { setTimeout, clearTimeout };
  const random = options.random ?? Math.random;
  const clock = options.clock ?? { now: () => Date.now(), monotonic: () => performance.now() };
  const verifier = options.verifier ?? ((target, signal) => checkAdminReadiness(target, sshRunner(signal)));
  let started = false;
  let stopping = false;
  let tick: Timer | undefined;
  let cycle: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const active = new Set<AbortController>();
  const waits = new Set<() => void>();
  const emit = (event: RefreshEvent) => { try { onEvent?.(event); } catch { /* observers cannot break checks */ } };
  const rand = () => { const n = random(); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };
  const wait = (ms: number) => new Promise<void>(resolve => {
    if (stopping || ms <= 0) { resolve(); return; }
    let timer: Timer;
    const done = () => { timers.clearTimeout(timer); waits.delete(done); resolve(); };
    timer = timers.setTimeout(done, ms); waits.add(done);
  });
  const isBusy = (error: unknown) => typeof error === "object" && error !== null &&
    "code" in error && typeof error.code === "string" &&
    (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"));
  // Do not set SQLite busy_timeout: it synchronously blocks Bun's event loop.
  // Sleep between attempts; a finite attempt budget also works with fake timers.
  const storageOperation = async <T>(operation: () => T, stopEarly: boolean): Promise<T> => {
    let remaining = retryMs;
    for (;;) {
      if (stopEarly && stopping) throw new Error("Refresh stopped");
      try { return operation(); }
      catch (error) {
        if (!isBusy(error) || remaining <= 0) throw error;
        const delay = Math.min(retryDelay, remaining);
        remaining -= delay;
        if (stopEarly) await wait(delay);
        else await new Promise<void>(resolve => { timers.setTimeout(resolve, delay); });
      }
    }
  };
  const check = async (machine: StoredMachine) => {
    if (stopping) return;
    let token: string;
    try { token = await storageOperation(() => storage.beginVerification(machine.id, { preserveReady: true }), true); }
    catch (error) {
      if (!stopping) emit(isBusy(error) ? { type: "storage-busy", machineId: machine.id } : { type: "check-error", machineId: machine.id });
      return;
    }
    // stop may have run while the asynchronous begin retry was settling.
    if (stopping) return;
    const controller = new AbortController();
    active.add(controller);
    emit({ type: "check-start", machineId: machine.id });
    let timedOut = false;
    const wallStart = clock.now();
    const monoStart = clock.monotonic();
    const timer = timers.setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const expireIfLate = () => {
      const wallElapsed = clock.now() - wallStart;
      const monoElapsed = clock.monotonic() - monoStart;
      if (!Number.isFinite(wallElapsed) || !Number.isFinite(monoElapsed) ||
          wallElapsed < 0 || monoElapsed < 0 || wallElapsed >= timeout || monoElapsed >= timeout) timedOut = true;
    };
    let ready = false;
    let failed = false;
    let sshDurationMs: number | undefined;
    let sshTimedOut = false;
    try {
      // Old catalog rows have no SSH user. Never invent one or run unsupported OS.
      if (!stopping && machine.sshUser && ["linux", "macos", "windows"].includes(machine.os.toLowerCase())) {
        const result = await verifier({ host: machine.host, user: machine.sshUser, os: machine.os,
          sshPort: machine.sshPort, ...(machine.relayNodeId == null ? {} : { relayNodeId: machine.relayNodeId }) }, controller.signal);
        if (typeof result?.sshDurationMs === "number" && Number.isFinite(result.sshDurationMs) && result.sshDurationMs >= 0)
          sshDurationMs = Math.round(result.sshDurationMs);
        sshTimedOut = result?.timeoutStage === "ssh-process";
        // Timers can be delayed by sleep or an event-loop stall. Never renew
        // evidence based on a result that arrived after the check deadline.
        expireIfLate();
        ready = !timedOut && !controller.signal.aborted && result?.ready === true && result.status === "ready";
      }
    } catch { failed = true; }
    finally { timers.clearTimeout(timer); active.delete(controller); }
    try {
      // CAS avoids overwriting a newer manual verification, including on failure/stop.
      await storageOperation(() => {
        // Lock retries can themselves delay the write past the freshness bound.
        expireIfLate();
        if (timedOut || stopping) ready = false;
        return storage.recordVerification(machine.id, ready, token);
      }, false);
      emit({ type: timedOut || sshTimedOut ? "check-timeout" : failed ? "check-error" : ready ? "check-ready" : "check-not-ready", machineId: machine.id,
        ...(sshDurationMs === undefined ? {} : { sshDurationMs }),
        ...(timedOut ? { timeoutStage: "refresh" as const } : sshTimedOut ? { timeoutStage: "ssh-process" as const } : {}) });
    } catch (error) { emit(isBusy(error) ? { type: "storage-busy", machineId: machine.id } : { type: "check-error", machineId: machine.id }); }
  };
  const runCycle = (spread: boolean): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (cycle) return cycle;
    // Assign once; concurrent refresh calls coalesce and never duplicate a machine.
    cycle = (async () => {
      let machines: StoredMachine[];
      try { machines = await storageOperation(() => storage.listMachines(), true); }
      catch (error) { if (!stopping) emit(isBusy(error) ? { type: "storage-busy" } : { type: "cycle-error" }); return; }
      const jobs = machines.map(machine => ({ machine, due: spread ? rand() * interval * jitter : 0 }))
        .sort((a, b) => a.due - b.due);
      const start = clock.now();
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (!stopping && index < jobs.length) {
          const job = jobs[index++];
          await wait(Math.max(0, start + job.due - clock.now()));
          if (!stopping) await check(job.machine);
        }
      }));
    })().catch(() => { emit({ type: "cycle-error" }); }).finally(() => { cycle = undefined; });
    return cycle;
  };
  const schedule = (delay: number) => {
    tick = timers.setTimeout(() => {
      tick = undefined;
      if (stopping) return;
      void runCycle(true);
      schedule(interval * (1 - jitter + 2 * jitter * rand()));
    }, delay);
  };
  return {
    start() {
      if (stopping) throw new Error("Refresh service stopped");
      if (started) return;
      started = true;
      // A short initial jitter prevents a fleet of services starting SSH together.
      schedule(rand() * interval * jitter);
    },
    refresh() { return runCycle(false); },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (tick !== undefined) { timers.clearTimeout(tick); tick = undefined; }
      for (const done of [...waits]) done();
      for (const controller of active) controller.abort();
      const draining = cycle ?? Promise.resolve();
      stopPromise = new Promise<void>((resolve, reject) => {
        const timer = timers.setTimeout(() => {
          emit({ type: "stop-timeout" });
          reject(new Error("Readiness refresh did not stop before its deadline; keep storage open until checks settle"));
        }, deadline);
        draining.then(() => { timers.clearTimeout(timer); resolve(); }, error => { timers.clearTimeout(timer); reject(error); });
      }).catch(error => { stopPromise = undefined; throw error; });
      return stopPromise;
    },
  };
}
