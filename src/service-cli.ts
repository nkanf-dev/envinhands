import { loadServiceConfig } from "./service-config.ts";
import { startAgentBusServer } from "./server.ts";

export interface ServiceSignals {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export interface ServiceIO {
  write(text: string): void;
  error(text: string): void;
}

/** Explicit lifecycle entry. Config and database survive shutdown unchanged. */
export async function runServiceCli(args: string[], io: ServiceIO = {
  write: text => { process.stdout.write(text); },
  error: text => { process.stderr.write(text); },
}, signals: ServiceSignals = process): Promise<number> {
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  let stopped = false;
  let resolveStop!: () => void;
  const shutdown = new Promise<void>(resolve => { resolveStop = resolve; });
  const stop = () => { stopped = true; resolveStop(); };
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  try {
    try {
      if (args.length !== 1) throw new Error();
      const config = await loadServiceConfig(args[0]!);
      if (!stopped) {
        server = startAgentBusServer({ ...config, requireSignedMutations: true });
        io.write(JSON.stringify({ type: "ready", url: server.url, hostname: server.hostname,
          port: Number(new URL(server.url).port), pid: process.pid, requireSignedMutations: true }) + "\n");
        await shutdown;
      }
    } finally {
      try { await server?.stop(); }
      finally { signals.removeListener("SIGINT", stop); signals.removeListener("SIGTERM", stop); }
    }
    return 0;
  } catch {
    io.error("Control service failed. Check the private configuration, database and listener; no credentials were printed.\n");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runServiceCli(process.argv.slice(2));
