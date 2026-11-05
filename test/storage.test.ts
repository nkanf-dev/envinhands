import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/storage.ts";

const registration = { id: "nas", name: " NAS ", host: "nas.local", os: "Linux" };

test("machines, heartbeat, and messages survive close and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "envinhands-storage-"));
  const path = join(dir, "state.sqlite");
  let store = Storage.open(path);
  try {
    const machine = store.registerMachine(registration);
    assert.equal(machine.name, "NAS");
    assert.equal(machine.sshPort, 22);
    assert.equal(machine.lastHeartbeatAt, null);
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
