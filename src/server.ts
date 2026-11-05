/**
 * Experimental HTTP listener. It does not provide TLS. Use only on a trusted
 * local host or behind a correctly configured HTTPS-terminating proxy. The bus
 * token grants broad authority to impersonate agents and access their queues.
 * Importing this module does not start a listener.
 */
import { createAgentBus } from "./agent-bus.ts";
import { createMachineApi } from "./machine-api.ts";
import { createChangeApi } from "./change-api.ts";
import { createSharedFilesApi } from "./shared-files-api.ts";
import { createAccessEvidenceApi } from "./access-evidence-api.ts";
import { createMutationAudit } from "./mutation-audit.ts";

export interface AgentBusServerOptions {
  dbPath: string;
  token: string;
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
  const bus = createAgentBus({ dbPath: options.dbPath, token: options.token });
  let machines: ReturnType<typeof createMachineApi>;
  try { machines = createMachineApi({ dbPath: options.dbPath, token: options.token }); }
  catch (error) { bus.close(); throw error; }
  let changes: ReturnType<typeof createChangeApi>;
  try { changes = createChangeApi({ dbPath: options.dbPath, token: options.token }); }
  catch (error) { machines.close(); bus.close(); throw error; }
  let accessEvidence: ReturnType<typeof createAccessEvidenceApi>;
  try { accessEvidence = createAccessEvidenceApi({dbPath: options.dbPath, token: options.token}); }
  catch (error) { changes.close(); machines.close(); bus.close(); throw error; }
  let sharedFiles: ReturnType<typeof createSharedFilesApi>;
  try { sharedFiles = createSharedFilesApi({roots: options.sharedRoots ?? {}, token: options.token}); }
  catch (error) { accessEvidence.close(); changes.close(); machines.close(); bus.close(); throw error; }
  let mutations: ReturnType<typeof createMutationAudit>;
  try { mutations = createMutationAudit({dbPath: options.dbPath, token: options.token,
    machineId: options.machineId ?? "control-host", requireSignedMutations: options.requireSignedMutations}); }
  catch (error) { sharedFiles.close(); accessEvidence.close(); changes.close(); machines.close(); bus.close(); throw error; }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.hostname ?? "0.0.0.0",
      port: options.port ?? 8787,
      fetch: (request) => mutations.dispatch(request, (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/shared-files" || path === "/v1/shared-files/list" || path === "/v1/shared-resources") return sharedFiles.fetch(request);
        if (path === "/v1/access-evidence") return accessEvidence.fetch(request);
        if (path === "/v1/changes" || path === "/v1/agent-registrations") return changes.fetch(request);
        return path === "/v1/machines" || path.startsWith("/v1/machines/") || path.startsWith("/v1/resources/")
          ? machines.fetch(request) : bus.fetch(request);
      }),
    });
  } catch (error) {
    mutations.close();
    sharedFiles.close();
    accessEvidence.close();
    changes.close();
    machines.close();
    bus.close();
    throw error;
  }

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
          finally { mutations.close(); sharedFiles.close(); accessEvidence.close(); changes.close(); machines.close(); bus.close(); }
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
