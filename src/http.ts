import { createHash, timingSafeEqual } from "node:crypto";
/** Shared HTTP boundary for persistent APIs; no listener or storage side effects. */
const MAX_BODY = 16 * 1024;
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
export function fields(data: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(data).some((k) => !allowed.includes(k))) throw new HttpError(400, "Unexpected field");
}
export async function bodyBytes(req: Request): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new HttpError(400, "Invalid Content-Length");
    if (Number(declared) > MAX_BODY) throw new HttpError(413, "Request body too large");
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function json(req: Request): Promise<Record<string, unknown>> {
  const raw = await bodyBytes(req);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new HttpError(400, "Expected a JSON object"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed as Record<string, unknown>;
}

/** Shared-token access only, not per-agent identity authentication. */
export function bearerAuth(token: string): (request: Request) => boolean {
  if (typeof token !== "string" || !token || /\s|[\u0000-\u001f\u007f]/.test(token)) throw new Error("A nonempty bearer token without whitespace is required");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return request => timingSafeEqual(createHash("sha256").update(request.headers.get("authorization") ?? "").digest(), expected);
}
