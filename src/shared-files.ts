/** Explicit shared roots, ordinary UTF-8 files and optimistic writes; not an OS sandbox. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { open, opendir, realpath, lstat, rename, unlink, link } from "node:fs/promises";
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
const writes = new Map<string, Promise<unknown>>();
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
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); }
async function contents(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new SharedFileError(403, "Shared path is not a regular file");
    if (info.size > SHARED_FILE_MAX_BYTES) throw new SharedFileError(413, "Shared file too large");
    const file = await open(path, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new SharedFileError(403, "Shared path changed before read");
      const buffer = Buffer.alloc(SHARED_FILE_MAX_BYTES + 1); let size = 0;
      while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > SHARED_FILE_MAX_BYTES) throw new SharedFileError(413, "Shared file too large");
      return buffer.subarray(0, size);
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new SharedFileError(403, "Shared path is a symlink"); throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r"); try { await directory.sync(); } finally { await directory.close(); }
}
export function createSharedFiles(options: { roots: Record<string, string> }) {
  const roots = new Map(Object.entries(options.roots));
  for (const [id, path] of roots) { parseSharedFileLocation(id, "config.txt"); if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Shared roots must be absolute directories"); }
  const locate = async (resourceId: string, path: string) => {
    parseSharedFileLocation(resourceId, path); const configured = roots.get(resourceId); if (!configured) throw new SharedFileError(404, "Shared resource not found");
    const root = await realpath(configured), target = resolve(root, ...path.split("/"));
    let parent: string;
    try { parent = await realpath(resolve(target, "..")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SharedFileError(404, "Shared parent not found"); throw error; }
    if (!inside(root, parent) || !inside(root, target)) throw new SharedFileError(403, "Shared path leaves configured root");
    return { root, parent, target: join(parent, path.split("/").at(-1)!) };
  };
  return {
    listResources(): { resources: SharedResource[] } {
      return { resources: [...roots.keys()].map(resourceId => ({ resourceId, kind: "shared-directory", capabilities: ["read", "comparewrite"] })) };
    },
    async list(resourceId: string, path = ""): Promise<SharedDirectory> {
      parseSharedDirectoryLocation(resourceId, path);
      const configured = roots.get(resourceId); if (!configured) throw new SharedFileError(404, "Shared resource not found");
      const root = await realpath(configured), target = path ? (await locate(resourceId, path)).target : root;
      let info;
      try { info = await lstat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SharedFileError(404, "Shared directory not found"); throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new SharedFileError(403, "Shared path is not a regular directory");
      const directoryPath = await realpath(target);
      if (!inside(root, directoryPath)) throw new SharedFileError(403, "Shared directory leaves configured root");
      const entries: SharedDirectoryEntry[] = []; let hasMore = false;
      const directory = await opendir(directoryPath);
      try {
        while (true) {
          const entry = await directory.read(); if (!entry) break;
          if (entries.length === 100) { hasMore = true; break; }
          try {
            const metadata = await lstat(join(directoryPath, entry.name));
            const type = metadata.isSymbolicLink() ? "unsupported" : metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "unsupported";
            entries.push({ name: entry.name, type, bytes: type === "file" ? metadata.size : null, modifiedAt: type === "unsupported" ? null : metadata.mtime.toISOString() });
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      } finally { await directory.close(); }
      return { resourceId, path, entries, hasMore };
    },
    async read(resourceId: string, path: string): Promise<SharedFile> {
      const location = await locate(resourceId, path), bytes = await contents(location.target);
      if (bytes === null) throw new SharedFileError(404, "Shared file not found");
      let text: string; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new SharedFileError(400, "Shared file is not UTF-8"); }
      return { resourceId, path, text, sha256: sharedFileHash(bytes) };
    },
    async write(value: SharedFileWrite): Promise<SharedFileWriteReceipt> {
      const input = parseSharedFileWrite(value), location = await locate(input.resourceId, input.path), key = process.platform === "win32" ? location.target.toLowerCase() : location.target;
      const previous = writes.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(async () => {
        const currentLocation = await locate(input.resourceId, input.path);
        if (currentLocation.target !== location.target) throw new SharedFileError(409, "Shared path changed; reread before writing");
        const before = await contents(location.target), beforeSha256 = before === null ? null : sharedFileHash(before);
        if (beforeSha256 !== input.expectedSha256) throw new SharedFileError(409, "Shared file changed; reread before writing");
        const bytes = Buffer.from(input.text, "utf8"), temporary = join(location.parent, `.envinhands-${randomUUID()}.tmp`);
        const file = await open(temporary, "wx", 0o600);
        try {
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          const checked = await locate(input.resourceId, input.path);
          if (checked.target !== location.target) throw new SharedFileError(409, "Shared path changed; reread before writing");
          const latest = await contents(location.target);
          if ((latest === null ? null : sharedFileHash(latest)) !== beforeSha256) throw new SharedFileError(409, "Shared file changed; reread before writing");
          if (before === null) {
            try { await link(temporary, location.target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SharedFileError(409, "Shared file already exists"); throw error; }
          } else { await rename(temporary, location.target); }
          await syncDirectory(location.parent);
        } finally { try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
        return { resourceId: input.resourceId, path: input.path, beforeSha256, afterSha256: sharedFileHash(bytes), bytes: bytes.length };
      });
      writes.set(key, current); try { return await current; } finally { if (writes.get(key) === current) writes.delete(key); }
    },
  };
}
