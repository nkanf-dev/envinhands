import { runLocalExecution, type LocalExecution } from "./local-execution.ts";
import { runRemoteExecution, type RemoteExecution } from "./remote-execution.ts";
import { ChangeSpool } from "./change-spool.ts";
import { isAbsolute } from "node:path";
import { fetchTransportCatalog, transportCatalogCandidates } from "./transport-catalog.ts";
import { buildSshRouteArgv, selectSshRoute, type SshAccess, type SshRoute } from "./transports/ssh-routes.ts";
import type { ChangeCliIO } from "./change-cli.ts";

export async function runRemoteCli(args: string[], env: NodeJS.ProcessEnv, io: Pick<ChangeCliIO, "readInput" | "write" | "error">): Promise<number> {
  const secrets = [env.ENVINHANDS_TOKEN, env.ENVINHANDS_RELAY_SECRET].filter((s): s is string => !!s);
  const conceal = (text: string): string => {
    // Removing one secret can join fragments into the other. Repeat until no
    // nonempty secret remains, including in short diagnostic messages.
    let previous: string;
    do {
      previous = text;
      for (const secret of secrets) text = text.split(secret).join("");
    } while (text !== previous);
    return text;
  };
  const markSecrets = (text: string): string => {
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return conceal(text);
  };
  try {
    const local = args.length === 1 && args[0] === "--local";
    const catalog = args.length === 1 && args[0] === "--catalog";
    if ((!local && !catalog && args.length !== 0) || !env.ENVINHANDS_CHANGE_SPOOL || !isAbsolute(env.ENVINHANDS_CHANGE_SPOOL)) throw new Error();
    const input = await io.readInput();
    if (new TextEncoder().encode(input).length > 16384) throw new Error();
    const value = JSON.parse(input);
    // Inspect decoded JSON strings and object keys in every mode before any
    // spool or process work. Escaped spelling must not bypass this boundary.
    const containsSecret = (v: unknown): boolean => {
      if (typeof v === "string") return secrets.some(secret => v.includes(secret));
      if (Array.isArray(v)) return v.some(containsSecret);
      return !!v && typeof v === "object" && Object.entries(v).some(([key, item]) => containsSecret(key) || containsSecret(item));
    };
    if (secrets.length && containsSecret(value)) throw new Error();
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !(local ? ["registration", "change", "executable", "args", "cwd", "timeoutMs"] : catalog ?
          ["registration", "change", "targetMachineId", "access", "probeBudgetMs", "command", "timeoutMs"] :
          ["registration", "change", "routes", "access", "priority", "probeBudgetMs", "command", "timeoutMs"]).includes(key))) throw new Error();
    const spool = new ChangeSpool(env.ENVINHANDS_CHANGE_SPOOL);
    const result = local ? await runLocalExecution({ ...value, spool } as LocalExecution) : catalog ?
      await runCatalogExecution(value, env, spool) : await runRemoteExecution({ ...value, spool } as RemoteExecution);
    // Remote output is untrusted. Do not print local bearer or relay credentials even
    // if the remote process happens to echo them.
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return markSecrets(value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [markSecrets(k), redact(v)]));
      return value;
    };
    const ok = result.outcome === "success" && result.locallyRecorded;
    const error = {type:"execution", code:"E_EXECUTION", message:"E_EXECUTION"};
    // Keep top-level result for existing JSON consumers. data is the same
    // object in the structured CLI envelope.
    const envelope = ok ? {ok, data:result, meta:{}, result} : {ok, error, data:result, meta:{}, result};
    const rendered = JSON.stringify(redact(envelope)) + "\n";
    // A fixed error field must never be altered to hide a secret. If even JSON
    // syntax or a fixed literal conflicts with one, suppress the output.
    const errorLiteral = JSON.stringify(error);
    if ((!ok && secrets.some(secret => errorLiteral.includes(secret))) || secrets.some(secret => rendered.includes(secret))) throw new Error();
    if (ok) io.write(rendered); else io.error(rendered);
    return ok ? 0 : 1;
  } catch {
    const failure = JSON.stringify({ok:false, error:{type:"execution", code:"E_EXECUTION", message:"E_EXECUTION"}}) + "\n";
    // Silence is safer than printing a secret or a mutated fixed error code.
    if (!secrets.some(secret => failure.includes(secret))) io.error(failure);
    return 1;
  }
}

/** Resolve only network endpoints from the catalog. Authentication, trust and
 * the command remain local. All network and SSH work runs after audit intent. */
async function runCatalogExecution(value: Record<string, any>, env: NodeJS.ProcessEnv, spool: ChangeSpool) {
  const access = value.access as SshAccess;
  if (!access || typeof access !== "object" || Array.isArray(access) ||
      Object.keys(access).some(k => !["user", "hostKeyAlias", "identityFile", "knownHostsFile"].includes(k)) ||
      typeof access.identityFile !== "string" || !access.identityFile ||
      typeof access.knownHostsFile !== "string" || !access.knownHostsFile ||
      typeof value.targetMachineId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value.targetMachineId) ||
      !value.change || value.change.targetMachineId !== value.targetMachineId ||
      !Number.isSafeInteger(value.probeBudgetMs) || value.probeBudgetMs < 2 || value.probeBudgetMs > 120000) throw new Error("Invalid catalog execution");
  buildSshRouteArgv({id:"validation", host:access.hostKeyAlias}, access);
  const diagnostics: {status: string; attempts: {routeId:string; status:string}[]} = {status:"not-started", attempts:[]};
  const result = await runRemoteExecution({
    registration:value.registration, change:value.change, access, routes:[], priority:[],
    probeBudgetMs:value.probeBudgetMs, command:value.command, timeoutMs:value.timeoutMs, spool,
    selectRoute: async () => {
      const deadline = performance.now() + value.probeBudgetMs;
      diagnostics.status = "catalog-unavailable";
      const base = env.ENVINHANDS_URL, token = env.ENVINHANDS_TOKEN;
      if (!base || !token) throw new Error("Catalog unavailable");
      const parsed = new URL(base);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid catalog URL");
      // Reserve at least half of the total budget for SSH probes.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let page;
      try {
        page = await Promise.race([
          fetchTransportCatalog(base, token, value.targetMachineId,
            (url, init) => fetch(url, {...init, signal:controller.signal})),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("Catalog timed out")); }, Math.max(1, Math.floor(value.probeBudgetMs / 2)));
          }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      diagnostics.status = "no-verified-route";
      // On Windows or without a locally configured relay, skip relay records;
      // direct paths must remain usable. Mapping each record separately also
      // prevents an unusable candidate from blocking the rest.
      const binary = env.ENVINHANDS_PROXY_BINARY;
      let relayReady = process.platform !== "win32" && !!binary && isAbsolute(binary) && !/[%\x00-\x1f\x7f]/.test(binary) &&
        !!env.ENVINHANDS_RELAY_URL && !!env.ENVINHANDS_RELAY_SECRET;
      if (relayReady) {
        try {
          const u = new URL(env.ENVINHANDS_RELAY_URL!);
          relayReady = ["ws:", "wss:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash &&
            !/[\r\n\x00]/.test(env.ENVINHANDS_RELAY_SECRET!);
        } catch { relayReady = false; }
      }
      const ranked = [...page.routes].filter(r => r.status === "observed").sort((a,b) =>
        Number(a.kind === "relay") - Number(b.kind === "relay") || a.priority - b.priority || a.routeId.localeCompare(b.routeId));
      const routes: {route:SshRoute; expiresAt:number; relay:boolean}[] = [];
      for (const record of ranked) {
        if (record.kind === "relay" && !relayReady) { diagnostics.attempts.push({routeId:record.routeId, status:"unavailable"}); continue; }
        try {
          const mapped = transportCatalogCandidates({machineId:page.machineId,routes:[record]}, value.targetMachineId,
            {access:access as SshAccess & {identityFile:string;knownHostsFile:string}, relayBinaryPath:relayReady ? binary! : process.execPath});
          for (const route of mapped.routes) routes.push({route, expiresAt:record.observedAt + record.ttlMs, relay:record.kind === "relay"});
        } catch { diagnostics.attempts.push({routeId:record.routeId, status:"invalid"}); }
      }
      // Reserve a separate part of the remaining time for relay, even when
      // many direct candidates are slow or process startup has overhead.
      const directDeadline = routes.some(r => r.relay) ?
        performance.now() + Math.max(0, deadline - performance.now()) * 2 / 3 : deadline;
      // A probe runs only the fixed echo command. One short second sweep
      // allows a path that is still coming up to become ready. The user task
      // itself is never retried.
      for (let sweep = 0; sweep < 2 && routes.length; sweep++) {
        if (sweep) {
          const left = Math.floor(deadline - performance.now());
          if (left <= 100) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        for (let i = 0; i < routes.length; i++) {
          const remaining = Math.floor(deadline - performance.now());
          if (remaining <= 0) break;
          const candidate = routes[i]!;
          if (candidate.expiresAt <= Date.now()) { diagnostics.attempts.push({routeId:candidate.route.id, status:"expired"}); continue; }
          // The direct phase cannot consume the reserved relay phase.
          const phaseRemaining = Math.floor((candidate.relay ? deadline : directDeadline) - performance.now());
          if (phaseRemaining <= 0) continue;
          const peers = routes.slice(i).filter(r => r.relay === candidate.relay).length;
          const budget = Math.max(1, Math.floor(Math.min(remaining, phaseRemaining) / peers));
          try {
            const selected = await selectSshRoute([candidate.route], access, {priority:[candidate.route.id], totalBudgetMs:budget, probeTimeoutMs:Math.min(10000,budget)});
            diagnostics.attempts.push({routeId:candidate.route.id, status:"healthy"});
            diagnostics.status = "selected";
            return selected;
          } catch { diagnostics.attempts.push({routeId:candidate.route.id, status:"failed"}); }
        }
      }
      throw new Error("No verified route");
    },
  });
  return {...result, diagnostics};
}
