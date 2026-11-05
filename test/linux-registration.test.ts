import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyLinuxRegistration, prepareLinuxRegistration } from "../src/registration/linux.ts";

// A synthetic public wire blob; no private key or filesystem access is involved.
const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]);
const key = `ssh-ed25519 ${blob.toString("base64")}`;
const input = { user: "alice", publicKey: key };

test("plan is deterministic, explicit about full root access, and not ready", () => {
  const plan = prepareLinuxRegistration(input);
  assert.deepEqual(plan, prepareLinuxRegistration(input));
  assert.equal(plan.publicKey, key);
  assert.equal(plan.fingerprint, `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`);
  assert.equal(plan.sudoersPath, "/etc/sudoers.d/envinhands-alice");
  assert.equal(plan.sudoersContent, "alice ALL=(ALL:ALL) NOPASSWD: ALL\n");
  assert.equal(plan.ready, false);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.steps));
  assert.match(plan.steps.join(" "), /visudo/);
  assert.match(plan.steps.join(" "), /symlinks/);
  assert.match(plan.rollback.join(" "), /pre-existing keys/);
});

test("username, input shape and unsupported key formats fail closed", () => {
  for (const user of ["", "root", "-alice", "alice;id", "alice\nroot", "alice\n", "a/b", "a.b", "a b", "A", "a".repeat(33), "alice$"]) {
    assert.throws(() => prepareLinuxRegistration({ ...input, user }));
  }
  for (const publicKey of ["", key + " comment", key + "\n", key.replace("ssh-ed25519", "ssh-rsa"),
    `command=bad ${key}`, "-----BEGIN OPENSSH PRIVATE KEY-----", "ssh-ed25519 !!!!", "ssh-ed25519 AAAA",
    `ssh-ed25519 ${blob.toString("base64")}=`]) {
    assert.throws(() => prepareLinuxRegistration({ ...input, publicKey }));
  }
  assert.throws(() => prepareLinuxRegistration({ ...input, home: "/tmp" } as never));
  assert.throws(() => prepareLinuxRegistration(null as never));
});

test("wire length, algorithm bytes and key length are checked", () => {
  for (const offset of [3, 4, 18]) {
    const modified = Buffer.from(blob); modified[offset] ^= 1;
    assert.throws(() => prepareLinuxRegistration({ ...input, publicKey: `ssh-ed25519 ${modified.toString("base64")}` }));
  }
  const extra = Buffer.concat([blob, Buffer.from([0])]);
  assert.throws(() => prepareLinuxRegistration({ ...input, publicKey: `ssh-ed25519 ${extra.toString("base64")}` }));
});

test("apply is explicitly blocked even with malformed or forged plans", async () => {
  for (const plan of [prepareLinuxRegistration(input), null, { ready: true }]) {
    const result = await applyLinuxRegistration(plan as never);
    assert.equal(result.status, "blocked"); assert.equal(result.ready, false);
    assert.match(result.message, /No changes were made/);
    assert.match(result.message, /visudo/);
  }
});
