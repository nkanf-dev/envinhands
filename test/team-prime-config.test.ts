import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTeamPrimeConfig, teamPrimeConfigPath, teamPrimeDiagnostics, validateTeamPrimeConfig, writeTeamPrimeConfig } from "../src/team-prime-config.ts";

const homes: string[] = [];
async function home() { const p = await fs.mkdtemp(join(tmpdir(), "team-prime-test-")); homes.push(p); return p; }
afterEach(async () => { for (const p of homes.splice(0)) await fs.rm(p, { recursive: true, force: true }); });
const value = { url: "https://mesh.example", token: "secret-test-value", machineId: "registered-node" };

describe("team Prime configuration", () => {
  test("validates origins, bearer tokens, and stable registration IDs without leaking values", () => {
    expect(validateTeamPrimeConfig({ url: "http://127.0.0.1:4200", token: "abc", machineId: "A-1" }).url).toBe("http://127.0.0.1:4200");
    expect(validateTeamPrimeConfig({ url: "https://example.com", token: "abc" }, "host-name").machineId).toBe("host-name");
    for (const input of [
      { ...value, url: "http://example.com" }, { ...value, url: "https://user:pw@example.com" },
      { ...value, url: "https://example.com/path" }, { ...value, url: "https://example.com/?x=1" },
      { ...value, url: "http://localhost.evil.example" }, { ...value, token: "secret\nvalue" },
      { ...value, machineId: "../../bad" }, { ...value, machineId: "bad space" },
    ]) { try { validateTeamPrimeConfig(input); throw new Error("unexpected success"); } catch (e) { expect(String(e)).not.toContain(input.token); expect(String(e)).toContain("Invalid"); } }
    expect(() => validateTeamPrimeConfig({ url: value.url, token: value.token }, "bad host")).toThrow("machineId");
  });
  test("writes only one private file, is idempotent and leaves team state intact", async () => {
    const h = await home(); await fs.mkdir(join(h, ".prime-team"), { mode: 0o700 });
    await fs.writeFile(join(h, ".prime-team", "unrelated.json"), "unchanged");
    expect(await readTeamPrimeConfig({ home: h })).toBeNull();
    const a = await writeTeamPrimeConfig(value, { home: h });
    expect(a.status).toBe("created"); expect(JSON.stringify(a)).not.toContain(value.token);
    expect(a.diagnostics.connectivity).toBe("not-tested");
    expect((await fs.stat(join(h, ".prime-team"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(teamPrimeConfigPath(h))).mode & 0o777).toBe(0o600);
    expect(await readTeamPrimeConfig({ home: h })).toEqual(value);
    expect((await writeTeamPrimeConfig(value, { home: h })).status).toBe("unchanged");
    expect(await fs.readdir(join(h, ".prime-team"))).toEqual(["envinhands-mesh.json", "unrelated.json"]);
    expect(await fs.readFile(join(h, ".prime-team", "unrelated.json"), "utf8")).toBe("unchanged");
  });
  test("refuses overwrite without explicit replace and changes only target", async () => {
    const h = await home(); await writeTeamPrimeConfig(value, { home: h });
    const changed = { ...value, token: "different-secret" };
    await expect(writeTeamPrimeConfig(changed, { home: h })).rejects.toThrow("explicit replace");
    expect(await readTeamPrimeConfig({ home: h })).toEqual(value);
    expect((await writeTeamPrimeConfig(changed, { home: h, replace: true })).status).toBe("replaced");
    expect(await readTeamPrimeConfig({ home: h })).toEqual(changed);
  });
  test("rejects symlink target, parent and ancestor, insecure mode and corrupt data", async () => {
    const h = await home(), elsewhere = await home();
    await fs.mkdir(join(h, ".prime-team"), { mode: 0o700 });
    const target = teamPrimeConfigPath(h); const external = join(elsewhere, "external");
    await fs.writeFile(external, "untouched"); await fs.symlink(external, target);
    await expect(writeTeamPrimeConfig(value, { home: h, replace: true })).rejects.toThrow();
    expect(await fs.readFile(external, "utf8")).toBe("untouched");
    await fs.unlink(target); await fs.rmdir(join(h, ".prime-team")); await fs.symlink(elsewhere, join(h, ".prime-team"));
    await expect(writeTeamPrimeConfig(value, { home: h })).rejects.toThrow();
    await fs.unlink(join(h, ".prime-team"));
    const alias = join(h, "alias"); await fs.symlink(elsewhere, alias);
    await expect(writeTeamPrimeConfig(value, { home: alias })).rejects.toThrow();
    await fs.mkdir(join(h, ".prime-team"), { mode: 0o755 }); await fs.chmod(join(h, ".prime-team"), 0o755);
    await expect(writeTeamPrimeConfig(value, { home: h })).rejects.toThrow();
    await fs.chmod(join(h, ".prime-team"), 0o700);
    await fs.writeFile(target, "{broken", { mode: 0o600 });
    await expect(writeTeamPrimeConfig(value, { home: h, replace: true })).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("{broken");
  });
  test("concurrent creators do not overwrite each other", async () => {
    const h = await home();
    const a = { ...value, machineId: "A" }, b = { ...value, machineId: "B" };
    const results = await Promise.allSettled([writeTeamPrimeConfig(a, { home: h }), writeTeamPrimeConfig(b, { home: h })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(["A", "B"]).toContain((await readTeamPrimeConfig({ home: h }))!.machineId);
    expect(await fs.readdir(join(h, ".prime-team"))).toEqual(["envinhands-mesh.json"]);
  });
  test("filesystem failure is sanitized and never prints token", async () => {
    const h = await home(); await fs.writeFile(join(h, ".prime-team"), "block");
    try { await writeTeamPrimeConfig(value, { home: h }); throw new Error("unexpected success"); } catch (e) { expect(String(e)).not.toContain(value.token); expect(String(e)).toContain("securely"); }
  });
  test("memory/write failure removes temporary file and preserves old target", async () => {
    const h = await home(); await writeTeamPrimeConfig(value, { home: h });
    const before = await fs.readFile(teamPrimeConfigPath(h), "utf8");
    const testHooks = { beforeTempWrite: () => { throw Object.assign(new Error(value.token), { code: "ENOMEM" }); } };
    try { await writeTeamPrimeConfig({ ...value, machineId: "new" }, { home: h, replace: true, testHooks }); throw Error("unexpected success"); }
    catch (e) { expect(String(e)).not.toContain(value.token); expect(String(e)).toContain("securely"); }
    expect(await fs.readFile(teamPrimeConfigPath(h), "utf8")).toBe(before);
    expect(await fs.readdir(join(h, ".prime-team"))).toEqual(["envinhands-mesh.json"]);
  });
  test("loopback reports SSH dependency, not tunnel or connection", () => {
    const a = teamPrimeDiagnostics("http://127.0.0.1:4242", () => false);
    expect(a).toMatchObject({ tunnel: "possibly-required", ssh: "missing-or-unusable", connectivity: "not-tested" });
    expect(a.message).toContain("running SSH tunnel");
    const b = teamPrimeDiagnostics("http://127.0.0.1:4242", () => true);
    expect(b.ssh).toBe("available"); expect(b.connectivity).toBe("not-tested");
    expect(teamPrimeDiagnostics(value.url, () => { throw Error(); }).ssh).toBe("not-checked");
  });

  test("relay validates safe URLs and secrets without disclosing either credential", () => {
    const relay = { url: "wss://relay.example/ws", secret: "relay secret" };
    expect(validateTeamPrimeConfig({ ...value, relay }).relay).toEqual(relay);
    expect(validateTeamPrimeConfig({ ...value, relay: { ...relay, url: "ws://127.0.0.1:3999" } }).relay?.url).toBe("ws://127.0.0.1:3999/");
    for (const url of ["ws://relay.example", "https://relay.example", "wss://user:pass@relay.example", "wss://relay.example/x?q=a", "wss://relay.example/x#f", "wss://relay.example/x?"]) {
      expect(() => validateTeamPrimeConfig({ ...value, relay: { ...relay, url } })).toThrow("Invalid relay url");
    }
    for (const secret of ["", "  ", "bad\nsecret"]) expect(() => validateTeamPrimeConfig({ ...value, relay: { ...relay, secret } })).toThrow("Invalid relay secret");
    expect(() => validateTeamPrimeConfig({ ...value, relay: { url: relay.url } as any })).toThrow("Invalid relay secret");
  });
  test("relay add preserves old control, omitted relay preserves it; conflict needs replace", async () => {
    const h = await home(), relay = { url: "wss://relay.example/ws", secret: "relay-secret" };
    await writeTeamPrimeConfig(value, { home: h });
    expect(await readTeamPrimeConfig({ home: h })).toEqual(value);
    expect((await writeTeamPrimeConfig({ ...value, relay }, { home: h })).status).toBe("replaced");
    expect(await readTeamPrimeConfig({ home: h })).toEqual({ ...value, relay });
    expect((await writeTeamPrimeConfig(value, { home: h })).status).toBe("unchanged");
    const changed = { ...relay, secret: "new-secret" };
    await expect(writeTeamPrimeConfig({ ...value, relay: changed }, { home: h })).rejects.toThrow("explicit replace");
    expect((await readTeamPrimeConfig({ home: h }))?.relay).toEqual(relay);
    expect((await writeTeamPrimeConfig({ ...value, relay: changed }, { home: h, replace: true })).status).toBe("replaced");
    expect((await readTeamPrimeConfig({ home: h }))?.relay).toEqual(changed);
    await writeTeamPrimeConfig({ ...value, url: "https://other.example" }, { home: h, replace: true });
    expect((await readTeamPrimeConfig({ home: h }))?.relay).toBeUndefined();
  });
  test("concurrent relay additions cannot silently clobber existing or each other", async () => {
    const h = await home(); await writeTeamPrimeConfig(value, { home: h });
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { started = r; });
    const relay1 = { url: "wss://relay.example/one", secret: "one" }, relay2 = { url: "wss://relay.example/two", secret: "two" };
    const first = writeTeamPrimeConfig({ ...value, relay: relay1 }, { home: h, testHooks: { beforeTempWrite: async () => { started(); await waiting; } } });
    await entered;
    await expect(writeTeamPrimeConfig({ ...value, relay: relay2 }, { home: h })).rejects.toThrow("locked");
    release(); await first;
    await expect(writeTeamPrimeConfig({ ...value, relay: relay2 }, { home: h })).rejects.toThrow("explicit replace");
    expect((await readTeamPrimeConfig({ home: h }))?.relay).toEqual(relay1);
    expect(await fs.readdir(join(h, ".prime-team"))).toEqual(["envinhands-mesh.json"]);
  });

  test("Windows mock forwards relay and preserves and replaces it by adapter contract", async () => {
    const h = await home(); let stored: import("../src/team-prime-config.ts").TeamPrimeConfig | undefined;
    const runner = (op: "read" | "write", _home: string, config?: import("../src/team-prime-config.ts").TeamPrimeConfig, replace?: boolean) => {
      if (op === "read") return stored ? JSON.stringify(stored) : "missing";
      if (!stored) { stored = config; return "created"; }
      const sameControl = stored.url === config!.url && stored.token === config!.token && stored.machineId === config!.machineId;
      const merged = { ...config!, relay: config!.relay ?? (sameControl ? stored.relay : undefined) };
      if (JSON.stringify(stored) === JSON.stringify(merged)) return "unchanged";
      if (!replace && (!sameControl || (stored.relay && JSON.stringify(stored.relay) !== JSON.stringify(merged.relay)))) return "exists";
      stored = merged; return "replaced";
    };
    const options = { home: h, platform: "win32" as const, windowsRunner: runner };
    const relay = { url: "wss://relay.example/socket", secret: "windows-secret" };
    expect((await writeTeamPrimeConfig(value, options)).status).toBe("created");
    expect((await writeTeamPrimeConfig({ ...value, relay }, options)).status).toBe("replaced");
    expect((await readTeamPrimeConfig(options))?.relay).toEqual(relay);
    expect((await writeTeamPrimeConfig(value, options)).status).toBe("unchanged");
    await expect(writeTeamPrimeConfig({ ...value, relay: { ...relay, secret: "changed" } }, options)).rejects.toThrow("explicit replace");
    expect((await writeTeamPrimeConfig({ ...value, relay: { ...relay, secret: "changed" } }, { ...options, replace: true })).status).toBe("replaced");
  });
  test("Windows adapter is exercised with mock only, not a Windows integration test", async () => {
    const h = await home(); let stored: typeof value | undefined;
    const runner = (op: "read" | "write", _home: string, config?: typeof value, replace?: boolean) => {
      if (op === "read") return stored ? JSON.stringify(stored) : "missing";
      if (stored && JSON.stringify(stored) === JSON.stringify(config)) return "unchanged";
      if (stored && !replace) return "exists";
      const result = stored ? "replaced" : "created"; stored = config; return result;
    };
    const options = { home: h, platform: "win32" as const, windowsRunner: runner };
    expect((await writeTeamPrimeConfig(value, options)).status).toBe("created");
    expect(await readTeamPrimeConfig(options)).toEqual(value);
    await expect(writeTeamPrimeConfig({ ...value, machineId: "B" }, options)).rejects.toThrow("explicit replace");
    expect((await writeTeamPrimeConfig({ ...value, machineId: "B" }, { ...options, replace: true })).status).toBe("replaced");
    await expect(writeTeamPrimeConfig(value, { ...options, windowsRunner: () => { throw Error(value.token); } })).rejects.not.toThrow(value.token);
  });
});
