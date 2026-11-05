import { createSharedFiles, parseSharedFileLocation, parseSharedDirectoryLocation, parseSharedFileWrite, SharedFileError } from "./shared-files.ts";
import { bearerAuth, response } from "./http.ts";
export const SHARED_FILE_REQUEST_MAX_BYTES = 68 * 1024;
async function requestBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw new SharedFileError(400, "Expected JSON file write");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > SHARED_FILE_REQUEST_MAX_BYTES) { void reader.cancel().catch(() => {}); throw new SharedFileError(413, "Shared file request too large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new SharedFileError(400, "Expected JSON file write"); }
}
/** Root server wraps POST in mutation audit; this handler returns hashes, never logs text. */
export function createSharedFilesApi(options: { roots: Record<string, string>; token: string }) {
  const authorized = bearerAuth(options.token), files = createSharedFiles({ roots: options.roots }); let closed = false;
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        if (closed) return response(503, { error: "Shared files closed" });
        if (!authorized(request)) return response(401, { error: "Unauthorized" });
        const url = new URL(request.url);
        if (url.pathname === "/v1/shared-resources") {
          if (request.method !== "GET") return response(405, { error: "Method not allowed" }, { allow: "GET" });
          if (url.search) throw new SharedFileError(400, "Unexpected query");
          return response(200, files.listResources());
        }
        if (url.pathname === "/v1/shared-files/list") {
          if (request.method !== "GET") return response(405, { error: "Method not allowed" }, { allow: "GET" });
          if ([...url.searchParams.keys()].some(key => !["resourceId", "path"].includes(key)) || url.searchParams.getAll("resourceId").length !== 1 || url.searchParams.getAll("path").length > 1) throw new SharedFileError(400, "Expected shared directory resource and path");
          const { resourceId, path } = parseSharedDirectoryLocation(url.searchParams.get("resourceId"), url.searchParams.get("path") ?? "");
          return response(200, await files.list(resourceId, path));
        }
        if (url.pathname !== "/v1/shared-files") return response(404, { error: "Not found" });
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].some(key => !["resourceId", "path"].includes(key)) || url.searchParams.getAll("resourceId").length !== 1 || url.searchParams.getAll("path").length !== 1) throw new SharedFileError(400, "Expected shared resource and path");
          const { resourceId, path } = parseSharedFileLocation(url.searchParams.get("resourceId"), url.searchParams.get("path"));
          const result = await files.read(resourceId, path);
          if (result.text.includes(options.token)) throw new SharedFileError(403, "Shared file contains a service credential");
          return response(200, result);
        }
        if (request.method !== "POST") return response(405, { error: "Method not allowed" }, { allow: "GET, POST" });
        if (url.search) throw new SharedFileError(400, "Unexpected query");
        const input = parseSharedFileWrite(await requestBody(request));
        if ([input.resourceId, input.path, input.text].some(value => value.includes(options.token))) throw new SharedFileError(400, "Shared write contains a service credential");
        return response(200, await files.write(input));
      } catch (error) {
        if (error instanceof SharedFileError) return response(error.status, { error: error.message });
        return response(500, { error: "Shared file request failed; write effects may be unknown" });
      }
    },
    close() { closed = true; },
  };
}
