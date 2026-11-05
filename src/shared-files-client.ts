import { PrimeBridge, BridgeError } from "./prime-bridge.ts";
import { parseSharedFileLocation, parseSharedFileWrite, sharedFileHash, type SharedFile, type SharedFileWrite, type SharedFileWriteReceipt } from "./shared-files.ts";
import { SHARED_FILE_REQUEST_MAX_BYTES } from "./shared-files-api.ts";
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export class SharedFilesClient extends PrimeBridge {
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
