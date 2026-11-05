/** Authorized reverse loopback publication. Forward confirmation is not HTTP readiness. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { buildSshRouteArgv } from "./transports/ssh-routes.ts";
export interface RemotePublishOptions {
  host: string; user: string; port?: number; hostKeyAlias?: string;
  identityFile?: string; knownHostsFile?: string; jump?: string;
  localServicePort: number; remotePort: number;
}
export interface RemotePublish {
  remoteHost: string; remotePort: number; url: string;
  finished: Promise<void>; close(): Promise<void>;
}
export interface RemotePublishDependencies {
  spawn?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
  signal?: AbortSignal;
  setupTimeoutMs?: number;
}
export async function startRemotePublish(options: RemotePublishOptions, dependencies: RemotePublishDependencies = {}): Promise<RemotePublish> {
  const fields = ["host", "user", "port", "hostKeyAlias", "identityFile", "knownHostsFile", "jump", "localServicePort", "remotePort"];
  if (!options || typeof options !== "object" || Object.keys(options).some(key => !fields.includes(key)) ||
      ![options.localServicePort, options.remotePort].every(port => Number.isInteger(port) && port >= 1 && port <= 65535))
    throw new Error("Publication requires fixed valid loopback ports.");
  const timeout = dependencies.setupTimeoutMs ?? 20000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error("Invalid publication setup deadline.");
  const route = buildSshRouteArgv({id:"remote-publish", host:options.host, port:options.port, jump:options.jump},
    {user:options.user, hostKeyAlias:options.hostKeyAlias ?? options.host, identityFile:options.identityFile, knownHostsFile:options.knownHostsFile});
  if (dependencies.signal?.aborted) throw new Error("Publication cancelled.");
  const separator = route.indexOf("--");
  const args = [...route.slice(0, separator), "-N", "-v", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-R", `127.0.0.1:${options.remotePort}:127.0.0.1:${options.localServicePort}`, ...route.slice(separator)];
  const launch = dependencies.spawn ?? ((executable, argv) => spawn(executable, argv, {shell:false, stdio:["pipe", "pipe", "pipe"]}));
  const child = launch("ssh", args);
  let confirmed = false, closing = false, closePromise: Promise<void> | undefined;
  let ready!: () => void, failed!: (error: Error) => void, finished!: () => void, lost!: (error: Error) => void;
  const confirmation = new Promise<void>((resolve, reject) => {ready=resolve; failed=reject;});
  const completion = new Promise<void>((resolve, reject) => {finished=resolve; lost=reject;});
  void completion.catch(() => {}); // Caller receives finished after confirmation; early failures still have a handler.
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const failure = () => {failed(new Error("SSH publication failed; verify route, trust and remote port.")); if (confirmed) lost(new Error("SSH publication disconnected; backend state is unknown."));};
  const abort = () => {void close();};
  const cleanup = () => {clearTimeout(timer); dependencies.signal?.removeEventListener("abort", abort); child.stderr.off("data", inspect);};
  function close(): Promise<void> {
    if (!closePromise) {
      closing=true; failed(new Error("Publication stopped before confirmation.")); cleanup();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      closePromise=closed.then(() => {finished();});
    }
    return closePromise;
  }
  let line="", diagnosticBytes=0;
  const expected=`remote forward success for: listen 127.0.0.1:${options.remotePort}, connect 127.0.0.1:${options.localServicePort}`;
  const inspect = (chunk: Buffer) => {
    diagnosticBytes+=chunk.length;
    if (diagnosticBytes > 65536) {failure(); void close(); return;}
    line+=chunk.toString("utf8");
    let end: number;
    while ((end=line.indexOf("\n")) >= 0) {
      const current=line.slice(0,end).replace(/\r$/, ""); line=line.slice(end+1);
      if (current === `debug1: ${expected}`) {confirmed=true; clearTimeout(timer); child.stderr.off("data", inspect); child.stderr.resume(); ready();}
    }
    if (line.length > 8192) {failure(); void close();}
  };
  const timer=setTimeout(() => {failure(); void close();}, timeout);
  child.on("error", failure); child.stdin.on("error", failure); child.stdout.on("error", failure); child.stderr.on("error", failure);
  child.stdout.resume(); child.stderr.on("data", inspect);
  child.once("close", () => {cleanup(); if (closing) finished(); else {failure(); if (!confirmed) finished();}});
  dependencies.signal?.addEventListener("abort", abort, {once:true});
  if (dependencies.signal?.aborted) abort();
  try {await confirmation; if (closing) throw new Error("Publication cancelled.");}
  catch {await close(); throw new Error("SSH loopback publication was not established.");}
  return {remoteHost:options.host, remotePort:options.remotePort, url:`http://127.0.0.1:${options.remotePort}`, finished:completion, close};
}
