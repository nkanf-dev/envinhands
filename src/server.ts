/**
 * Experimental HTTP listener. It does not provide TLS. Use only on a trusted
 * local host or behind a correctly configured HTTPS-terminating proxy. The bus
 * token grants broad authority to impersonate agents and access their queues.
 * Importing this module does not start a listener.
 */
import type { DebugEventHandler } from "./relay.ts";
import { createAgentBus } from "./agent-bus.ts";
import { createMachineApi } from "./machine-api.ts";
import { createChangeApi } from "./change-api.ts";
import { createSharedFilesApi } from "./shared-files-api.ts";
import { createAccessEvidenceApi } from "./access-evidence-api.ts";
import { createMutationAudit } from "./mutation-audit.ts";
import { createResourceProfileApi } from "./resource-profile.ts";
import { createNativeMeshApi } from "./integrations/native-mesh.ts";

export interface AgentBusServerOptions {
  dbPath: string;
  token: string;
  onEvent?: DebugEventHandler;
  /** Formal service defaults to requiring declared registration on non-audit writes. */
  requireSignedMutations?: boolean;
  machineId?: string;
  sharedRoots?: Record<string,string>;
  /** Port 0 asks the operating system to select an available port. */
  port?: number;
  /** Address to bind. Defaults to all IPv4 interfaces. */
  hostname?: string;
}

/** Start an experimental listener. It has no TLS; use HTTPS termination for untrusted networks. */
export function startAgentBusServer(options: AgentBusServerOptions): { url: string; hostname: string; stop(): Promise<void> } {
  // Close created resources in reverse order, including after startup failure.
  const closers: Array<() => void> = [];
  function own<T extends {close(): void}>(resource: T): T {
    closers.push(() => resource.close());
    return resource;
  }
  function closeAll(): void {
    let firstError: unknown;
    let failed = false;
    while (closers.length) {
      try { closers.pop()!(); }
      catch (error) { if (!failed) { firstError = error; failed = true; } }
    }
    if (failed) throw firstError;
  }
  const emit = (event: string, fields: import("./debug-log.ts").DebugFields = {}) => { try { options.onEvent?.(event, fields); } catch {} };
  const started = performance.now();
  let server: ReturnType<typeof Bun.serve>;
  try {
    const bus = own(createAgentBus({ dbPath: options.dbPath, token: options.token }));
    const machines = own(createMachineApi({ dbPath: options.dbPath, token: options.token }));
    const changes = own(createChangeApi({ dbPath: options.dbPath, token: options.token }));
    const accessEvidence = own(createAccessEvidenceApi({ dbPath: options.dbPath, token: options.token }));
    const sharedFiles = own(createSharedFilesApi({ roots: options.sharedRoots ?? {}, token: options.token }));
    const profiles = own(createResourceProfileApi({ dbPath: options.dbPath, token: options.token }));
    const nativeMesh = own(createNativeMeshApi({ dbPath: options.dbPath, token: options.token }));
    const mutations = own(createMutationAudit({ dbPath: options.dbPath, token: options.token,
      machineId: options.machineId ?? "control-host", requireSignedMutations: options.requireSignedMutations }));
    server = Bun.serve({
      hostname: options.hostname ?? "0.0.0.0",
      port: options.port ?? 8787,
      fetch: (request) => mutations.dispatch(request, (request) => {
        const path = new URL(request.url).pathname;
        if (/^\/v1\/resources\/[^/]+\/profile-notes(?:\/[^/]+)?$/.test(path)) return profiles.fetch(request);
        if (path === "/v1/native-mesh/agents") return nativeMesh.fetch(request);
        if (path === "/v1/shared-files" || path === "/v1/shared-files/list" || path === "/v1/shared-resources") return sharedFiles.fetch(request);
        if (path === "/v1/access-evidence") return accessEvidence.fetch(request);
        if (path === "/v1/changes" || path === "/v1/agent-registrations") return changes.fetch(request);
        return path === "/v1/machines" || path.startsWith("/v1/machines/") || path.startsWith("/v1/resources/")
          ? machines.fetch(request) : bus.fetch(request);
      }),
    });
  } catch (error) {
    emit("server_start_failed", { errorCategory: "startup" });
    try { closeAll(); } catch { /* Preserve the startup error. */ }
    throw error;
  }

  emit("server_started", { transport: "http" });
  // A wildcard is a bind address, not a remote destination. Return a loopback
  // URL for local probes; callers on other machines need the actual host address.
  const host = options.hostname ?? "0.0.0.0";
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = `http://${localHost}:${server.port}`;
  let stopping: Promise<void> | undefined;
  return {
    url,
    hostname: host,
    stop(): Promise<void> {
      if (!stopping) {
        stopping = (async () => {
          try { await server.stop(true); }
          finally { try { closeAll(); } finally { emit("server_stopped", { transport: "http", durationMs: Math.max(0, performance.now() - started) }); } }
        })();
      }
      return stopping;
    },
  };
}

// Explicit startup only. Never log the shared token or any request body.
if (import.meta.main) {
  const token = process.env.ENVINHANDS_TOKEN;
  const port = Number(process.env.ENVINHANDS_PORT ?? "8787");
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Set ENVINHANDS_TOKEN and a valid ENVINHANDS_PORT (1-65535).");
    process.exit(1);
  }
  const server = startAgentBusServer({
    token,
    dbPath: process.env.ENVINHANDS_DB ?? "envinhands.sqlite",
    hostname: process.env.ENVINHANDS_HOST ?? "0.0.0.0",
    port,
  });
  console.error(`Experimental HTTP listener on ${server.hostname}:${port}; use TLS termination on untrusted networks.`);
  const shutdown = () => { void server.stop().then(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
