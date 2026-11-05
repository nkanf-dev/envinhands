import { afterEach, describe, expect, test } from "bun:test";
import { createRelayServer, sendRelayFrame, startNodeClient } from "../src/relay";

const secret = "local-test-secret";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function startRelay(setupTimeoutMs = 1000) {
  const relay = createRelayServer({ secret, setupTimeoutMs });
  cleanup.push(() => relay.stop());
  return { relay, base: `ws://127.0.0.1:${relay.port}` };
}
function connect(base: string, path: string, auth = secret): WebSocket {
  const ws = new WebSocket(base + path, { headers: { Authorization: `Bearer ${auth}` } });
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
    expect(await nextText(ws)).toBe("ready");
    ws.send(expected);
    ws.close(1000);
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
    expect(await Promise.all([nextText(a), nextText(b)])).toEqual(["ready", "ready"]);
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
    expect(messages[0]).toBe("ready");
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(banner);
  });

  test("requires shared secret, rejects missing node, and prevents duplicate registration", async () => {
    const { base } = startRelay();
    const http = base.replace("ws:", "http:");
    expect((await fetch(http + "/node?id=n")).status).toBe(401);
    expect((await fetch(http + "/client?node=n", { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(404);
    const node = startNodeClient({ relayUrl: base, nodeId: "n", secret });
    cleanup.push(() => node.close());
    await node.ready;
    const duplicate = startNodeClient({ relayUrl: base, nodeId: "n", secret });
    cleanup.push(() => duplicate.close());
    await expect(duplicate.ready).rejects.toThrow();
    const wrong = startNodeClient({ relayUrl: base, nodeId: "other", secret: "wrong" });
    cleanup.push(() => wrong.close());
    await expect(wrong.ready).rejects.toThrow();
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
    expect(await nextText(control)).toBe("registered");
    const ws = connect(base, "/client?node=idle");
    const request = JSON.parse(await nextText(control));
    expect(request.type).toBe("connect");
    await closed(ws);
    const http = base.replace("ws:", "http:");
    expect((await fetch(http + "/channel?id=" + request.id, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(404);
  });
});
