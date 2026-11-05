import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { collectDeviceRegistration, collectLocalDevice, DeviceRegistrationClient, type DeviceObservation } from "../src/device-registration.ts";
import { createMachineApi } from "../src/machine-api.ts";

const local = (platform: string): DeviceObservation => ({ hostname: "display-only-host", platform, arch: "arm64", sshUser: "agent", sshPort: 22 });
test("one collector path maps Linux/macOS/Windows without inventing a reachable address or wire architecture field", () => {
  for (const [platform, os] of [["linux", "linux"], ["darwin", "macos"], ["win32", "windows"]]) {
    const collected = collectDeviceRegistration({ id: "team-node", host: "reachable.example", sshPort: 2222 }, () => local(platform));
    assert.equal(collected.machine.os, os); assert.equal(collected.machine.host, "reachable.example"); assert.equal(collected.machine.name, "display-only-host");
    assert.equal(collected.machine.sshPort, 2222); assert.equal(collected.observation.arch, "arm64"); assert.equal(Object.hasOwn(collected.machine, "arch"), false);
  }
  assert.throws(() => collectDeviceRegistration({ id: "node", host: "" }, () => local("linux")));
  assert.throws(() => collectDeviceRegistration({ id: "node", host: "route" }, () => local("freebsd")));
  assert.throws(() => collectDeviceRegistration({ id: "node", host: "route", sshPort: 0 }, () => local("linux")));
  const actual = collectLocalDevice(); assert.ok(actual.hostname); assert.ok(actual.arch); assert.equal(actual.platform, process.platform);
});

test("real machine HTTP registration stays pending by default and explicit verification returns actual scope/state", async () => {
  const token = randomBytes(32).toString("hex"); let verifies = 0, ready = false;
  const api = createMachineApi({ dbPath: ":memory:", token, verifier: async () => { verifies++; return ready ? { status: "ready", ready: true, message: "fixture" } : { status: "not-ready", ready: false, message: "fixture" }; } });
  const requests: Array<{ path: string; body: string; method: string }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    requests.push({ path: new URL(request.url).pathname, body: await request.clone().text(), method: request.method }); return api.fetch(request);
  } });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`, client = new DeviceRegistrationClient({ baseUrl, token, fetch });
    const pending = await client.registerDevice({ id: "windows-node", host: "explicit.example", sshUser: "approved" }, {}, () => local("win32"));
    assert.equal(pending.machine.status, "pending"); assert.equal(pending.verificationRequested, false); assert.equal(pending.verificationScope, null); assert.equal(verifies, 0);
    assert.deepEqual(JSON.parse(requests[0].body), { id: "windows-node", name: "display-only-host", host: "explicit.example", os: "windows", sshUser: "approved", sshPort: 22 });
    const failed = await client.registerDevice({ id: "linux-node", host: "route.example" }, { verify: true }, () => local("linux"));
    assert.equal(failed.machine.status, "not-ready"); assert.match(failed.verificationScope!, /server.*SSH identity/); assert.equal(verifies, 1);
    ready = true;
    const verified = await client.registerDevice({ id: "mac-node", host: "mac.example", relayNodeId: "relay-a" }, { verify: true }, () => local("darwin"));
    assert.equal(verified.machine.status, "ready"); assert.equal(verified.machine.os, "macos"); assert.equal(verifies, 2);
    assert.ok(requests.filter(r => r.path.endsWith("/verify")).every(r => r.body === "" && r.method === "POST"));
    await assert.rejects(client.registerDevice({ id: "windows-node", host: "explicit.example" }, {}, () => local("win32")), error => (error as {status?:number}).status === 409);
    const wrong = new DeviceRegistrationClient({ baseUrl, token: "wrong-token", fetch });
    await assert.rejects(wrong.registerDevice({ id: "unauthorized", host: "route.example" }, {}, () => local("linux")), error => (error as {status?:number}).status === 401);
  } finally { await server.stop(true); api.close(); }
});
