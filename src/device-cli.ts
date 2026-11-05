import {signedCliFetch} from "./cli-registration.ts";
import { DeviceRegistrationClient, type DeviceRegistrationOptions } from "./device-registration.ts";
import { BridgeError } from "./prime-bridge.ts";
import type { ChangeCliIO } from "./change-cli.ts";

/** One local observation and an explicit reachable address, no implicit verification/provisioning. */
export async function runDeviceCli(args: string[], env: NodeJS.ProcessEnv, io: ChangeCliIO): Promise<number> {
  try {
    if (args.length !== 1 || !["register", "inventory"].includes(args[0])) throw new Error();
    const baseUrl = env.ENVINHANDS_URL, token = env.ENVINHANDS_TOKEN;
    if (!baseUrl || !token) throw new Error();
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error();
    const client = new DeviceRegistrationClient({ baseUrl, token, fetch: args[0] === "register" ? signedCliFetch(env, io.fetch) : io.fetch });
    if (args[0] === "inventory") {
      const response = await io.fetch(new URL("/v1/machines?includePending=true&includeNotReady=true", baseUrl), { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
      if (!response.ok) throw new Error();
      io.write(JSON.stringify({ untrusted: true, inventory: await response.json(), scope: "catalog data, not this Agent's access verification" }) + "\n");
      return 0;
    }
    const input = await io.readInput();
    if (new TextEncoder().encode(input).length > 16384 || input.includes(token)) throw new Error();
    const value = JSON.parse(input) as DeviceRegistrationOptions & { verify?: boolean };
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key =>
      !["id", "host", "name", "sshUser", "sshPort", "relayNodeId", "verify"].includes(key)) ||
      (value.verify !== undefined && typeof value.verify !== "boolean")) throw new Error();
    const { verify, ...options } = value;
    const receipt = await client.registerDevice(options, { verify });
    const output = JSON.stringify({ untrusted: true, receipt, provisioned: false });
    if (output.includes(token)) throw new Error();
    io.write(output + "\n");
    return verify && receipt.machine.status !== "ready" ? 1 : 0;
  } catch (error) {
    io.error(error instanceof BridgeError && error.status === 409 ? "Device ID already registered. Inspect inventory; no implicit update or verification performed.\n" :
      "Device request failed. A pending record may exist; inspect inventory before retry. No SSH keys or administrator privileges were configured.\n");
    return 1;
  }
}
