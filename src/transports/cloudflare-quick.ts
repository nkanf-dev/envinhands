import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Quick tunnels are an explicitly opted-in, temporary, public HTTP/WebSocket
 * ingress. Anyone who learns the hostname can access the origin. They have no
 * built-in application authentication, no stable hostname or uptime guarantee,
 * and are for development/testing rather than production. Cloudflare service
 * terms and limits apply. Never publish a sensitive/unauthenticated service.
 * See https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
 * and https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/
 *
 * This module is not started by server or on import. The caller must explicitly
 * consent and supply a loopback HTTP port. Install a trusted cloudflared binary
 * separately. Edge connection failures and restarts change the address; consumers
 * must observe status and re-discover it. No request or WebSocket is replayed.
 */
export type QuickTunnelEvent = "starting" | "url-assigned" | "exited" | "restart-scheduled" | "stopping" | "stopped" | "spawn-error";
export interface QuickTunnelOptions {
  /** Explicit acknowledgement that this publicly exposes the specified origin. */
  exposePublicly: true;
  localPort: number;
  executable?: string;
  restartDelayMs?: number;
  /** Categorical lifecycle events only; no process output, URL, or credentials. */
  onEvent?: (event: QuickTunnelEvent) => void;
}
export interface QuickTunnel {
  /** An assigned URL is not evidence of end-to-end readiness. */
  snapshot(): { state: "starting" | "assigned" | "restarting" | "stopping" | "stopped"; url: string | null; generation: number };
  /** Terminate the current process and prevent future restarts. Idempotent. */
  stop(): Promise<void>;
}

export async function startCloudflareQuick(o: QuickTunnelOptions): Promise<QuickTunnel> {
  if (!o || o.exposePublicly !== true || !Number.isInteger(o.localPort) || o.localPort < 1 || o.localPort > 65535 ||
      (o.executable !== undefined && (typeof o.executable !== "string" || !o.executable || /[\x00-\x1f\x7f]/.test(o.executable))) ||
      (o.restartDelayMs !== undefined && (!Number.isInteger(o.restartDelayMs) || o.restartDelayMs < 50 || o.restartDelayMs > 60000)) ||
      (o.onEvent !== undefined && typeof o.onEvent !== "function")) throw new Error("Invalid quick tunnel options");
  const dir = await mkdtemp(join(tmpdir(), "envinhands-quick-"));
  const config = join(dir, "empty.yml");
  try { await writeFile(config, "{}\n", { mode: 0o600, flag: "wx" }); }
  catch { await rm(dir, { recursive: true, force: true }); throw new Error("Failed to initialize quick tunnel"); }
  // Do not inherit HOME, Cloudflare token/overrides, proxy credentials, or arbitrary secrets.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[key]) env[key] = process.env[key];
  env.HOME = dir;
  let state: ReturnType<QuickTunnel["snapshot"]>["state"] = "starting";
  let url: string | null = null;
  let generation = 0;
  let child: ChildProcess | undefined;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let childClosed: Promise<void> = Promise.resolve();
  const emit = (event: QuickTunnelEvent) => { try { o.onEvent?.(event); } catch { /* observers cannot affect process cleanup */ } };
  const launch = () => {
    if (stopped) return;
    state = "starting"; url = null; generation++; emit("starting");
    if (stopped) return;
    try {
      const current = spawn(o.executable ?? "cloudflared", ["--config", config, "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "--url", `http://127.0.0.1:${o.localPort}`],
        { cwd: dir, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child = current;
      let resolveClosed!: () => void;
      childClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
      let buffer = "";
      const parse = (chunk: Buffer) => {
        if (stopped || current !== child || url) return;
        buffer = (buffer + chunk.toString("utf8")).slice(-8192);
        // Parse only complete lines, never an incomplete hostname at a chunk boundary.
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          const found = line.match(/https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?=[\s|\x1b]|$)/i);
          if (found) { url = found[0].toLowerCase(); state = "assigned"; emit("url-assigned"); break; }
        }
      };
      current.stdout?.on("data", parse); current.stderr?.on("data", parse);
      current.on("error", () => emit("spawn-error"));
      current.once("close", () => {
        resolveClosed();
        if (child !== current) return;
        child = undefined; url = null; emit("exited");
        if (stopped) return;
        state = "restarting"; emit("restart-scheduled");
        restart = setTimeout(launch, o.restartDelayMs ?? 1000);
      });
    } catch {
      emit("spawn-error"); state = "restarting"; emit("restart-scheduled");
      restart = setTimeout(launch, o.restartDelayMs ?? 1000);
    }
  };
  launch();
  return {
    snapshot: () => ({ state, url, generation }),
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true; state = "stopping"; url = null; emit("stopping");
      if (restart) clearTimeout(restart);
      const current = child; const closed = childClosed;
      stopPromise = (async () => {
        if (current) {
          try { current.kill("SIGTERM"); } catch { /* verify close below */ }
          if (!await within(closed, 2000)) {
            try { current.kill("SIGKILL"); } catch { /* verify close below */ }
            if (!await within(closed, 2000)) throw new Error("Quick tunnel termination unconfirmed");
          }
        }
        await rm(dir, { recursive: true, force: true });
        state = "stopped"; emit("stopped");
      })();
      return stopPromise;
    },
  };
}
function within(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}
