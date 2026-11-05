import { startNodeClient, type NodeClientOptions } from "./relay";

/** Controls reconnect timing. Delays use bounded downward jitter. */
export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Fraction in [0, 1); 0 disables jitter. Defaults to 0.2. */
  jitter?: number;
}

export interface NodeRuntimeOptions extends NodeClientOptions {
  reconnect?: ReconnectOptions;
}

export interface NodeConnection {
  ready: Promise<void>;
  /** Resolves when the control connection ends, not when SSH drains. */
  closed: Promise<void>;
  close(): void;
}

/** Injectable dependencies allow deterministic testing without a network. */
export interface NodeRuntimeDependencies {
  startClient?: (options: NodeClientOptions) => NodeConnection;
  random?: () => number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Keep a single node registration alive. A disconnected SSH session is never
 * saved or migrated. ready resolves on the first registration, or rejects if
 * stopped before that. finished tracks this runtime's control connections and
 * retry timer only; it does not represent SSH session completion.
 */
export function startNodeRuntime(options: NodeRuntimeOptions, dependencies: NodeRuntimeDependencies = {}) {
  const { reconnect, ...clientOptions } = options;
  const initial = reconnect?.initialDelayMs ?? 500;
  const max = reconnect?.maxDelayMs ?? 30_000;
  const jitter = reconnect?.jitter ?? 0.2;
  if (!Number.isSafeInteger(initial) || initial < 1 || !Number.isSafeInteger(max) || max < initial || max > 2_147_483_647)
    throw new Error("Invalid reconnect delay");
  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) throw new Error("Invalid reconnect jitter");
  const start = dependencies.startClient ?? startNodeClient;
  const random = dependencies.random ?? Math.random;
  const setTimer: NonNullable<NodeRuntimeDependencies["setTimeout"]> = dependencies.setTimeout ?? setTimeout;
  const clearTimer: NonNullable<NodeRuntimeDependencies["clearTimeout"]> = dependencies.clearTimeout ?? clearTimeout;
  let stopped = false;
  let connected = false;
  let current: NodeConnection | undefined;
  let cancelDelay: (() => void) | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveFinished!: () => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const closeConnection = (connection: NodeConnection) => { try { connection.close(); } catch {} };
  function close() {
    if (stopped) return;
    stopped = true;
    if (!connected) rejectReady(new Error("Node runtime closed before registration"));
    cancelDelay?.();
    if (current) closeConnection(current);
  }
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimer(() => { cancelDelay = undefined; resolve(); }, ms);
      cancelDelay = () => { clearTimer(timer); cancelDelay = undefined; resolve(); };
    });
  }
  async function run() {
    let next = initial;
    try {
      while (!stopped) {
        let client: NodeConnection | undefined;
        try {
          client = start(clientOptions);
          current = client;
          const state = await Promise.race([
            client.ready.then(() => "ready" as const, () => "failed" as const),
            client.closed.then(() => "closed" as const, () => "closed" as const),
          ]);
          if (state === "ready" && !stopped) {
            next = initial;
            if (!connected) { connected = true; resolveReady(); }
          } else {
            closeConnection(client);
          }
          // Do not start another connection while the old control socket lives.
          await client.closed.catch(() => {});
        } catch {
          if (client) {
            closeConnection(client);
            await client.closed.catch(() => {});
          }
        } finally {
          if (current === client) current = undefined;
        }
        if (stopped) break;
        let sample = 0.5;
        try { sample = random(); } catch {}
        if (!Number.isFinite(sample)) sample = 0.5;
        sample = Math.max(0, Math.min(1, sample));
        const wait = Math.max(1, Math.floor(next * (1 - jitter + jitter * sample)));
        next = Math.min(max, next * 2);
        await delay(wait);
      }
    } finally {
      resolveFinished();
    }
  }
  void run();
  return { ready, finished, close };
}
