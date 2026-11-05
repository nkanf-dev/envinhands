/**
 * Local SSH ProxyCommand byte bridge for the relay in relay.ts (Bun runtime).
 * Pass secrets through configuration, never through a constructed shell command.
 * Use wss:// on untrusted networks. This does not perform SSH host-key checking.
 *
 * WebSocket has no TCP half-close. On input EOF we drain locally queued frames,
 * close the WebSocket normally, and reject: bytes accepted before close are
 * ordered ahead of it, but delivery or a response after EOF cannot be guaranteed.
 * In particular, this is not suitable for protocols that require a half-close.
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
      url.pathname = "/client";
      url.searchParams.set("node", options.nodeId);
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
    let remoteClosed = false;
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
      if (finished || !ready || closing) return;
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
        // bufferedAmount == 0 is necessary before starting close; the close frame
        // follows preceding data but is not a remote-application acknowledgement.
        if (ws.bufferedAmount !== 0) { ensurePoll(); return; }
        closing = true;
        try { ws.close(1000, ""); } catch { fail("Relay close failed"); }
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
      drainTimer = setTimeout(() => fail("Relay drain timed out"), DRAIN_TIMEOUT);
      pump();
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
        if (event.data !== "ready") { fail("Invalid relay ready message"); return; }
        ready = true;
        if (setupTimer) clearTimeout(setupTimer);
        if (input.readableEnded) onEnd();
        pump(); return;
      }
      if (!(event.data instanceof ArrayBuffer)) { fail("Unexpected relay message"); return; }
      const bytes = new Uint8Array(event.data);
      if (bytes.byteLength > 1024 * 1024) { fail("Relay frame limit exceeded"); return; }
      if (pendingOutput + bytes.byteLength > MAX_PENDING) { fail("Output buffer limit exceeded"); return; }
      pendingOutput += bytes.byteLength;
      try {
        output.write(bytes, (err?: Error | null) => {
          pendingOutput -= bytes.byteLength;
          if (finished && pendingOutput === 0) setImmediate(() => output.removeListener("error", onOutputError));
          if (err) { fail("Output stream failed"); return; }
          if (remoteClosed && pendingOutput === 0) finish(closeError);
        });
      } catch { fail("Output stream failed"); }
    };
    ws.onerror = () => fail("Relay connection failed");
    ws.onclose = (event) => {
      if (finished) return;
      remoteClosed = true; closing = true; input.pause();
      if (!ready || (event.code !== 1000 && event.code !== 1005)) closeError = new Error("Relay connection closed unexpectedly");
      else if (eof) closeError = new Error("Input EOF: TCP half-close is not supported; response after EOF cannot be guaranteed");
      if (pendingOutput === 0) finish(closeError);
      else if (!drainTimer) drainTimer = setTimeout(() => fail("Output drain timed out"), DRAIN_TIMEOUT);
    };
  });
}
