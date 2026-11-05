import { ChangeSpool } from "./change-spool.ts";
import { isAbsolute } from "node:path";
import { ChangeClient } from "./change-client.ts";
import { BridgeError, type Fetcher } from "./prime-bridge.ts";
import { parseRegistration, parseChange } from "./change-model.ts";

export interface ChangeCliIO {
  readInput(): Promise<string>;
  write(text: string): void;
  error(text: string): void;
  fetch: Fetcher;
}
/** No secret in arguments; one bounded JSON object on stdin for writes. */
export async function runChangeCli(args: string[], env: NodeJS.ProcessEnv, io: ChangeCliIO): Promise<number> {
  try {
    const [command, after = "0", limit = "10"] = args;
    if (!command || !["register", "record", "list", "enqueue", "flush"].includes(command) ||
        (command === "list" ? args.length > 3 : args.length !== 1)) throw new Error();
    const baseUrl = env.ENVINHANDS_URL, token = env.ENVINHANDS_TOKEN;
    if (command === "enqueue" || command === "flush") {
      const directory = env.ENVINHANDS_CHANGE_SPOOL;
      if (!directory || !isAbsolute(directory)) throw new Error();
      const spool = new ChangeSpool(directory);
      if (command === "enqueue") {
        const input = await io.readInput();
        if (new TextEncoder().encode(input).length > 16384 || (token && input.includes(token))) throw new Error();
        const pending = JSON.parse(input);
        if (!pending || typeof pending !== "object" || Array.isArray(pending) ||
            Object.keys(pending).length !== 2 || !Object.hasOwn(pending, "registration") || !Object.hasOwn(pending, "change")) throw new Error();
        await spool.enqueue(parseRegistration(pending.registration), parseChange(pending.change));
        io.write(JSON.stringify({ storedLocally: true, synced: false, requestId: pending.change.requestId }) + "\n");
        return 0;
      }
    }
    if (!baseUrl || !token) throw new Error();
    const url = new URL(baseUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error();
    const client = new ChangeClient({ baseUrl, token, fetch: io.fetch });
    let receipt: unknown;
    if (command === "flush") {
      receipt = await new ChangeSpool(env.ENVINHANDS_CHANGE_SPOOL!).flush(client);
    } else if (command === "list") {
      if (!/^(0|[1-9]\d*)$/.test(after) || !/^[1-9]\d*$/.test(limit)) throw new Error();
      receipt = await client.listChanges(Number(after), Number(limit));
    } else {
      const input = await io.readInput();
      if (new TextEncoder().encode(input).length > 16384 || input.includes(token)) throw new Error();
      const value: unknown = JSON.parse(input);
      receipt = command === "register" ? await client.register(parseRegistration(value)) : await client.recordChange(parseChange(value));
    }
    // The whole receipt is external data, not executable instructions.
    const output = JSON.stringify({ untrusted: true, receipt });
    if (output.includes(token)) throw new Error();
    io.write(output + "\n");
    return 0;
  } catch (error) {
    io.error(error instanceof BridgeError && error.status === 409 ? "Change request ID conflict; preserve the original input and inspect it.\n"
      : "Change request failed or input was invalid. A write may already be stored; retry only with the same ID and content.\n");
    return 1;
  }
}
