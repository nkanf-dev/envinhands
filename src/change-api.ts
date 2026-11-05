/** Shared-bearer provenance API. Records are declarations, never access grants. */
import { createChangeStore, ChangeStoreError } from "./change-store.ts";
import { parseChangeQuery, ChangeInputError } from "./change-model.ts";
import { HttpError, response, json, bearerAuth } from "./http.ts";

export function createChangeApi(options: { dbPath: string; token: string }) {
  const authorized = bearerAuth(options.token);
  const store = createChangeStore(options.dbPath);
  let closed = false;
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        if (closed) return response(503, { error: "Change log closed" });
        if (!authorized(request)) return response(401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
        const url = new URL(request.url);
        if (url.pathname === "/v1/changes" && request.method === "GET") {
          const { after, limit } = parseChangeQuery(url.searchParams);
          return response(200, store.list(after, limit));
        }
        if (["/v1/changes", "/v1/agent-registrations"].includes(url.pathname)) {
          if (request.method !== "POST") return response(405, { error: "Method not allowed" },
            { allow: url.pathname === "/v1/changes" ? "GET, POST" : "POST" });
          if (url.search) throw new HttpError(400, "Unexpected query");
          const value = await json(request);
          const result = url.pathname === "/v1/changes" ? store.append(value) : store.register(value);
          return response(result.duplicate ? 200 : 201, result);
        }
        return response(404, { error: "Not found" });
      } catch (error) {
        if (error instanceof HttpError || error instanceof ChangeStoreError) return response(error.status, { error: error.message });
        if (error instanceof ChangeInputError) return response(400, { error: error.message });
        return response(500, { error: "Internal error" });
      }
    },
    close() { if (!closed) { closed = true; store.close(); } },
  };
}
