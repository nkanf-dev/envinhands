import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTmuxRelayArgv, type TmuxRelayOptions } from "../src/session/tmux-relay.ts";

const valid: TmuxRelayOptions = { nodeId: "node-1", sessionKey: "work", binaryPath: "/opt/envinhands" };

describe("tmux relay SSH argv", () => {
  test("builds structured ssh options and a stable known-hosts identity", () => {
    if (process.platform === "win32") {
      expect(() => buildTmuxRelayArgv(valid)).toThrow(/Windows.*unsupported/i);
      return;
    }
    const argv = buildTmuxRelayArgv({ ...valid, user: "alice", sshExecutable: "/usr/bin/ssh" });
    expect(argv.slice(0, 8)).toEqual([
      "/usr/bin/ssh", "-tt", "-o", "StrictHostKeyChecking=yes",
      "-o", "ProxyCommand='/opt/envinhands' proxy 'node-1'", "-l", "alice",
    ]);
    expect(argv.slice(-5)).toEqual(["tmux", "new-session", "-A", "-s", "envinhands-work"]);
    const host = argv[8];
    expect(host).toMatch(/^envinhands-[a-f0-9]{32}\.[a-f0-9]{32}$/);
    expect(buildTmuxRelayArgv({ ...valid, sessionKey: "other" })[6]).toBe(host);
    expect(buildTmuxRelayArgv({ ...valid, nodeId: "node-2" })[6]).not.toBe(host);
    expect(argv.join(" ")).not.toMatch(/StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/i);
  });

  test("does not read or include relay secrets or URLs in argv", () => {
    const secret = "sensitive-secret-not-an-option";
    const url = "wss://relay.example/private";
    const beforeSecret = process.env.ENVINHANDS_RELAY_SECRET;
    const beforeUrl = process.env.ENVINHANDS_RELAY_URL;
    try {
      process.env.ENVINHANDS_RELAY_SECRET = secret;
      process.env.ENVINHANDS_RELAY_URL = url;
      if (process.platform === "win32") {
        expect(() => buildTmuxRelayArgv(valid)).toThrow(/Windows.*unsupported/i);
        return;
      }
      const argv = buildTmuxRelayArgv(valid).join(" ");
      expect(argv).not.toContain(secret);
      expect(argv).not.toContain(url);
    } finally {
      if (beforeSecret === undefined) delete process.env.ENVINHANDS_RELAY_SECRET;
      else process.env.ENVINHANDS_RELAY_SECRET = beforeSecret;
      if (beforeUrl === undefined) delete process.env.ENVINHANDS_RELAY_URL;
      else process.env.ENVINHANDS_RELAY_URL = beforeUrl;
    }
  });

  test("rejects unsafe and malformed input, including trailing newlines", () => {
    for (const nodeId of ["", ".abc", "a b", "a;id", "a$(id)", "a\n", "a/b", "é", "a".repeat(129)]) {
      expect(() => buildTmuxRelayArgv({ ...valid, nodeId })).toThrow();
    }
    for (const sessionKey of ["", "-bad", "a b", "a;id", "a\n", "a".repeat(65)]) {
      expect(() => buildTmuxRelayArgv({ ...valid, sessionKey })).toThrow();
    }
    for (const user of ["", "-bad", "a b", "a;id", "a\n", "a".repeat(33)]) {
      expect(() => buildTmuxRelayArgv({ ...valid, user })).toThrow();
    }
    for (const binaryPath of ["", "relative", "/tmp/a\0b", "/tmp/a\nb"]) {
      expect(() => buildTmuxRelayArgv({ ...valid, binaryPath })).toThrow();
    }
    expect(() => buildTmuxRelayArgv({ ...valid, sshExecutable: "" })).toThrow();
    expect(() => buildTmuxRelayArgv({ ...valid, sshExecutable: "ssh\0x" })).toThrow();
    expect(() => buildTmuxRelayArgv({ ...valid, platform: "win32" })).toThrow(/Windows.*unsupported/i);
    expect(() => buildTmuxRelayArgv({ ...valid, port: 22 } as TmuxRelayOptions)).toThrow();
    expect(() => buildTmuxRelayArgv({ ...valid, secret: "no" } as TmuxRelayOptions)).toThrow();
    const boundary = { ...valid, nodeId: "_a." + "a".repeat(125), sessionKey: "a".repeat(64), user: "_user" };
    if (process.platform === "win32") expect(() => buildTmuxRelayArgv(boundary)).toThrow(/Windows.*unsupported/i);
    else expect(buildTmuxRelayArgv(boundary)).toContain("_user");
  });

  test("real OpenSSH expands percent safely and invokes the exact local path without a network connection", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "tmux-relay-"));
    try {
      const marker = join(dir, "injected");
      // The shell metacharacters and SSH %-tokens must stay literal in the path.
      const binaryPath = join(dir, "bin 'quoted' $(touch injected) ; %h %% executable");
      const capture = join(dir, "capture");
      writeFileSync(binaryPath, '#!/bin/sh\nprintf "%s\\n" "$@" "$ENVINHANDS_RELAY_URL" "$ENVINHANDS_RELAY_SECRET" > "$CAPTURE"\nexit 1\n', { mode: 0o700 });
      const argv = buildTmuxRelayArgv({ ...valid, nodeId: "node._-", binaryPath });
      // Disable local SSH config. ProxyCommand exits locally, before any network.
      argv.splice(1, 0, "-F", "/dev/null");
      const result = Bun.spawnSync(argv, { cwd: dir, env: { ...process.env, CAPTURE: capture,
        ENVINHANDS_RELAY_URL: "wss://example.test", ENVINHANDS_RELAY_SECRET: "local-test-secret" },
        stdout: "pipe", stderr: "pipe", timeout: 5000 });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(capture, "utf8")).toBe("proxy\nnode._-\nwss://example.test\nlocal-test-secret\n");
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
