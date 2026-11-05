/** Pure shared-file wire model; safe in Node clients, no native helper or filesystem import. */
import {createHash} from "node:crypto";
import {isAbsolute} from "node:path";
export const SHARED_FILE_REQUEST_MAX_BYTES = 68 * 1024;
export const SHARED_FILE_MAX_BYTES = 65536;
export interface SharedFile { resourceId: string; path: string; text: string; sha256: string }
export interface SharedFileWrite { resourceId: string; path: string; text: string; expectedSha256: string | null }
export interface SharedFileWriteReceipt { resourceId: string; path: string; beforeSha256: string | null; afterSha256: string; bytes: number }
export interface SharedResource { resourceId: string; kind: "shared-directory"; capabilities: ["read", "comparewrite"] }
export interface SharedDirectoryEntry { name: string; type: "file" | "directory" | "unsupported"; bytes: number | null; modifiedAt: string | null }
export interface SharedDirectory { resourceId: string; path: string; entries: SharedDirectoryEntry[]; hasMore: boolean }
export function parseSharedDirectoryLocation(resourceId: unknown, path: unknown): { resourceId: string; path: string } {
  if (path === "") { parseSharedFileLocation(resourceId, "directory"); return { resourceId: resourceId as string, path }; }
  return parseSharedFileLocation(resourceId, path);
}
export class SharedFileError extends Error { constructor(readonly status: 400 | 403 | 404 | 409 | 413, message: string) { super(message); } }
export const sharedFileHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function parseSharedFileLocation(resourceId: unknown, path: unknown): { resourceId: string; path: string } {
  if (typeof resourceId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(resourceId) || /[\r\n]/.test(resourceId) ||
      typeof path !== "string" || !path || path.length > 2048 || isAbsolute(path) || /[\\:\x00-\x1f\x7f]/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new SharedFileError(400, "Invalid shared file location");
  return { resourceId, path };
}
export function parseSharedFileWrite(value: unknown): SharedFileWrite {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4 ||
      !["resourceId", "path", "text", "expectedSha256"].every(key => Object.hasOwn(value, key))) throw new SharedFileError(400, "Invalid shared file write");
  const v = value as Record<string, unknown>, location = parseSharedFileLocation(v.resourceId, v.path);
  if (typeof v.text !== "string" || !(v.expectedSha256 === null || typeof v.expectedSha256 === "string" && /^[a-f0-9]{64}$/.test(v.expectedSha256) && v.expectedSha256.length === 64))
    throw new SharedFileError(400, "Invalid shared file content or expected hash");
  if (Buffer.byteLength(v.text, "utf8") > SHARED_FILE_MAX_BYTES) throw new SharedFileError(413, "Shared file too large");
  return { ...location, text: v.text, expectedSha256: v.expectedSha256 as string | null };
}
