/**
 * Experimental HTTP listener. It does not provide TLS. Use only on a trusted
 * local host or behind a correctly configured HTTPS-terminating proxy. The bus
 * token grants broad authority to impersonate agents and access their queues.
 * Importing this module does not start a listener.
 */
import { createAgentBus } from "./agent-bus.ts";

export interface AgentBusServerOptions {
  dbPath: string;
  token: string;
  /** Port 0 asks the operating system to select an available port. */
  port?: number;
  /** Address to bind. Defaults to all IPv4 interfaces. */
  hostname?: string;
}

/** Start an experimental listener. It has no TLS; use HTTPS termination for untrusted networks. */
export function startAgentBusServer(options: AgentBusServerOptions): { url: string; hostname: string; stop(): Promise<void> } {
  const bus = createAgentBus({ dbPath: options.dbPath, token: options.token });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.hostname ?? "0.0.0.0",
      port: options.port ?? 8787,
      fetch: (request) => bus.fetch(request),
    });
  } catch (error) {
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
          finally { bus.close(); }
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
