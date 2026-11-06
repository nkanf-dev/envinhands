/**
 * Registration creates pending metadata, not access or provisioning. Verification
 * uses the server's existing SSH identity and trusted host keys; no key or sudo
 * configuration is installed. A success is point-in-time and does not verify
 * any other agent's SSH identity. Each agent's identity must be checked separately.
 * A heartbeat only records receipt. This handler needs a trusted HTTPS boundary.
 */
import { HttpError, response as reply, fields, bodyBytes as body, json, bearerAuth } from "./http.ts";
import { Storage, validMachineSshUser } from "./storage.ts";
import { checkAdminReadiness, type ReadinessTarget, type ReadinessResult } from "./readiness.ts";

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new HttpError(400, `Invalid ${field}`);
  return value;
}
function pathId(value: string, field: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new HttpError(400, `Invalid ${field}`); }
  return id(decoded, field);
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new HttpError(400, `Invalid ${field}`);
  return value.trim();
}
function method(allow: string): Response {
  return reply(405, { error: "Method not allowed" }, { allow });
}

/** Open the SQLite catalog explicitly. Call close after the listener stops. */
export function createMachineApi({ dbPath, token, readinessTtlMs, verifier = checkAdminReadiness }: {
  dbPath: string; token: string; readinessTtlMs?: number;
  verifier?: (target: ReadinessTarget) => Promise<ReadinessResult>;
}): { fetch(request: Request): Promise<Response>; close(): void } {
  const authorized = bearerAuth(token);
  if (typeof dbPath !== "string" || !dbPath) throw new Error("A database path is required");
  const storage = Storage.open(dbPath, readinessTtlMs);
  let closed = false;
  return {
    async fetch(req: Request): Promise<Response> {
      try {
        if (closed) return reply(503, { error: "Catalog closed" });
        if (!authorized(req)) return reply(401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === "/v1/machines") {
          if (req.method === "GET") {
            if ([...url.searchParams.keys()].some(k => k !== "os" && k !== "includePending" && k !== "includeNotReady") || url.searchParams.getAll("os").length > 1 || url.searchParams.getAll("includePending").length > 1 || url.searchParams.getAll("includeNotReady").length > 1) throw new HttpError(400, "Invalid query");
            const os = url.searchParams.get("os");
            const pending = url.searchParams.get("includePending");
            const notReady = url.searchParams.get("includeNotReady");
            if ((pending !== null && pending !== "true" && pending !== "false") || (notReady !== null && notReady !== "true" && notReady !== "false")) throw new HttpError(400, "Invalid query");
            const machines = storage.listMachines(os === null ? undefined : text(os, "os", 100))
              .filter(machine => machine.status === "ready" || (pending === "true" && machine.status === "pending") || (notReady === "true" && machine.status === "not-ready"));
            return reply(200, { machines });
          }
          if (req.method !== "POST") return method("GET, POST");
          const data = await json(req);
          fields(data, ["id", "name", "host", "os", "sshPort", "sshUser", "relayNodeId"]);
          const machineId = id(data.id, "id");
          const relayNodeId = data.relayNodeId === undefined ? undefined : id(data.relayNodeId, "relayNodeId");
          const name = text(data.name, "name", 200);
          const host = text(data.host, "host", 253);
          const os = text(data.os, "os", 100);
          const sshUser = os.toLowerCase() === "windows" ? data.sshUser : text(data.sshUser, "sshUser", 64);
          if (!validMachineSshUser(sshUser, os)) throw new HttpError(400, "Invalid sshUser");
          const sshPort = data.sshPort === undefined ? 22 : data.sshPort;
          if (typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new HttpError(400, "Invalid sshPort");
          try { return reply(202, { machine: storage.registerMachine({ id: machineId, name, host, os, sshPort, sshUser, relayNodeId }) }); }
          catch (error) {
            // Insert is atomic; identify a uniqueness conflict even with concurrent writers.
            if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT") && storage.getMachine(machineId)) throw new HttpError(409, "Machine already exists");
            throw error;
          }
        }
        const verify = /^\/v1\/machines\/([^/]+)\/verify$/.exec(path);
        if (verify) {
          if (req.method !== "POST") return method("POST");
          const machineId = pathId(verify[1], "id");
          if ((await body(req)).length) throw new HttpError(400, "Verify does not accept a body");
          const target = storage.getMachine(machineId);
          if (!target) throw new HttpError(404, "Machine not found");
          const checkToken = storage.beginVerification(machineId);
          let ready = false;
          try {
            // Unsupported OS and legacy records must fail closed, even with an injected verifier.
            if (target.sshUser && ["linux", "macos", "windows"].includes(target.os.toLowerCase())) {
              const result = await verifier({ host: target.host, user: target.sshUser, os: target.os, sshPort: target.sshPort,
                ...(target.relayNodeId == null ? {} : { relayNodeId: target.relayNodeId }) });
              ready = result?.ready === true && result.status === "ready";
            }
          } catch { /* A verifier error is not proof of readiness. */ }
          return reply(200, { machine: storage.recordVerification(machineId, ready, checkToken),
            verificationScope: "Point-in-time check using the server's configured SSH identity. Each agent's login identity must be verified separately; no SSH key or sudo setup is installed." });
        }
        const heartbeat = /^\/v1\/machines\/([^/]+)\/heartbeat$/.exec(path);
        if (heartbeat) {
          if (req.method !== "POST") return method("POST");
          const machineId = pathId(heartbeat[1], "id");
          if ((await body(req)).length) throw new HttpError(400, "Heartbeat does not accept a body");
          // Avoid translating arbitrary storage errors into 404s.
          if (!storage.getMachine(machineId)) throw new HttpError(404, "Machine not found");
          return reply(200, { machine: storage.recordHeartbeat(machineId) });
        }
        const resource = /^\/v1\/resources\/([^/]+)\/messages$/.exec(path);
        if (resource) {
          const resourceId = pathId(resource[1], "resource id");
          if (req.method === "GET") return reply(200, { messages: storage.listMessages(resourceId) });
          if (req.method !== "POST") return method("GET, POST");
          const data = await json(req);
          fields(data, ["author", "text"]);
          const message = storage.addMessage(resourceId, text(data.author, "author", 200), text(data.text, "text", 4000));
          return reply(201, { message });
        }
        return reply(404, { error: "Not found" });
      } catch (error) {
        if (error instanceof HttpError) return reply(error.status, { error: error.message });
        return reply(500, { error: "Internal error" });
      }
    },
    close(): void { if (!closed) { closed = true; storage.close(); } },
  };
}
