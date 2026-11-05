import { RELAY_VERSION, REGISTERED, READY, FIN, FIN_ACK, relayControl, relayEndpoint } from "./relay-protocol.ts";
/**
 * TEST PROTOTYPE ONLY. A shared bearer secret gives every holder full access to
 * every node, including the ability to impersonate one. No per-node or user
 * authorization, per-identity rate limiting, reconnect, persistence, or SSH host checking
 * is provided. Use only on a trusted network; plain ws:// exposes the secret
 * and traffic. Supply TLS externally for wss://. SSH itself remains end-to-end
 * between the SSH client and server; this code does not implement SSH.
 * Global application caps below do not limit TCP connections or incomplete HTTP
 * headers before fetch, request/body bandwidth, or per-identity abuse. WebSocket
 * idleTimeout remains disabled; node and active session lifetimes are unbounded.
 * These limits do not make this prototype safe for public deployment.
 *
 * Protocol: WebSocket GET /node?id=NAME registers; GET /client?node=NAME
 * requests a session; GET /channel?id=UUID attaches the requested node channel.
 * All upgrades require Authorization: Bearer <secret>. A client must wait for
 * the text frame "ready" before sending binary frames. Afterwards only binary
 * frames carry opaque bytes. Every endpoint requires v=2 with registered-v2/ready-v2.
 * Directional fin/fin-ack preserve replies after EOF. Only the relay closes the
 * session normally after both FINs and drain acknowledgements. An unexpected
 * close, buffer overflow or completion timeout aborts, never claims delivery.
 * A FIN acknowledgement is not proof the remote application read or handled data.
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
type SocketData = { role: Role; id: string; sessionReserved?: boolean };
type ServerSocket = import("bun").ServerWebSocket<SocketData>;
type Session = {
  id: string; node: string; client: ServerSocket; channel?: ServerSocket;
  ready: boolean; timer: ReturnType<typeof setTimeout>;
  clientFin: boolean; nodeFin: boolean; clientAck: boolean; nodeAck: boolean;
};

export interface RelayOptions {
  secret: string;
  hostname?: string;
  port?: number;
  /** Maximum time for the node to attach and connect its local TCP socket. */
  setupTimeoutMs?: number;
  /** Global limits. WebSocket slots include closing sockets until close. */
  maxNodes?: number;
  maxSessions?: number;
  maxWebSockets?: number;
  /** Fixed global one-second window, counts all HTTP requests reaching fetch. */
  maxRequestsPerSecond?: number;
}

function validSecret(secret: string): void {
  if (typeof secret !== "string" || !secret || /[\r\n]/.test(secret)) throw new Error("A non-empty shared secret is required");
}

/** Starts a Bun WebSocket relay. stop() closes registered sockets and sessions. */
export function createRelayServer(options: RelayOptions) {
  validSecret(options.secret);
  const timeout = options.setupTimeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid setup timeout");
  const limit = (value: number | undefined, fallback: number, name: string) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid ${name}`);
    return result;
  };
  const maxNodes = limit(options.maxNodes, 64, "maxNodes");
  const maxSessions = limit(options.maxSessions, 128, "maxSessions");
  const maxWebSockets = limit(options.maxWebSockets, 384, "maxWebSockets");
  const maxRequestsPerSecond = limit(options.maxRequestsPerSecond, 200, "maxRequestsPerSecond");
  const nodes = new Map<string, ServerSocket>();
  const reservedNodes = new Set<string>();
  const reservedChannels = new Set<string>();
  let sessionCount = 0;
  let socketCount = 0;
  let windowStart = performance.now();
  let requests = 0;
  const sessions = new Map<string, Session>();
  // Includes upgraded sockets not yet observed by open(), for stop().
  const sockets = new Set<ServerSocket>();
  let stopping = false;

  function end(id: string, code = 1011, reason = "Relay failure") {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    sessionCount--;
    clearTimeout(s.timer);
    try { s.client.close(code, reason); } catch {}
    try { s.channel?.close(code, reason); } catch {}
  }
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? 0,
    fetch(req, srv) {
      if (stopping) return new Response("Stopping", { status: 503 });
      const now = performance.now();
      if (now - windowStart >= 1000) { windowStart = now; requests = 0; }
      if (++requests > maxRequestsPerSecond) return new Response("Request limit exceeded", { status: 429, headers: { "Retry-After": "1" } });
      if (req.headers.get("authorization") !== `Bearer ${options.secret}`) return new Response("Unauthorized", { status: 401 });
      const url = new URL(req.url);
      if (url.searchParams.getAll("v").length !== 1 || url.searchParams.get("v") !== RELAY_VERSION) return new Response("Relay protocol v2 required", { status: 400 });
      let data: SocketData;
      if (url.pathname === "/node") {
        const id = url.searchParams.get("id") ?? "";
        if (!ID.test(id)) return new Response("Invalid node", { status: 400 });
        if (nodes.has(id) || reservedNodes.has(id)) return new Response("Node already registered", { status: 409 });
        if (nodes.size + reservedNodes.size >= maxNodes) return new Response("Node limit exceeded", { status: 503 });
        data = { role: "node", id };
      } else if (url.pathname === "/client") {
        const id = url.searchParams.get("node") ?? "";
        if (!ID.test(id)) return new Response("Invalid node", { status: 400 });
        if (!nodes.has(id)) return new Response("Node unavailable", { status: 404 });
        if (sessionCount >= maxSessions) return new Response("Session limit exceeded", { status: 503 });
        data = { role: "client", id, sessionReserved: true };
      } else if (url.pathname === "/channel") {
        const id = url.searchParams.get("id") ?? "";
        const session = sessions.get(id);
        if (!session || session.channel || reservedChannels.has(id)) return new Response("Unknown channel", { status: 404 });
        data = { role: "channel", id };
      } else return new Response("Not found", { status: 404 });
      if (socketCount >= maxWebSockets) return new Response("WebSocket limit exceeded", { status: 503 });
      // Reserve before upgrade: open and close may happen in a later event-loop turn.
      socketCount++;
      if (data.role === "node") reservedNodes.add(data.id);
      if (data.role === "client") sessionCount++;
      if (data.role === "channel") reservedChannels.add(data.id);
      let upgraded = false;
      try { upgraded = srv.upgrade(req, { data }); } finally {
        if (!upgraded) {
          socketCount--;
          if (data.role === "node") reservedNodes.delete(data.id);
          if (data.role === "client") sessionCount--;
          if (data.role === "channel") reservedChannels.delete(data.id);
        }
      }
      if (!upgraded) return new Response("Expected WebSocket", { status: 400 });
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
        if (role === "node") reservedNodes.delete(id);
        if (role === "channel") reservedChannels.delete(id);
        if (stopping) { ws.close(); return; }
        if (role === "node") {
          if (nodes.has(id)) { ws.close(1008, "Node already registered"); return; }
          nodes.set(id, ws);
          if (!sendRelayFrame(ws, REGISTERED)) ws.close(1011, "Control send failed");
        } else if (role === "client") {
          const node = nodes.get(id);
          if (!node) { ws.close(1011, "Node unavailable"); return; }
          const sessionId = crypto.randomUUID();
          const session: Session = { id: sessionId, node: id, client: ws, ready: false, clientFin: false, nodeFin: false, clientAck: false, nodeAck: false,
            timer: setTimeout(() => end(sessionId), timeout) };
          sessions.set(sessionId, session);
          ws.data.sessionReserved = false;
          // Set before sending: a synchronous failure must still clean up this session.
          ws.data.id = sessionId;
          if (!sendRelayFrame(node, JSON.stringify({ type: "connect", id: sessionId, version: 2 }))) end(sessionId);
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
        if (role === "channel" && !s.ready && message === READY) {
          s.ready = true;
          clearTimeout(s.timer);
          if (!sendRelayFrame(s.client, READY)) end(id);
          return;
        }
        if (!s.ready || !s.channel) { end(id); return; }
        const peer = role === "client" ? s.channel : s.client;
        if (typeof message === "string") {
          const frame = relayControl(message);
          if (frame === FIN) {
            if (role === "client" ? s.clientFin : s.nodeFin) { end(id); return; }
            if (!s.clientFin && !s.nodeFin) s.timer = setTimeout(() => end(id, 1011, "FIN completion timed out"), DRAIN_TIMEOUT_MS);
            if (role === "client") s.clientFin = true; else s.nodeFin = true;
          } else if (frame === FIN_ACK) {
            if (role === "client" ? !s.nodeFin || s.clientAck : !s.clientFin || s.nodeAck) { end(id); return; }
            if (role === "client") s.clientAck = true; else s.nodeAck = true;
          } else { end(id); return; }
          if (!sendRelayFrame(peer, message)) { end(id); return; }
          if (s.clientFin && s.nodeFin && s.clientAck && s.nodeAck) end(id, 1000, "");
          return;
        }
        if (role === "client" ? s.clientFin : s.nodeFin) { end(id); return; }
        if (message.byteLength && !sendRelayFrame(peer, message)) end(id, 1011, "Relay buffer exceeded");
      },
      close(ws, code) {
        sockets.delete(ws);
        socketCount--;
        const { role, id } = ws.data;
        if (ws.data.sessionReserved) { sessionCount--; ws.data.sessionReserved = false; }
        if (role === "node") {
          if (nodes.get(id) !== ws) return;
          nodes.delete(id);
          for (const [key, session] of sessions) if (session.node === id) end(key);
        } else {
          const s = sessions.get(id);
          if (s && (role === "client" ? s.client === ws : s.channel === ws)) {
            // A peer close is never the v2 completion owner; completed sessions were already removed by end().
            end(id, 1011, "Peer closed before directional completion");
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
  const control = new WebSocket(relayEndpoint(base.toString(), "/node", "id", options.nodeId), { headers });
  const channels = new Set<() => void>();
  let stopped = false;
  let registered = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveClosed!: () => void;
  // Only the control WebSocket lifetime is represented, not SSH session drain.
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  function stop() {
    if (stopped) return;
    stopped = true;
    if (!registered) rejectReady(new Error("Node registration failed or closed"));
    for (const close of [...channels]) close();
    try { control.close(); } catch {}
  }
  function connect(id: string) {
    if (stopped || channels.size >= 256) return;
    const ws = new WebSocket(relayEndpoint(base.toString(), "/channel", "id", id), { headers });
    ws.binaryType = "arraybuffer";
    let tcp: import("bun").Socket | undefined;
    let closed = false, tcpReady = false, remoteFin = false, localFin = false, localFinAck = false, remoteFinAck = false, tcpClosed = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: Uint8Array[] = [], early: Uint8Array[] = [];
    let pendingBytes = 0, earlyBytes = 0;
    const boundFinish = () => { if (!drainTimer) drainTimer = setTimeout(abort, DRAIN_TIMEOUT_MS); };
    function finish() {
      if (closed) return;
      closed = true; channels.delete(abort);
      if (drainTimer) clearTimeout(drainTimer);
      pending = []; early = []; pendingBytes = earlyBytes = 0;
    }
    function abort() {
      if (closed) return;
      finish(); try { tcp?.terminate(); } catch {}
      try { ws.close(4000, "Session aborted"); } catch {}
    }
    function send(data: string | Uint8Array): boolean {
      const bytes = typeof data === "string" ? data.length : data.byteLength;
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + bytes + 14 > MAX_BUFFER) { abort(); return false; }
      try { ws.send(data); return true; } catch { abort(); return false; }
    }
    function sendTcpData(data: Uint8Array) {
      if (closed || localFin) { abort(); return; }
      for (let offset = 0; offset < data.byteLength; offset += MAX_FRAME) {
        if (!send(data.subarray(offset, offset + MAX_FRAME))) return;
      }
    }
    function sendLocalFin() {
      if (!tcpReady || closed || localFin) return;
      localFin = true; boundFinish(); send(FIN);
    }
    function flush() {
      if (!tcp || closed || remoteFinAck) return;
      try {
        while (pending.length) {
          const first = pending[0]!, count = tcp.write(first);
          if (count < 0) { abort(); return; }
          if (count === 0) return;
          pendingBytes -= count;
          if (count < first.byteLength) { pending[0] = first.subarray(count); return; }
          pending.shift();
        }
        if (remoteFin) {
          // Set before end(): normal TCP close can precede WebSocket acknowledgement.
          remoteFinAck = true;
          tcp.shutdown(false); send(FIN_ACK);
        }
      } catch { abort(); }
    }
    channels.add(abort);
    let earlyEnd = false;
    ws.onopen = () => {
      void Bun.connect({ hostname: options.sshHost ?? "127.0.0.1", port, allowHalfOpen: true,
        socket: {
          data(_socket, data) {
            if (closed) return;
            if (!tcpReady) {
              if (earlyBytes + data.byteLength > MAX_BUFFER) { abort(); return; }
              early.push(new Uint8Array(data)); earlyBytes += data.byteLength;
            } else sendTcpData(data);
          },
          end() { if (!tcpReady) earlyEnd = true; else sendLocalFin(); },
          drain() { flush(); },
          close(_socket, error) {
            if (error) { abort(); return; }
            tcpClosed = true;
            if (closed) return;
            // Bun may report close rather than end when both TCP directions have finished.
            if (remoteFinAck) sendLocalFin();
            else abort();
          },
          error() { abort(); }, connectError() { abort(); },
        },
      }).then(socket => {
        if (closed) { socket.terminate(); return; }
        tcp = socket;
        if (!send(READY)) return;
        tcpReady = true;
        for (const bytes of early) { sendTcpData(bytes); if (closed) return; }
        early = []; earlyBytes = 0;
        if (earlyEnd) sendLocalFin();
      }).catch(abort);
    };
    ws.onmessage = event => {
      if (!tcp || closed) { abort(); return; }
      if (typeof event.data === "string") {
        const frame = relayControl(event.data);
        if (frame === FIN && !remoteFin) { remoteFin = true; boundFinish(); flush(); }
        else if (frame === FIN_ACK && localFin && !localFinAck) localFinAck = true;
        else abort();
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || remoteFin || tcpClosed) { abort(); return; }
      const bytes = new Uint8Array(event.data);
      if (pendingBytes + bytes.byteLength > MAX_BUFFER) { abort(); return; }
      if (bytes.byteLength) { pending.push(bytes); pendingBytes += bytes.byteLength; flush(); }
    };
    ws.onerror = abort;
    ws.onclose = event => {
      if (closed) return;
      if ((event.code === 1000 || event.code === 1005) && localFin && remoteFin && localFinAck && remoteFinAck && pendingBytes === 0) {
        finish(); if (!tcpClosed) { try { tcp?.end(); } catch {} }
      } else abort();
    };
  }
  control.onmessage = (event) => {
    if (event.data === REGISTERED && !registered) { registered = true; resolveReady(); return; }
    if (!registered || typeof event.data !== "string") { stop(); return; }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type !== "connect" || msg.version !== 2 || typeof msg.id !== "string" || !/^[0-9a-f-]{36}$/i.test(msg.id)) { stop(); return; }
      connect(msg.id);
    } catch { stop(); }
  };
  control.onerror = stop;
  control.onclose = () => { stop(); resolveClosed(); };
  return { ready, closed, close: stop };
}
