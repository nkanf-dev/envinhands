import { PrimeBridge, BridgeError } from "./prime-bridge.ts";
import { parseSharedFileLocation, parseSharedDirectoryLocation, parseSharedFileWrite, sharedFileHash, type SharedFile, type SharedFileWrite, type SharedFileWriteReceipt, type SharedResource, type SharedDirectory } from "./shared-files-model.ts";
import { SHARED_FILE_REQUEST_MAX_BYTES } from "./shared-files-model.ts";
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export class SharedFilesClient extends PrimeBridge {
  async listResources(): Promise<{ resources: SharedResource[] }> {
    const result = await this.request("/v1/shared-resources", "GET", undefined, true, 256 * 1024);
    if (!object(result) || !Array.isArray(result.resources)) throw new BridgeError("Invalid shared resource response");
    const resources = result.resources.map(value => {
      if (!object(value) || value.kind !== "shared-directory" || !Array.isArray(value.capabilities) || value.capabilities.length !== 2 || value.capabilities[0] !== "read" || value.capabilities[1] !== "comparewrite") throw new BridgeError("Invalid shared resource response");
      const location = parseSharedDirectoryLocation(value.resourceId, "");
      return { resourceId: location.resourceId, kind: "shared-directory" as const, capabilities: ["read", "comparewrite"] as ["read", "comparewrite"] };
    });
    return { resources };
  }
  async list(resourceId: string, path = ""): Promise<SharedDirectory> {
    const location = parseSharedDirectoryLocation(resourceId, path), query = new URLSearchParams(location);
    const result = await this.request(`/v1/shared-files/list?${query}`, "GET", undefined, true, 256 * 1024);
    if (!object(result) || result.resourceId !== resourceId || result.path !== path || typeof result.hasMore !== "boolean" || !Array.isArray(result.entries) || result.entries.length > 100) throw new BridgeError("Invalid shared directory response");
    const entries = result.entries.map(value => {
      if (!object(value) || typeof value.name !== "string" || !value.name || value.name === "." || value.name === ".." || /[\\/]/.test(value.name) || !["file", "directory", "unsupported"].includes(String(value.type)) ||
          !(value.bytes === null || Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0) || !(value.modifiedAt === null || typeof value.modifiedAt === "string" && Number.isFinite(Date.parse(value.modifiedAt)))) throw new BridgeError("Invalid shared directory entry");
      return { name: value.name, type: value.type as "file" | "directory" | "unsupported", bytes: value.bytes as number | null, modifiedAt: value.modifiedAt as string | null };
    });
    return { ...location, entries, hasMore: result.hasMore };
  }
  async read(resourceId: string, path: string): Promise<SharedFile> {
    const location = parseSharedFileLocation(resourceId, path), query = new URLSearchParams(location);
    const result = await this.request(`/v1/shared-files?${query}`, "GET", undefined, true, 512 * 1024);
    if (!object(result) || result.resourceId !== resourceId || result.path !== path || typeof result.text !== "string" || Buffer.byteLength(result.text) > 65536 || result.sha256 !== sharedFileHash(Buffer.from(result.text))) throw new BridgeError("Invalid shared file response");
    return { ...location, text: result.text, sha256: result.sha256 as string };
  }
  async write(input: SharedFileWrite): Promise<SharedFileWriteReceipt> {
    const value = parseSharedFileWrite(input);
    if (Buffer.byteLength(JSON.stringify(value)) > SHARED_FILE_REQUEST_MAX_BYTES) throw new BridgeError("Shared file request too large");
    const result = await this.request("/v1/shared-files", "POST", value, true, 256 * 1024);
    if (!object(result) || result.resourceId !== value.resourceId || result.path !== value.path || result.beforeSha256 !== value.expectedSha256 || result.afterSha256 !== sharedFileHash(Buffer.from(value.text)) || result.bytes !== Buffer.byteLength(value.text)) throw new BridgeError("Invalid shared file write receipt");
    return { resourceId: value.resourceId, path: value.path, beforeSha256: result.beforeSha256 as string | null, afterSha256: result.afterSha256 as string, bytes: result.bytes as number };
  }
}
