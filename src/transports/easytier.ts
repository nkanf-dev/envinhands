/** EasyTier v2.6.4 sidecar. Install the binary and prepare its TOML separately. */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isAbsolute } from "node:path";
import { buildSshRouteArgv, type SshAccess } from "./ssh-routes.ts";
import { runCommand, type CommandRunner } from "../readiness.ts";

export interface EasyTierOptions {
  /** Existing private TOML containing fixed [network_identity] network_name and network_secret.
   * Its pathname is visible in argv: never put credentials in the pathname. */
  configPath: string;
  /** Installed binary, or absolute binary path. Do not include secrets in its path. */
  binary?: string;
}
export type EasyTierRunner = (command: string, args: string[], options: {
  shell: false; stdio: "ignore"; windowsHide: true; env: NodeJS.ProcessEnv;
}) => ChildProcess;
export type EasyTierExit = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "error" };
export interface EasyTierTarget {
  /** OS interface created by this EasyTier node. */
  interfaceName: string;
  /** This interface's IPv4 address and the peer's EasyTier IPv4 address. */
  localIp: string;
  remoteIp: string;
  port?: number;
  access: SshAccess;
}
export interface EasyTierProcess {
  exited: Promise<EasyTierExit>;
  stop(): boolean;
  /** Verify OS route and perform authenticated, strict-host-key SSH `true`.
   * Only a point-in-time observation, not a promise about future traffic. */
  probeSsh(target: EasyTierTarget, timeoutMs?: number): Promise<{ status: "healthy" | "failed"; argv?: string[] }>;
}
type ProbeDependencies = {
  route?: (remote: string, local: string, iface: string) => Promise<boolean>;
  ssh?: CommandRunner;
};
const defaultRunner: EasyTierRunner = (command, args, options) => spawn(command, args, options);

/** No shell, secrets or third-party output in errors. Bound output and time. */
async function routeMatches(remote: string, local: string, iface: string): Promise<boolean> {
  if (process.platform !== "linux") return false; // macOS and Windows route checks are not implemented.
  if (!networkInterfaces()[iface]?.some(x => x.family === "IPv4" && x.address === local)) return false;
  return new Promise(resolve => {
    execFile("ip", ["-j", "route", "get", remote, "from", local],
      { timeout: 3000, maxBuffer: 16384, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(false);
        try {
          const routes: unknown = JSON.parse(stdout);
          if (!Array.isArray(routes) || routes.length !== 1) return resolve(false);
          const route = routes[0];
          resolve(route && typeof route === "object" && route.dev === iface &&
            !route.gateway && (!route.type || route.type === "unicast"));
        } catch { resolve(false); }
      });
  });
}

/**
 * Spawn only: not evidence of a working VPN. TOML must be fully configured by
 * the caller, including stable network credentials, peers and TUN settings.
 * No configuration is generated, copied, printed or modified. On POSIX the
 * file must be owned by the current user, regular, non-symlink, mode 0600 or
 * stricter. Parent directories and replacement races remain caller's responsibility.
 * Windows is rejected because POSIX mode checks cannot verify Windows ACLs.
 * EasyTier prints configuration including secrets: both output streams are discarded.
 */
export async function startEasyTier(options: EasyTierOptions, runner: EasyTierRunner = defaultRunner,
  dependencies: ProbeDependencies = {}): Promise<EasyTierProcess> {
  if (!options || typeof options.configPath !== "string" || !isAbsolute(options.configPath) ||
      /[\x00-\x1f\x7f]/.test(options.configPath) ||
      (options.binary !== undefined && (typeof options.binary !== "string" ||
       (options.binary !== "easytier-core" && !isAbsolute(options.binary)) || /[\x00-\x1f\x7f]/.test(options.binary))))
    throw new Error("Invalid EasyTier options");
  if (process.platform === "win32" || typeof process.getuid !== "function") throw new Error("EasyTier private config permissions unsupported on this platform");
  try {
    const info = await lstat(options.configPath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o177) !== 0 || info.size > 1024 * 1024)
      throw new Error();
    const toml = Bun.TOML.parse(await readFile(options.configPath, "utf8")) as Record<string, unknown>;
    const identity = toml.network_identity as Record<string, unknown> | undefined;
    if (!identity || typeof identity.network_name !== "string" || !identity.network_name.trim() ||
        typeof identity.network_secret !== "string" || !identity.network_secret.trim()) throw new Error();
  } catch { throw new Error("EasyTier config must be an owner-only regular TOML file with fixed network credentials"); }

  // EasyTier also accepts ET_* environment settings; do not inherit ambient
  // configuration that could change the sidecar identity or leak to logs.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ET_/i.test(key)));
  let child: ChildProcess;
  try { child = runner(options.binary ?? "easytier-core", ["--config-file", options.configPath, "--file-log-level", "off", "--console-log-level", "off", "--disable-env-parsing"],
    { shell: false, stdio: "ignore", windowsHide: true, env }); }
  catch { throw new Error("Failed to start EasyTier"); }
  let resolveExit!: (outcome: EasyTierExit) => void;
  const exited = new Promise<EasyTierExit>(resolve => { resolveExit = resolve; });
  let settled = false, terminated = false, started = false, stopRequested = false, errored = false;
  const finish = (outcome: EasyTierExit) => { if (!settled) { settled = true; resolveExit(outcome); } };
  const stop = () => {
    if (terminated || stopRequested) return false;
    stopRequested = true;
    try { if (child.kill("SIGTERM")) return true; } catch { /* suppress sensitive messages */ }
    stopRequested = false; return false;
  };
  const probeSsh: EasyTierProcess["probeSsh"] = async (target, timeoutMs = 10000) => {
    const failed = { status: "failed" as const };
    if (!started || terminated || stopRequested || errored || !target ||
        typeof target.interfaceName !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(target.interfaceName) ||
        isIP(target.localIp) !== 4 || isIP(target.remoteIp) !== 4 || target.localIp === target.remoteIp ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return failed;
    let argv: string[];
    try { argv = buildSshRouteArgv({ id: "easytier", host: target.remoteIp, port: target.port }, target.access); }
    catch { return failed; }
    // Bind the source to the actual EasyTier interface address; host key and
    // authentication are still verified by the shared hardened SSH builder.
    argv.unshift("-b", target.localIp);
    const route = dependencies.route ?? routeMatches;
    const ssh = dependencies.ssh ?? runCommand;
    try {
      if (!await route(target.remoteIp, target.localIp, target.interfaceName)) return failed;
      if (terminated || stopRequested || errored) return failed;
      const result = await ssh("ssh", [...argv, "true"], timeoutMs);
      if (result.exitCode !== 0 || terminated || stopRequested || errored ||
          !await route(target.remoteIp, target.localIp, target.interfaceName) || terminated || stopRequested || errored) return failed;
      return { status: "healthy", argv };
    } catch { return failed; }
  };
  return new Promise((resolve, reject) => {
    child.on("error", () => { errored = true; finish({ kind: "error" });
      if (!started) reject(new Error("Failed to start EasyTier")); else stop(); });
    child.once("exit", (code, signal) => { terminated = true; finish({ kind: "exit", code, signal });
      if (!started) reject(new Error("Failed to start EasyTier")); });
    child.once("spawn", () => { if (!settled) { started = true; resolve({ exited, stop, probeSsh }); } });
  });
}
