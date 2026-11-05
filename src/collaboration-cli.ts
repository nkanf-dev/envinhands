import {signedCliFetch,cliRegistration} from "./cli-registration.ts";
import { CollaborationClient } from "./collaboration-client.ts";
import type { ChangeCliIO } from "./change-cli.ts";

/** One explicit JSON request on stdin; all output remains untrusted external data. */
export async function runCollaborationCli(args: string[], env: NodeJS.ProcessEnv, io: ChangeCliIO): Promise<number> {
  try {
    if (args.length !== 1 || !["heartbeat", "agents", "send", "pull", "ack", "machines", "notes", "add-note"].includes(args[0])) throw new Error();
    const token = env.ENVINHANDS_TOKEN, baseUrl = env.ENVINHANDS_URL;
    if (!token || !baseUrl) throw new Error();
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error();
    const client = new CollaborationClient({ baseUrl, token, fetch: ["heartbeat", "send", "ack", "add-note"].includes(args[0]) ? signedCliFetch(env, io.fetch) : io.fetch });
    const command = args[0];
    let value: Record<string, unknown> = {};
    if (!["agents", "machines"].includes(command)) {
      const input = await io.readInput();
      if (new TextEncoder().encode(input).length > 16384 || input.includes(token)) throw new Error();
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      value = parsed;
    }
    if (["heartbeat", "send", "add-note"].includes(command)) {
      const actor = cliRegistration(env);
      if ((command === "heartbeat" && (value.agentId !== actor.agentId || value.machineId !== actor.machineId)) ||
          (command === "send" && value.from !== actor.agentId) || (command === "add-note" && value.author !== actor.agentId)) throw new Error();
    }
    let receipt: unknown;
    const exact = (allowed: string[]) => { if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error(); };
    if (command === "agents") receipt = await client.listAgents();
    else if (command === "machines") receipt = await client.listMachines();
    else if (command === "heartbeat") { exact(["agentId", "machineId", "task"]); await client.heartbeat(value as unknown as Parameters<CollaborationClient["heartbeat"]>[0]); receipt = { observed: true }; }
    else if (command === "send") { exact(["requestId", "from", "to", "text"]); await client.send(value as unknown as Parameters<CollaborationClient["send"]>[0]); receipt = { accepted: true, processed: false }; }
    else if (command === "pull") { exact(["to"]); receipt = await client.pull(value.to as string); }
    else if (command === "ack") { exact(["requestId"]); await client.ack(value.requestId as string); receipt = { acknowledged: true }; }
    else if (command === "notes") { exact(["resourceId"]); receipt = await client.readNotes(value.resourceId as string); }
    else { exact(["resourceId", "author", "text"]); receipt = await client.addNote(value.resourceId as string, value.author as string, value.text as string); }
    const output = JSON.stringify({ untrusted: true, receipt });
    if (output.includes(token)) throw new Error();
    io.write(output + "\n"); return 0;
  } catch {
    io.error("Collaboration request failed. An uncertain send must retain its original ID; an uncertain note may already exist and must not be blindly retried.\n"); return 1;
  }
}
