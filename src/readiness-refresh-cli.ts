/** Explicit, opt-in background readiness checks. Importing this module starts nothing. */
import { loadServiceConfig } from "./service-config.ts";
import { Storage } from "./storage.ts";
import { createReadinessRefresh, type ReadinessRefreshOptions } from "./readiness-refresh.ts";

export interface RefreshCliSignals {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export interface RefreshCliIO { write(text: string): void; error(text: string): void; }
export interface RefreshCliDependencies {
  openStorage?: (path: string) => Storage;
  /** Test-only injection. Production uses the real SSH verifier and refresh defaults. */
  refreshOptions?: Omit<ReadinessRefreshOptions, "storage" | "onEvent">;
}

/** Running the CLI is explicit consent to periodic real SSH/admin checks. */
export async function runReadinessRefreshCli(args: string[], io: RefreshCliIO = {
  write: text => { process.stdout.write(text); },
  error: text => { process.stderr.write(text); },
}, signals: RefreshCliSignals = process, dependencies: RefreshCliDependencies = {}): Promise<number> {
  let storage: Storage | undefined;
  let service: ReturnType<typeof createReadinessRefresh> | undefined;
  let interrupted = false;
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => { resolveShutdown = resolve; });
  const stop = () => { interrupted = true; resolveShutdown(); };
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  let failed = false;
  try {
    if (args.length !== 1) throw new Error();
    const config = await loadServiceConfig(args[0]!);
    if (!interrupted) {
      storage = (dependencies.openStorage ?? Storage.open)(config.dbPath);
      service = createReadinessRefresh({ ...dependencies.refreshOptions, storage,
        onEvent: event => {
          // Machine IDs may themselves reveal targets. Never print them or errors.
          if (event.type === "cycle-error" || event.type === "stop-timeout") {
            io.error(`Readiness refresh: ${event.type}.\n`);
          }
        } });
      service.start();
      io.write("Readiness refresh started (periodic checks enabled).\n");
      await shutdown;
    }
  } catch {
    failed = true;
  } finally {
    if (service) {
      try {
        // stop() rejects on deadline even if a check is still using the DB.
        await service.stop();
      } catch {
        failed = true;
        // Ownership deliberately remains with the process. Do not close an
        // actively used database, even though graceful shutdown was bounded.
        storage = undefined;
      }
    }
    try { storage?.close(); } catch { failed = true; }
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
  }
  if (failed) {
    io.error("Readiness refresh failed or did not stop in time; no credentials or targets were printed.\n");
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await runReadinessRefreshCli(process.argv.slice(2));
