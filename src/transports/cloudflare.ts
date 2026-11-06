import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { get } from "node:http";
import { isAbsolute } from "node:path";

/** The dashboard's remotely managed tunnel must already route its HTTPS hostname
 * to the intended local HTTP service (including its WebSocket upgrade path).
 * This module does not create a tunnel, DNS, Access policy, or origin service.
 * HTTPS/WSS are Cloudflare services, not a raw SSH transport. For SSH use
 * Cloudflare Access's separately configured cloudflared access ssh client and
 * verify SSH host keys; this adapter does not implement that route.
 *
 * Install and update cloudflared separately. Its source is Apache-2.0; Cloudflare
 * services have separate terms and plan limits. Enable WebSockets on the zone.
 * Edge restarts/timeouts can end WebSockets: clients must reconnect and implement
 * their own resume semantics. Never expose an unauthenticated origin by accident.
 * Cloudflare requires DNS and outbound TCP/UDP 7844 (HTTP/2 TCP, QUIC UDP), plus
 * working TLS trust and access to Cloudflare; inspect current provider docs.
 * Public HTTPS needs a valid Cloudflare edge certificate for the configured host.
 * HTTPS origins also need a trusted origin certificate and matching name; do not
 * disable verification. HTTP on localhost has no origin TLS. An Access policy and
 * application authentication are separate from the connector token. The WAF
 * inspects the WebSocket upgrade, not subsequent messages. Argo Smart Routing is
 * incompatible with WebSockets. TLS, policies and origin routing are configured
 * by the operator in Cloudflare, not by this module.
 *
 * https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/#token
 * https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/
 * https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/
 * https://developers.cloudflare.com/network/websockets/
 * https://github.com/cloudflare/cloudflared/blob/master/LICENSE
 */
export type CloudflareSecret = { env: string } | { file: string };
export interface CloudflareOptions {
  /** Installed trusted binary path; defaults to cloudflared on PATH. */
  executable?: string;
  /** Read from this process's private environment or an owner-only regular file. */
  token: CloudflareSecret;
  /** Dedicated, unused local port. /ready is not authenticated. */
  metricsPort: number;
  /** Delay between process failures; cloudflared handles network reconnect itself. */
  restartDelayMs?: number;
}
export type CloudflareStatus = "starting" | "running" | "restarting" | "stopped";
export interface CloudflareSidecar {
  status(): CloudflareStatus;
  /** /ready indicates an edge connection, NOT authenticated end-to-end access.
   * Use an exclusively allocated port: this cannot prove which process owns it. */
  ready(): Promise<boolean>;
  /** Stops restarts and terminates the child; false means termination unconfirmed. */
  stop(): Promise<boolean>;
}

async function tokenFrom(source: CloudflareSecret): Promise<string> {
  let token: string | undefined;
  if (source && "env" in source && Object.keys(source).length === 1 &&
      typeof source.env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.env)) {
    token = process.env[source.env];
  } else if (source && "file" in source && Object.keys(source).length === 1 &&
      typeof source.file === "string" && isAbsolute(source.file) && !source.file.includes("\0")) {
    // Require O_NOFOLLOW and verify the opened inode to avoid following a symlink.
    // On Windows POSIX ownership/mode cannot be verified, so use env instead.
    if (process.platform === "win32" || !constants.O_NOFOLLOW) throw new Error("Cannot verify token file privacy");
    let f;
    try {
      f = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await f.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > 16384) {
        throw new Error();
      }
      token = (await f.readFile({ encoding: "utf8" })).trim();
    } catch { throw new Error("Cannot read private token file"); }
    finally { await f?.close(); }
  } else throw new Error("Invalid token source");
  if (typeof token !== "string" || token.length < 1 || token.length > 16384 || /[\s\0]/.test(token)) {
    throw new Error("Invalid tunnel token");
  }
  return token;
}

/**
 * Start and supervise a remotely managed tunnel. Only the token enters the child
 * environment as TUNNEL_TOKEN, never argv, logs, return values or error messages.
 * The process environment is visible to privileged/same-user process inspectors;
 * protect the account, host, token file, and local metrics port. Child output is
 * suppressed. A spawned process does not establish availability. Check ready(),
 * then perform an application-level authenticated probe through the public URL.
 */
export async function startCloudflare(options: CloudflareOptions): Promise<CloudflareSidecar> {
  if (!options || !Number.isInteger(options.metricsPort) || options.metricsPort < 1 || options.metricsPort > 65535 ||
      (options.executable !== undefined && (typeof options.executable !== "string" || !options.executable || options.executable.includes("\0"))) ||
      (options.restartDelayMs !== undefined && (!Number.isInteger(options.restartDelayMs) || options.restartDelayMs < 50 || options.restartDelayMs > 60000))) {
    throw new Error("Invalid Cloudflare options");
  }
  const token = await tokenFrom(options.token);
  // Keep the environment narrow so unrelated secrets and TUNNEL_* overrides do not
  // reach the child. HOME is deliberately omitted to avoid implicit local config.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.TUNNEL_TOKEN = token;
  let state: CloudflareStatus = "starting";
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let closeWaiters: (() => void)[] = [];
  const launch = () => {
    if (stopping) return;
    state = "starting";
    try {
      child = spawn(options.executable ?? "cloudflared", ["tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${options.metricsPort}`, "run"],
        { shell: false, stdio: "ignore", windowsHide: true, env });
      const current = child;
      current.once("spawn", () => { if (!stopping && child === current) state = "running"; });
      current.on("error", () => { /* Details may contain secrets; close follows spawn failure. */ });
      current.once("close", () => {
        if (child !== current) return;
        child = undefined;
        for (const done of closeWaiters.splice(0)) done();
        if (stopping) { state = "stopped"; return; }
        state = "restarting";
        timer = setTimeout(launch, options.restartDelayMs ?? 1000);
      });
    } catch {
      state = "restarting";
      timer = setTimeout(launch, options.restartDelayMs ?? 1000);
    }
  };
  launch();
  return {
    status: () => state,
    async ready() {
      if (state !== "running") return false;
      const observed = child;
      return new Promise<boolean>((resolve) => {
        const req = get({ hostname: "127.0.0.1", port: options.metricsPort, path: "/ready", timeout: 1500, agent: false }, (res) => {
          const ok = res.statusCode === 200;
          res.resume();
          resolve(ok && !stopping && state === "running" && child === observed);
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(false));
      });
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (!child) { state = "stopped"; return true; }
      const current = child;
      const closed = new Promise<boolean>((resolve) => closeWaiters.push(() => resolve(true)));
      try { current.kill("SIGTERM"); } catch { /* report only whether close was seen */ }
      const expired = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => { try { current.kill("SIGKILL"); } catch {} resolve(false); }, 2000);
        void closed.then(() => clearTimeout(t));
      });
      return Promise.race([closed, expired]);
    },
  };
}

/** Build client endpoints only from a caller-configured HTTPS URL. Keep application
 * authentication and Cloudflare Access in the actual HTTP/WebSocket client. No
 * redirect following or credential handling is performed by this helper. */
export function cloudflareClientEndpoints(httpsUrl: string): { http: string; websocket: string } {
  let u: URL;
  try { u = new URL(httpsUrl); } catch { throw new Error("Invalid Cloudflare endpoint"); }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.hash) throw new Error("Invalid Cloudflare endpoint");
  const http = u.toString();
  u.protocol = "wss:";
  return { http, websocket: u.toString() };
}
