import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, chmodSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugLogger } from "../src/debug-log.ts";
import { createProcessDebugLogger } from "../src/process-debug-log.ts";

function fixture() { const root = mkdtempSync(join(tmpdir(), "env-log-test-")); return { root, dir: join(root, "logs"), clean: () => rmSync(root, { recursive: true, force: true }) }; }
function records(dir: string) { return readdirSync(dir).sort().flatMap(n => readFileSync(join(dir, n), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s))); }

describe("metadata JSONL logging", () => {
  test("appends after restart; partial crash tail is removed and mode is private", () => {
    const f = fixture(); try {
      let l = createDebugLogger({ directory: f.dir, component: "node" });
      l.debug("session.open", { machineId: "desk", sessionId: "s-1", connectionId: "c-1", transport: "ssh" }); l.close();
      const path = join(f.dir, "events.jsonl");
      writeFileSync(path, '{"partial":', { flag: "a" });
      l = createDebugLogger({ directory: f.dir, component: "node" }); l.info("session.close", { durationMs: 12 }); l.close();
      const rs = records(f.dir); expect(rs.map(x => x.event)).toEqual(["session.open", "session.close"]);
      expect(rs[0].timestamp).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/); expect(rs[0].level).toBe("debug");
      expect(statSync(f.dir).mode & 0o777).toBe(0o700); expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { f.clean(); }
  });
  test("rotates by size and time and bounds count and bytes", () => {
    const f = fixture(); try {
      let clock = 1_700_000_000_000;
      const l = createDebugLogger({ directory: f.dir, component: "server", maxLineBytes: 256, maxFileBytes: 512, maxFiles: 3, maxTotalBytes: 900, rotateMs: 100, now: () => clock });
      for (let i = 0; i < 20; i++) { l.info("connection.open", { sessionId: `id-${i}` }); clock += 30; }
      expect(l.status().failures).toBe(0); l.close();
      const files = readdirSync(f.dir); expect(files.length).toBeLessThanOrEqual(3);
      expect(files.reduce((n, x) => n + statSync(join(f.dir, x)).size, 0)).toBeLessThanOrEqual(900);
      expect(records(f.dir).some(x => x.sessionId === "id-19")).toBe(true);
    } finally { f.clean(); }
  });
  test("only allows constrained metadata, redacts known secrets, rejects injection and oversized lines", () => {
    const f = fixture(); try {
      const l = createDebugLogger({ directory: f.dir, component: "relay", knownSecrets: ["secret123"], maxLineBytes: 256, maxFileBytes: 512 });
      l.info("session.open", { machineId: "secret123", sessionId: "https://host/?token=bad", connectionId: "ok\nBAD", transport: "ssh", ...({ body: "SSH TERMINAL PLAINTEXT", authorization: "Bearer secret123", error: new Error("private") } as object) });
      l.info("bad\nevent");
      l.info("session.close", { sessionId: "x".repeat(128), connectionId: "y".repeat(128) });
      expect(l.status().failures).toBe(2); l.close();
      const raw = readFileSync(join(f.dir, "events.jsonl"), "utf8");
      expect(raw).not.toContain("secret123"); expect(raw).not.toContain("PLAINTEXT"); expect(raw).not.toContain("BAD"); expect(raw).not.toContain("token");
      expect(JSON.parse(raw).machineId).toBe("REDACTED");
    } finally { f.clean(); }
  });
  test("refuses symlinks, unsafe permissions and concurrent same-isolate owners; errors stay observable", () => {
    const f = fixture(); try {
      symlinkSync(f.root, f.dir); const warnings: string[] = [];
      const bad = createDebugLogger({ directory: f.dir, component: "node", onFailure: e => { warnings.push(e); throw Error("ignore"); } });
      bad.info("event"); expect(bad.status().failures).toBe(1); expect(warnings).toEqual(["unsafe_path"]);
      rmSync(f.dir); const first = createDebugLogger({ directory: f.dir, component: "node" });
      const second = createDebugLogger({ directory: f.dir, component: "node" }); expect(second.status().lastFailure).toBe("configuration");
      first.info("event"); chmodSync(f.dir, 0o755); first.info("event2"); expect(first.status().lastFailure).toBe("unsafe_path"); first.close();
    } finally { f.clean(); }
  });
  test("does not follow a malicious active file symlink", () => {
    const f = fixture(); try {
      const target = join(f.root, "target"); writeFileSync(target, "untouched");
      const first = createDebugLogger({ directory: f.dir, component: "node" }); first.close();
      symlinkSync(target, join(f.dir, "events.jsonl"));
      const l = createDebugLogger({ directory: f.dir, component: "node" }); l.info("event");
      expect(l.status().failures).toBe(1); expect(readFileSync(target, "utf8")).toBe("untouched");
    } finally { f.clean(); }
  });
});

// A platform override checks only fail-closed behavior on local temporary data.
// It is not evidence of Windows ACL or reparse-point support.
test("Windows logging fails closed without touching disk or exposing secrets", () => {
  const f = fixture(); try {
    const messages: string[] = [];
    const env = { ENVINHANDS_LOG_DIR: f.dir };
    const result = createProcessDebugLogger("node", ["private-token"], env, message => messages.push(message), "win32", true);
    expect(result).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("unsupported_windows_acl");
    expect(messages[0]).not.toContain("private-token");
    expect(readdirSync(f.root)).toEqual([]);
    expect(() => createProcessDebugLogger("relay", ["private-token"], env, () => { throw Error("sink failed"); }, "win32")).not.toThrow();
    expect(readdirSync(f.root)).toEqual([]);
  } finally { f.clean(); }
});
