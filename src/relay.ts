/**
 * TEST PROTOTYPE ONLY. A shared bearer secret gives every holder full access to
 * every node, including the ability to impersonate one. No per-node or user
 * authorization, rate limiting, reconnect, persistence, or SSH host checking
 * is provided. Use only on a trusted network; plain ws:// exposes the secret
 * and traffic. Supply TLS externally for wss://. SSH itself remains end-to-end
 * between the SSH client and server; this code does not implement SSH.
 *
 * Protocol: WebSocket GET /node?id=NAME registers; GET /client?node=NAME
 * requests a session; GET /channel?id=UUID attaches the requested node channel.
 * All upgrades require Authorization: Bearer <secret>. A client must wait for
 * the text frame "ready" before sending binary frames. Afterwards only binary
 * frames carry opaque bytes. A close on either side closes the whole session;
 * TCP half-close is not supported. A normal WebSocket close drains accepted
 * client bytes to TCP before FIN, but cannot return data sent after that close.
 * Errors, buffer overflow and drain timeout abort rather than claim delivery.
 * A normal close is not an acknowledgement that the remote application read data.
 * Once the WebSocket is closed, a later drain failure cannot be reported to it.
 */

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const MAX_FRAME = 1024 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 10_000;

/** Bun returns -1 for accepted, buffered frames; 0 means dropped. */
export function sendRelayFrame(ws: Pick<ServerSocket, "send" | "getBufferedAmount">, data: string | Uint8Array): boolean {
  const size = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  // Include the maximum WebSocket frame header in the budget.
  try {
    if (ws.getBufferedAmount() + size + 14 > MAX_BUFFER) return false;
    return ws.send(data, false) !== 0;
  } catch { return false; }
}

type Role = "node" | "client" | "channel";
type SocketData = { role: Role; id: string };
type ServerSocket = import("bun").ServerWebSocket<SocketData>;
type Session = {
  id: string; node: string; client: ServerSocket; channel?: ServerSocket;
  ready: boolean; timer: ReturnType<typeof setTimeout>;
};

export interface RelayOptions {
  secret: string;
  hostname?: string;
  port?: number;
  /** Maximum time for the node to attach and connect its local TCP socket. */
  setupTimeoutMs?: number;
}

function validSecret(secret: string): void {
  if (typeof secret !== "string" || !secret || /[\r\n]/.test(secret)) throw new Error("A non-empty shared secret is required");
}

/** Starts a Bun WebSocket relay. stop() closes registered sockets and sessions. */
export function createRelayServer(options: RelayOptions) {
  validSecret(options.secret);
  const timeout = options.setupTimeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid setup timeout");
  const nodes = new Map<string, ServerSocket>();
  const sessions = new Map<string, Session>();
  // Includes upgraded sockets not yet observed by open(), for stop().
  const sockets = new Set<ServerSocket>();
  let stopping = false;

  function end(id: string, code = 1011, reason = "Relay failure") {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    clearTimeout(s.timer);
    try { s.client.close(code, reason); } catch {}
    try { s.channel?.close(code, reason); } catch {}
  }
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch(req, srv) {
      if (stopping) return new Response("Stopping", { status: 503 });
      if (req.headers.get("authorization") !== `Bearer ${options.secret}`) return new Response("Unauthorized", { status: 401 });
      const url = new URL(req.url);
      let data: SocketData;
      if (url.pathname === "/node") {
        const id = url.searchParams.get("id") ?? "";
        if (!ID.test(id)) return new Response("Invalid node", { status: 400 });
        if (nodes.has(id)) return new Response("Node already registered", { status: 409 });
        data = { role: "node", id };
      } else if (url.pathname === "/client") {
        const id = url.searchParams.get("node") ?? "";
        if (!ID.test(id)) return new Response("Invalid node", { status: 400 });
        if (!nodes.has(id)) return new Response("Node unavailable", { status: 404 });
        data = { role: "client", id };
      } else if (url.pathname === "/channel") {
        const id = url.searchParams.get("id") ?? "";
        const session = sessions.get(id);
        if (!session || session.channel) return new Response("Unknown channel", { status: 404 });
        data = { role: "channel", id };
      } else return new Response("Not found", { status: 404 });
      if (!srv.upgrade(req, { data })) return new Response("Expected WebSocket", { status: 400 });
      return undefined;
    },
    websocket: {
      maxPayloadLength: MAX_FRAME,
      backpressureLimit: MAX_BUFFER,
      closeOnBackpressureLimit: true,
      idleTimeout: 0,
      open(ws) {
        sockets.add(ws);
        const { role, id } = ws.data;
        if (stopping) { ws.close(); return; }
        if (role === "node") {
          if (nodes.has(id)) { ws.close(1008, "Node already registered"); return; }
          nodes.set(id, ws);
          if (!sendRelayFrame(ws, "registered")) ws.close(1011, "Control send failed");
        } else if (role === "client") {
          const node = nodes.get(id);
          if (!node) { ws.close(1011, "Node unavailable"); return; }
          const sessionId = crypto.randomUUID();
          const session: Session = { id: sessionId, node: id, client: ws, ready: false,
            timer: setTimeout(() => end(sessionId), timeout) };
          sessions.set(sessionId, session);
          if (!sendRelayFrame(node, JSON.stringify({ type: "connect", id: sessionId }))) end(sessionId);
          // Use the session ID for close/message handling from now on.
          ws.data.id = sessionId;
        } else {
          const session = sessions.get(id);
          if (!session || session.channel) { ws.close(1008, "Unknown channel"); return; }
          session.channel = ws;
        }
      },
      message(ws, message) {
        const { role, id } = ws.data;
        if (role === "node") { ws.close(1008, "Unexpected control message"); return; }
        const s = sessions.get(id);
        if (!s || (role === "channel" ? s.channel !== ws : s.client !== ws)) { ws.close(); return; }
        if (role === "channel" && !s.ready && message === "ready") {
          s.ready = true;
          clearTimeout(s.timer);
          if (!sendRelayFrame(s.client, "ready")) end(id);
          return;
        }
        if (!s.ready || typeof message === "string" || !s.channel) { end(id); return; }
        if (message.byteLength && !sendRelayFrame(role === "client" ? s.channel : s.client, message)) end(id, 1011, "Relay buffer exceeded");
      },
      close(ws, code) {
        sockets.delete(ws);
        const { role, id } = ws.data;
        if (role === "node") {
          if (nodes.get(id) !== ws) return;
          nodes.delete(id);
          for (const [key, session] of sessions) if (session.node === id) end(key);
        } else {
          const s = sessions.get(id);
          if (s && (role === "client" ? s.client === ws : s.channel === ws)) {
            const normal = code === 1000 || code === 1005;
            end(id, normal ? 1000 : 1011, normal ? "" : "Peer closed abnormally");
          }
        }
      },
    },
  });
  return {
    hostname: server.hostname,
    port: server.port,
    stop() {
      if (stopping) return;
      stopping = true;
      for (const id of sessions.keys()) end(id);
      for (const ws of sockets) try { ws.close(); } catch {}
      nodes.clear();
      server.stop(true);
    },
  };
}

export interface NodeClientOptions {
  /** Base ws:// or wss:// URL of the relay. */
  relayUrl: string;
  nodeId: string;
  secret: string;
  /** Local SSH host defaults to loopback. Never supplied by a relay client. */
  sshHost?: string;
  sshPort?: number;
}

/** Registers one node; opens one outbound WebSocket and TCP socket per session. */
export function startNodeClient(options: NodeClientOptions) {
  validSecret(options.secret);
  if (!ID.test(options.nodeId)) throw new Error("Invalid node id");
  const port = options.sshPort ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH port");
  const base = new URL(options.relayUrl);
  if (base.protocol !== "ws:" && base.protocol !== "wss:") throw new Error("Expected ws:// or wss:// relay URL");
  const headers = { Authorization: `Bearer ${options.secret}` };
  function url(path: string, key: string, value: string) {
    const u = new URL(path, base); u.searchParams.set(key, value); return u.toString();
  }
  const control = new WebSocket(url("/node", "id", options.nodeId), { headers });
  const channels = new Set<() => void>();
  let stopped = false;
  let registered = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  function stop() {
    if (stopped) return;
    stopped = true;
    if (!registered) rejectReady(new Error("Node registration failed or closed"));
    for (const close of [...channels]) close();
    try { control.close(); } catch {}
  }
  function connect(id: string) {
    if (stopped || channels.size >= 256) return;
    const ws = new WebSocket(url("/channel", "id", id), { headers });
    ws.binaryType = "arraybuffer";
    let tcp: import("bun").Socket | undefined;
    let closed = false;
    let draining = false;
    let finSent = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    // The SSH server may send its banner immediately on TCP connect. Do not
    // forward it until the channel's ready marker has been sent.
    let tcpReady = false;
    let early: Uint8Array[] = [];
    let earlyBytes = 0;
    function sendTcpData(data: Uint8Array) {
      if (draining || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + data.byteLength + 14 * Math.ceil(data.byteLength / MAX_FRAME) > MAX_BUFFER) { abort(); return; }
      try {
        for (let offset = 0; offset < data.byteLength; offset += MAX_FRAME)
          ws.send(data.subarray(offset, offset + MAX_FRAME));
      } catch { abort(); }
    }
    function finish() {
      if (closed) return;
      closed = true; channels.delete(abort);
      if (drainTimer) clearTimeout(drainTimer);
      pending = []; pendingBytes = 0; early = []; earlyBytes = 0;
    }
    function abort() {
      if (closed) return;
      finish();
      try { tcp?.terminate(); } catch {}
      try { ws.close(4000, "Session aborted"); } catch {}
    }
    channels.add(abort);
    function flush() {
      if (!tcp || closed) return;
      try {
        while (pending.length) {
          const first = pending[0];
          const count = tcp.write(first);
          if (count < 0) { abort(); return; }
          if (count === 0) return;
          pendingBytes -= count;
          if (count < first.byteLength) { pending[0] = first.subarray(count); return; }
          pending.shift();
        }
        if (draining && !finSent) {
          finSent = true;
          // All bytes are accepted by the kernel. FIN preserves their order.
          tcp.end();
          // No return path exists after WebSocket close. Keep a bounded lifetime.
        }
      } catch { abort(); }
    }
    function gracefulClose() {
      if (closed || draining) return;
      if (!tcp) { abort(); return; }
      draining = true;
      drainTimer = setTimeout(abort, DRAIN_TIMEOUT_MS);
      flush();
    }
    ws.onopen = () => {
      void Bun.connect({
        hostname: options.sshHost ?? "127.0.0.1", port,
        socket: {
          data(_socket, data) {
            if (closed || draining) return; // WebSocket cannot carry a TCP half-close response.
            if (!tcpReady) {
              if (earlyBytes + data.byteLength > MAX_BUFFER) { abort(); return; }
              early.push(new Uint8Array(data)); earlyBytes += data.byteLength;
            } else sendTcpData(data);
          },
          drain() { flush(); },
          close() {
            if (draining && pendingBytes === 0) finish();
            else abort();
          },
          error() { abort(); },
          connectError() { abort(); },
        },
      }).then((socket) => {
        if (closed) { socket.terminate(); return; }
        tcp = socket;
        try { ws.send("ready"); } catch { abort(); return; }
        tcpReady = true;
        for (const data of early) { sendTcpData(data); if (closed) break; }
        early = []; earlyBytes = 0;
      }).catch(abort);
    };
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer) || !tcp || draining) { abort(); return; }
      const bytes = new Uint8Array(event.data);
      if (pendingBytes + bytes.byteLength > MAX_BUFFER) { abort(); return; }
      if (bytes.byteLength) { pending.push(bytes); pendingBytes += bytes.byteLength; flush(); }
    };
    ws.onerror = abort;
    ws.onclose = (event) => {
      if (event.code === 1000 || event.code === 1005) gracefulClose();
      else abort();
    };
  }
  control.onmessage = (event) => {
    if (event.data === "registered" && !registered) { registered = true; resolveReady(); return; }
    if (!registered || typeof event.data !== "string") { stop(); return; }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type !== "connect" || typeof msg.id !== "string" || !/^[0-9a-f-]{36}$/i.test(msg.id)) { stop(); return; }
      connect(msg.id);
    } catch { stop(); }
  };
  control.onerror = stop;
  control.onclose = stop;
  return { ready, close: stop };
}
