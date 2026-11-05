import { describe, expect, test } from "bun:test";
import { startNodeRuntime, type NodeConnection, type NodeRuntimeDependencies } from "../src/node-runtime";
import { createRelayServer } from "../src/relay";

const options = {
  relayUrl: "ws://127.0.0.1:1", nodeId: "test-node", secret: "local-test-secret",
  reconnect: { initialDelayMs: 10, maxDelayMs: 40, jitter: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function connection() {
  const ready = deferred<void>();
  const closed = deferred<void>();
  let closes = 0;
  const client: NodeConnection = {
    ready: ready.promise, closed: closed.promise,
    close() { closes++; },
  };
  return { client, ready, closed, get closes() { return closes; } };
}
// Flush all promise continuations without advancing the fake timer.
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function fakeTimers() {
  let nextId = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  const cleared: number[] = [];
  const setTimeout: NonNullable<NodeRuntimeDependencies["setTimeout"]> = (callback, delay) => {
    const id = ++nextId;
    pending.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };
  const clearTimeout: NonNullable<NodeRuntimeDependencies["clearTimeout"]> = (timer) => {
    const id = timer as unknown as number;
    cleared.push(id);
    pending.delete(id);
  };
  return {
    setTimeout, clearTimeout, pending, cleared,
    fire() {
      expect(pending.size).toBe(1);
      const [id, timer] = [...pending][0]!;
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
    delay() { expect(pending.size).toBe(1); return [...pending.values()][0]!.delay; },
  };
}

describe("node reconnect runtime", () => {
  test("retries failed registrations with capped exponential backoff, never in a tight loop", async () => {
    const timers = fakeTimers();
    const clients: ReturnType<typeof connection>[] = [];
    const received: unknown[] = [];
    const runtime = startNodeRuntime(options, { ...timers, startClient(opts) {
      received.push(opts);
      const c = connection(); clients.push(c); return c.client;
    } });
    const readyResult = runtime.ready.catch((e: Error) => e);
    for (const [index, delay] of [10, 20, 40, 40].entries()) {
      expect(clients).toHaveLength(index + 1);
      clients[index]!.ready.reject(new Error("registration failed"));
      clients[index]!.closed.resolve();
      await flush();
      expect(timers.delay()).toBe(delay);
      await flush();
      expect(clients).toHaveLength(index + 1); // no retry before timer fires
      timers.fire();
      await flush();
    }
    expect(received[0]).toEqual({ relayUrl: options.relayUrl, nodeId: options.nodeId, secret: options.secret });
    runtime.close();
    clients.at(-1)!.closed.resolve();
    await runtime.finished;
    expect(await readyResult).toBeInstanceOf(Error);
  });

  test("reconnects after a successful registration and resets the backoff", async () => {
    const timers = fakeTimers();
    const clients: ReturnType<typeof connection>[] = [];
    const runtime = startNodeRuntime(options, { ...timers, startClient() {
      const c = connection(); clients.push(c); return c.client;
    } });
    clients[0]!.ready.reject(new Error("offline")); clients[0]!.closed.resolve();
    await flush(); expect(timers.fire()).toBe(10); await flush();
    clients[1]!.ready.reject(new Error("offline")); clients[1]!.closed.resolve();
    await flush(); expect(timers.fire()).toBe(20); await flush();
    clients[2]!.ready.resolve();
    await runtime.ready;
    clients[2]!.closed.resolve();
    await flush(); expect(timers.fire()).toBe(10); await flush();
    expect(clients).toHaveLength(4);
    clients[3]!.ready.resolve(); await flush();
    runtime.close();
    expect(clients[3]!.closes).toBe(1);
    clients[3]!.closed.resolve();
    await runtime.finished;
    expect(timers.pending.size).toBe(0);
  });

  test("handles synchronous start errors with jittered, bounded retry delays", async () => {
    const timers = fakeTimers();
    let calls = 0;
    const samples = [0, 1, 0];
    const runtime = startNodeRuntime({ ...options, reconnect: { initialDelayMs: 10, maxDelayMs: 20, jitter: 0.5 } }, {
      ...timers, random: () => samples.shift()!, startClient() { calls++; throw new Error("unavailable"); },
    });
    const readyResult = runtime.ready.catch((e: Error) => e);
    await flush(); expect(timers.delay()).toBe(5); expect(calls).toBe(1);
    timers.fire(); await flush(); expect(timers.delay()).toBe(20); expect(calls).toBe(2);
    timers.fire(); await flush(); expect(timers.delay()).toBe(10); expect(calls).toBe(3);
    runtime.close(); runtime.close();
    await runtime.finished;
    expect(await readyResult).toBeInstanceOf(Error);
    expect(timers.pending.size).toBe(0);
    expect(timers.cleared).toHaveLength(1);
    await flush(); expect(calls).toBe(3);
  });

  test("waits for the old control connection to close before retrying or finishing", async () => {
    const timers = fakeTimers();
    const c = connection();
    let calls = 0;
    const runtime = startNodeRuntime(options, { ...timers, startClient() { calls++; return c.client; } });
    const readyResult = runtime.ready.catch((e: Error) => e);
    c.ready.reject(new Error("registration failed"));
    await flush();
    expect(c.closes).toBe(1);
    expect(timers.pending.size).toBe(0);
    expect(calls).toBe(1);
    runtime.close();
    let finished = false;
    void runtime.finished.then(() => { finished = true; });
    await flush(); expect(finished).toBe(false);
    c.closed.resolve();
    await runtime.finished;
    expect(await readyResult).toBeInstanceOf(Error);
    expect(timers.pending.size).toBe(0);
    expect(calls).toBe(1);
  });

  test("rejects invalid reconnect settings", () => {
    for (const reconnect of [
      { initialDelayMs: 0 }, { initialDelayMs: 1.5 }, { initialDelayMs: Infinity },
      { initialDelayMs: 10, maxDelayMs: 9 }, { maxDelayMs: 2_147_483_648 },
      { jitter: -0.1 }, { jitter: 1 }, { jitter: NaN },
    ]) expect(() => startNodeRuntime({ ...options, reconnect })).toThrow();
  });
});

test("a node registers again when a local relay restarts", async () => {
  const secret = "local-test-secret";
  let relay = createRelayServer({ hostname: "127.0.0.1", secret });
  let accepted = 0;
  const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    open() { accepted++; }, data(socket, data) { socket.write(data); }, error() {},
  } });
  const port = relay.port;
  const runtime = startNodeRuntime({
    relayUrl: `ws://127.0.0.1:${port}`, nodeId: "restart-test", secret, sshPort: tcp.port,
    reconnect: { initialDelayMs: 20, maxDelayMs: 80, jitter: 0 },
  });
  const openSession = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client?node=restart-test&v=2`, { headers: { Authorization: `Bearer ${secret}` } });
    const ready = new Promise<void>((resolve, reject) => {
      ws.addEventListener("message", (event) => event.data === "ready-v2" ? resolve() : reject(new Error("Unexpected session message")), { once: true });
      ws.addEventListener("close", () => reject(new Error("Session closed before ready")), { once: true });
    });
    return { ws, ready };
  };
  try {
    await Promise.race([runtime.ready, Bun.sleep(2000).then(() => { throw new Error("initial registration timed out"); })]);
    const first = openSession();
    await first.ready;
    const firstClosed = new Promise<void>((resolve) => first.ws.addEventListener("close", () => resolve(), { once: true }));
    relay.stop();
    await firstClosed;
    relay = createRelayServer({ hostname: "127.0.0.1", port, secret });
    const deadline = Date.now() + 3000;
    let status = 0;
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${port}/client?node=restart-test&v=2`, { headers: { Authorization: `Bearer ${secret}` } });
      status = response.status;
      if (status === 400) break; // registered node, but this HTTP request is not a WebSocket upgrade
      await Bun.sleep(20);
    }
    expect(status).toBe(400);
    const second = openSession();
    await second.ready;
    expect(accepted).toBe(2); // The disconnected session was not migrated.
    const echoed = new Promise<MessageEvent>((resolve) => second.ws.addEventListener("message", resolve, { once: true }));
    second.ws.binaryType = "arraybuffer";
    second.ws.send(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array((await echoed).data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    second.ws.close();
  } finally {
    runtime.close();
    await runtime.finished;
    relay.stop();
    tcp.stop(true);
  }
}, 5000);
