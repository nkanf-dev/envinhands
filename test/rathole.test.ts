import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { startRathole, type RatholeOptions, type RatholeSpawnRunner } from "../src/transports/rathole";

const valid: RatholeOptions = { role: "client", configPath: "./config/client.toml" };

function mock() {
  const child = new EventEmitter() as ChildProcess;
  const calls: unknown[][] = [];
  const signals: (string | number | undefined)[] = [];
  child.kill = ((signal?: NodeJS.Signals | number) => { signals.push(signal); return true; }) as ChildProcess["kill"];
  const runner: RatholeSpawnRunner = (...args) => { calls.push(args); return child; };
  return { child, calls, signals, runner };
}

describe("rathole process adapter", () => {
  test("uses argv without a shell or inherited output, resolves only after spawn, and observes exit", async () => {
    const m = mock();
    const pending = startRathole(valid, m.runner);
    let launched = false;
    void pending.then(() => { launched = true; });
    await Promise.resolve();
    expect(launched).toBe(false);
    expect(m.calls).toEqual([["rathole", ["--client", resolve(valid.configPath)],
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

  test("supports server and a dash-prefixed config filename without option injection", async () => {
    const m = mock();
    const pending = startRathole({ role: "server", configPath: "-server config.toml" }, m.runner);
    expect(m.calls[0]?.[1]).toEqual(["--server", resolve("-server config.toml")]);
    m.child.emit("spawn");
    const process = await pending;
    m.child.emit("exit", 2, null);
    expect(await process.exited).toEqual({ kind: "exit", code: 2, signal: null });
    expect(process.stop()).toBe(false);
  });

  test("rejects invalid options before calling the runner", async () => {
    const m = mock();
    for (const options of [null, { ...valid, role: "both" }, { ...valid, configPath: "" },
      { ...valid, configPath: "a\0b" }, { ...valid, configPath: 42 }]) {
      await expect(startRathole(options as RatholeOptions, m.runner)).rejects.toThrow("Invalid rathole options");
    }
    expect(m.calls).toEqual([]);
  });

  test("sanitizes synchronous and asynchronous startup errors", async () => {
    const runner: RatholeSpawnRunner = () => { throw new Error("secret"); };
    await expect(startRathole(valid, runner)).rejects.toThrow("Failed to start rathole");
    const m = mock();
    const pending = startRathole(valid, m.runner);
    m.child.emit("error", new Error("secret"));
    await expect(pending).rejects.toThrow("Failed to start rathole");
    m.child.emit("error", new Error("secret"));
  });

  test("reports later errors without leaking details and requests termination", async () => {
    const m = mock();
    const pending = startRathole(valid, m.runner);
    m.child.emit("spawn");
    const process = await pending;
    m.child.emit("error", new Error("secret"));
    expect(await process.exited).toEqual({ kind: "error" });
    expect(m.signals).toEqual(["SIGTERM"]);
    expect(process.stop()).toBe(false);
    m.child.emit("exit", 1, null);
    expect(await process.exited).toEqual({ kind: "error" });
  });

  test("does not treat exit before spawn as startup", async () => {
    const m = mock();
    const pending = startRathole(valid, m.runner);
    m.child.emit("exit", 1, null);
    m.child.emit("spawn");
    await expect(pending).rejects.toThrow("Failed to start rathole");
  });

  test("failed stop can be retried without leaking exceptions", async () => {
    const m = mock();
    let attempts = 0;
    m.child.kill = (() => { attempts++; if (attempts === 1) throw new Error("secret"); return attempts > 2; }) as ChildProcess["kill"];
    const pending = startRathole(valid, m.runner);
    m.child.emit("spawn");
    const process = await pending;
    expect(process.stop()).toBe(false);
    expect(process.stop()).toBe(false);
    expect(process.stop()).toBe(true);
    expect(process.stop()).toBe(false);
    m.child.emit("exit", 0, null);
    expect(await process.exited).toEqual({ kind: "exit", code: 0, signal: null });
  });
});
