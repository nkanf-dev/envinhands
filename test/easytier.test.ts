import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { startEasyTier, type EasyTierRunner } from "../src/transports/easytier";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function config(mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), "env-easytier-test-")); dirs.push(dir);
  const path = join(dir, "config.toml");
  await writeFile(path, '[network_identity]\nnetwork_name="test"\nnetwork_secret="secret-test"\n', { mode });
  await chmod(path, mode); return path;
}
function mock() {
  const child = new EventEmitter() as ChildProcess;
  const calls: Parameters<EasyTierRunner>[] = [], signals: unknown[] = [];
  child.kill = ((signal: unknown) => { signals.push(signal); return true; }) as ChildProcess["kill"];
  const runner: EasyTierRunner = (...args) => { calls.push(args); return child; };
  return { child, calls, runner, signals };
}
const target = { interfaceName: "tun0", localIp: "10.8.0.1", remoteIp: "10.8.0.2",
  access: { user: "test", hostKeyAlias: "host.test" } };

describe("EasyTier sidecar", () => {
  test("launches a private config with no secrets in argv, no shell or output, and follows exit", async () => {
    const path = await config(), m = mock();
    const pending = startEasyTier({ configPath: path }, m.runner);
    // Config checks perform asynchronous I/O.
    await Bun.sleep(10);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]![0]).toBe("easytier-core");
    expect(m.calls[0]![1]).toEqual(["--config-file", path, "--file-log-level", "off", "--console-log-level", "off", "--disable-env-parsing"]);
    expect(JSON.stringify(m.calls[0]![1])).not.toContain("secret-test");
    expect(m.calls[0]![2]).toMatchObject({ shell: false, stdio: "ignore", windowsHide: true });
    m.child.emit("spawn"); const p = await pending;
    expect(p.stop()).toBe(true); expect(p.stop()).toBe(false);
    m.child.emit("exit", null, "SIGTERM");
    expect(await p.exited).toEqual({ kind: "exit", code: null, signal: "SIGTERM" });
  });
  test("rejects public files and symlinks before starting", async () => {
    const path = await config(0o644), m = mock();
    await expect(startEasyTier({ configPath: path }, m.runner)).rejects.toThrow("owner-only");
    await chmod(path, 0o600); const link = path + ".link"; await symlink(path, link);
    await expect(startEasyTier({ configPath: link }, m.runner)).rejects.toThrow("owner-only");
    expect(m.calls).toHaveLength(0);
  });
  test("rejects missing fixed network credentials", async () => {
    const path = await config(), m = mock();
    await writeFile(path, '[network_identity]\nnetwork_name="fixed"\n');
    await expect(startEasyTier({ configPath: path }, m.runner)).rejects.toThrow("fixed network credentials");
    expect(m.calls).toHaveLength(0);
  });
  test("drops ET environment overrides and sanitizes process errors", async () => {
    const path = await config(), m = mock(); process.env.ET_NETWORK_SECRET = "env-secret";
    try {
      const pending = startEasyTier({ configPath: path }, m.runner); await Bun.sleep(10);
      expect(m.calls[0]![2].env.ET_NETWORK_SECRET).toBeUndefined();
      m.child.emit("error", new Error("private error"));
      await expect(pending).rejects.toThrow("Failed to start EasyTier");
    } finally { delete process.env.ET_NETWORK_SECRET; }
  });
  test("requires route validation, authenticated SSH and a live process", async () => {
    const path = await config(), m = mock(), calls: unknown[] = [];
    const dependencies = {
      route: async (...args: string[]) => { calls.push(["route", ...args]); return true; },
      ssh: async (cmd: string, args: readonly string[]) => { calls.push([cmd, args]); return { exitCode: 0 }; },
    };
    const pending = startEasyTier({ configPath: path }, m.runner, dependencies); await Bun.sleep(10); m.child.emit("spawn");
    const p = await pending; const result = await p.probeSsh(target);
    expect(result.status).toBe("healthy"); expect(result.argv?.slice(0, 2)).toEqual(["-b", target.localIp]);
    expect(result.argv).toContain("StrictHostKeyChecking=yes");
    expect(calls).toHaveLength(3); expect((calls[1] as [string, string[]])[1].at(-1)).toBe("true");
    m.child.emit("exit", 0, null); expect((await p.probeSsh(target)).status).toBe("failed");
  });
  test("route failure or SSH failure never reports healthy", async () => {
    const path = await config(), m = mock(); let routeOK = false, sshCode = 0, sshCalls = 0;
    const pending = startEasyTier({ configPath: path }, m.runner, {
      route: async () => routeOK, ssh: async () => { sshCalls++; return { exitCode: sshCode }; },
    }); await Bun.sleep(10); m.child.emit("spawn"); const p = await pending;
    expect((await p.probeSsh(target)).status).toBe("failed"); expect(sshCalls).toBe(0);
    routeOK = true; sshCode = 1; expect((await p.probeSsh(target)).status).toBe("failed");
    expect((await p.probeSsh({ ...target, remoteIp: "127.0.0.1;bad" })).status).toBe("failed");
    p.stop(); m.child.emit("exit", 0, null);
  });
});
