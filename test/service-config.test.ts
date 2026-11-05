import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { loadServiceConfig } from "../src/service-config.ts";

test("private exact service config loads unchanged; malformed, oversized and public Unix mode reject without leaking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-service-config-"));
  const path = join(dir, "config.json"), token = randomBytes(32).toString("hex");
  const config = { hostname: "127.0.0.1", port: 0, dbPath: join(dir, "bus.sqlite"), token };
  try {
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    expect(await loadServiceConfig(path)).toEqual(config);
    for (const value of [{ ...config, extra: token }, { ...config, port: -1 }, { ...config, dbPath: "relative" }, { ...config, token: "bad token" }, { ...config, hostname: "" }, { ...config, dbPath: path }, { ...config, token: "x".repeat(17000) }]) {
      await writeFile(path, JSON.stringify(value));
      try { await loadServiceConfig(path); throw new Error("Invalid config accepted"); }
      catch (error) { expect(String(error)).toContain("Service configuration"); expect(String(error)).not.toContain(token); }
    }
    await expect(loadServiceConfig("relative.json")).rejects.toThrow("Service configuration");
    await writeFile(path, JSON.stringify(config));
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(loadServiceConfig(path)).rejects.toThrow("Service configuration");
      await chmod(path, 0o600);
      expect(await loadServiceConfig(path)).toEqual(config);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
