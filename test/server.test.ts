import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrimeBridge } from "../src/prime-bridge.ts";
import { startAgentBusServer } from "../src/server.ts";
import { createSignedFetch } from "../src/signed-fetch.ts";
import { NativeMesh, qualifiedAgentId, meshRequestId } from "../src/integrations/native-mesh.ts";
import { createChangeStore } from "../src/change-store.ts";

test("loopback HTTP server supports PrimeBridge and releases resources on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-server-"));
  const dbPath = join(dir, "bus.sqlite");
  const token = randomBytes(32).toString("hex");
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  try {
    server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    const address = new URL(server.url);
    expect(server.hostname).toBe("127.0.0.1");
    expect(address.protocol).toBe("http:");
    expect(address.hostname).toBe("127.0.0.1");
    expect(Number(address.port)).toBeGreaterThan(0);
    const unauthenticated = await fetch(`${server.url}/v1/agents`);
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.body?.cancel();
    const bridge = new PrimeBridge({ baseUrl: server.url, token, fetch });
    const wrongToken = new PrimeBridge({ baseUrl: server.url, token: "wrong-token", fetch });

    await expect(wrongToken.listAgents()).rejects.toMatchObject({ name: "BridgeError", status: 401 });
    await expect(wrongToken.send({ requestId: "bad", from: "alice", to: "bob", text: "no" }))
      .rejects.toMatchObject({ name: "BridgeError", status: 401 });
    await bridge.heartbeat({ agentId: "alice", machineId: "machine-a", task: "working" });
    const agents = await bridge.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agentId: "alice", machineId: "machine-a", task: "working", status: "observed" });
    expect(Number.isNaN(Date.parse(agents[0].lastHeartbeatAt))).toBe(false);

    // Omitting task clears the previous value; observations do not assert liveness.
    await bridge.heartbeat({ agentId: "alice", machineId: "machine-a" });
    const clearedAgents = await bridge.listAgents();
    expect(clearedAgents[0]).toMatchObject({ agentId: "alice", task: null, status: "observed" });

    // The bus/PrimeBridge allow slash IDs. The separate Prime extension has a
    // narrower ID grammar; this case is not proof of extension compatibility.
    const message = { requestId: "request/1", from: "alice", to: "bob", text: "hello over HTTP" };
    const postMessage = (value: typeof message) => fetch(`${server!.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const accepted = await postMessage(message);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ status: "accepted", duplicate: false });
    const duplicate = await postMessage(message);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ status: "accepted", duplicate: true });
    const conflict = await postMessage({ ...message, text: "conflicting content" });
    expect(conflict.status).toBe(409);
    await conflict.body?.cancel();
    expect(await bridge.pull("alice")).toEqual([]);
    expect(await bridge.pull("bob")).toEqual([message]);
    expect(await bridge.pull("bob")).toEqual([message]); // Pull does not acknowledge.
    await bridge.ack(message.requestId);
    await bridge.ack(message.requestId); // Ack retries are idempotent.
    expect(await bridge.pull("bob")).toEqual([]);

    const pending = { requestId: "request-2", from: "alice", to: "bob", text: "survives restart" };
    await bridge.send(pending);
    const stoppedUrl = server.url;
    await server.stop();
    await server.stop(); // Repeated shutdown is safe.
    await expect(fetch(`${stoppedUrl}/v1/agents`, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow();

    server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    const restarted = new PrimeBridge({ baseUrl: server.url, token, fetch });
    expect(await restarted.listAgents()).toEqual(clearedAgents);
    expect(await restarted.pull("bob")).toEqual([pending]);
    await restarted.send(message); // Acknowledged IDs stay idempotent across restart.
    expect(await restarted.pull("bob")).toEqual([pending]);
    await expect(restarted.send({ ...message, text: "conflict" })).rejects.toMatchObject({ name: "BridgeError", status: 409 });
    await restarted.ack(pending.requestId);
    expect(await restarted.pull("bob")).toEqual([]);
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("bind failure closes the opened bus database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-bind-failure-"));
  const dbPath = join(dir, "bus.sqlite");
  const token = randomBytes(32).toString("hex");
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  try {
    expect(() => startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: occupied.port })).toThrow();
    // On Linux, inspect open descriptors to verify the failed startup closed SQLite.
    // Descriptor entries may disappear between readdir and readlink.
    if (process.platform === "linux" && existsSync("/proc/self/fd")) {
      const openPaths = readdirSync("/proc/self/fd").flatMap((fd) => {
        try { return [readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
      });
      expect(openPaths.filter((path) => path === dbPath || path.startsWith(`${dbPath}-`))).toEqual([]);
    }
    // The same database remains usable by a subsequent successful startup.
    const server = startAgentBusServer({ dbPath, token, hostname: "127.0.0.1", port: 0 });
    try {
      const bridge = new PrimeBridge({ baseUrl: server.url, token, fetch });
      expect(await bridge.listAgents()).toEqual([]);
    } finally {
      await server.stop();
    }
  } finally {
    await occupied.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("machine catalog and notes share the real HTTP server and survive restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-machines-"));
  const dbPath = join(dir, "catalog.sqlite");
  const token = randomBytes(32).toString("hex");
  let server: ReturnType<typeof startAgentBusServer> | undefined;

  const call = (path: string, method = "GET", value?: unknown) => fetch(server!.url + path, {
    method, headers: {authorization: `Bearer ${token}`, ...(value ? {"content-type": "application/json"} : {})},
    ...(value ? {body: JSON.stringify(value)} : {}),
  });
  try {
    server = startAgentBusServer({dbPath, token, hostname: "127.0.0.1", port: 0});
    for (const path of ["/v1/machines", "/v1/resources/nas/messages"]) {
      for (const authorization of [undefined, "Bearer wrong-token"]) {
        const denied = await fetch(server.url + path, {
          headers: authorization === undefined ? {} : { authorization },
        });
        expect(denied.status).toBe(401);
        await denied.body?.cancel();
      }
    }
    expect((await call("/v1/machines", "POST", {id:"nas",name:"NAS",host:"127.0.0.1",os:"linux",sshUser:"agent"})).status).toBe(202);
    expect((await call("/v1/machines/nas/heartbeat", "POST")).status).toBe(200);
    const note = { author: "agent-a", text: "Test note" };
    const first = await call("/v1/resources/nas/messages", "POST", note);
    const second = await call("/v1/resources/nas/messages", "POST", note);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json() as { message: { id: string } };
    const secondBody = await second.json() as { message: { id: string } };
    // Notes have no requestId: retrying the same body creates a second note.
    expect(firstBody.message.id).not.toBe(secondBody.message.id);
    await server.stop();
    server = startAgentBusServer({dbPath, token, hostname: "127.0.0.1", port: 0});
    expect(((await (await call("/v1/machines")).json()) as {machines: unknown[]}).machines).toEqual([]);
    const machines = await (await call("/v1/machines?includePending=true")).json() as {machines: {id: string; lastHeartbeatAt: string | null}[]};
    expect(machines.machines[0].id).toBe("nas");
    expect(machines.machines[0].lastHeartbeatAt).toBeTruthy();
    const notes = await (await call("/v1/resources/nas/messages")).json() as {messages: {text: string}[]};
    expect(notes.messages).toHaveLength(2);
    expect(notes.messages.map(note => note.text)).toEqual(["Test note", "Test note"]);
  } finally { await server?.stop(); rmSync(dir, {recursive: true, force: true}); }
});


test("production server mounts profile notes and native mesh under declared mutation audit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "server-integrated-"));
  const dbPath = join(dir, "bus.sqlite"), token = randomBytes(32).toString("hex");
  const registration = {registrationId: "reg-integrated", agentId: "alice", sessionId: "session-a", machineId: "client-a", signature: "test declaration"};
  const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  const declared = {...headers, "x-envinhands-registration": Buffer.from(JSON.stringify(registration)).toString("base64url"), "x-envinhands-operation-id": "annotate-note"};
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  const start = () => startAgentBusServer({dbPath, token, hostname: "127.0.0.1", port: 0, requireSignedMutations: true});
  const raw = (path: string, method = "GET", body?: unknown, h: Record<string,string> = headers) => fetch(server!.url + path, {
    method, headers: h, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  try {
    server = start();
    const signed = createSignedFetch({baseUrl: server.url, fetch, registration: () => registration});
    const send = (path: string, body: unknown) => signed(server!.url + path, {method: "POST", headers, body: JSON.stringify(body)});
    const profile = "/v1/resources/nas/profile-notes", meshPath = "/v1/native-mesh/agents";
    const meshRegistration = {hostId: "host-a", agentId: "session-a", parentId: null, name: "Alice", state: "active" as const};
    for (const path of [profile, meshPath]) {
      expect((await raw(path, "GET", undefined, {})).status).toBe(401);
      expect((await raw(path, "GET", undefined, {authorization: "Bearer wrong"})).status).toBe(401);
    }
    // A bearer alone cannot mutate when declared attribution is required.
    expect((await raw(profile, "POST", {author: "alice", text: "unsigned", category: "issue"})).status).toBe(400);
    expect((await raw(meshPath, "POST", meshRegistration)).status).toBe(400);
    expect((await raw(profile)).status).toBe(200);
    expect(((await (await raw(profile)).json()) as {notes: unknown[]}).notes).toEqual([]);
    expect(((await (await raw(meshPath)).json()) as {agents: unknown[]}).agents).toEqual([]);

    // Legacy notes and profile notes share storage in both directions.
    const oldResponse = await send("/v1/resources/nas/messages", {author: "legacy", text: "old note"});
    expect(oldResponse.status).toBe(201);
    const oldId = ((await oldResponse.json()) as {message: {id: string}}).message.id;
    const annotation = await raw(profile + "/" + oldId, "PUT", {category: "issue", topic: "disk", annotatedBy: "alice"}, declared);
    expect(annotation.status).toBe(201);
    expect(((await annotation.json()) as {note: unknown}).note).toMatchObject({id: oldId, category: "issue", annotatedBy: "alice"});
    const noteResponse = await send(profile, {author: "alice", text: "replacement", category: "change", topic: "disk", replyTo: oldId});
    expect(noteResponse.status).toBe(201);
    const noteId = ((await noteResponse.json()) as {note: {id: string}}).note.id;
    const legacyNotes = ((await (await raw("/v1/resources/nas/messages")).json()) as {messages: {id: string}[]}).messages;
    expect(legacyNotes.map(n => n.id)).toEqual([oldId, noteId]);
    expect((await send(profile, {author: "alice", text: "bad reply", category: "change", replyTo: "missing"})).status).toBe(400);
    expect((await raw(profile + "?limit=0")).status).toBe(400);

    const mesh = new NativeMesh({baseUrl: server.url, token, fetch: signed});
    const alice = qualifiedAgentId("host-a", "session-a"), bob = qualifiedAgentId("host-b", "session-b");
    await mesh.register(meshRegistration);
    await mesh.register({hostId: "host-b", agentId: "session-b", parentId: alice, name: "Bob", state: "active"});
    expect((await mesh.discover()).map(a => a.id).sort()).toEqual([alice, bob].sort());
    const message = {senderId: alice, recipientId: bob, messageId: "msg-1", text: "hello"};
    await mesh.send(message);
    await mesh.send(message);
    await expect(mesh.send({...message, text: "conflict"})).rejects.toMatchObject({status: 409});
    expect(await mesh.pull(bob)).toHaveLength(1);
    // Existing bus API remains mounted beside both additions.
    expect((await raw("/v1/agents")).status).toBe(200);
    expect((await raw("/v1/machines")).status).toBe(200);
    await server.stop();
    server = start();
    const signedAgain = createSignedFetch({baseUrl: server.url, fetch, registration: () => registration});
    const restarted = new NativeMesh({baseUrl: server.url, token, fetch: signedAgain});
    const notes = ((await (await raw(profile + "?topic=disk")).json()) as {notes: {id: string; category: string; replyTo: string | null}[]}).notes;
    expect(notes.map(n => n.id)).toEqual([oldId, noteId]);
    expect(notes[0].category).toBe("issue");
    expect(notes[1].replyTo).toBe(oldId);
    expect((await restarted.discover()).map(a => a.id).sort()).toEqual([alice, bob].sort());
    const pending = await restarted.pull(bob);
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe(meshRequestId(alice, message.messageId));
    await restarted.ack(pending[0].requestId);
    expect(await restarted.pull(bob)).toEqual([]);
    const store = createChangeStore(dbPath);
    try {
      const records = store.list(0, 100).records;
      for (const resourceId of [profile, profile + "/" + oldId, meshPath]) {
        expect(records.some(r => r.resourceId === resourceId && r.outcome === "success" && r.registration.agentId === "alice")).toBe(true);
      }
      expect(JSON.stringify(records)).not.toContain("replacement");
    } finally { store.close(); }
  } finally { await server?.stop(); rmSync(dir, {recursive: true, force: true}); }
});

test("new API startup failures close earlier database handles", async () => {
  for (const name of ["resource_profile_metadata", "native_mesh_agents_v1"]) {
    const dir = mkdtempSync(join(tmpdir(), "server-api-init-failure-"));
    const dbPath = join(dir, "bus.sqlite"), token = randomBytes(32).toString("hex");
    try {
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE fixture (value INTEGER); CREATE INDEX ${name} ON fixture(value)`);
      db.close();
      let unexpectedlyStarted: ReturnType<typeof startAgentBusServer> | undefined;
      try {
        expect(() => { unexpectedlyStarted = startAgentBusServer({dbPath, token, hostname: "127.0.0.1", port: 0}); }).toThrow();
      } finally { await unexpectedlyStarted?.stop(); }
      if (process.platform === "linux" && existsSync("/proc/self/fd")) {
        const openPaths = readdirSync("/proc/self/fd").flatMap(fd => {
          try { return [readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
        });
        expect(openPaths.filter(path => path === dbPath || path.startsWith(`${dbPath}-`))).toEqual([]);
      }
      const repair = new Database(dbPath); repair.exec(`DROP INDEX ${name}`); repair.close();
      const server = startAgentBusServer({dbPath, token, hostname: "127.0.0.1", port: 0});
      try {
        expect((await fetch(server.url + "/v1/native-mesh/agents", {headers: {authorization: `Bearer ${token}`}})).status).toBe(200);
      } finally { await server.stop(); }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});


test("server lifecycle metadata ignores callback failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "server-lifecycle-"));
  const events: string[] = [];
  try {
    const server = startAgentBusServer({ dbPath: join(dir, "db"), token: "private-token", hostname: "127.0.0.1", port: 0,
      onEvent(event) { events.push(event); throw new Error("must not interrupt server"); } });
    await server.stop(); await server.stop();
    expect(events).toEqual(["server_started", "server_stopped"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
