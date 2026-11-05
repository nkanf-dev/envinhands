import helperSource from "./unix-helper.py" with {type:"text"};
import {materializeRegistrationHelper} from "./helper-asset.ts";

import { isAbsolute } from "node:path";
import { prepareLinuxRegistration } from "./linux.ts";

export type UnixRegistrationRequest =
  | { action: "apply"; operationId: string; user: string; publicKey: string; confirm: true }
  | { action: "revoke"; operationId: string; confirm: true };
export interface UnixRegistrationOptions {
  pythonPath?: string;
  visudoPath?: string;
  timeoutMs?: number;
  /** Explicit isolated fixture. Never supplies alternate real-system paths. */
  fixtureRoot?: string;
}
export interface UnixRegistrationResult {
  status: "applied" | "revoked" | "partial" | "failed";
  ready: false;
  fixture: boolean;
  receipt?: Record<string, unknown>;
  message: string;
}

/** stdin carries the request; no privilege escalation, shell or public key in argv. */
export async function runUnixRegistration(request: UnixRegistrationRequest, options: UnixRegistrationOptions = {}): Promise<UnixRegistrationResult> {
  const fixture = options.fixtureRoot !== undefined;
  const failed = (message: string): UnixRegistrationResult => ({ status: "failed", ready: false, fixture, message });
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let helper: Awaited<ReturnType<typeof materializeRegistrationHelper>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!["linux", "darwin"].includes(process.platform) || !request || request.confirm !== true ||
        !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(request.operationId) || /[\r\n]/.test(request.operationId) ||
        !["apply", "revoke"].includes(request.action)) throw new Error();
    if (request.action === "apply") prepareLinuxRegistration({ user: request.user, publicKey: request.publicKey });
    const timeoutMs = options.timeoutMs ?? 20000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
        (fixture && (!isAbsolute(options.fixtureRoot!) || options.fixtureRoot === "/")) ||
        (options.visudoPath !== undefined && !isAbsolute(options.visudoPath))) throw new Error();
    const input = JSON.stringify({ request, options: { fixtureRoot: options.fixtureRoot, visudoPath: options.visudoPath } });
    if (Buffer.byteLength(input) > 16384) throw new Error();
    helper = await materializeRegistrationHelper("unix-helper.py",helperSource);
    child = Bun.spawn([options.pythonPath ?? "python3", helper.path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(input);
    child.stdin.end();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      child?.kill("SIGKILL"); reject(new Error("timeout"));
    }, timeoutMs); });
    const [stdout, _stderr, exit] = await Promise.race([Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), expired]);
    if (Buffer.byteLength(stdout) > 65536) throw new Error();
    const result = JSON.parse(stdout) as UnixRegistrationResult;
    if (!["applied", "revoked", "partial", "failed"].includes(result.status) || result.ready !== false ||
        result.fixture !== fixture || typeof result.message !== "string" ||
        ((result.status === "applied" || result.status === "revoked") && exit !== 0)) throw new Error();
    return result;
  } catch {
    return { ...failed("Unix registration unavailable or outcome unknown; inspect its owned receipt before replay."), status: child ? "partial" : "failed" };
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await helper?.close();
  }
}
