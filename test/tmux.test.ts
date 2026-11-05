import { describe, expect, test } from "bun:test";
import { buildTmuxSshArgv, type TmuxSessionOptions } from "../src/session/tmux";

const valid: TmuxSessionOptions = { host: "box.example.org", sessionKey: "work-1" };

describe("tmux SSH argv construction", () => {
  test("keeps SSH options, host and remote command as separate arguments", () => {
    expect(buildTmuxSshArgv({ ...valid, user: "alice", port: 2222 })).toEqual([
      "ssh", "-tt", "-o", "StrictHostKeyChecking=yes", "-l", "alice", "-p", "2222",
      "box.example.org", "tmux", "new-session", "-A", "-s", "envinhands-work-1",
    ]);
  });

  test("produces a stable safe name and enforces host key verification", () => {
    const first = buildTmuxSshArgv(valid);
    expect(buildTmuxSshArgv(valid)).toEqual(first);
    expect(buildTmuxSshArgv({ ...valid, host: "other.example" }).at(-1)).toBe(first.at(-1));
    expect(buildTmuxSshArgv({ ...valid, sessionKey: "work-2" }).at(-1)).not.toBe(first.at(-1));
    expect(first).toContain("StrictHostKeyChecking=yes");
    expect(first.join(" ")).not.toMatch(/StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/i);
  });

  test("accepts bounded safe names, IP addresses, and valid port boundaries", () => {
    expect(buildTmuxSshArgv({ host: "::1", sessionKey: "a".repeat(64), port: 1, user: "_a" }).at(-1))
      .toBe(`envinhands-${"a".repeat(64)}`);
    expect(buildTmuxSshArgv({ ...valid, host: "127.0.0.1", port: 65535 })).toContain("65535");
  });

  test("rejects unsafe session keys", () => {
    for (const sessionKey of ["", "-foo", "_foo", "a".repeat(65), "a b", "a;id", "a$(id)", "a/b", "a.b", "a:b", "a\n", "é"]) {
      expect(() => buildTmuxSshArgv({ ...valid, sessionKey })).toThrow();
    }
  });

  test("rejects unsafe host names and SSH parameters", () => {
    for (const host of ["", "-oProxyCommand=x", "host;id", "host name", "host\n", "user@host", "host:22", "$(id)", "a..b", "-bad", "bad-", "a".repeat(64) + ".example", "[::1]", "::1%eth0"]) {
      expect(() => buildTmuxSshArgv({ ...valid, host })).toThrow();
    }
    for (const user of ["", "-oProxyCommand=x", "a;id", "a b", "a\n", "user@host", "x".repeat(33)]) {
      expect(() => buildTmuxSshArgv({ ...valid, user })).toThrow();
    }
    for (const port of [0, -1, 65536, 1.5, NaN, Infinity, "22", null]) {
      expect(() => buildTmuxSshArgv({ ...valid, port } as TmuxSessionOptions)).toThrow();
    }
    expect(() => buildTmuxSshArgv({ ...valid, sshArgs: ["-o", "StrictHostKeyChecking=no"] } as TmuxSessionOptions)).toThrow();
  });
});
