/**
 * Client-side adapter for the EnvInHands bus, not a Prime Agent wire protocol.
 * A successful send means only that the bus accepted a durable enqueue; it is
 * not a delivery or processing receipt. A timeout/network error has an unknown
 * outcome: retry with the same requestId if the bus supports idempotency.
 *
 * Inject fetch rather than relying on a global. Use HTTPS on untrusted networks:
 * bearer credentials and message contents are exposed by plain HTTP.
 */
export interface BridgeOptions {
  /** HTTP(S) origin only, with no credentials, query, fragment or base path. */
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

export interface Heartbeat {
  agentId: string;
  machineId: string;
  task?: string;
}

/** A heartbeat is an observation, not proof the agent is online. */
export interface BusAgent {
  agentId: string;
  machineId: string;
  task: string | null;
  status: "observed";
  lastHeartbeatAt: string;
}

export interface BusMessage {
  requestId: string;
  from: string;
  to: string;
  text: string;
}

/** No server response body or network error is included, to avoid leaking secrets. */
export class BridgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "BridgeError";
  }
}

const encoder = new TextEncoder();
function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || encoder.encode(value).length > 128 || /[\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") throw new BridgeError(`Invalid ${name}`);
}
function text(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || encoder.encode(value).length > max || value.includes("\u0000")) throw new BridgeError(`Invalid ${name}`);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class PrimeBridge {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BridgeOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new BridgeError("Invalid baseUrl"); }
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new BridgeError("Invalid baseUrl");
    }
    // RFC 6750 bearer-token syntax; reject whitespace and header injection.
    if (typeof options.token !== "string" || !/^[A-Za-z0-9._~+\/-]+=*$/.test(options.token)) throw new BridgeError("Invalid token");
    if (typeof options.fetch !== "function") throw new BridgeError("Invalid fetch");
    const timeout = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new BridgeError("Invalid timeoutMs");
    this.origin = url.origin;
    this.token = options.token;
    this.fetcher = options.fetch;
    this.timeoutMs = timeout;
  }

  private async request(path: string, method: "GET" | "POST", body?: object, parseJson = false): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async (): Promise<unknown> => {
      let response: Response;
      try {
        response = await this.fetcher(new URL(path, this.origin).toString(), {
          method,
          headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: "manual",
        });
      } catch { throw new BridgeError("Bus request failed"); }
      if (!response.ok || response.status < 200 || response.status >= 300) throw new BridgeError("Bus request rejected", response.status);
      if (!parseJson) return undefined;
      try { return await response.json(); } catch { throw new BridgeError("Invalid bus response"); }
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new BridgeError("Bus request timed out")); }, this.timeoutMs);
        }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async heartbeat(beat: Heartbeat): Promise<void> {
    if (!object(beat)) throw new BridgeError("Invalid heartbeat");
    id(beat.agentId, "agentId"); id(beat.machineId, "machineId");
    if (beat.task !== undefined) text(beat.task, "task", 2048);
    await this.request("/v1/agents/heartbeat", "POST", {
      agentId: beat.agentId, machineId: beat.machineId, ...(beat.task === undefined ? {} : { task: beat.task }),
    });
  }

  /** List last-observed agents. This is not a liveness check. */
  async listAgents(): Promise<BusAgent[]> {
    const response = await this.request("/v1/agents", "GET", undefined, true);
    if (!object(response) || !Array.isArray(response.agents)) throw new BridgeError("Invalid bus response");
    return response.agents.map((value: unknown): BusAgent => {
      if (!object(value)) throw new BridgeError("Invalid bus response");
      try {
        id(value.agentId, "agentId"); id(value.machineId, "machineId");
        if (value.task !== null) text(value.task, "task", 2048);
        if (value.status !== "observed" || typeof value.lastHeartbeatAt !== "string" || Number.isNaN(Date.parse(value.lastHeartbeatAt))) throw new BridgeError("Invalid bus response");
      } catch { throw new BridgeError("Invalid bus response"); }
      return { agentId: value.agentId, machineId: value.machineId, task: value.task as string | null, status: "observed", lastHeartbeatAt: value.lastHeartbeatAt as string };
    });
  }

  /** Success means enqueued only. It does not mean received or processed. */
  async send(message: BusMessage): Promise<void> {
    if (!object(message)) throw new BridgeError("Invalid message");
    id(message.requestId, "requestId"); id(message.from, "from"); id(message.to, "to"); text(message.text, "text", 8192);
    await this.request("/v1/messages", "POST", {
      requestId: message.requestId, from: message.from, to: message.to, text: message.text,
    });
  }

  /** Pull never acknowledges messages. Caller must explicitly ack after local acceptance. */
  async pull(to: string): Promise<BusMessage[]> {
    id(to, "to");
    const params = new URLSearchParams({ to });
    const response = await this.request(`/v1/messages?${params}`, "GET", undefined, true);
    if (!object(response) || !Array.isArray(response.messages)) throw new BridgeError("Invalid bus response");
    return response.messages.map((value: unknown): BusMessage => {
      if (!object(value)) throw new BridgeError("Invalid bus response");
      try {
        id(value.requestId, "requestId"); id(value.from, "from"); id(value.to, "to"); text(value.text, "text", 8192);
        if (value.to !== to) throw new BridgeError("Invalid bus response");
      } catch { throw new BridgeError("Invalid bus response"); }
      return { requestId: value.requestId, from: value.from, to: value.to, text: value.text };
    });
  }

  /** Call only after the local Prime Agent has confirmed receipt. */
  async ack(requestId: string): Promise<void> {
    id(requestId, "requestId");
    await this.request(`/v1/messages/${encodeURIComponent(requestId)}/ack`, "POST");
  }
}
