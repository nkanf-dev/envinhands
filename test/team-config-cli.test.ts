import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTeamConfigCli, type TeamConfigCliDeps } from "../src/team-config-cli.ts";
import { readTeamPrimeConfig, teamPrimeConfigPath, writeTeamPrimeConfig } from "../src/team-prime-config.ts";

const homes: string[] = [];
async function home() { const h = await fs.mkdtemp(join(tmpdir(), "team-cli-test-")); homes.push(h); return h; }
afterEach(async () => { for (const h of homes.splice(0)) await fs.rm(h, { recursive: true, force: true }); });
const secret = "fictional-secret-123";
const env = { ENVINHANDS_URL: "https://mesh.example", ENVINHANDS_TOKEN: secret, ENVINHANDS_MACHINE_ID: "registered-node" };
async function cli(args: string[], vars: NodeJS.ProcessEnv, deps: TeamConfigCliDeps) {
  let stdout = "", stderr = "";
  const code = await runTeamConfigCli(args, vars, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, deps);
  return { code, stdout, stderr };
}

describe("team config CLI", () => {
  test("creates and reuses mesh config without touching upstream or sessions", async () => {
    const h = await home();
    await fs.mkdir(join(h, ".prime-team", "agent", "sessions"), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(h, ".prime-team", "agent", "config.toml"), "upstream config");
    await fs.writeFile(join(h, ".prime-team", "agent", "sessions", "one.json"), "session data");
    const first = await cli([], env, { home: h });
    expect(first.code).toBe(0); expect(first.stdout).toContain("status: created");
    expect(first.stdout).toContain(`path: ${teamPrimeConfigPath(h)}`);
    expect(first.stdout).toContain("connectivity=not-tested");
    expect(first.stdout + first.stderr).not.toContain(secret);
    expect((await cli([], env, { home: h })).stdout).toContain("status: unchanged");
    expect(await fs.readFile(join(h, ".prime-team", "agent", "config.toml"), "utf8")).toBe("upstream config");
    expect(await fs.readFile(join(h, ".prime-team", "agent", "sessions", "one.json"), "utf8")).toBe("session data");
    expect((await fs.readdir(join(h, ".prime-team"))).sort()).toEqual(["agent", "envinhands-mesh.json"]);
  });
  test("does not create an agent profile and falls back to detected hostname", async () => {
    const h = await home();
    const vars = { ENVINHANDS_URL: env.ENVINHANDS_URL, ENVINHANDS_TOKEN: secret };
    expect((await cli([], vars, { home: h, detectedHostname: "host-01" })).code).toBe(0);
    expect((await readTeamPrimeConfig({ home: h }))?.machineId).toBe("host-01");
    expect(await fs.readdir(join(h, ".prime-team"))).toEqual(["envinhands-mesh.json"]);
  });
  test("rejects conflict and permits only explicit --replace", async () => {
    const h = await home(); await cli([], env, { home: h });
    const changed = { ...env, ENVINHANDS_TOKEN: "fictional-other-secret" };
    const rejected = await cli([], changed, { home: h });
    expect(rejected.code).toBe(1); expect(rejected.stderr).toContain("--replace");
    expect((await readTeamPrimeConfig({ home: h }))?.token).toBe(secret);
    expect((await cli(["--replace=true"], changed, { home: h })).code).toBe(2);
    expect((await cli(["--replace", "--replace"], changed, { home: h })).code).toBe(2);
    const replaced = await cli(["--replace"], changed, { home: h });
    expect(replaced.code).toBe(0); expect(replaced.stdout).toContain("status: replaced");
    expect((await readTeamPrimeConfig({ home: h }))?.token).toBe(changed.ENVINHANDS_TOKEN);
    expect(rejected.stdout + rejected.stderr + replaced.stdout + replaced.stderr).not.toContain(changed.ENVINHANDS_TOKEN);
  });
  test("handles empty or partial environment and help without writing or leaking arguments", async () => {
    const h = await home();
    for (const vars of [{}, { ENVINHANDS_URL: env.ENVINHANDS_URL }, { ENVINHANDS_TOKEN: secret }, { ...env, ENVINHANDS_TOKEN: "  " }]) {
      const result = await cli([], vars, { home: h });
      expect(result.code).toBe(2); expect(result.stderr).toContain("Missing required environment variables");
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    const badArgs = await cli([secret], env, { home: h });
    expect(badArgs.code).toBe(2); expect(badArgs.stderr).not.toContain(secret);
    expect((await cli(["--help"], {}, { home: h })).stdout).toContain("ENVINHANDS_TOKEN");
    expect(await fs.readdir(h)).toEqual([]);
  });
  test("reports invalid input and errors safely, without writing logs or secret", async () => {
    const h = await home();
    const invalid = await cli([], { ...env, ENVINHANDS_URL: `https://${secret}@mesh.example` }, { home: h });
    expect(invalid.code).toBe(1); expect(invalid.stderr).toContain("Invalid ENVINHANDS_URL");
    expect(invalid.stdout + invalid.stderr).not.toContain(secret);
    const failure = await cli([], env, { home: h, write: async () => { throw Error(`timeout ${secret}`); } });
    expect(failure.code).toBe(1); expect(failure.stderr).toContain("timed out");
    expect(failure.stdout + failure.stderr).not.toContain(secret);
    expect(await fs.readdir(h)).toEqual([]);
  });
  test("redacts token even from injected output and uses the same Windows writer adapter", async () => {
    const h = await home(); let stored = false;
    const write: typeof writeTeamPrimeConfig = async (input, options) => writeTeamPrimeConfig(input, {
      ...options, platform: "win32", windowsRunner: () => stored ? "unchanged" : (stored = true, "created"),
    });
    const result = await cli([], env, { home: h, write });
    expect(result.code).toBe(0); expect(result.stdout).toContain("status: created");
    expect((await cli([], env, { home: h, write })).stdout).toContain("status: unchanged");
    const inject: typeof writeTeamPrimeConfig = async () => ({ status: "created", path: `/mock/${secret}`, diagnostics: { connectivity: "not-tested", tunnel: "not-inferred", ssh: "not-checked", message: secret } });
    const redacted = await cli([], env, { home: h, write: inject });
    expect(redacted.stdout).not.toContain(secret); expect(redacted.stdout).toContain("[REDACTED]");
    expect(await fs.readdir(h)).toEqual([]);
  });
});
