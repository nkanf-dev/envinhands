/** Prime tool observations, not filesystem monitoring or remote-mutation inference. */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ChangeSpool } from "../change-spool.ts";
import { ChangeClient } from "../change-client.ts";
import { parseRegistration, parseChange, type AgentRegistrationInput, type ChangeInput } from "../change-model.ts";

interface Context {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: { setStatus(key: string, text: string | undefined): void; notify(message: string, type?: "warning" | "error" | "info"): void };
}
interface Call { type: "tool_call"; toolName: string; toolCallId: string; input: Record<string, unknown> }
interface Result { type: "tool_result"; toolName: string; toolCallId: string; input: Record<string, unknown>; content: Array<{type:string;[key:string]:unknown}>; isError: boolean }
interface API {
  on(event: "tool_call", handler: (event: Call, ctx: Context) => Promise<{block:true;reason:string} | void>): void;
  on(event: "tool_result", handler: (event: Result, ctx: Context) => Promise<{content: Result["content"];isError?:boolean} | void>): void;
  on(event: "agent_end" | "session_shutdown", handler: (event: unknown, ctx: Context) => Promise<void>): void;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const skipped = new Set(["envinhands_register_agent", "envinhands_record_change", "envinhands_list_changes", "envinhands_execute"]);
const scope = "tool-execution-observation";
async function localFileHash(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) return null;
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      return hash.digest("hex");
    } finally { await file.close(); }
  } catch { return null; }
}
export default function attribution(pi: API): void {
  const { ENVINHANDS_AGENT_ID: agentId, ENVINHANDS_MACHINE_ID: machineId, ENVINHANDS_AUDIT_SIGNATURE: signature,
    ENVINHANDS_CHANGE_SPOOL: directory, ENVINHANDS_URL: baseUrl, ENVINHANDS_TOKEN: token } = process.env;
  if (!agentId || !machineId || !signature || !directory) return;
  if (!isAbsolute(directory)) throw new Error("Attribution spool path must be absolute.");
  parseRegistration({ registrationId: "config", agentId, machineId, signature, sessionId: "config" });
  const secrets = [token, process.env.ENVINHANDS_ACCEPTANCE_API_KEY].filter((value): value is string => !!value);
  const safe = (value: string) => !/[\x00-\x1f\x7f]/.test(value) && !secrets.some(secret => value.includes(secret));
  if (![agentId, machineId, signature].every(safe)) throw new Error("Attribution identity contains an invalid value.");
  const spool = new ChangeSpool(directory);
  const pending = new Map<string, { registration: AgentRegistrationInput; intent: ChangeInput; editPath?: string }>();
  let dirty = true; // A new runtime also drains any previously persisted observations.
  const key = (event: Call | Result, ctx: Context) => digest(JSON.stringify([ctx.sessionManager.getSessionId(), event.toolCallId]));
  const status = (ctx: Context, message: string) => ctx.ui.setStatus("envinhands-attribution", message);
  const warning = "EnvInHands tool observation was not durably completed. Effects may be unknown; inspect the local spool, do not blindly repeat the tool.";
  pi.on("tool_call", async (event, ctx) => {
    if (skipped.has(event.toolName)) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const registration = parseRegistration({ registrationId: "observe-" + digest(JSON.stringify({ agentId, machineId, signature, sessionId })), agentId, machineId, signature, sessionId });
      const callKey = key(event, ctx);
      const path = event.toolName === "edit" && typeof event.input.path === "string" ? event.input.path : undefined;
      const resourcePath = path && path.trim() && safe(path) ? resolve(ctx.cwd, path) : undefined;
      const editPath = resourcePath && resourcePath.length <= 2048 && safe(resourcePath) ? resourcePath : undefined;
      const resourceId = editPath ?? "tool-call:" + callKey;
      const tool = ["edit", "bash", "ipython"].includes(event.toolName) ? event.toolName : "custom";
      const intent = parseChange({ requestId: "intent-" + callKey, operationId: "tool-" + callKey, registrationId: registration.registrationId,
        targetMachineId: machineId, resourceId, action: scope, summary: `${tool} invocation observed; result pending`, reason: scope,
        authority: "Observation of host-dispatched tool; not an additional execution grant", outcome: "unknown", occurredAt: new Date().toISOString(),
        beforeSha256: editPath ? await localFileHash(editPath) : null, afterSha256: null, evidenceRef: "input-sha256:" + digest(JSON.stringify(event.input)) });
      await spool.enqueue(registration, intent);
      pending.set(callKey, { registration, intent, editPath }); dirty = true;
      status(ctx, "Tool observation durable locally; service synchronization pending");
    } catch {
      ctx.ui.notify("EnvInHands could not persist tool intent; execution blocked.", "error");
      return { block: true, reason: "EnvInHands could not persist tool intent; execution blocked." };
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (skipped.has(event.toolName)) return;
    const callKey = key(event, ctx), observed = pending.get(callKey);
    if (!observed) return;
    try {
      const completed = parseChange({ ...observed.intent, requestId: "result-" + callKey, occurredAt: new Date().toISOString(),
        afterSha256: observed.editPath ? await localFileHash(observed.editPath) : null,
        outcome: event.isError ? "failed" : "success", summary: event.isError ? "Tool returned an error; side effects not inferred" : "Tool returned without an error; side effects not inferred" });
      await spool.enqueue(observed.registration, completed, observed.intent.requestId);
      pending.delete(callKey); dirty = true;
      status(ctx, "Tool observation durable locally; service synchronization pending");
    } catch {
      status(ctx, "Tool observation completion not recorded; inspect local spool");
      ctx.ui.notify(warning, "error");
      return { content: [...event.content, { type: "text", text: warning }], isError: true };
    }
  });
  const synchronize = async (_event: unknown, ctx: Context) => {
    if (!dirty) return;
    if (!baseUrl || !token) { status(ctx, "Tool observations pending locally; service not configured"); return; }
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error();
      const receipt = await spool.flush(new ChangeClient({ baseUrl, token, fetch: globalThis.fetch.bind(globalThis), timeoutMs: 2000 }));
      dirty = receipt.pending !== 0;
      status(ctx, dirty ? "Tool observations pending locally" : "Tool observations service-receipted");
    } catch {
      status(ctx, "Tool observations pending locally; service synchronization failed");
      ctx.ui.notify("EnvInHands observations remain pending locally; service synchronization failed. Tool work was not replayed.", "warning");
    }
  };
  pi.on("agent_end", synchronize);
  pi.on("session_shutdown", synchronize);
}
