import { afterEach, describe, expect, test } from "bun:test";
import { createRelayServer, sendRelayFrame, startNodeClient } from "../src/relay";
import { createServer, connect as connectTcp, type Socket } from "node:net";

const secret = "local-test-secret";
const cleanup: Array<() => void> = [];
async function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function startRelay(setupTimeoutMs = 1000, limits: Partial<Parameters<typeof createRelayServer>[0]> = {}) {
  const relay = createRelayServer({ secret, setupTimeoutMs, ...limits });
  cleanup.push(() => relay.stop());
  return { relay, base: `ws://127.0.0.1:${relay.port}` };
}
function connect(base: string, path: string, auth = secret): WebSocket {
  const ws = new WebSocket(base + path + (path.includes("?") ? "&v=2" : "?v=2"), { headers: { Authorization: `Bearer ${auth}` } });
  ws.binaryType = "arraybuffer";
  cleanup.push(() => ws.close());
  return ws;
}
function nextText(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { detach(); reject(new Error("Timed out waiting for text")); }, 2000);
    function detach() { clearTimeout(timer); ws.removeEventListener("message", onMessage); ws.removeEventListener("close", onClose); }
    function onMessage(e: MessageEvent) { detach(); typeof e.data === "string" ? resolve(e.data) : reject(new Error("Expected text")); }
    function onClose() { detach(); reject(new Error("Closed before text")); }
    ws.addEventListener("message", onMessage); ws.addEventListener("close", onClose);
  });
}
function closed(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), 2000);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
function echo(ws: WebSocket, bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let received = new Uint8Array(0);
    const timer = setTimeout(() => { detach(); reject(new Error("Timed out waiting for echo")); }, 2000);
    function detach() { clearTimeout(timer); ws.removeEventListener("message", onMessage); ws.removeEventListener("close", onClose); }
    function onClose() { detach(); reject(new Error("Closed before echo")); }
    function onMessage(e: MessageEvent) {
      if (!(e.data instanceof ArrayBuffer)) { detach(); reject(new Error("Expected binary")); return; }
      const chunk = new Uint8Array(e.data);
      const joined = new Uint8Array(received.length + chunk.length);
      joined.set(received); joined.set(chunk, received.length); received = joined;
      if (received.length >= bytes.length) { detach(); resolve(received); }
    }
    ws.addEventListener("message", onMessage); ws.addEventListener("close", onClose);
    ws.send(bytes);
  });
}

describe("reverse relay prototype", () => {
  test("limits node registrations and recovers after close and failed upgrade", async () => {
    const { base } = startRelay(1000, { maxNodes: 2 });
    const http = base.replace("ws:", "http:");
    const headers = { Authorization: `Bearer ${secret}` };
    // A valid HTTP request without an upgrade must not consume a slot.
    expect((await fetch(http + "/node?id=bad&v=2", { headers })).status).toBe(400);
    const a = connect(base, "/node?id=a");
    const b = connect(base, "/node?id=b");
    expect(await Promise.all([nextText(a), nextText(b)])).toEqual(["registered-v2", "registered-v2"]);
    expect((await fetch(http + "/node?id=c&v=2", { headers })).status).toBe(503);
    const denied = connect(base, "/node?id=denied");
    await closed(denied);
    a.close(); await closed(a);
    const c = connect(base, "/node?id=c");
    expect(await nextText(c)).toBe("registered-v2");
  });

  test("session limit counts pending and active sessions and releases them", async () => {
    const { base } = startRelay(300, { maxSessions: 1 });
    const http = base.replace("ws:", "http:");
    const headers = { Authorization: `Bearer ${secret}` };
    const control = connect(base, "/node?id=n");
    await nextText(control);
    const a = connect(base, "/client?node=n");
    const request = JSON.parse(await nextText(control));
    expect((await fetch(http + "/client?node=n&v=2", { headers })).status).toBe(503);
    const denied = connect(base, "/client?node=n");
    await closed(denied);
    const channel = connect(base, "/channel?id=" + request.id);
    const ready = nextText(a);
    await new Promise<void>((resolve, reject) => { channel.onopen = () => resolve(); channel.onerror = () => reject(new Error("channel failed")); });
    channel.send("ready-v2");
    expect(await ready).toBe("ready-v2");
    expect((await fetch(http + "/client?node=n&v=2", { headers })).status).toBe(503);
    a.close(); await closed(a); await closed(channel);
    const b = connect(base, "/client?node=n");
    expect(JSON.parse(await nextText(control)).type).toBe("connect");
    await closed(b); // pending session times out
    const c = connect(base, "/client?node=n");
    expect(JSON.parse(await nextText(control)).type).toBe("connect");
    c.close();
  });

  test("global WebSocket cap rejects excess sockets and releases on close", async () => {
    const { base } = startRelay(1000, { maxWebSockets: 2 });
    const http = base.replace("ws:", "http:");
    const headers = { Authorization: `Bearer ${secret}` };
    const a = connect(base, "/node?id=a");
    const b = connect(base, "/node?id=b");
    await Promise.all([nextText(a), nextText(b)]);
    expect((await fetch(http + "/node?id=c&v=2", { headers })).status).toBe(503);
    const denied = connect(base, "/node?id=denied");
    await closed(denied);
    b.close(); await closed(b);
    const c = connect(base, "/node?id=c");
    expect(await nextText(c)).toBe("registered-v2");
  });

  test("global HTTP request window counts unauthorized requests and recovers", async () => {
    const { base } = startRelay(1000, { maxRequestsPerSecond: 2 });
    const http = base.replace("ws:", "http:");
    expect((await fetch(http + "/")).status).toBe(401);
    expect((await fetch(http + "/")).status).toBe(401);
    const limited = await fetch(http + "/");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    await Bun.sleep(1050);
    const ws = connect(base, "/node?id=after");
    expect(await nextText(ws)).toBe("registered-v2");
  });

  test("rejects invalid limit configuration", () => {
    for (const name of ["maxNodes", "maxSessions", "maxWebSockets", "maxRequestsPerSecond"] as const) {
      for (const value of [0, -1, 1.5, Infinity, NaN]) {
        expect(() => createRelayServer({ secret, [name]: value })).toThrow();
      }
    }
  });

  test("server send treats -1 as accepted without retry; 0 and overflow fail", () => {
    const sent: unknown[] = [];
    let buffered = 0;
    let result = -1;
    const socket = {
      getBufferedAmount: () => buffered,
      send: (data: unknown) => { sent.push(data); return result; },
    };
    const payload = new Uint8Array([1, 2, 3]);
    expect(sendRelayFrame(socket, payload)).toBe(true);
    expect(sent).toEqual([payload]);
    result = 0;
    expect(sendRelayFrame(socket, payload)).toBe(false);
    buffered = 4 * 1024 * 1024;
    expect(sendRelayFrame(socket, payload)).toBe(false);
    expect(sent).toHaveLength(2);
  });

  test("normal close drains a large message to a slow TCP reader before FIN", async () => {
    const expected = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 131 + (i >>> 8)) % 256);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { socket.pause(); setTimeout(() => socket.resume(), 200); },
      data(_socket, data) { chunks.push(new Uint8Array(data)); total += data.byteLength; },
      close() { resolveEnd(); },
      error() { resolveEnd(); },
    } });
    cleanup.push(() => tcp.stop(true));
    const { base } = startRelay();
    const node = startNodeClient({ relayUrl: base, nodeId: "slow", secret, sshPort: tcp.port });
    cleanup.push(() => node.close());
    await node.ready;
    const ws = connect(base, "/client?node=slow");
    expect(await nextText(ws)).toBe("ready-v2");
    ws.addEventListener("message", event => { if (event.data === "fin") ws.send("fin-ack"); });
    ws.send(expected);
    ws.send("fin");
    await Promise.race([ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TCP drain timed out")), 4000))]);
    expect(total).toBe(expected.length);
    const actual = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { actual.set(chunk, offset); offset += chunk.length; }
    expect(actual).toEqual(expected);
  });

  test("a stalled TCP receiver causes an explicit abnormal close at the buffer limit", async () => {
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { socket.pause(); }, data() {}, error() {},
    } });
    cleanup.push(() => tcp.stop(true));
    const { base } = startRelay();
    const node = startNodeClient({ relayUrl: base, nodeId: "stalled", secret, sshPort: tcp.port });
    cleanup.push(() => node.close());
    await node.ready;
    const ws = connect(base, "/client?node=stalled");
    await nextText(ws);
    const closeEvent = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve, { once: true }));
    const block = new Uint8Array(512 * 1024);
    for (let i = 0; i < 32; i++) ws.send(block);
    const event = await Promise.race([closeEvent, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Overflow did not close")), 4000))]);
    expect(event.code).not.toBe(1000);
    expect(event.code).not.toBe(1005);
  });

  test("local TCP failure reaches the client as an abnormal close", async () => {
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { setTimeout(() => socket.terminate(), 50); },
      data() {}, error() {},
    } });
    cleanup.push(() => tcp.stop(true));
    const { base } = startRelay();
    const node = startNodeClient({ relayUrl: base, nodeId: "broken", secret, sshPort: tcp.port });
    cleanup.push(() => node.close());
    await node.ready;
    const ws = connect(base, "/client?node=broken");
    await nextText(ws);
    const event = await new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve, { once: true }));
    expect(event.code).not.toBe(1000);
  });

  test("node dials outbound, bridges binary in both directions, and isolates sessions", async () => {
    let accepted = 0;
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open() { accepted++; },
      data(socket, data) { socket.write(data); },
      error() {},
    } });
    cleanup.push(() => tcp.stop(true));
    const { base } = startRelay();
    const node = startNodeClient({ relayUrl: base, nodeId: "machine-1", secret, sshPort: tcp.port });
    cleanup.push(() => node.close());
    await node.ready;
    const a = connect(base, "/client?node=machine-1");
    const b = connect(base, "/client?node=machine-1");
    expect(await Promise.all([nextText(a), nextText(b)])).toEqual(["ready-v2", "ready-v2"]);
    expect(accepted).toBe(2);
    const one = new Uint8Array([0, 255, 128, 13, 10, 1, 0, 42]);
    const two = Uint8Array.from({ length: 65536 }, (_, i) => (i * 131) % 256);
    const [aResult, bResult] = await Promise.all([echo(a, one), echo(b, two)]);
    expect(aResult).toEqual(one); expect(bResult).toEqual(two);
    a.close(); await closed(a);
    expect(await echo(b, one)).toEqual(one);
    const bClosed = closed(b);
    node.close();
    await bClosed;
  });

  test("forwards a server-first banner after the ready marker", async () => {
    const banner = new TextEncoder().encode("SSH-2.0-test-server\r\n");
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { socket.write(banner); },
      data() {}, error() {},
    } });
    cleanup.push(() => tcp.stop(true));
    const { base } = startRelay();
    const node = startNodeClient({ relayUrl: base, nodeId: "banner", secret, sshPort: tcp.port });
    cleanup.push(() => node.close());
    await node.ready;
    const ws = connect(base, "/client?node=banner");
    const messages = await new Promise<(string | ArrayBuffer)[]>((resolve, reject) => {
      const result: (string | ArrayBuffer)[] = [];
      const timer = setTimeout(() => reject(new Error("Timed out waiting for banner")), 2000);
      ws.addEventListener("message", (event) => {
        result.push(event.data);
        if (result.length === 2) { clearTimeout(timer); resolve(result); }
      });
    });
    expect(messages[0]).toBe("ready-v2");
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(banner);
  });

  test("requires shared secret, rejects missing node, and prevents duplicate registration", async () => {
    const { base } = startRelay();
    const http = base.replace("ws:", "http:");
    expect((await fetch(http + "/node?id=n&v=2")).status).toBe(401);
    expect((await fetch(http + "/client?node=n&v=2", { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(404);
    const node = startNodeClient({ relayUrl: base, nodeId: "n", secret });
    cleanup.push(() => node.close());
    await node.ready;
    const duplicate = startNodeClient({ relayUrl: base, nodeId: "n", secret });
    cleanup.push(() => duplicate.close());
    await expect(duplicate.ready).rejects.toThrow();
    await duplicate.closed;
    const wrong = startNodeClient({ relayUrl: base, nodeId: "other", secret: "wrong" });
    cleanup.push(() => wrong.close());
    await expect(wrong.ready).rejects.toThrow();
    await wrong.closed;
  });

  test("closed follows control loss and explicit close", async () => {
    const { relay, base } = startRelay();
    const first = startNodeClient({ relayUrl: base, nodeId: "close-test", secret });
    await first.ready;
    relay.stop();
    await first.closed;
    first.close(); first.close();

    const other = startRelay();
    const second = startNodeClient({ relayUrl: other.base, nodeId: "close-test", secret });
    await second.ready;
    second.close(); second.close();
    await second.closed;
  });

  test("closed follows close before registration", async () => {
    const { base } = startRelay();
    const node = startNodeClient({ relayUrl: base, nodeId: "early-close", secret });
    const rejected = node.ready.then(() => false, () => true);
    node.close();
    expect(await rejected).toBe(true);
    await node.closed;
  });

  test("unavailable local TCP closes client and node remains registered", async () => {
    // Reserve then release a local port. No process should be listening on it.
    const unused = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = unused.port; unused.stop(true);
    const { base } = startRelay();
    const node = startNodeClient({ relayUrl: base, nodeId: "offline", secret, sshPort: port });
    cleanup.push(() => node.close());
    await node.ready;
    const ws = connect(base, "/client?node=offline");
    await closed(ws);
    const duplicate = startNodeClient({ relayUrl: base, nodeId: "offline", secret });
    cleanup.push(() => duplicate.close());
    await expect(duplicate.ready).rejects.toThrow();
  });

  test("cleans up an unanswered session after the setup timeout", async () => {
    const { base } = startRelay(50);
    const control = connect(base, "/node?id=idle");
    expect(await nextText(control)).toBe("registered-v2");
    const ws = connect(base, "/client?node=idle");
    const request = JSON.parse(await nextText(control));
    expect(request.type).toBe("connect");
    await closed(ws);
    const http = base.replace("ws:", "http:");
    expect((await fetch(http + "/channel?id=" + request.id + "&v=2", { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(404);
  });
});


test("v2 rejects legacy upgrades and binary data sent after FIN", async()=>{
 const {base}=startRelay();const http=base.replace("ws:","http:");const headers={Authorization:`Bearer ${secret}`};
 for(const path of ["/node?id=legacy","/node?id=legacy&v=1","/node?id=legacy&v=2&v=2"])
   expect((await fetch(http+path,{headers})).status).toBe(400);
 const control=connect(base,"/node?id=fin-check");expect(await nextText(control)).toBe("registered-v2");
 const client=connect(base,"/client?node=fin-check");const request=JSON.parse(await nextText(control));expect(request.version).toBe(2);
 const channel=connect(base,"/channel?id="+request.id);const ready=nextText(client);
 await new Promise<void>((resolve,reject)=>{channel.onopen=()=>resolve();channel.onerror=()=>reject(new Error("Channel failed"));});
 channel.send("ready-v2");expect(await ready).toBe("ready-v2");
 const event=new Promise<CloseEvent>(resolve=>client.addEventListener("close",resolve,{once:true}));
 client.send("fin");client.send(new Uint8Array([1]));expect((await event).code).toBe(1011);
 const next=connect(base,"/client?node=fin-check");const nextRequest=JSON.parse(await nextText(control));
 const nextChannel=connect(base,"/channel?id="+nextRequest.id);const nextReady=nextText(next);
 await new Promise<void>((resolve,reject)=>{nextChannel.onopen=()=>resolve();nextChannel.onerror=()=>reject(new Error("Channel failed"));});
 nextChannel.send("ready-v2");expect(await nextReady).toBe("ready-v2");
 const peerClose=new Promise<CloseEvent>(resolve=>nextChannel.addEventListener("close",resolve,{once:true}));
 next.close(1000);expect((await peerClose).code).toBe(1011);
});


// Forward real TCP bytes without parsing WebSocket frames. Only the first
// connection (the control socket) can be blackholed; channel sockets still flow.
async function controlProxy(targetPort: number) {
  let direction: "none" | "to-relay" | "to-node" = "none";
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((incoming) => {
    const control = ++connections === 1;
    const outgoing = connectTcp(targetPort, "127.0.0.1");
    sockets.add(incoming); sockets.add(outgoing);
    incoming.on("data", (data) => { if (!control || direction !== "to-relay") outgoing.write(data); });
    outgoing.on("data", (data) => { if (!control || direction !== "to-node") incoming.write(data); });
    incoming.on("error", () => {}); outgoing.on("error", () => {});
    incoming.on("close", () => { sockets.delete(incoming); outgoing.destroy(); });
    outgoing.on("close", () => { sockets.delete(outgoing); incoming.destroy(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy failed to listen");
  cleanup.push(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { port: address.port, blackhole(value: typeof direction) { direction = value; } };
}

async function waitFor(predicate: () => Promise<boolean>, label: string, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

for (const side of ["relay", "node"] as const) {
  test(`${side} heartbeat detects a silent one-way control blackhole and releases sessions`, async () => {
    const relayTiming = side === "relay"
      ? { heartbeatIntervalMs: 40, heartbeatTimeoutMs: 120 }
      : { heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 2000 };
    const nodeTiming = side === "node"
      ? { heartbeatIntervalMs: 40, heartbeatTimeoutMs: 120 }
      : { heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 2000 };
    const { relay, base } = startRelay(1000, { ...relayTiming, maxNodes: 1, maxSessions: 1 });
    const proxy = await controlProxy(relay.port);
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      data(socket, data) { socket.write(data); }, error() {},
    } });
    cleanup.push(() => tcp.stop(true));
    const node = startNodeClient({ relayUrl: `ws://127.0.0.1:${proxy.port}`, nodeId: "heartbeat", secret, sshPort: tcp.port, registrationTimeoutMs: 120, ...nodeTiming });
    cleanup.push(() => node.close());
    await node.ready;
    const session = connect(base, "/client?node=heartbeat");
    expect(await nextText(session)).toBe("ready-v2");
    const bytes = new Uint8Array([1, 0, 255]);
    expect(await echo(session, bytes)).toEqual(bytes);
    await Bun.sleep(350); // Several heartbeat cycles must not kill a healthy idle control.
    expect(await echo(session, bytes)).toEqual(bytes);
    const sessionClosed = closed(session);
    proxy.blackhole(side === "relay" ? "to-relay" : "to-node");
    await deadline(node.closed, 2500, "Node control did not close");
    await sessionClosed;
    const http = base.replace("ws:", "http:");
    const headers = { Authorization: `Bearer ${secret}` };
    await waitFor(async () => (await fetch(http + "/client?node=heartbeat&v=2", { headers })).status === 404, "stale registration removal");
    const replacement = startNodeClient({ relayUrl: base, nodeId: "heartbeat", secret, sshPort: tcp.port, ...nodeTiming });
    cleanup.push(() => replacement.close());
    await deadline(replacement.ready, 2000, "Replacement registration timed out");
    node.close(); // Repeated close on the old client must not remove the replacement.
    const second = connect(base, "/client?node=heartbeat");
    expect(await nextText(second)).toBe("ready-v2");
    expect(await echo(second, bytes)).toEqual(bytes);
  }, 5000);
}

test("registration deadline closes a server that upgrades but never registers", async () => {
  const silent = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 }); },
    websocket: { message() {}, idleTimeout: 0 },
  });
  cleanup.push(() => silent.stop(true));
  const node = startNodeClient({ relayUrl: `ws://127.0.0.1:${silent.port}`, nodeId: "silent", secret,
    heartbeatIntervalMs: 50, heartbeatTimeoutMs: 150, registrationTimeoutMs: 120 });
  cleanup.push(() => node.close());
  await expect(deadline(node.ready, 1500, "Registration deadline did not fire")).rejects.toThrow(/registr/i);
  await deadline(node.closed, 1500, "Timed out waiting for control close");
  node.close(); node.close();
}, 3000);


test("registration timeout covers a TCP peer that never completes HTTP upgrade", async () => {
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, error() {} } });
  cleanup.push(() => silent.stop(true));
  const node = startNodeClient({ relayUrl: `ws://127.0.0.1:${silent.port}`, nodeId: "handshake", secret, registrationTimeoutMs: 120 });
  cleanup.push(() => node.close());
  await expect(deadline(node.ready, 1500, "registration deadline not enforced")).rejects.toThrow(/registr/i);
  await deadline(node.closed, 1500, "handshake did not close");
}, 3000);

test("explicit close interrupts a pending HTTP handshake", async () => {
  let accepted!: () => void;
  const opened = new Promise<void>((resolve) => { accepted = resolve; });
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { accepted(); }, data() {}, error() {} } });
  cleanup.push(() => silent.stop(true));
  const node = startNodeClient({ relayUrl: `ws://127.0.0.1:${silent.port}`, nodeId: "early-handshake", secret, registrationTimeoutMs: 2000 });
  cleanup.push(() => node.close());
  const ready = node.ready.catch((error) => error);
  await deadline(opened, 1000, "handshake did not start");
  node.close(); node.close();
  expect(await ready).toBeInstanceOf(Error);
  await deadline(node.closed, 1000, "close did not interrupt handshake");
}, 3000);

test("explicit stop during a blackhole closes control and allows relay port reuse", async () => {
  const { relay } = startRelay(1000, { heartbeatIntervalMs: 40, heartbeatTimeoutMs: 500 });
  const proxy = await controlProxy(relay.port);
  const node = startNodeClient({ relayUrl: `ws://127.0.0.1:${proxy.port}`, nodeId: "stopping", secret,
    heartbeatIntervalMs: 40, heartbeatTimeoutMs: 500 });
  cleanup.push(() => node.close());
  await node.ready;
  proxy.blackhole("to-relay");
  await Bun.sleep(70); // Leave an outstanding ping before explicit shutdown.
  node.close(); node.close();
  await deadline(node.closed, 1000, "Node did not stop");
  relay.stop(); relay.stop();
  const next = createRelayServer({ hostname: "127.0.0.1", port: relay.port, secret, heartbeatIntervalMs: 40, heartbeatTimeoutMs: 100 });
  cleanup.push(() => next.stop());
  const replacement = startNodeClient({ relayUrl: `ws://127.0.0.1:${next.port}`, nodeId: "stopping", secret,
    heartbeatIntervalMs: 40, heartbeatTimeoutMs: 100 });
  cleanup.push(() => replacement.close());
  await replacement.ready;
  await Bun.sleep(600); // Old heartbeat deadlines must not affect the new relay.
  const status = await fetch(`http://127.0.0.1:${next.port}/client?node=stopping&v=2`, { headers: { Authorization: `Bearer ${secret}` } });
  expect(status.status).toBe(400);
}, 3000);


test("rejects invalid heartbeat and registration durations", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    for (const name of ["heartbeatIntervalMs", "heartbeatTimeoutMs"] as const) {
      expect(() => createRelayServer({ secret, [name]: value })).toThrow();
      expect(() => startNodeClient({ relayUrl: "ws://127.0.0.1:1", nodeId: "invalid", secret, [name]: value })).toThrow();
    }
    expect(() => startNodeClient({ relayUrl: "ws://127.0.0.1:1", nodeId: "invalid", secret, registrationTimeoutMs: value })).toThrow();
  }
});

test("unsolicited wrong pong payloads do not keep a relay registration alive", async () => {
  const { relay, base } = startRelay(1000, { heartbeatIntervalMs: 40, heartbeatTimeoutMs: 120 });
  const raw = connectTcp(relay.port, "127.0.0.1");
  cleanup.push(() => raw.destroy());
  raw.on("error", () => {});
  let response = "";
  raw.on("data", (data) => { response += data.toString("latin1"); });
  const ended = new Promise<void>((resolve) => raw.once("close", () => resolve()));
  raw.write(`GET /node?id=wrong-pong&v=2 HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${secret}\r\n\r\n`);
  await waitFor(async () => response.includes("registered-v2"), "raw node registration");
  // A client-to-server WebSocket pong must be masked. This fixed payload never
  // matches the relay's random ping nonce; no automatic pong is generated.
  const wrongPong = Buffer.from([0x8a, 0x81, 1, 2, 3, 4, 0x78 ^ 1]);
  const timer = setInterval(() => raw.write(wrongPong), 15);
  try { await deadline(ended, 1200, "Wrong pongs masked heartbeat failure"); }
  finally { clearInterval(timer); }
  const status = await fetch(base.replace("ws:", "http:") + "/client?node=wrong-pong&v=2", { headers: { Authorization: `Bearer ${secret}` } });
  expect(status.status).toBe(404);
}, 2500);


test("relay emits metadata for node and timed out session without credentials", async () => {
  const events: Array<{ event: string; fields: unknown }> = [];
  const { relay, base } = startRelay(30, { onEvent(event, fields) { events.push({ event, fields }); } });
  const control = connect(base, "/node?id=log-node");
  await nextText(control);
  const client = connect(base, "/client?node=log-node");
  const request = JSON.parse(await nextText(control));
  await closed(client);
  const end = events.find(e => e.event === "ssh_session_end");
  expect(end?.fields).toMatchObject({ machineId: "log-node", sessionId: request.id, errorCategory: "timeout", status: "aborted" });
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(events.some(e => e.event === "node_registered")).toBe(true);
  relay.stop(); expect(events.some(e => e.event === "relay_stopped")).toBe(true);
});
