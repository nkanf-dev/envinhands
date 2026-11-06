import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createServer, isIP, type Socket } from "node:net";
import { isAbsolute } from "node:path";

/** A TCP connection is not a readiness check. SSH authentication alone does not
 * mean the remote service is available. No data is replayed after a failure. */
export interface SshStdioAccessOptions {
  host: string;
  sshPort: number;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  remotePort: number;
  localPort?: number;
  /** Trusted executable override, mainly useful for testing. */
  sshPath?: string;
  /** Trusted process runner override. */
  spawn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}

const MARKER = Buffer.from("ENVINHANDS-STDIO-1\n", "ascii");
const remoteProgram = `import os, select, socket, sys

def main():
    port = int(sys.argv[1])
    s = socket.create_connection(("127.0.0.1", port), 10)
    s.setblocking(False)
    os.write(1, b"ENVINHANDS-STDIO-1\\n")
    os.set_blocking(0, False)
    os.set_blocking(1, False)
    to_socket = bytearray()
    to_output = bytearray()
    input_open = True
    socket_open = True
    write_shutdown = False
    output_open = True
    limit = 65536
    while True:
        if not input_open and not to_socket and not write_shutdown:
            s.shutdown(socket.SHUT_WR)
            write_shutdown = True
        if not socket_open and not to_output and output_open:
            os.close(1)
            os.close(2)
            output_open = False
        if write_shutdown and not output_open:
            break
        reads = []
        writes = []
        if input_open and len(to_socket) < limit:
            reads.append(0)
        if socket_open and len(to_output) < limit:
            reads.append(s)
        if to_socket:
            writes.append(s)
        if to_output:
            writes.append(1)
        ready_r, ready_w, _ = select.select(reads, writes, [])
        if 0 in ready_r:
            data = os.read(0, limit - len(to_socket))
            if data: to_socket.extend(data)
            else: input_open = False
        if s in ready_r:
            data = s.recv(limit - len(to_output))
            if data: to_output.extend(data)
            else: socket_open = False
        if s in ready_w:
            del to_socket[:s.send(to_socket)]
        if 1 in ready_w:
            del to_output[:os.write(1, to_output)]
    s.close()

try:
    main()
except Exception:
    sys.exit(1)
`;

function port(value: unknown, allowZero = false): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65535;
}
function safePath(value: unknown): value is string {
  // OpenSSH parses -o arguments as configuration syntax. Reject whitespace,
  // quotes, percent expansions and all shell/config metacharacters, even for -i.
  return typeof value === "string" && isAbsolute(value) && /^\/[A-Za-z0-9_./-]+$/.test(value);
}
function safeHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253) return false;
  if (isIP(value)) return true;
  return value.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

/** Start a loopback-only listener. Each connection owns a fresh ssh process.
 * The listener is not an access-control boundary against other local users.
 * Caller must provide a trusted pinned known_hosts file and an unencrypted key
 * usable without prompts. Do not place passwords or other secrets in arguments.
 */
export async function startSshStdioAccess(options: SshStdioAccessOptions): Promise<{port: number; close(): Promise<void>}> {
  if (!options || !safeHost(options.host) || typeof options.user !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(options.user) ||
      !safePath(options.identityFile) || !safePath(options.knownHostsFile) ||
      !port(options.sshPort) || !port(options.remotePort) || !port(options.localPort ?? 0, true) ||
      (options.sshPath !== undefined && !safePath(options.sshPath))) throw new Error("Invalid SSH stdio access options");
  // Only the validated integer is dynamic; the program itself contains no single quote.
  const command = `/usr/bin/python3 -c '${remoteProgram}' ${options.remotePort}`;
  const args = ["-F", "/dev/null", "-T", "-p", String(options.sshPort), "-l", options.user,
    "-i", options.identityFile, "-o", `UserKnownHostsFile=${options.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=yes",
    "-o", "CheckHostIP=no", "-o", "VerifyHostKeyDNS=no", "-o", "UpdateHostKeys=no",
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
    "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no",
    "-o", "ControlPath=none", "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
    "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "LogLevel=ERROR",
    options.host, command];
  const sockets = new Set<Socket>();
  const children = new Set<ChildProcessWithoutNullStreams>();
  const childExits = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  let closing = false;
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => {
    if (closing || children.size >= 64) { socket.destroy(); return; }
    sockets.add(socket);
    let child: ChildProcessWithoutNullStreams;
    try { child = (options.spawn ?? nodeSpawn)(options.sshPath ?? "/usr/bin/ssh", args, {shell: false, stdio: ["pipe", "pipe", "pipe"]}); }
    catch { socket.destroy(); sockets.delete(socket); return; }
    children.add(child);
    childExits.set(child, new Promise(resolve => child.once("close", () => { childExits.delete(child); resolve(); })));
    let marker = Buffer.alloc(0);
    let established = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stopChild = () => {
      // A rejected handshake may leave unread stdout buffered. Destroy all pipes
      // so child close can complete even when no consumer will read them.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (!killTimer) { killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref(); }
    };
    const handshakeTimer = setTimeout(() => { socket.destroy(); stopChild(); }, 15000);
    handshakeTimer.unref();
    const fail = () => { socket.destroy(); stopChild(); };
    socket.on("error", fail);
    socket.once("close", () => { sockets.delete(socket); clearTimeout(handshakeTimer); stopChild(); });
    child.once("error", fail);
    child.stdin?.on("error", fail);
    child.stdout?.on("error", fail);
    child.stderr?.on("error", fail);
    child.stderr?.resume(); // Drain, but never log potentially sensitive remote output.
    child.once("close", code => {
      children.delete(child);
      clearTimeout(handshakeTimer);
      if (killTimer) clearTimeout(killTimer);
      if (code !== 0 || !established) socket.destroy();
    });
    if (!child.stdin || !child.stdout) { fail(); return; }
    const stdout = child.stdout;
    const stdin = child.stdin;
    const onReadable = () => {
      const chunk: Buffer | null = stdout.read(MARKER.length - marker.length);
      if (!chunk) return;
      marker = Buffer.concat([marker, chunk]);
      if (!MARKER.subarray(0, marker.length).equals(marker)) { fail(); return; }
      if (marker.length === MARKER.length) {
        established = true;
        clearTimeout(handshakeTimer);
        stdout.removeListener("readable", onReadable);
        socket.pipe(stdin);
        stdout.pipe(socket);
        socket.resume();
      }
    };
    stdout.on("readable", onReadable);
    stdout.once("end", () => { if (!established) fail(); });
  });
  // Asynchronous listener failures after startup must not crash the process.
  server.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.localPort ?? 0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Cannot start loopback listener"); }
  let closePromise: Promise<void> | undefined;
  return { port: address.port, close() {
    if (closePromise) return closePromise;
    closing = true;
    const listenerClosed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    // Child close handlers are registered before this snapshot. Socket close
    // sends SIGTERM and schedules SIGKILL for a child that does not exit.
    closePromise = Promise.all([listenerClosed, ...childExits.values()]).then(() => {});
    return closePromise;
  }};
}
