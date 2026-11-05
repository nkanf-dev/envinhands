import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage.ts";

const registration = { id: "nas", name: " NAS ", host: "nas.local", os: "Linux", sshUser: "admin" };

test("machines, heartbeat, and messages survive close and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "envinhands-storage-"));
  const path = join(dir, "state.sqlite");
  let store = Storage.open(path);
  try {
    const machine = store.registerMachine(registration);
    assert.equal(machine.name, "NAS");
    assert.equal(machine.sshPort, 22);
    assert.equal(machine.lastHeartbeatAt, null);
    assert.equal(machine.status, "pending");
    assert.equal(machine.sshUser, "admin");
    assert.equal(machine.verifiedAt, null);
    assert.ok(!Number.isNaN(Date.parse(machine.registeredAt)));
    const heartbeat = store.recordHeartbeat("nas");
    assert.ok(heartbeat.lastHeartbeatAt);
    assert.ok(!Number.isNaN(Date.parse(heartbeat.lastHeartbeatAt)));
    const message = store.addMessage("nas", " Ada ", " Running a job ");
    assert.equal(message.author, "Ada");
    assert.equal(message.text, "Running a job");
    assert.ok(!Number.isNaN(Date.parse(message.createdAt)));
    store.close();
    store = Storage.open(path);
    assert.deepEqual(store.getMachine("nas"), heartbeat);
    assert.deepEqual(store.listMachines(), [heartbeat]);
    assert.deepEqual(store.listMachines("Linux"), [heartbeat]);
    assert.deepEqual(store.listMachines("Windows"), []);
    assert.deepEqual(store.listMessages("nas"), [message]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resource messages stay isolated, ordered, and treat content as data", () => {
  const store = Storage.open(":memory:");
  try {
    const first = store.addMessage("nas", "Ada", "'; DROP TABLE machines; --");
    const other = store.addMessage("gpu", "Bob", "working");
    const second = store.addMessage("nas", "Eve", "done");
    assert.notEqual(first.id, second.id);
    assert.deepEqual(store.listMessages("nas"), [first, second]);
    assert.deepEqual(store.listMessages("gpu"), [other]);
    assert.deepEqual(store.listMessages("empty"), []);
    assert.deepEqual(store.listMachines(), []);
  } finally { store.close(); }
});

test("invalid inputs, duplicate ids, missing machines and closed storage fail", () => {
  const store = Storage.open(":memory:");
  try {
    assert.throws(() => store.registerMachine({ ...registration, id: "bad/id" }), /Invalid id/);
    assert.throws(() => store.registerMachine({ ...registration, name: "   " }), /Invalid name/);
    assert.throws(() => store.registerMachine({ ...registration, host: "x".repeat(254) }), /Invalid host/);
    assert.throws(() => store.registerMachine({ ...registration, sshPort: 0 }), /Invalid sshPort/);
    assert.throws(() => store.registerMachine({ ...registration, sshPort: 22.5 }), /Invalid sshPort/);
    store.registerMachine(registration);
    assert.throws(() => store.registerMachine(registration));
    assert.equal(store.getMachine("missing"), null);
    assert.throws(() => store.recordHeartbeat("missing"), /Machine not found/);
    assert.throws(() => store.addMessage("bad/id", "Ada", "text"), /Invalid resource id/);
    assert.throws(() => store.addMessage("nas", "", "text"), /Invalid author/);
    assert.throws(() => store.addMessage("nas", "Ada", "x".repeat(4001)), /Invalid text/);
    assert.throws(() => store.listMessages("nas' OR 1=1 --"), /Invalid resource id/);
    assert.deepEqual(store.listMessages("nas"), []);
  } finally { store.close(); }
  store.close();
  assert.throws(() => store.listMachines(), /Storage is closed/);
  assert.throws(() => store.registerMachine(registration), /Storage is closed/);
});

test("verification state is persisted and can be revoked", () => {
  const store = Storage.open(":memory:", 60_000);
  try {
    store.registerMachine(registration);
    const verified = store.recordVerification("nas", true);
    assert.equal(verified.status, "ready");
    assert.ok(verified.verifiedAt && !Number.isNaN(Date.parse(verified.verifiedAt)));
    assert.deepEqual(store.getMachine("nas"), verified);
    assert.deepEqual(store.listMachines(), [verified]);
    const failed = store.recordVerification("nas", false);
    assert.equal(failed.status, "not-ready");
    assert.equal(failed.verifiedAt, null);
    assert.ok(failed.checkedAt && !Number.isNaN(Date.parse(failed.checkedAt)));
    assert.equal(store.getMachine("nas")?.status, "not-ready");
    assert.throws(() => store.recordVerification("missing", true), /Machine not found/);
  } finally { store.close(); }
});

test("verification expiry is computed for both get and list, and re-verification restores readiness", () => {
  const dir = mkdtempSync(join(tmpdir(), "envinhands-expiry-"));
  const path = join(dir, "state.sqlite");
  const store = Storage.open(path, 60_000);
  try {
    store.registerMachine(registration);
    store.recordVerification("nas", true);
    const db = new Database(path);
    try { db.query("UPDATE machines SET verifiedAt = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "nas"); }
    finally { db.close(); }
    assert.equal(store.getMachine("nas")?.status, "not-ready");
    assert.equal(store.listMachines()[0].status, "not-ready");
    assert.equal(store.recordVerification("nas", true).status, "ready");
    assert.equal(store.getMachine("nas")?.status, "ready");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy database migrates without granting readiness or losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "envinhands-migration-"));
  const path = join(dir, "state.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE machines (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
    os TEXT NOT NULL, sshPort INTEGER NOT NULL, registeredAt TEXT NOT NULL, lastHeartbeatAt TEXT
  );
  CREATE TABLE resource_messages (id TEXT PRIMARY KEY NOT NULL, resourceId TEXT NOT NULL,
    author TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL);
  INSERT INTO machines VALUES ('old', 'Legacy', 'old.local', 'Linux', 22, '2020-01-01T00:00:00.000Z', NULL);
  INSERT INTO resource_messages VALUES ('msg', 'old', 'Ada', 'hello', '2020-01-02T00:00:00.000Z');`);
  db.close();
  let store = Storage.open(path);
  try {
    const legacy = store.getMachine("old");
    assert.ok(legacy);
    assert.equal(legacy.status, "not-ready");
    assert.equal(legacy.sshUser, null);
    assert.equal(legacy.verifiedAt, null);
    assert.equal(legacy.name, "Legacy");
    assert.equal(store.listMessages("old")[0].text, "hello");
    store.close();
    store = Storage.open(path);
    assert.deepEqual(store.getMachine("old"), legacy);
    assert.equal(store.listMessages("old").length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
