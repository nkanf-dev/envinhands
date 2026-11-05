/** Isolated no-model ExtensionRunner host. JSONL on stdin/stdout is a local fixture protocol. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const checkout = process.env.PRIME_AGENT_CHECKOUT;
const dataDir = process.env.PRIME_CLIENT_DATA_DIR;
if (!checkout || !dataDir) throw new Error("PRIME_AGENT_CHECKOUT and PRIME_CLIENT_DATA_DIR are required.");
const root = resolve(checkout), workspace = resolve(dataDir);
mkdirSync(workspace, { recursive: true });
const core = (path: string) => pathToFileURL(join(root, "packages/coding-agent/src", path)).href;
const [{ DefaultResourceLoader }, { ExtensionRunner }, { SessionManager }, { ModelRegistry }, { AuthStorage },
  { wrapRegisteredTools }, { validateToolArguments }] = await Promise.all([
  import(core("core/resource-loader.ts")), import(core("core/extensions/runner.ts")), import(core("core/session-manager.ts")),
  import(core("core/model-registry.ts")), import(core("core/auth-storage.ts")), import(core("core/extensions/wrapper.ts")),
  import(pathToFileURL(join(root, "packages/ai/src/utils/validation.ts")).href),
]);
const configuredToken = process.env.ENVINHANDS_TOKEN;
const tokenValues = [configuredToken, process.env.PRIME_FIXTURE_REDACT_TOKEN].filter((v): v is string => !!v);
const redact = (value: string) => { for (const token of tokenValues) while (value.includes(token)) value = value.split(token).join(""); return value; };
const emit = (value: unknown) => process.stdout.write(redact(JSON.stringify(value)) + "\n");
const attribution = {
  agentId: process.env.ENVINHANDS_AGENT_ID ?? "unconfigured-fixture", signature: process.env.ENVINHANDS_AUDIT_SIGNATURE ?? "unconfigured fixture",
  executionMachineId: process.env.ENVINHANDS_MACHINE_ID ?? "unconfigured-host", processId: process.pid,
};
const auditPath = join(workspace, "fixture-changes.jsonl");
const audit = (action: string, resourceId: string, outcome: string, summary: string, targetMachineId = attribution.executionMachineId) => appendFileSync(auditPath, JSON.stringify({
  ...attribution, sessionId: session?.getSessionId() ?? null, recordedAt: new Date().toISOString(), action, resourceId,
  targetMachineId, outcome, summary, authority: "Explicit no-model fixture controller; no external modification authority.",
  registrationRef: join(workspace, "fixture-registration.json"), limitations: "Local declared fixture record, not automatic all-resource interception or authenticated signature.",
}) + "\n");
let session: { getSessionId(): string } | undefined;
const originalFetch = globalThis.fetch;
const origin = process.env.ENVINHANDS_URL ? new URL(process.env.ENVINHANDS_URL).origin : undefined;
let blockedNetwork = 0, allowedRequests = 0;
const wire: Array<{ method: string; path: string; status?: number; outcome: string }> = [];
const inFlight = new Set<Promise<void>>();
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!origin || url.origin !== origin) { blockedNetwork++; throw new Error("Fixture blocks non-service network requests."); }
  allowedRequests++;
  if (process.env.PRIME_CLIENT_FIXTURE_FAULT === "ack-unavailable" && url.pathname.endsWith("/ack")) {
    wire.push({ method: "POST", path: url.pathname, status: 503, outcome: "explicit-negative-control" });
    return new Response(null, { status: 503 });
  }
  const record = { method: init?.method ?? (input instanceof Request ? input.method : "GET"), path: url.pathname, outcome: "pending" } as {method:string;path:string;status?:number;outcome:string};
  wire.push(record);
  const operation = originalFetch(input, init);
  const finished = operation.then(response => { record.status = response.status; record.outcome = "response"; }, () => { record.outcome = "failed"; if(record.method !== "GET") audit("http-mutation-outcome", url.origin + record.path, "unknown", "Transport failure; server mutation outcome is unknown.", process.env.PRIME_CLIENT_SERVICE_MACHINE_ID ?? "unknown-service-host"); });
  inFlight.add(finished); void finished.finally(() => inFlight.delete(finished));
  const response = await operation;
  if (record.method !== "GET") audit("http-mutation-response", url.origin + record.path, response.ok ? "success" : "failed", `HTTP ${response.status}; receipt is not proof of recipient processing.`, process.env.PRIME_CLIENT_SERVICE_MACHINE_ID ?? "unknown-service-host");
  return response;
}) as typeof fetch;
const extensionPaths = ["heartbeat", "messages", "resources"].map(name => join(root, "packages/coding-agent/examples/extensions", `envinhands-${name}.ts`));
extensionPaths.push(fileURLToPath(new URL("../src/integrations/prime.ts", import.meta.url)));
const loader = new DefaultResourceLoader({ cwd: workspace, agentDir: join(workspace, "agent"), additionalExtensionPaths: extensionPaths,
  bundledSkillsDir: null, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
let runner: { emit(event: Record<string, unknown>): Promise<unknown>; invalidate(): void; getAllRegisteredTools(): unknown[]; onError(fn: () => void): void } | undefined;
let heartbeatActive = false;
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length) throw new Error("Real extension loading failed.");
  session = SessionManager.inMemory();
  const currentRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, workspace, session, ModelRegistry.inMemory(AuthStorage.inMemory()));
  runner = currentRunner; let extensionErrors = 0; currentRunner.onError(() => { extensionErrors++; });
  const tools = wrapRegisteredTools(currentRunner.getAllRegisteredTools(), currentRunner);
  writeFileSync(join(workspace, "fixture-registration.json"), JSON.stringify({ ...attribution, sessionId: session!.getSessionId(), registeredAt: new Date().toISOString(),
    registrationScope: "Local process fixture declaration; no shared service credential included.", changeLedger: auditPath }));
  audit("create-client-fixture", workspace, "success", "Created isolated client workspace/session and local fixture registration.");
  const status = () => ({ pid: process.pid, sessionId: session!.getSessionId(), agentId: attribution.agentId, machineId: attribution.executionMachineId,
    tools: tools.map((tool: {name:string}) => tool.name), modelCalls: 0, modelProviderConfigured: false, blockedNetwork, allowedRequests, extensionErrors,
    wire: [...wire], dataDir: workspace, auditPath, runtime: "real ExtensionRunner, not Prime daemon/TUI/model Agent" });
  emit({ type: "ready", ...status() });
  for await (const line of reader) {
    let id: unknown;
    try {
      if (Buffer.byteLength(line, "utf8") > 64 * 1024) throw new Error();
      const command: unknown = JSON.parse(line);
      if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error();
      const value = command as Record<string, unknown>; id = value.id;
      if (typeof id !== "string" || typeof value.type !== "string") throw new Error();
      if (value.type === "status") { emit({ id, ok: true, result: status() }); continue; }
      if (value.type === "call") {
        if (typeof value.name !== "string") throw new Error();
        const tool = tools.find((item: {name:string}) => item.name === value.name);
        if (!tool) throw new Error();
        const params = validateToolArguments(tool, { type: "toolCall", id, name: value.name, arguments: value.args });
        const result = await tool.execute(id, params);
        emit({ id, ok: true, result }); continue;
      }
      if (value.type === "lifecycle") {
        if (!["session_start", "agent_start", "agent_end", "session_shutdown"].includes(String(value.event))) throw new Error();
        const event = String(value.event);
        if (event === "session_start") heartbeatActive = true;
        await currentRunner.emit({ type: event, ...(event === "session_start" ? { reason: "startup" } : event === "session_shutdown" ? { reason: "quit" } : {}) });
        if (event === "session_shutdown") heartbeatActive = false;
        // Hooks are nonblocking. Await actual observed transport completion, never a readiness sleep.
        await Promise.all([...inFlight]);
        if (extensionErrors) throw new Error();
        emit({ id, ok: true, result: status() }); continue;
      }
      if (value.type === "close") { emit({ id, ok: true }); break; }
      throw new Error();
    } catch { emit({ id: typeof id === "string" ? id : null, ok: false, error: "Invalid fixture command or execution failure; no raw inputs or secrets returned." }); }
  }
} catch {
  emit({ type: "startup_error", error: "Real loader/client startup failed; no configuration values disclosed." }); process.exitCode = 1;
} finally {
  reader.close();
  if (runner && heartbeatActive) { await runner.emit({ type: "session_shutdown", reason: "quit" }); await Promise.all([...inFlight]); }
  runner?.invalidate(); globalThis.fetch = originalFetch;
  if (session) audit("close-client-fixture", workspace, "success", "Stopped own runner/timers; controller owns fixture cleanup.");
}
