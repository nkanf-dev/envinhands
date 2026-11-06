import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSshStdioAccess } from "../src/ssh-stdio-access.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function timeout<T>(promise: Promise<T>, what: string, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener address");
  return address.port;
}

function connection(port: number): Socket {
  const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  socket.on("error", () => {});
  cleanups.push(() => { socket.destroy(); });
  return socket;
}

const base = { host: "nas.example", sshPort: 20415, user: "agent", identityFile: "/tmp/id-test", knownHostsFile: "/tmp/known-hosts-test", remotePort: 12345 };

async function fakeSsh() {
  const dir = await mkdtemp(join(tmpdir(), "ssh-stdio-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "fake-ssh"), log = join(dir, "args.jsonl");
  // OpenSSH passes a remote command as a shell command. Execute it locally so this
  // checks the actual remote Python bridge, not just a simulated byte pump.
  await writeFile(path, `#!/usr/bin/env python3
import json, os, sys
with open(${JSON.stringify(log)}, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
idx = next(i for i, a in enumerate(args) if a == "nas.example" or a == "agent@nas.example")
command = " ".join(args[idx + 1:])
os.execl("/bin/sh", "sh", "-c", command)
`, { mode: 0o755 });
  return { path, log };
}

describe("SSH stdio access", () => {
  test("runs the remote bridge over stdio and preserves 1 MiB in both directions across a half-close", async () => {
    const request = Buffer.from(Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 131 + (i >>> 8)) % 256));
    const response = Buffer.from(Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 37 + (i >>> 9)) % 256));
    const received: Buffer[] = [];
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const target = createServer({ allowHalfOpen: true }, socket => {
      socket.on("error", () => {});
      socket.pause(); setTimeout(() => socket.resume(), 100);
      socket.on("data", chunk => received.push(Buffer.from(chunk)));
      socket.on("end", () => { socket.end(response); finish(); });
    });
    const remotePort = await listen(target);
    const fake = await fakeSsh();
    const access = await startSshStdioAccess({ ...base, remotePort, sshPath: fake.path });
    cleanups.push(() => access.close());
    expect(access.port).toBeGreaterThan(0);
    const client = connection(access.port), chunks: Buffer[] = [];
    client.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const ended = once(client, "end");
    client.end(request);
    await timeout(Promise.all([finished, ended]), "remote request and response EOF");
    expect(Buffer.concat(received)).toEqual(request);
    expect(Buffer.concat(chunks)).toEqual(response);
    const calls = (await readFile(fake.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args).not.toContain("-n");
    expect(args).not.toContain("-W");
    expect(args).not.toContain("-L");
    expect(args.join(" ")).toContain("20415");
    expect(args.join(" ")).toContain("StrictHostKeyChecking=yes");
    expect(args.join(" ")).toContain(base.identityFile);
    expect(args.join(" ")).toContain(base.knownHostsFile);
  }, 15000);

  test("rejects invalid ports and unsafe SSH destinations before listening", async () => {
    for (const overrides of [
      { sshPort: 0 }, { sshPort: 65536 }, { sshPort: 1.5 },
      { remotePort: 0 }, { remotePort: 65536 }, { remotePort: 1.5 },
      { localPort: -1 }, { localPort: 65536 }, { localPort: 1.5 },
      { host: "-oProxyCommand=evil" }, { host: "nas.example;touch /tmp/pwned" },
      { host: "nas.example$(id)" }, { user: "-bad" }, { user: "agent;id" },
      { identityFile: "/tmp/key -oProxyCommand=evil" }, { identityFile: "/tmp/key\nHost *" },
      { identityFile: "/tmp/key$(id)" }, { knownHostsFile: '/tmp/hosts" ProxyCommand=evil' },
      { knownHostsFile: "/tmp/hosts%h" }, { knownHostsFile: "/tmp/hosts;id" },
    ]) {
      await expect(startSshStdioAccess({ ...base, ...overrides })).rejects.toThrow();
    }
  });

  test("close terminates active SSH children, closes clients, is idempotent, and frees its port", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let started!: () => void;
    const childStarted = new Promise<void>(resolve => { started = resolve; });
    const access = await startSshStdioAccess({ ...base, spawn: () => {
      child = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"] });
      child.once("spawn", started);
      return child;
    } });
    cleanups.push(() => access.close());
    const client = connection(access.port);
    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    client.write("trigger");
    await timeout(childStarted, "SSH process start");
    await timeout(access.close(), "access close");
    await timeout(closed, "client close");
    expect(child && (child.exitCode !== null || child.signalCode !== null)).toBe(true);
    await access.close();
    const restarted = await startSshStdioAccess({ ...base, localPort: access.port });
    cleanups.push(() => restarted.close());
    expect(restarted.port).toBe(access.port);
  }, 10000);

  test("client TCP reset terminates its owned SSH child", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const access = await startSshStdioAccess({ ...base, spawn: () => {
      child = spawn(process.execPath, ["-e", "process.stdout.write('ENVINHANDS-STDIO-1\\nready'); setInterval(() => {}, 1000)"],
        { stdio: ["pipe", "pipe", "pipe"] });
      child.once("close", resolveExit);
      return child;
    } });
    cleanups.push(() => access.close());
    const client = connection(access.port);
    const data = once(client, "data");
    client.write("trigger");
    const [chunk] = await timeout(data, "SSH child ready");
    expect(Buffer.from(chunk).toString()).toBe("ready");
    client.resetAndDestroy();
    await timeout(exited, "SSH child exits after client TCP reset");
    expect(child && (child.exitCode !== null || child.signalCode !== null)).toBe(true);
  }, 10000);

  test("spawn failure closes the client and does not prevent shutdown", async () => {
    const access = await startSshStdioAccess({ ...base, sshPath: "/definitely/not/a/real/ssh" });
    cleanups.push(() => access.close());
    const client = connection(access.port);
    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    client.write("trigger");
    await timeout(closed, "failed SSH connection");
    await timeout(access.close(), "shutdown after spawn failure");
  }, 10000);

  test("refused remote service closes the client without forwarding diagnostics", async () => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No reservation address");
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const fake = await fakeSsh();
    const access = await startSshStdioAccess({ ...base, remotePort: address.port, sshPath: fake.path });
    cleanups.push(() => access.close());
    const client = connection(access.port), chunks: Buffer[] = [];
    client.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    client.write("request");
    await timeout(closed, "remote connection refused");
    expect(Buffer.concat(chunks).length).toBe(0);
    await timeout(access.close(), "shutdown after remote refusal");
  }, 10000);

  test("remote write FIN leaves request direction open for final client bytes", async () => {
    const banner = Buffer.from("server-finished-sending"), tail = Buffer.from("client-after-server-fin");
    const chunks: Buffer[] = [];
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const target = createServer({ allowHalfOpen: true }, socket => {
      socket.on("error", () => {});
      socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
      socket.on("end", finish);
      socket.end(banner);
    });
    const remotePort = await listen(target);
    const fake = await fakeSsh();
    const access = await startSshStdioAccess({ ...base, remotePort, sshPath: fake.path });
    cleanups.push(() => access.close());
    const client = connection(access.port), received: Buffer[] = [];
    client.on("data", chunk => received.push(Buffer.from(chunk)));
    const serverEnd = once(client, "end");
    // Send a byte to trigger Bun's paused server connection handling.
    client.write(Buffer.from("initial"));
    await timeout(serverEnd, "remote write FIN");
    expect(Buffer.concat(received)).toEqual(banner);
    client.end(tail);
    await timeout(finished, "client FIN after remote FIN");
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.from("initial"), tail]));
  }, 10000);

  test("rejects invalid SSH handshake without leaking output into the client stream", async () => {
    const access = await startSshStdioAccess({ ...base, spawn: () => spawn(process.execPath,
      ["-e", "process.stdout.write('bad-handshake-and-sensitive-output'); setInterval(() => {}, 1000)"],
      { stdio: ["pipe", "pipe", "pipe"] }) });
    cleanups.push(() => access.close());
    const client = connection(access.port), chunks: Buffer[] = [];
    client.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    client.write("request");
    await timeout(closed, "invalid handshake");
    expect(Buffer.concat(chunks).length).toBe(0);
  }, 10000);

  test("fails to bind an occupied local port", async () => {
    const server = createServer();
    const port = await listen(server);
    await expect(startSshStdioAccess({ ...base, localPort: port })).rejects.toThrow();
  });
});
