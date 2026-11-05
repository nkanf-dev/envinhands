import { READY, FIN, FIN_ACK, relayControl, relayEndpoint } from "./relay-protocol.ts";
/**
 * Local SSH ProxyCommand byte bridge for the relay in relay.ts (Bun runtime).
 * Pass secrets through configuration, never through a constructed shell command.
 * Use wss:// on untrusted networks. This does not perform SSH host-key checking.
 *
 * Protocol v2 carries directional FIN/ACK without closing the WebSocket early.
 * Input EOF drains accepted bytes and preserves the response direction.
 * FIN ACK confirms bridge drain/EOF only, never application processing.
 * Output is never ended by this function; callers own the injected streams.
 * Bun WebSocket assembles a complete inbound message before delivery, so its
 * internal allocations cannot be bounded here; a relay must be trusted to obey
 * the protocol frame limit. Application-owned queued output is bounded.
 */
import type { Readable, Writable } from "node:stream";

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const FRAME = 64 * 1024;
const HIGH = 512 * 1024;
const LOW = 128 * 1024;
const MAX_PENDING = 4 * 1024 * 1024;
const DRAIN_TIMEOUT = 10_000;

export interface SshProxyOptions {
  relayUrl: string;
  nodeId: string;
  secret: string;
  input?: Readable;
  output?: Writable;
  setupTimeoutMs?: number;
  /** Called once after remote FIN and accepted output drains. Caller owns output EOF. */
  onRemoteEnd?: () => void;
}

/** Rejects with a safe diagnostic. It never writes diagnostics to stdout. */
export function startSshProxy(options: SshProxyOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    // Do not expose URL, WebSocket errors, header values, or close reasons in errors.
    if (typeof options.secret !== "string" || !options.secret || /[\r\n]/.test(options.secret)) {
      reject(new Error("Invalid relay secret")); return;
    }
    if (!ID.test(options.nodeId)) { reject(new Error("Invalid node id")); return; }
    const setupMs = options.setupTimeoutMs ?? 10_000;
    if (!Number.isFinite(setupMs) || setupMs <= 0) { reject(new Error("Invalid setup timeout")); return; }
    let url: URL;
    try {
      url = new URL(options.relayUrl);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error();
      url = new URL(relayEndpoint(url.toString(), "/client", "node", options.nodeId));
    } catch { reject(new Error("Invalid relay URL")); return; }
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    let ws: WebSocket;
    try {
      input.pause();
      ws = new WebSocket(url.toString(), { headers: { Authorization: `Bearer ${options.secret}` } });
      ws.binaryType = "arraybuffer";
    } catch { reject(new Error("Cannot start relay connection")); return; }

    let ready = false, finished = false, eof = false, closing = false;
    let queue: Uint8Array[] = [];
    let queued = 0, pendingOutput = 0;
    let remoteClosed = false, sentFin = false, remoteFin = false, sentAck = false, receivedAck = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    let closeError: Error | undefined;

    const clearTimers = () => {
      if (setupTimer) clearTimeout(setupTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (poll) clearInterval(poll);
    };
    const cleanup = () => {
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onInputError);
      if (pendingOutput === 0) output.removeListener("error", onOutputError);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    };
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true; clearTimers();
      queue = []; queued = 0;
      try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(err ? 4000 : 1000, err ? "Bridge failed" : ""); } catch {}
      // write callbacks can precede their stream's error event in the same turn.
      setImmediate(cleanup);
      if (err) reject(err); else resolve();
    };
    const fail = (message: string) => finish(new Error(message));
    const ensurePoll = () => { if (!poll) poll = setInterval(pump, 10); };
    function pump() {
      if (finished || !ready || closing || sentFin) return;
      if (ws.readyState !== WebSocket.OPEN) { fail("Relay connection closed unexpectedly"); return; }
      try {
        while (queue.length && ws.bufferedAmount < HIGH) {
          const first = queue[0];
          const part = first.subarray(0, FRAME);
          ws.send(part);
          queued -= part.byteLength;
          if (part.byteLength === first.byteLength) queue.shift();
          else queue[0] = first.subarray(part.byteLength);
        }
      } catch { fail("Relay send failed"); return; }
      if (queue.length || ws.bufferedAmount > LOW) { input.pause(); ensurePoll(); return; }
      if (poll) { clearInterval(poll); poll = undefined; }
      if (eof) {
        // FIN follows preceding bytes in the same ordered WebSocket direction.
        // Drain does not acknowledge remote application processing.
        if (ws.bufferedAmount !== 0) { ensurePoll(); return; }
        sentFin = true;
        try { ws.send(FIN); } catch { fail("Relay FIN failed"); }
      } else input.resume();
    }
    function onData(chunk: unknown) {
      if (finished || eof) return;
      if (!(chunk instanceof Uint8Array)) { fail("Input must contain bytes"); return; }
      if (queued + chunk.byteLength > MAX_PENDING) { fail("Input buffer limit exceeded"); return; }
      if (chunk.byteLength) { queue.push(chunk); queued += chunk.byteLength; }
      pump();
    }
    function onEnd() {
      if (finished || eof) return;
      eof = true;
      if (!drainTimer) drainTimer = setTimeout(() => fail("Relay drain timed out"), DRAIN_TIMEOUT);
      pump();
    }
    function acknowledgeRemoteFin() {
      if (!remoteFin || sentAck || pendingOutput !== 0 || finished) return;
      try {
        options.onRemoteEnd?.();
        sentAck = true; ws.send(FIN_ACK);
      } catch { fail("Output EOF failed"); }
    }
    function onInputError() { fail("Input stream failed"); }
    function onOutputError() { fail("Output stream failed"); }
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onInputError);
    output.on("error", onOutputError);
    setupTimer = setTimeout(() => fail("Relay setup timed out"), setupMs);
    ws.onmessage = (event) => {
      if (finished) return;
      if (!ready) {
        if (event.data !== READY) { fail("Invalid relay ready message"); return; }
        ready = true;
        if (setupTimer) clearTimeout(setupTimer);
        if (input.readableEnded) onEnd();
        pump(); return;
      }
      if (typeof event.data === "string") {
        const frame = relayControl(event.data);
        if (frame === FIN && !remoteFin) {
          remoteFin = true;
          if (!drainTimer) drainTimer = setTimeout(() => fail("FIN completion timed out"), DRAIN_TIMEOUT);
          acknowledgeRemoteFin();
        } else if (frame === FIN_ACK && sentFin && !receivedAck) receivedAck = true;
        else fail("Unexpected relay control message");
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || remoteFin) { fail("Unexpected relay message"); return; }
      const bytes = new Uint8Array(event.data);
      if (bytes.byteLength > 1024 * 1024) { fail("Relay frame limit exceeded"); return; }
      if (pendingOutput + bytes.byteLength > MAX_PENDING) { fail("Output buffer limit exceeded"); return; }
      pendingOutput += bytes.byteLength;
      try {
        output.write(bytes, (err?: Error | null) => {
          pendingOutput -= bytes.byteLength;
          if (finished && pendingOutput === 0) setImmediate(() => output.removeListener("error", onOutputError));
          if (err) { fail("Output stream failed"); return; }
          acknowledgeRemoteFin();
          if (remoteClosed && pendingOutput === 0) finish(closeError);
        });
      } catch { fail("Output stream failed"); }
    };
    ws.onerror = () => fail("Relay connection failed");
    ws.onclose = (event) => {
      if (finished) return;
      remoteClosed = true; closing = true; input.pause();
      if (!ready || (event.code !== 1000 && event.code !== 1005)) closeError = new Error("Relay connection closed unexpectedly");
      else if (!(sentFin && remoteFin && sentAck && receivedAck)) closeError = new Error("Relay closed before directional completion");
      if (pendingOutput === 0) finish(closeError);
      else if (!drainTimer) drainTimer = setTimeout(() => fail("Output drain timed out"), DRAIN_TIMEOUT);
    };
  });
}
