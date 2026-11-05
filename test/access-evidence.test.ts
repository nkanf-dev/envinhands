import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createChangeApi } from "../src/change-api.ts";
import { createAccessEvidenceApi } from "../src/access-evidence-api.ts";
import { AccessEvidenceClient } from "../src/access-evidence-client.ts";
import { ChangeClient } from "../src/change-client.ts";
import { isClientAccessFresh } from "../src/client-access.ts";
import { Storage } from "../src/storage.ts";
import { parseAccessEvidence, type ClientAccessEvidence } from "../src/access-evidence-model.ts";

const registration = { registrationId: "registration-a", agentId: "agent-a", sessionId: "session-a", machineId: "client-a", signature: "Agent A" };
const evidence: ClientAccessEvidence = { registrationId: registration.registrationId, agentId: registration.agentId, sessionId: registration.sessionId, targetMachineId: "vm", routeId: "route-a",
  sshIdentityRef: "SHA256:" + "A".repeat(43), sshUser: "agent", hostKeyAlias: "trusted.host", os: "linux", checkedAt: "2026-11-05T20:00:00.000Z", expiresAt: "2026-11-05T20:00:00.100Z",
  ready: true, status: "ready", verificationScope: "actual-client-ssh-identity-and-route" };

test("ordinary HTTP persists per-registration/public-key observations across restart without marking the machine ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "access-evidence-api-")), dbPath = join(dir, "catalog.sqlite"), token = randomBytes(32).toString("hex");
  let changes = createChangeApi({ dbPath, token }), access = createAccessEvidenceApi({ dbPath, token });
  let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname === "/v1/access-evidence" ? access.fetch(req) : changes.fetch(req) });
  const storage = Storage.open(dbPath); storage.registerMachine({ id: "vm", name: "VM", host: "vm.local", os: "linux", sshUser: "agent" });
  try {
    const origin = () => `http://127.0.0.1:${server.port}`;
    let client = new AccessEvidenceClient({ baseUrl: origin(), token, fetch });
    await assert.rejects(client.submit("missing", evidence), error => (error as {status?:number}).status === 404);
    const registered = await new ChangeClient({ baseUrl: origin(), token, fetch }).register(registration);
    const first = await client.submit("request-a", evidence); assert.equal(first.duplicate, false); assert.deepEqual(first.record.registration, registered.registration);
    assert.equal((await client.submit("request-a", evidence)).duplicate, true);
    await assert.rejects(client.submit("request-a", { ...evidence, ready: false, status: "not-ready" }), error => (error as {status?:number}).status === 409);
    await assert.rejects(client.submit("wrong-session", { ...evidence, sessionId: "different" }), error => (error as {status?:number}).status === 409);
    await client.submit("replacement-key", { ...evidence, sshIdentityRef: "SHA256:" + "B".repeat(43), ready: false, status: "not-ready" });
    const page = await client.list({ registrationId: registration.registrationId, targetMachineId: "vm", limit: 1 }); assert.equal(page.records.length, 1); assert.equal(page.nextAfter, first.record.sequence);
    assert.equal((await client.list({ registrationId: "other-registration", targetMachineId: "vm" })).records.length, 0);
    const expected = { registrationId: evidence.registrationId, agentId: evidence.agentId, sessionId: evidence.sessionId, targetMachineId: evidence.targetMachineId, routeId: evidence.routeId,
      sshIdentityRef: evidence.sshIdentityRef, sshUser: evidence.sshUser, hostKeyAlias: evidence.hostKeyAlias };
    assert.equal(isClientAccessFresh(first.record.evidence, expected, Date.parse(evidence.expiresAt) - 1), true);
    assert.equal(isClientAccessFresh(first.record.evidence, expected, Date.parse(evidence.expiresAt)), false);
    const negative = await client.submit("same-key-negative", { ...evidence, ready: false, status: "not-ready" });
    const latest = await client.latest({ registrationId: evidence.registrationId, targetMachineId: "vm", routeId: evidence.routeId, sshIdentityRef: evidence.sshIdentityRef, sshUser: evidence.sshUser });
    assert.equal(latest!.sequence, negative.record.sequence); assert.equal(isClientAccessFresh(latest!.evidence, expected, Date.parse(evidence.checkedAt)), false);
    assert.equal(storage.getMachine("vm")!.status, "pending");
    await server.stop(true); changes.close(); access.close();
    changes = createChangeApi({ dbPath, token }); access = createAccessEvidenceApi({ dbPath, token });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname === "/v1/access-evidence" ? access.fetch(req) : changes.fetch(req) });
    client = new AccessEvidenceClient({ baseUrl: origin(), token, fetch });
    const restored = await client.list({ registrationId: registration.registrationId, targetMachineId: "vm", sshIdentityRef: evidence.sshIdentityRef }); assert.deepEqual(restored.records, [first.record, negative.record]);
    const denied = await fetch(origin() + "/v1/access-evidence?registrationId=registration-a&targetMachineId=vm"); assert.equal(denied.status, 401); await denied.body?.cancel();
    const malformed = await fetch(origin() + "/v1/access-evidence?registrationId=registration-a&targetMachineId=vm&after=01", { headers: {authorization:`Bearer ${token}`} }); assert.equal(malformed.status, 400); await malformed.body?.cancel();
    assert.throws(() => parseAccessEvidence({ ...evidence, expiresAt: "2026-11-05T20:10:00.000Z" }));
  } finally { await server.stop(true); changes.close(); access.close(); storage.close(); await rm(dir, { recursive: true, force: true }); }
});
