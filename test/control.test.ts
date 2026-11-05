import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createControlHandler } from "../src/control.ts";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer(createControlHandler());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

async function request(base: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() as any };
}

test("registration, discovery, and heartbeat record only observation time", async () => {
  await withServer(async (base) => {
    assert.deepEqual((await request(base, "/machines")).body, { machines: [] });
    const registered = await request(base, "/machines", "POST", { id: "nas", name: "NAS", host: "nas.local", os: "Debian" });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.machine.sshPort, 22);
    assert.equal(registered.body.machine.lastHeartbeatAt, null);
    assert.ok(!Number.isNaN(Date.parse(registered.body.machine.registeredAt)));
    assert.equal((await request(base, "/machines", "POST", { id: "nas", name: "NAS", host: "nas.local", os: "Debian" })).status, 409);
    assert.equal((await request(base, "/machines/missing/heartbeat", "POST")).status, 404);
    const beat = await request(base, "/machines/nas/heartbeat", "POST");
    assert.equal(beat.status, 200);
    assert.ok(!Number.isNaN(Date.parse(beat.body.machine.lastHeartbeatAt)));
    assert.equal((await request(base, "/machines?os=Debian")).body.machines.length, 1);
    assert.equal((await request(base, "/machines?os=Windows")).body.machines.length, 0);
    assert.equal((await request(base, "/machines")).body.machines[0].lastHeartbeatAt, beat.body.machine.lastHeartbeatAt);
  });
});

test("resource messages are scoped and carry author and time", async () => {
  await withServer(async (base) => {
    const posted = await request(base, "/resources/nas/messages", "POST", { author: "Ada", text: "Running a job" });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.message.resourceId, "nas");
    assert.equal(posted.body.message.author, "Ada");
    assert.ok(posted.body.message.id);
    assert.ok(!Number.isNaN(Date.parse(posted.body.message.createdAt)));
    assert.deepEqual((await request(base, "/resources/nas/messages")).body.messages, [posted.body.message]);
    assert.deepEqual((await request(base, "/resources/other/messages")).body.messages, []);
  });
});

test("validation, methods, and unknown routes", async () => {
  await withServer(async (base) => {
    for (const payload of [
      { id: "bad/id", name: "x", host: "h", os: "Linux" },
      { id: "ok", name: "", host: "h", os: "Linux" },
      { id: "ok", name: "x", host: "h", os: "Linux", sshPort: 65536 },
      { id: "ok", name: "x", host: "h", os: "Linux", password: "secret" },
    ]) assert.equal((await request(base, "/machines", "POST", payload)).status, 400);
    assert.equal((await request(base, "/resources/a/messages", "POST", { author: "x", text: " " })).status, 400);
    assert.equal((await request(base, "/machines/%2F/heartbeat", "POST")).status, 400);
    const malformed = await fetch(base + "/machines", { method: "POST", body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await request(base, "/machines", "POST", "x".repeat(17000))).status, 413);
    const invalidMethod = await request(base, "/machines", "DELETE");
    assert.equal(invalidMethod.status, 405);
    assert.equal(invalidMethod.headers.get("allow"), "GET, POST");
    assert.equal((await request(base, "/not-a-route")).status, 404);
  });
});

test("handlers do not share process-local state", async () => {
  await withServer(async (first) => {
    await request(first, "/machines", "POST", { id: "a", name: "A", host: "h", os: "Linux" });
    await withServer(async (second) => {
      assert.deepEqual((await request(second, "/machines")).body.machines, []);
    });
  });
});
