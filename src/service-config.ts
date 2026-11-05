import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";

export interface ServiceConfig {
  hostname: string;
  port: number;
  dbPath: string;
  token: string;
  sharedRoots?: Record<string,string>;
  machineId?: string;
}
const MAX_CONFIG_BYTES = 16 * 1024;

/** Read a caller-owned config; Unix permissions are checked on the opened file. */
export async function loadServiceConfig(path: string): Promise<ServiceConfig> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error();
    file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES ||
        (process.platform !== "win32" && ((metadata.mode & 0o7777) !== 0o600 || metadata.uid !== process.getuid?.()))) throw new Error();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const config = value as Record<string, unknown>;
    const keys = ["hostname", "port", "dbPath", "token"];
    if (!keys.every(key => Object.hasOwn(config, key)) || Object.keys(config).some(key => ![...keys,"sharedRoots","machineId"].includes(key))) throw new Error();
    const { hostname, port, dbPath, token } = config;
    if (typeof hostname !== "string" || hostname.length > 253 || /[\x00-\x20\x7f]/.test(hostname) ||
        (!isIP(hostname) && !hostname.split(".").every(part => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) ||
        typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535 ||
        typeof dbPath !== "string" || !isAbsolute(dbPath) || /[\x00-\x1f\x7f]/.test(dbPath) || dbPath === path ||
        typeof token !== "string" || !token || /\s|[\x00-\x1f\x7f]/.test(token) || hostname.includes(token)) throw new Error();
    if (config.machineId !== undefined && (typeof config.machineId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(config.machineId))) throw new Error();
    let sharedRoots: Record<string,string> | undefined;
    if (config.sharedRoots !== undefined) {
      if (!config.sharedRoots || typeof config.sharedRoots !== "object" || Array.isArray(config.sharedRoots)) throw new Error();
      sharedRoots = {};
      for (const [id,path] of Object.entries(config.sharedRoots)) {
        if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id) || typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || path.includes(token)) throw new Error();
        sharedRoots[id] = path;
      }
    }
    return { hostname, port, dbPath, token, ...(sharedRoots === undefined ? {} : {sharedRoots}), ...(config.machineId === undefined ? {} : {machineId: config.machineId as string}) };
  } catch {
    throw new Error("Service configuration could not be read or was invalid. Check its absolute paths and private permissions.");
  } finally {
    await file?.close();
  }
}
