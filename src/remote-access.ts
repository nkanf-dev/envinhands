/** Loopback HTTP access through an already authorized, strictly verified SSH route. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { buildSshRouteArgv } from "./transports/ssh-routes.ts";

export interface RemoteAccessOptions {
  host: string;
  user: string;
  port?: number;
  hostKeyAlias?: string;
  identityFile?: string;
  knownHostsFile?: string;
  jump?: string;
  /** Fixed local loopback port for stable client references; default0 selects a random port. */
  localPort?: number;
  destinationHost: "127.0.0.1";
  destinationPort: number;
}
export interface RemoteAccess {
  url: string;
  port: number;
  close(): Promise<void>;
}
export interface RemoteAccessDependencies {
  spawn?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
}
/** Listening is ready on return. It is not proof that SSH or the destination service is ready. */
export async function startRemoteAccess(options: RemoteAccessOptions, dependencies: RemoteAccessDependencies = {}): Promise<RemoteAccess> {
  if (!Number.isInteger(options.localPort ?? 0) || (options.localPort ?? 0) < 0 || (options.localPort ?? 0) > 65535) throw new Error("Invalid local access port.");
  if (options.destinationHost !== "127.0.0.1" || !Number.isInteger(options.destinationPort) || options.destinationPort < 1 || options.destinationPort > 65535)
    throw new Error("Remote access requires a loopback destination and valid port.");
  const routeArgs = buildSshRouteArgv({ id: "remote-access", host: options.host, port: options.port, jump: options.jump },
    { user: options.user, hostKeyAlias: options.hostKeyAlias ?? options.host, identityFile: options.identityFile, knownHostsFile: options.knownHostsFile });
  // -n would discard the forwarded input. -W must precede -- and the SSH host.
  const separator = routeArgs.indexOf("--");
  const args = [...routeArgs.slice(0, separator).filter(arg => arg !== "-n"), "-W", `${options.destinationHost}:${options.destinationPort}`, ...routeArgs.slice(separator)];
  const launch = dependencies.spawn ?? ((executable, argv) => spawn(executable, argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] }));
  const sockets = new Set<Socket>(), children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    let child: ChildProcessWithoutNullStreams;
    try { child = launch("ssh", args); }
    catch { socket.destroy(); sockets.delete(socket); return; }
    const closed = new Promise<void>(resolve => child.once("close", () => { children.delete(child); resolve(); }));
    children.set(child, closed);
    const fail = () => socket.destroy();
    child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail);
    child.stderr.resume(); // SSH diagnostics can contain local metadata; never mix them into HTTP or log secrets.
    socket.on("error", () => {});
    socket.once("close", () => { sockets.delete(socket); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    child.once("close", code => { if (code !== 0) socket.destroy(); else socket.end(); });
    socket.pipe(child.stdin); child.stdout.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed); server.once("listening", ready); server.listen(options.localPort ?? 0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Remote access listener did not provide a TCP port.");
  return { url: `http://127.0.0.1:${address.port}`, port: address.port,
    close() {
      if (!closing) closing = (async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
        const exits = [...children.values()];
        for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await Promise.all([stopped, ...exits]);
      })();
      return closing;
    },
  };
}
