import { spawn } from "node:child_process";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

/** An existing, compatible frpc executable and a pre-provisioned frps are required.
 * The remote port is a TCP listener on frps; protect it with SSH authentication
 * and network controls. A token authenticates frpc to frps, not SSH users. */
export interface FrpClientOptions {
  executable?: string;
  serverAddress: string;
  serverPort: number;
  token: string;
  proxyName: string;
  remotePort: number;
  localPort?: number; // defaults to local SSH on 127.0.0.1:22
  /** Configure a trusted CA and server name to authenticate the TLS server. */
  tlsTrustedCaFile?: string;
  tlsServerName?: string;
}
export type FrpOutcome = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "error" };
export interface FrpProbeOptions {
  host: string;
  port: number;
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
}
export interface FrpClient {
  /** First process error or exit. An error is not proof of process termination. */
  readonly outcome: Promise<FrpOutcome>;
  /** Resolves after OS close and private config removal; rejects if removal fails. */
  readonly closed: Promise<void>;
  readonly state: "running" | "error" | "exited";
  /** A successful TCP connect only, not proof of SSH identity or proxy ownership. */
  probe(options: FrpProbeOptions): Promise<boolean>;
  /** SIGTERM, then SIGKILL after grace; rejects if termination/cleanup is unconfirmed. */
  stop(graceMs?: number): Promise<void>;
}

const validPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;
const validText = (x: unknown): x is string => typeof x === "string" && x.length > 0 && !/[\x00-\x1f\x7f]/.test(x);
const bounded = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
const str = (s: string) => JSON.stringify(s); // JSON basic strings are valid TOML for these validated values.

function validate(o: FrpClientOptions): void {
  if (!o || !validText(o.serverAddress) || !validPort(o.serverPort) || !validText(o.token) ||
      !validText(o.proxyName) || !validPort(o.remotePort) || !validPort(o.localPort ?? 22) ||
      (o.executable !== undefined && !validText(o.executable)) ||
      (o.tlsTrustedCaFile !== undefined && !validText(o.tlsTrustedCaFile)) ||
      (o.tlsServerName !== undefined && !validText(o.tlsServerName))) throw new Error("Invalid FRP client options");
  if (!!o.tlsTrustedCaFile !== !!o.tlsServerName) throw new Error("FRP TLS CA and server name must be provided together");
}

/** Start outbound frpc. Spawn success is NOT tunnel readiness. frpc output and
 * native errors are suppressed to avoid leaking credentials. Without a trusted
 * CA and server name the FRP TLS peer is not authenticated; use trusted networks
 * or configure both. Only the local loopback service can be forwarded. */
export async function startFrpClient(o: FrpClientOptions): Promise<FrpClient> {
  validate(o);
  // POSIX modes cannot establish private ACLs on Windows. Fail closed.
  if (process.platform === "win32") throw new Error("FRP private configuration requires POSIX permissions");
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "envinhands-frp-"));
    await chmod(dir, 0o700);
    const path = join(dir, "frpc.toml");
    const config = `serverAddr = ${str(o.serverAddress)}
serverPort = ${o.serverPort}
loginFailExit = false
auth.method = "token"
auth.token = ${str(o.token)}
transport.tls.enable = true
` +
      (o.tlsTrustedCaFile ? `transport.tls.trustedCaFile = ${str(o.tlsTrustedCaFile)}
transport.tls.serverName = ${str(o.tlsServerName!)}
` : "") +
      `[[proxies]]
name = ${str(o.proxyName)}
type = "tcp"
localIP = "127.0.0.1"
localPort = ${o.localPort ?? 22}
remotePort = ${o.remotePort}
`;
    await writeFile(path, config, { mode: 0o600, flag: "wx" });
    const child = spawn(o.executable ?? "frpc", ["-c", path], { shell: false, stdio: "ignore", windowsHide: true });
    let state: FrpClient["state"] = "running";
    let resolveOutcome!: (outcome: FrpOutcome) => void;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const outcome = new Promise<FrpOutcome>(r => { resolveOutcome = r; });
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    // Suppress an unhandled rejection if cleanup fails before the caller awaits closed.
    void closed.catch(() => {});
    let settled = false;
    const finish = (result: FrpOutcome) => { if (!settled) { settled = true; resolveOutcome(result); } };
    let started = false;
    let rejectStart!: (error: Error) => void;
    let resolveStart!: () => void;
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    child.once("spawn", () => { started = true; resolveStart(); });
    child.on("error", () => {
      state = "error"; finish({ kind: "error" });
      if (!started) rejectStart(new Error("Failed to start FRP client"));
      else { try { child.kill("SIGTERM"); } catch { /* Never expose OS errors. */ } }
    });
    child.once("exit", (code, signal) => {
      if (state !== "error") state = "exited";
      finish({ kind: "exit", code, signal });
      if (!started) rejectStart(new Error("Failed to start FRP client"));
    });
    const ownedDir = dir;
    child.once("close", () => {
      void rm(ownedDir, { recursive: true, force: true }).then(resolveClosed, () => rejectClosed(new Error("Failed to remove FRP private configuration")));
    });
    try { await start; } catch { await closed.catch(() => {}); throw new Error("Failed to start FRP client"); }
    // Child owns the configuration from here until close.
    dir = undefined;
    return {
      outcome, closed,
      get state() { return state; },
      async probe(p) {
        const attempts = p?.attempts ?? 1, interval = p?.intervalMs ?? 200, timeout = p?.timeoutMs ?? 1000;
        if (!p || !validText(p.host) || !validPort(p.port) || !bounded(attempts, 1, 100) ||
            !bounded(interval, 0, 30000) || !bounded(timeout, 1, 30000)) throw new Error("Invalid FRP probe options");
        for (let i = 0; i < attempts && state === "running"; i++) {
          const ok = await tcpProbe(p.host, p.port, timeout);
          if (ok && state === "running") return true;
          if (i + 1 < attempts && state === "running") await delayUnlessExited(interval, outcome);
        }
        return false;
      },
      async stop(graceMs = 2000) {
        if (!bounded(graceMs, 0, 30000)) throw new Error("Invalid FRP stop timeout");
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGTERM"); } catch { /* Test termination below. */ }
          if (!(await within(closed, graceMs))) {
            try { child.kill("SIGKILL"); } catch { /* Test termination below. */ }
            if (!(await within(closed, 2000))) throw new Error("FRP client termination unconfirmed");
          }
        } else await closed;
      },
    };
  } catch {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error("Failed to start FRP client");
  }
}

function tcpProbe(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
function within(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(() => { clearTimeout(timer); resolve(true); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Starts a client and waits for a bounded number of TCP probes. On failure the
 * client is stopped before rejecting. TCP reachability alone is not SSH readiness
 * or authenticated identity; callers must perform their own SSH verification. */
export async function startFrpClientReady(options: FrpClientOptions, probe: FrpProbeOptions): Promise<FrpClient> {
  const client = await startFrpClient(options);
  try {
    if (await client.probe(probe)) return client;
    throw new Error("FRP TCP probe did not become ready");
  } catch (error) {
    await client.stop();
    throw error;
  }
}

function delayUnlessExited(ms: number, outcome: Promise<FrpOutcome>): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    void outcome.then(() => { clearTimeout(timer); resolve(); });
  });
}
