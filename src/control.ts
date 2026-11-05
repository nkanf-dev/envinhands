/**
 * A deliberately in-memory prototype. State is lost on restart and is not
 * shared between handlers. There is no authentication, authorization or TLS;
 * do not expose it to an untrusted network or send SSH credentials to it.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse, RequestListener } from "node:http";

export interface Machine {
  id: string;
  name: string;
  host: string;
  os: string;
  sshPort: number;
  registeredAt: string;
  /** Time the control plane last received a heartbeat, not an SSH check. */
  lastHeartbeatAt: string | null;
}

export interface ResourceMessage {
  id: string;
  resourceId: string;
  author: string;
  text: string;
  createdAt: string;
}

const MAX_BODY_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size <= MAX_BODY_BYTES) chunks.push(bytes);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Expected a JSON object"); }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "Expected a JSON object");
  }
  return data as Record<string, unknown>;
}

function fields(data: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(data).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "Unexpected field");
  }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return value.trim();
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new HttpError(400, `Invalid ${field}`);
  return value;
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("allow", allow);
  send(res, 405, { error: "Method not allowed" });
}

/**
 * Routes:
 * POST /machines {id,name,host,os,sshPort?}; GET /machines[?os=...]
 * POST /machines/:id/heartbeat (no body needed)
 * POST /resources/:id/messages {author,text}; GET /resources/:id/messages
 * IDs contain only letters, digits, _, - and .; the first character cannot be a dot.
 * Heartbeats only record receipt time. Messages are not locks or reservations.
 */
export function createControlHandler(): RequestListener {
  const machines = new Map<string, Machine>();
  const messages = new Map<string, ResourceMessage[]>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); }
    catch { throw new HttpError(400, "Invalid URL"); }
    const path = url.pathname;
    const method = req.method ?? "";
    if (path === "/machines") {
      if (method === "GET") {
        const os = url.searchParams.get("os");
        send(res, 200, { machines: [...machines.values()].filter((m) => os === null || m.os === os) });
      } else if (method === "POST") {
        const data = await jsonBody(req);
        fields(data, ["id", "name", "host", "os", "sshPort"]);
        const id = identifier(data.id, "id");
        const name = text(data.name, "name", 200);
        const host = text(data.host, "host", 253);
        const os = text(data.os, "os", 100);
        const sshPort = data.sshPort === undefined ? 22 : data.sshPort;
        if (typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
          throw new HttpError(400, "Invalid sshPort");
        }
        if (machines.has(id)) throw new HttpError(409, "Machine already exists");
        const machine: Machine = { id, name, host, os, sshPort, registeredAt: new Date().toISOString(), lastHeartbeatAt: null };
        machines.set(id, machine);
        send(res, 201, { machine });
      } else methodNotAllowed(res, "GET, POST");
      return;
    }
    const heartbeat = /^\/machines\/([^/]+)\/heartbeat$/.exec(path);
    if (heartbeat) {
      if (method !== "POST") { methodNotAllowed(res, "POST"); return; }
      const id = identifier(heartbeat[1], "id");
      const machine = machines.get(id);
      if (!machine) throw new HttpError(404, "Machine not found");
      machine.lastHeartbeatAt = new Date().toISOString();
      req.resume();
      send(res, 200, { machine });
      return;
    }
    const resource = /^\/resources\/([^/]+)\/messages$/.exec(path);
    if (resource) {
      const id = identifier(resource[1], "resource id");
      if (method === "GET") {
        send(res, 200, { messages: messages.get(id) ?? [] });
      } else if (method === "POST") {
        const data = await jsonBody(req);
        fields(data, ["author", "text"]);
        const message: ResourceMessage = {
          id: randomUUID(), resourceId: id,
          author: text(data.author, "author", 200), text: text(data.text, "text", 4000),
          createdAt: new Date().toISOString(),
        };
        const list = messages.get(id) ?? [];
        list.push(message);
        messages.set(id, list);
        send(res, 201, { message });
      } else methodNotAllowed(res, "GET, POST");
      return;
    }
    throw new HttpError(404, "Not found");
  }

  return (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) send(res, error.status, { error: error.message });
      else send(res, 500, { error: "Internal server error" });
    });
  };
}
