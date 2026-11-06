import { isIP } from "node:net";
import { resolveTeamCliEnv, type TeamCliOptions } from "./team-cli-defaults.ts";
import type { ChangeCliIO } from "./change-cli.ts";

export interface TeamStatusMachine {
  id: string;
  name: string;
  os: string;
  sshUser: string | null;
  sshPort: number;
  relayNodeId: string | null;
  status: "pending" | "ready" | "not-ready";
  host: string;
  checkedAt: string | null;
}
export interface TeamStatusResult {
  command: "status" | "machines";
  ok: boolean;
  checkedAt: string;
  localMachineId: string | null;
  machines: TeamStatusMachine[];
  error: { code: string; message: string } | null;
}
export interface TeamStatusOptions {
  timeoutMs?: number;
  now?: () => Date;
  team?: Omit<TeamCliOptions, "env">;
}
class Failure extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number) { super(message); }
}
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const validId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function validHost(v: unknown): v is string {
  return typeof v === "string" && v.length <= 253 && (isIP(v) !== 0 || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(v));
}
function parseMachines(value: unknown, secrets: string[]): TeamStatusMachine[] {
  if (!record(value) || !Array.isArray(value.machines) || value.machines.length > 1000) throw new Failure("INVALID_RESPONSE", "Invalid machine catalog response.", 5);
  const ids = new Set<string>();
  const machines = value.machines.map((m: unknown): TeamStatusMachine => {
    if (!record(m) || !validId(m.id) || ids.has(m.id) || !["pending", "ready", "not-ready"].includes(m.status as string) ||
        typeof m.name !== "string" || !m.name.trim() || m.name.length > 200 ||
        typeof m.os !== "string" || !m.os.trim() || m.os.length > 100 ||
        !(m.sshUser === null || typeof m.sshUser === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(m.sshUser)) ||
        !(m.relayNodeId === null || validId(m.relayNodeId)) ||
        !validHost(m.host) || !Number.isInteger(m.sshPort) || (m.sshPort as number) < 1 || (m.sshPort as number) > 65535 ||
        !(m.checkedAt === null || typeof m.checkedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.checkedAt) && Number.isFinite(Date.parse(m.checkedAt)))) {
      throw new Failure("INVALID_RESPONSE", "Invalid machine catalog response.", 5);
    }
    ids.add(m.id);
    if (secrets.some(secret => [m.id,m.name,m.os,m.host,m.sshUser,m.relayNodeId].some(field => typeof field === "string" && field.includes(secret)))) throw new Failure("INVALID_RESPONSE", "Invalid machine catalog response.", 5);
    return { id: m.id, name:m.name, os:m.os, sshUser:m.sshUser as string | null, sshPort:m.sshPort as number, relayNodeId:m.relayNodeId as string | null, status:m.status as TeamStatusMachine["status"], host:m.host, checkedAt:m.checkedAt as string | null };
  });
  return machines.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Failure("INVALID_RESPONSE", "Invalid machine catalog response.", 5);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1024 * 1024) throw new Error();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes));
  } catch { throw new Failure("INVALID_RESPONSE", "Invalid machine catalog response.", 5); }
  finally { void reader.cancel().catch(() => {}); }
}
function render(result: TeamStatusResult): string {
  if (!result.ok) return `${result.error!.code}: ${result.error!.message}\n`;
  if (result.command === "status") {
    const counts = ["ready", "pending", "not-ready"].map(state => `${state}=${result.machines.filter(m => m.status === state).length}`).join(" ");
    return `CONTROL  reachable\nMACHINES ${result.machines.length} ${counts}\nLOCAL    ${result.localMachineId ?? "-"}\n`;
  }
  const cell = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, "?");
  const rows = result.machines.map(m => `${m.id}\t${m.status}\t${cell(m.os)}\t${m.sshUser ?? "-"}`);
  return ["ID\tSTATUS\tOS\tUSER", ...rows].join("\n") + "\n";
}
/** Read the catalog; no route probe or mutation is performed. */
export async function runTeamStatusCli(args: string[], env: NodeJS.ProcessEnv, io: ChangeCliIO, options: TeamStatusOptions = {}): Promise<number> {
  const command = args[0] === "machines" ? "machines" : "status";
  const table = args.length === 3 && args[1] === "--format" && args[2] === "table";
  let result: TeamStatusResult = {command, ok:false, checkedAt:(options.now ?? (() => new Date()))().toISOString(), localMachineId:null, machines:[], error:null};
  let exitCode = 0;
  try {
    if (!(["status", "machines"].includes(args[0])) || !(args.length === 1 || args.length === 2 && args[1] === "--json" || table)) throw new Failure("USAGE", "Usage: envinhands status|machines [--json|--format table]", 2);
    const defaults = await resolveTeamCliEnv({ ...options.team, env });
    if (defaults.source === "partial" || defaults.source === "error") throw new Failure("CONFIG", defaults.diagnostic ?? "Check Team configuration.", 2);
    const urlText = defaults.env.ENVINHANDS_URL, token = defaults.env.ENVINHANDS_TOKEN;
    if (!urlText || !token) throw new Failure("CONFIG", "Set ENVINHANDS_URL and ENVINHANDS_TOKEN, or configure Team defaults.", 2);
    let url: URL;
    try { url = new URL(urlText); } catch { throw new Failure("CONFIG", "Invalid ENVINHANDS_URL.", 2); }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Failure("CONFIG", "ENVINHANDS_URL must be an HTTPS origin or loopback HTTP origin.", 2);
    if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new Failure("CONFIG", "Invalid ENVINHANDS_TOKEN.", 2);
    const timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Failure("CONFIG", "Invalid timeout.", 2);
    const secrets = [token, defaults.env.ENVINHANDS_RELAY_SECRET, defaults.env.ENVINHANDS_ACCEPTANCE_API_KEY].filter((v): v is string => !!v);
    const localId = defaults.env.ENVINHANDS_MACHINE_ID;
    if (localId && validId(localId) && !secrets.some(secret => localId.includes(secret))) result.localMachineId = localId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result.machines = await Promise.race([
        (async () => {
          let response: Response;
          try { response = await io.fetch(new URL("/v1/machines?includePending=true&includeNotReady=true", url), {method:"GET",headers:{authorization:`Bearer ${token}`},redirect:"manual",signal:controller.signal}); }
          catch { throw new Failure("NETWORK", "Cannot reach control service. Check URL and network; retry.", 4); }
          if (response.status === 401 || response.status === 403) throw new Failure("AUTH", `Control service returned HTTP ${response.status}. Check token.`, 3);
          if (!response.ok) throw new Failure("HTTP_ERROR", `Control service returned HTTP ${response.status}.`, 5);
          return parseMachines(await boundedJson(response), secrets);
        })(),
        new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new Failure("TIMEOUT", "Control service timed out; retry.", 4));}, timeoutMs);}),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
    result.ok = true;
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure("INTERNAL", "Cannot read machine catalog.", 5);
    result.error = {code:failure.code, message:failure.message}; exitCode = failure.exitCode;
  }
  if (!result.ok) {
    const type = exitCode === 2 ? "usage" : exitCode === 3 ? "auth" : exitCode === 4 ? "network" : "service";
    io.error(JSON.stringify({ok:false,error:{type,...result.error!}}) + "\n");
  } else if (table) io.write(render(result));
  else {
    const {command, checkedAt, localMachineId, machines} = result;
    io.write(JSON.stringify({ok:true,data:{command,checkedAt,localMachineId,machines},meta:{}}) + "\n");
  }
  return exitCode;
}
