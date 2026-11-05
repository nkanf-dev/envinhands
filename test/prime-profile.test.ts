import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createPrimeProfile } from "../src/integrations/prime-profile.ts";
import { runPrimeProfileCli } from "../src/prime-profile-cli.ts";

test("normal Prime profile includes observation and both skills independently of client workdir or CTF", () => {
  const env = resolve("env-source"), prime = resolve("prime-source");
  const profile = createPrimeProfile(env, prime);
  assert.equal(profile.extensions.length, 7);
  assert.ok(profile.extensions.some(path => path.endsWith("prime-attribution.ts")));
  assert.equal(profile.skills.length, 2);
  assert.ok(profile.skills.every(path => path.startsWith(env) && path.endsWith("SKILL.md")));
  assert.equal(new Set(profile.extensions).size, 7);
  const output: string[] = [], errors: string[] = [];
  const io = {write: (text: string) => output.push(text), error: (text: string) => errors.push(text)};
  assert.equal(runPrimeProfileCli([env, prime], io), 0);
  assert.deepEqual(JSON.parse(output[0]), profile);
  assert.equal(runPrimeProfileCli(["relative", prime], io), 1);
  assert.equal(errors.length, 1);
});
