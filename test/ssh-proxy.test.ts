import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { createRelayServer, startNodeClient } from "../src/relay";
import { startSshProxy } from "../src/ssh-proxy";

const secret = "local-proxy-test-secret";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function withTimeout<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}

function startRelay() {
  const relay = createRelayServer({ secret, setupTimeoutMs: 1000 });
  cleanup.push(() => relay.stop());
  return `ws://127.0.0.1:${relay.port}`;
}

async function startNode(base: string, port: number) {
  const node = startNodeClient({ relayUrl: base, nodeId: "local", secret, sshPort: port });
  cleanup.push(() => node.close());
  await withTimeout(node.ready, "node registration");
}

function streams() {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  let notify: (() => void) | undefined;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      notify?.();
      callback();
    },
  });
  cleanup.push(() => { input.destroy(); output.destroy(); });
  return {
    input, output,
    async received(size: number) {
      await withTimeout(new Promise<void>((resolve) => {
        notify = () => { if (chunks.reduce((n, c) => n + c.length, 0) >= size) resolve(); };
        notify();
      }), "proxy output");
      return Buffer.concat(chunks);
    },
  };
}

describe("SSH stdio proxy integration", () => {
  test("bridges arbitrary binary and a server-first banner through relay and node", async () => {
    const banner = Buffer.from([83, 83, 72, 0, 255, 13, 10]);
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { socket.write(banner); },
      data(socket, data) { socket.write(data); },
      end(socket) { socket.shutdown(); }, error() {},
    } });
    cleanup.push(() => tcp.stop(true));
    const base = startRelay();
    await startNode(base, tcp.port);
    const io = streams();
    const proxy = startSshProxy({ relayUrl: base, nodeId: "local", secret, input: io.input, output: io.output });
    // Observe rejection even if an assertion fails before the proxy ends.
    const result = proxy.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    expect(await io.received(banner.length)).toEqual(banner);
    const payload = Buffer.from([0, 255, 128, 13, 10, 1, 0, 42, 254]);
    io.input.write(payload);
    expect(await io.received(banner.length + payload.length)).toEqual(Buffer.concat([banner, payload]));
    io.input.end();
    expect((await withTimeout(result, "EOF")).error).toBeUndefined();
  });

  test("drains 1 MiB to a slow TCP receiver before input EOF", async () => {
    const expected = Buffer.from(Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 131 + (i >>> 8)) % 256));
    const chunks: Buffer[] = [];
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { socket.pause(); setTimeout(() => socket.resume(), 200); },
      data(_socket, data) { chunks.push(Buffer.from(data)); },
      close() { end(); },
      error() { end(); },
    } });
    cleanup.push(() => tcp.stop(true));
    const base = startRelay();
    await startNode(base, tcp.port);
    const io = streams();
    const proxy = startSshProxy({ relayUrl: base, nodeId: "local", secret, input: io.input, output: io.output });
    const result = proxy.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    // EOF can arrive before WebSocket readiness; bytes must not be discarded.
    io.input.end(expected);
    const settled = await withTimeout(result, "input EOF");
    expect(settled.error).toBeUndefined();
    await withTimeout(ended, "TCP FIN after drain");
    expect(Buffer.concat(chunks)).toEqual(expected);
  }, 10000);

  test("rejects authentication failure and a missing node", async () => {
    const base = startRelay();
    for (const options of [
      { nodeId: "local", secret: "wrong" },
      { nodeId: "missing", secret },
    ]) {
      const io = streams();
      const result = startSshProxy({ relayUrl: base, ...options, input: io.input, output: io.output, setupTimeoutMs: 1000 })
        .then(() => undefined, (error: unknown) => error);
      const error = await withTimeout(result, "failed setup");
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(options.secret);
    }
  });

  test("settles when the remote TCP side closes", async () => {
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { setTimeout(() => socket.end(), 50); },
      data() {}, error() {},
    } });
    cleanup.push(() => tcp.stop(true));
    const base = startRelay();
    await startNode(base, tcp.port);
    const io = streams();
    const proxy = startSshProxy({ relayUrl: base, nodeId: "local", secret, input: io.input, output: io.output, onRemoteEnd: () => io.input.end() });
    const result = proxy.then(() => "resolved", () => "rejected");
    expect(["resolved", "rejected"]).toContain(await withTimeout(result, "remote close"));
  });
});


test("half-close returns the complete response produced only after request EOF", async () => {
  const request = Buffer.alloc(1024 * 1024, 37), response = Buffer.alloc(1024 * 1024, 91), chunks: Buffer[] = [];
  let sawEof = false, sent = 0;
  const pump = (s: Bun.Socket) => {
    while (sent < response.length) { const written = s.write(response.subarray(sent)); if (written <= 0) return; sent += written; }
    s.shutdown();
  };
  const tcp = Bun.listen({hostname:"127.0.0.1",port:0,allowHalfOpen:true,socket:{
    data(_s,b){chunks.push(Buffer.from(b));},
    end(s){sawEof=true;expect(Buffer.concat(chunks)).toEqual(request);pump(s);},
    drain(s){if(sawEof && sent < response.length)pump(s);},error(){}
  }});
  cleanup.push(()=>tcp.stop(true));const base=startRelay();await startNode(base,tcp.port);
  const input = new PassThrough(), received: Buffer[] = [];
  const output = new Writable({highWaterMark:1024,write(chunk:Buffer,_encoding,callback){received.push(Buffer.from(chunk));setImmediate(callback);}});
  cleanup.push(()=>{input.destroy();output.destroy();});
  const io={input,output};
  const result=startSshProxy({relayUrl:base,nodeId:"local",secret,input:io.input,output:io.output});
  const settled=result.then(()=>true,()=>false);io.input.end(request);
  expect(await withTimeout(settled,"bidirectional FIN")).toBe(true);
  expect(Buffer.concat(received)).toEqual(response);expect(sawEof).toBe(true);expect(sent).toBe(response.length);
  expect(io.output.writableEnded).toBe(false);
});

test("remote FIN keeps the request direction open until the caller sends its final bytes", async()=>{
  const response=Buffer.from("server finished writing"),tail=Buffer.from("client sends after remote FIN");const chunks:Buffer[]=[];
  let resolveEnd!:()=>void;const ended=new Promise<void>(r=>resolveEnd=r);
  const tcp=Bun.listen({hostname:"127.0.0.1",port:0,allowHalfOpen:true,socket:{open(s){s.write(response);s.shutdown();},data(_s,b){chunks.push(Buffer.from(b));},end(){resolveEnd();},close(){resolveEnd();},error(){}}});
  cleanup.push(()=>tcp.stop(true));const base=startRelay();await startNode(base,tcp.port);const io=streams();let callbacks=0;
  const result=startSshProxy({relayUrl:base,nodeId:"local",secret,input:io.input,output:io.output,
    onRemoteEnd(){callbacks++;io.input.end(tail);}});
  const settled=result.then(()=>true,()=>false);
  expect(await io.received(response.length)).toEqual(response);expect(await withTimeout(settled,"remote FIN then local FIN")).toBe(true);
  await withTimeout(ended,"server received final client EOF");expect(Buffer.concat(chunks)).toEqual(tail);expect(callbacks).toBe(1);
});


test("v2 proxy refuses a legacy ready marker rather than silently falling back",async()=>{
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request,host){return host.upgrade(request)?undefined:new Response("upgrade required",{status:400});},websocket:{open(ws){ws.send("ready");},message(){}}});
 const input=new PassThrough(),output=new PassThrough();
 try{const result=startSshProxy({relayUrl:`ws://127.0.0.1:${server.port}`,nodeId:"legacy",secret,input,output});
  await expect(result).rejects.toThrow("Invalid relay ready message");
 }finally{input.destroy();output.destroy();server.stop(true);}
});
