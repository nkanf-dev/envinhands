import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { probeUuViewerAccount, probeUuViewerInstallation, probeUuMappedSsh, startUuPortmap, type UuPortmapOptions, type UuSpawnRunner } from "../src/transports/uu";

const valid: UuPortmapOptions = { device: "device-1", localPort: 2200, port: 22 };

function mock() {
  const child = new EventEmitter() as ChildProcess;
  const calls: unknown[][] = [];
  const signals: string[] = [];
  child.kill = ((signal?: NodeJS.Signals | number) => { signals.push(String(signal)); return true; }) as ChildProcess["kill"];
  const runner: UuSpawnRunner = (...args) => { calls.push(args); return child; };
  return { child, runner, calls, signals };
}

describe("optional UU portmap process", () => {
  test("passes separate arguments with no shell or inherited output and can request stop", async () => {
    const m = mock();
    const pending = startUuPortmap(valid, m.runner);
    expect(m.calls).toEqual([["uuremote-viewer", ["portmap", "device-1", "2200", "127.0.0.1", "22"],
      { shell: false, stdio: "ignore", windowsHide: true }]]);
    m.child.emit("spawn");
    const process = await pending;
    expect(process.stop()).toBe(true);
    expect(process.stop()).toBe(false);
    expect(m.signals).toEqual(["SIGTERM"]);
    m.child.emit("exit", null, "SIGTERM");
    expect(await process.exited).toEqual({ kind: "exit", code: null, signal: "SIGTERM" });
    expect(process.stop()).toBe(false);
  });

  test("allows explicit loopback and port boundaries", async () => {
    const m = mock();
    const pending = startUuPortmap({ device: "A_1.2:3", localPort: 1, host: "127.0.0.1", port: 65535 }, m.runner);
    expect(m.calls[0]?.[1]).toEqual(["portmap", "A_1.2:3", "1", "127.0.0.1", "65535"]);
    m.child.emit("spawn");
    const process = await pending;
    m.child.emit("exit", 1, null);
    expect(await process.exited).toEqual({ kind: "exit", code: 1, signal: null });
  });

  test("rejects invalid options before invoking a process", async () => {
    const m = mock();
    const bad: UuPortmapOptions[] = [
      ...["", "-option", ";touch /tmp/x", "abc\nxyz", "abc def", "x".repeat(129)].map(device => ({ ...valid, device })),
      ...[0, -1, 65536, 1.5, NaN, Infinity, "22"].map(port => ({ ...valid, port: port as number })),
      ...[0, 65536, NaN].map(localPort => ({ ...valid, localPort })),
      ...["localhost", "127.0.0.2", "0.0.0.0", "::1", "127.0.0.1;bad", "127.0.0.1 ", "", null].map(host => ({ ...valid, host: host as string })),
    ];
    for (const options of bad) await expect(startUuPortmap(options, m.runner)).rejects.toThrow();
    expect(m.calls).toEqual([]);
  });

  test("sanitizes synchronous and asynchronous launch errors", async () => {
    const secret = "credential-in-third-party-error";
    const throws: UuSpawnRunner = () => { throw new Error(secret); };
    await expect(startUuPortmap(valid, throws)).rejects.toThrow("Failed to start UU viewer");
    const m = mock();
    const pending = startUuPortmap(valid, m.runner);
    m.child.emit("error", new Error(secret));
    await expect(pending).rejects.toThrow("Failed to start UU viewer");
    // A late error is consumed and must not leak the third-party message.
    m.child.emit("error", new Error(secret));
  });

  test("reports a later process error without forwarding its text", async () => {
    const m = mock();
    const pending = startUuPortmap(valid, m.runner);
    m.child.emit("spawn");
    const process = await pending;
    m.child.emit("error", new Error("sensitive"));
    expect(await process.exited).toEqual({ kind: "error" });
    expect(m.signals).toEqual(["SIGTERM"]);
    expect(process.stop()).toBe(false);
  });

  test("fails closed if exit precedes spawn and does not report readiness", async () => {
    const m = mock();
    const pending = startUuPortmap(valid, m.runner);
    m.child.emit("exit", 1, null);
    m.child.emit("spawn");
    await expect(pending).rejects.toThrow("Failed to start UU viewer");
  });

  test("handles rejected termination without exposing an error", async () => {
    const m = mock();
    m.child.kill = (() => { throw new Error("sensitive"); }) as ChildProcess["kill"];
    const pending = startUuPortmap(valid, m.runner);
    m.child.emit("spawn");
    const process = await pending;
    expect(process.stop()).toBe(false);
    m.child.emit("exit", 0, null);
    expect(await process.exited).toEqual({ kind: "exit", code: 0, signal: null });
  });
});


describe("operator-managed UU SSH mapping", () => {
  const opts = { id: "uu", localPort: 2200, access: { user: "alice", hostKeyAlias: "trusted-machine", knownHostsFile: "/tmp/known_hosts", identityFile: "/tmp/id_ed25519" } };
  test("only a strict SSH and user authentication probe marks the route healthy", async () => {
    let calls: unknown[][] = [];
    const result = await probeUuMappedSsh(opts, async (...args) => { calls.push(args); return { exitCode: 0 }; });
    expect(result.status).toBe("healthy");
    expect(result.installation).toBe("unknown");
    expect(result.login).toBe("unknown");
    expect(result.route).toEqual({ id: "uu", host: "127.0.0.1", port: 2200 });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe("ssh");
    const argv = calls[0]?.[1] as string[];
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).toContain("HostKeyAlias=trusted-machine");
    expect(argv).toContain("BatchMode=yes");
    expect(argv.at(-1)).toBe("true");
    expect(argv.slice(0, -1)).toEqual(result.argv);
  });
  test("failure and later re-probe reflect disconnection without replay", async () => {
    let calls = 0;
    const runner = async () => ({ exitCode: ++calls === 1 ? 0 : 255 });
    expect((await probeUuMappedSsh(opts, runner)).status).toBe("healthy");
    expect((await probeUuMappedSsh(opts, runner)).status).toBe("failed");
    expect(calls).toBe(2);
    expect((await probeUuMappedSsh(opts, async () => { throw new Error("secret"); })).status).toBe("failed");
  });
  test("rejects invalid settings before invoking ssh", async () => {
    let count = 0;
    const runner = async () => { count++; return { exitCode: 0 }; };
    for (const input of [{ ...opts, localPort: 0 }, { ...opts, timeoutMs: 0 },
      { ...opts, access: { ...opts.access, hostKeyAlias: "-o ProxyCommand=evil" } }]) {
      await expect(probeUuMappedSsh(input, runner)).rejects.toThrow();
    }
    expect(count).toBe(0);
  });
});


describe("optional experimental viewer checks", () => {
  test("installation check uses a harmless bounded help command", async () => {
    const calls: unknown[][] = [];
    expect(await probeUuViewerInstallation(async (...args) => { calls.push(args); return { exitCode: 0 }; })).toBe("available");
    expect(calls).toEqual([["uuremote-viewer", ["--help"], 5000]]);
    expect(await probeUuViewerInstallation(async () => { throw Error("private"); })).toBe("unavailable");
    expect(await probeUuViewerInstallation(async () => ({ exitCode: 1 }))).toBe("unavailable");
  });
  test("account success is opt-in and failure is unknown, never logged-out", async () => {
    const calls: unknown[][] = [];
    expect(await probeUuViewerAccount(async (...args) => { calls.push(args); return { exitCode: 0 }; })).toBe("accepted");
    expect(calls).toEqual([["uuremote-viewer", ["devices", "GET", "/data/my_binded_devices", "/device_id", "/alias"], 15000]]);
    expect(await probeUuViewerAccount(async () => ({ exitCode: 2 }))).toBe("unknown");
    expect(await probeUuViewerAccount(async () => { throw Error("private"); })).toBe("unknown");
  });
});
