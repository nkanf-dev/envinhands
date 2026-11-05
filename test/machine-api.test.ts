import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { ResourceMessage } from "../src/control.ts";
import type { StoredMachine } from "../src/storage.ts";
import type { ReadinessResult, ReadinessTarget } from "../src/readiness.ts";
import { createMachineApi } from "../src/machine-api.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ready: ReadinessResult = { status: "ready", ready: true, message: "verified" };
function setup(verifier: (target: ReadinessTarget) => Promise<ReadinessResult> = async () => ready, readinessTtlMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), "machine-api-")); dirs.push(dir);
  const dbPath = join(dir, "test.sqlite");
  return { dbPath, api: createMachineApi({ dbPath, token: "secret", verifier, readinessTtlMs }) };
}
type Api = ReturnType<typeof createMachineApi>;
function call(api: Api, path: string, method = "GET", value?: unknown, token = "secret"): Promise<Response> {
  return api.fetch(new Request(`http://local.test${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
}
async function json(response: Response): Promise<{ machine: StoredMachine; message: ResourceMessage; machines: StoredMachine[]; messages: ResourceMessage[] }> {
  return await response.json() as { machine: StoredMachine; message: ResourceMessage; machines: StoredMachine[]; messages: ResourceMessage[] };
}
const input = { id: "host-1", name: "Node", host: "10.0.0.2", os: "linux", sshUser: "admin" };

describe("persistent machine API (direct fetch, no network)", () => {
  test("registration, timestamps, heartbeat and messages survive restart", async () => {
    const { dbPath, api } = setup();
    const registered = await call(api, "/v1/machines", "POST", input);
    expect(registered.status).toBe(202);
    const { machine } = await json(registered);
    expect(machine).toMatchObject({ ...input, sshPort: 22, lastHeartbeatAt: null });
    expect(Number.isFinite(Date.parse(machine.registeredAt))).toBe(true);
    expect(machine.status).toBe("pending");
    expect(machine.verifiedAt).toBeNull();
    expect((await json(await call(api, "/v1/machines"))).machines).toEqual([]);
    expect((await json(await call(api, "/v1/machines?includePending=true"))).machines).toEqual([machine]);
    expect((await call(api, "/v1/machines/host-1/verify", "POST")).status).toBe(200);
    expect((await call(api, "/v1/machines", "POST", input)).status).toBe(409);
    const hb = await call(api, "/v1/machines/host-1/heartbeat", "POST");
    expect(hb.status).toBe(200);
    const heartbeat = (await json(hb)).machine;
    expect(Number.isFinite(Date.parse(heartbeat.lastHeartbeatAt ?? ""))).toBe(true);
    expect(heartbeat.status).toBe("ready");
    const msg = await call(api, "/v1/resources/project-1/messages", "POST", { author: "alice", text: "hello" });
    expect(msg.status).toBe(201);
    const { message } = await json(msg);
    expect(message).toMatchObject({ resourceId: "project-1", author: "alice", text: "hello" });
    expect(Number.isFinite(Date.parse(message.createdAt))).toBe(true);
    api.close(); api.close();
    expect((await call(api, "/v1/machines")).status).toBe(503);
    const again = createMachineApi({ dbPath, token: "secret", verifier: async () => ready, readinessTtlMs: 60_000 });
    expect((await json(await call(again, "/v1/machines"))).machines).toEqual([heartbeat]);
    expect((await json(await call(again, "/v1/machines?os=linux"))).machines).toEqual([heartbeat]);
    expect((await json(await call(again, "/v1/machines?os=windows"))).machines).toEqual([]);
    expect((await json(await call(again, "/v1/resources/project-1/messages"))).messages).toEqual([message]);
    expect((await json(await call(again, "/v1/resources/other/messages"))).messages).toEqual([]);
    again.close();
  });
  test("optional relay node ID is validated and persists across restart", async () => {
    const targets: ReadinessTarget[] = [];
    const { dbPath, api } = setup(async target => { targets.push(target); return ready; });
    const nodeId = "relay_1.node-2";
    try {
      const response = await call(api, "/v1/machines", "POST", { ...input, relayNodeId: nodeId });
      expect(response.status).toBe(202);
      expect((await json(response)).machine.relayNodeId).toBe(nodeId);
      expect((await json(await call(api, "/v1/machines?includePending=true"))).machines[0].relayNodeId).toBe(nodeId);
      for (const value of [null, "", ".node", "bad/id", "bad id", "x".repeat(129), 123, [], {}]) {
        const invalid = await call(api, "/v1/machines", "POST", { ...input, id: "invalid", relayNodeId: value });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: "Invalid relayNodeId" });
      }
      const withoutNode = await call(api, "/v1/machines", "POST", { ...input, id: "no-node" });
      expect(withoutNode.status).toBe(202);
      expect((await json(withoutNode)).machine.relayNodeId).toBeNull();
      expect((await call(api, "/v1/machines/host-1/verify", "POST")).status).toBe(200);
      expect((await call(api, "/v1/machines/no-node/verify", "POST")).status).toBe(200);
      expect(targets).toEqual([
        { host: input.host, user: input.sshUser, os: input.os, sshPort: 22, relayNodeId: nodeId },
        { host: input.host, user: input.sshUser, os: input.os, sshPort: 22 },
      ]);
    } finally { api.close(); }
    const again = createMachineApi({ dbPath, token: "secret", verifier: async () => ready });
    try {
      const machines = (await json(await call(again, "/v1/machines?includePending=true"))).machines;
      expect(machines.map(machine => [machine.id, machine.relayNodeId])).toEqual([[input.id, nodeId], ["no-node", null]]);
    } finally { again.close(); }
  });
  test("authentication is required before reads and writes", async () => {
    const { api } = setup();
    for (const [path, method, value] of [["/v1/machines", "GET", undefined], ["/v1/machines", "POST", input], ["/v1/machines/host-1/heartbeat", "POST", undefined], ["/v1/machines/host-1/verify", "POST", undefined], ["/v1/resources/r/messages", "GET", undefined], ["/v1/resources/r/messages", "POST", {author: "a", text: "b"}]] as const) {
      const res = await call(api, path, method, value, "wrong-secret");
      expect(res.status).toBe(401); expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.text()).not.toContain("secret");
    }
    expect((await api.fetch(new Request("http://local.test/v1/machines"))).status).toBe(401);
    expect((await json(await call(api, "/v1/machines"))).machines).toEqual([]);
    api.close();
  });
  test("invalid, missing, duplicate, unsupported and oversized requests", async () => {
    const { api } = setup();
    expect((await call(api, "/v1/machines/missing/heartbeat", "POST")).status).toBe(404);
    expect((await call(api, "/v1/not-found")).status).toBe(404);
    const wrongMethod = await call(api, "/v1/machines", "DELETE");
    expect(wrongMethod.status).toBe(405); expect(wrongMethod.headers.get("allow")).toBe("GET, POST");
    for (const value of [null, [], {}, {...input, id: "bad/id"}, {...input, sshPort: 0}, {...input, sshUser: "-bad"}, {...input, sshUser: ""}, {...input, sshUser: undefined}, {...input, password: "secret"}]) {
      expect((await call(api, "/v1/machines", "POST", value)).status).toBe(400);
    }
    expect((await call(api, "/v1/machines?os=")).status).toBe(400);
    expect((await call(api, "/v1/machines?os=x&os=y")).status).toBe(400);
    expect((await call(api, "/v1/machines?includePending=anything")).status).toBe(400);
    expect((await call(api, "/v1/machines?includePending=true&includePending=false")).status).toBe(400);
    expect((await call(api, "/v1/machines/missing/verify", "POST")).status).toBe(404);
    expect((await call(api, "/v1/machines/missing/verify", "POST", {})).status).toBe(400);
    expect((await call(api, "/v1/resources/%2F/messages")).status).toBe(400);
    expect((await call(api, "/v1/resources/x/messages", "POST", {author: "a", text: " "})).status).toBe(400);
    expect((await call(api, "/v1/machines", "POST", {...input, name: "x".repeat(17000)})).status).toBe(413);
    expect((await call(api, "/v1/machines/missing/heartbeat", "POST", {})).status).toBe(400);
    const malformed = await api.fetch(new Request("http://local.test/v1/machines", {method: "POST", headers: {authorization: "Bearer secret"}, body: "{"}));
    expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain("secret");
    const chunked = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16385)); c.close(); } });
    const big = await api.fetch(new Request("http://local.test/v1/machines", {method: "POST", headers: {authorization: "Bearer secret"}, body: chunked}));
    expect(big.status).toBe(413);
    api.close();
  });
});

describe("readiness gate", () => {
  test("verification uses the registered SSH target and controls visibility", async () => {
    const targets: ReadinessTarget[] = [];
    let succeeds = true;
    const { api } = setup(async (target) => {
      targets.push(target);
      return succeeds ? ready : { status: "not-ready", ready: false, message: "no sudo" };
    });
    try {
      const pending = (await json(await call(api, "/v1/machines", "POST", { ...input, sshPort: 2222 }))).machine;
      expect(pending.status).toBe("pending");
      expect((await json(await call(api, "/v1/machines?includePending=true&os=linux"))).machines).toEqual([pending]);
      expect((await json(await call(api, "/v1/machines?includePending=true&os=windows"))).machines).toEqual([]);
      const verified = await call(api, "/v1/machines/host-1/verify", "POST");
      expect(verified.status).toBe(200);
      const machine = (await json(verified)).machine;
      expect(machine.status).toBe("ready");
      expect(Number.isFinite(Date.parse(machine.verifiedAt ?? ""))).toBe(true);
      expect(targets).toEqual([{ host: input.host, user: input.sshUser, os: input.os, sshPort: 2222 }]);
      expect((await json(await call(api, "/v1/machines"))).machines).toEqual([machine]);
      succeeds = false;
      const failure = await call(api, "/v1/machines/host-1/verify", "POST");
      expect(failure.status).toBe(200);
      const failed = (await json(failure)).machine;
      expect(failed.status).toBe("not-ready");
      expect(failed.verifiedAt).toBeNull();
      expect(Number.isFinite(Date.parse(failed.checkedAt ?? ""))).toBe(true);
      expect((await json(await call(api, "/v1/machines"))).machines).toEqual([]);
      expect((await json(await call(api, "/v1/machines?includePending=true"))).machines).toEqual([]);
    } finally { api.close(); }
  });

  test("Windows verification forwards the registered target, including an optional relay", async () => {
    const targets: ReadinessTarget[] = [];
    const { api } = setup(async target => { targets.push(target); return ready; });
    try {
      const windows = { ...input, id: "win-relay", os: "WiNdOwS", sshPort: 2222, relayNodeId: "relay-1" };
      const direct = { ...input, id: "win-direct", os: "windows" };
      for (const machine of [windows, direct]) {
        const registered = await call(api, "/v1/machines", "POST", machine);
        expect(registered.status).toBe(202);
        expect((await json(registered)).machine.status).toBe("pending");
        const response = await call(api, `/v1/machines/${machine.id}/verify`, "POST");
        expect(response.status).toBe(200);
        const verified = (await json(response)).machine;
        expect(verified.status).toBe("ready");
        expect(Number.isFinite(Date.parse(verified.verifiedAt ?? ""))).toBe(true);
      }
      expect(targets).toEqual([
        { host: windows.host, user: windows.sshUser, os: "WiNdOwS", sshPort: 2222, relayNodeId: "relay-1" },
        { host: direct.host, user: direct.sshUser, os: "windows", sshPort: 22 },
      ]);
      const visible = (await json(await call(api, "/v1/machines"))).machines;
      expect(visible.map(machine => machine.id)).toEqual([windows.id, direct.id]);
    } finally { api.close(); }
  });

  test("Windows verification fails closed on verifier failures and clears prior readiness", async () => {
    const results: Array<ReadinessResult | Error> = [
      ready,
      { status: "not-ready", ready: false, message: "not administrator" },
      { status: "unsupported", ready: false, message: "unavailable" },
      { status: "ready", ready: false, message: "inconsistent" } as unknown as ReadinessResult,
      { status: "not-ready", ready: true, message: "inconsistent" } as unknown as ReadinessResult,
      new Error("secret verifier detail"),
    ];
    let attempts = 0;
    const { api } = setup(async () => {
      const result = results[attempts++];
      if (result instanceof Error) throw result;
      return result;
    });
    try {
      expect((await call(api, "/v1/machines", "POST", { ...input, os: "windows" })).status).toBe(202);
      expect((await json(await call(api, "/v1/machines/host-1/verify", "POST"))).machine.status).toBe("ready");
      expect((await json(await call(api, "/v1/machines"))).machines).toHaveLength(1);
      for (let i = 1; i < results.length; i++) {
        const response = await call(api, "/v1/machines/host-1/verify", "POST");
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("secret verifier detail");
        const machine = JSON.parse(text).machine as StoredMachine;
        expect(machine.status).toBe("not-ready");
        expect(machine.verifiedAt).toBeNull();
        expect(Number.isFinite(Date.parse(machine.checkedAt ?? ""))).toBe(true);
        expect((await json(await call(api, "/v1/machines?includePending=true"))).machines).toEqual([]);
      }
      expect(attempts).toBe(results.length);
    } finally { api.close(); }
  });

  test("unknown OS cannot become ready even when the verifier would succeed", async () => {
    let calls = 0;
    const { api } = setup(async () => { calls++; return ready; });
    try {
      expect((await call(api, "/v1/machines", "POST", { ...input, os: "plan9" })).status).toBe(202);
      const response = await call(api, "/v1/machines/host-1/verify", "POST");
      expect(response.status).toBe(200);
      const machine = (await json(response)).machine;
      expect(machine.status).toBe("not-ready");
      expect(machine.verifiedAt).toBeNull();
      expect(calls).toBe(0);
      expect((await json(await call(api, "/v1/machines?includePending=true"))).machines).toEqual([]);
    } finally { api.close(); }
  });

  test("expired readiness is not visible until verification succeeds again", async () => {
    const { api, dbPath } = setup();
    try {
      await call(api, "/v1/machines", "POST", input);
      await call(api, "/v1/machines/host-1/verify", "POST");
      const db = new Database(dbPath);
      try { db.query("UPDATE machines SET verifiedAt = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", input.id); }
      finally { db.close(); }
      expect((await json(await call(api, "/v1/machines"))).machines).toEqual([]);
      expect((await json(await call(api, "/v1/machines?includePending=true"))).machines).toEqual([]);
      const result = await call(api, "/v1/machines/host-1/verify", "POST");
      expect(result.status).toBe(200);
      expect((await json(result)).machine.status).toBe("ready");
      expect((await json(await call(api, "/v1/machines"))).machines).toHaveLength(1);
    } finally { api.close(); }
  });
});

test("verifier errors and unsupported operating systems fail closed", async () => {
  let count = 0;
  const { api } = setup(async () => { count++; throw new Error("secret verifier detail"); });
  try {
    await call(api, "/v1/machines", "POST", input);
    const result = await call(api, "/v1/machines/host-1/verify", "POST");
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).not.toContain("secret verifier detail");
    expect(JSON.parse(text).machine.status).toBe("not-ready");
    await call(api, "/v1/machines", "POST", { ...input, id: "unknown", os: "plan9" });
    const unsupported = await call(api, "/v1/machines/unknown/verify", "POST");
    expect(unsupported.status).toBe(200);
    expect((await json(unsupported)).machine.status).toBe("not-ready");
    expect(count).toBe(1);
    expect((await json(await call(api, "/v1/machines?includePending=true"))).machines).toEqual([]);
  } finally { api.close(); }
});

test("a slow older verification cannot overwrite a newer failure", async () => {
  let release!: (result: ReadinessResult) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  let attempt = 0;
  const { api } = setup(async () => {
    attempt++;
    if (attempt === 1) return ready;
    if (attempt === 2) {
      signalStarted();
      return await new Promise<ReadinessResult>(resolve => { release = resolve; });
    }
    return { status: "not-ready", ready: false, message: "failed" };
  });
  try {
    await call(api, "/v1/machines", "POST", input);
    await call(api, "/v1/machines/host-1/verify", "POST");
    expect((await json(await call(api, "/v1/machines"))).machines).toHaveLength(1);
    const older = call(api, "/v1/machines/host-1/verify", "POST");
    await started;
    expect((await json(await call(api, "/v1/machines"))).machines).toEqual([]);
    const newer = await call(api, "/v1/machines/host-1/verify", "POST");
    expect((await json(newer)).machine.status).toBe("not-ready");
    release(ready);
    expect((await json(await older)).machine.status).toBe("not-ready");
    expect((await json(await call(api, "/v1/machines?includePending=true"))).machines).toEqual([]);
  } finally { api.close(); }
});
