import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { cloudflareClientEndpoints, startCloudflare, type CloudflareSidecar } from "../src/transports/cloudflare";

let sidecars: CloudflareSidecar[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const sidecar of sidecars) await sidecar.stop();
  sidecars = [];
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  delete process.env.CF_TEST_SECRET;
  delete process.env.CF_OTHER_SECRET;
});
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => s.close((e) => e ? reject(e) : resolve()));
  return port;
}
async function until(f: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await f()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for mock sidecar");
}

describe("Cloudflare sidecar", () => {
  test("validates endpoint without supplying a public hostname or credentials", () => {
    expect(cloudflareClientEndpoints("https://example.invalid/api?q=1")).toEqual({
      http: "https://example.invalid/api?q=1", websocket: "wss://example.invalid/api?q=1",
    });
    for (const value of ["http://example.invalid", "https://user:pass@example.invalid/", "https://example.invalid/#fragment", "not a url"]) {
      expect(() => cloudflareClientEndpoints(value)).toThrow("Invalid Cloudflare endpoint");
    }
  });

  test("rejects invalid config and missing secret without echoing it", async () => {
    await expect(startCloudflare({ token: { env: "CF_TEST_SECRET" }, metricsPort: 0 })).rejects.toThrow("Invalid Cloudflare options");
    await expect(startCloudflare({ token: { env: "CF_TEST_SECRET" }, metricsPort: 31222 })).rejects.toThrow("Invalid tunnel token");
    process.env.CF_TEST_SECRET = "bad secret";
    await expect(startCloudflare({ token: { env: "CF_TEST_SECRET" }, metricsPort: 31222 })).rejects.toThrow("Invalid tunnel token");
  });

  test.skipIf(process.platform === "win32")("private file checks do not follow links or accept shared modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-private-")); dirs.push(dir);
    const file = join(dir, "token");
    await writeFile(file, "private-token\n", { mode: 0o644 });
    await expect(startCloudflare({ token: { file }, metricsPort: 31222 })).rejects.toThrow("Cannot read private token file");
    await chmod(file, 0o600);
    const { symlink } = await import("node:fs/promises");
    const link = join(dir, "link"); await symlink(file, link);
    await expect(startCloudflare({ token: { file: link }, metricsPort: 31222 })).rejects.toThrow("Cannot read private token file");
    const s = await startCloudflare({ token: { file }, metricsPort: 31222, executable: "/nonexistent-cloudflared", restartDelayMs: 50 });
    sidecars.push(s);
    await until(() => s.status() === "restarting");
    expect(await s.ready()).toBe(false);
  });

  test.skipIf(process.platform === "win32")("isolated mock child gets token only in env, serves readiness and is restarted after exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-mock-")); dirs.push(dir);
    const executable = join(dir, "cloudflared-mock");
    // This is a loopback-only, isolated proxy, NOT a Cloudflare edge.
    const origin = Bun.serve({hostname: "127.0.0.1", port: 0,
      fetch(req, server) {
        if (new URL(req.url).pathname === "/ws") {
          if (server.upgrade(req)) return;
          return new Response("upgrade failed", { status: 400 });
        }
        return new Response("origin response");
      },
      websocket: {
        open(ws) { ws.send("ready"); },
        message(ws, message) { ws.send(`echo:${message}`); },
      },
    });
    const edgePort = await freePort();
    const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== "tunnel" || args[1] !== "--no-autoupdate" || args[2] !== "--metrics" || args[4] !== "run") process.exit(10);
if (process.env.TUNNEL_TOKEN !== "mock-token" || process.env.CF_OTHER_SECRET !== undefined || args.some(x => x.includes("mock-token"))) process.exit(11);
const port = Number(args[3].split(":")[1]);
Bun.serve({hostname: "127.0.0.1", port, fetch(req) {
  if (new URL(req.url).pathname === "/kill") { setTimeout(() => process.exit(7), 20); return new Response("ok"); }
  return new Response("ready", { status: new URL(req.url).pathname === "/ready" ? 200 : 404 });
}});
Bun.serve({hostname: "127.0.0.1", port: ${edgePort},
  fetch(req, server) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("upgrade failed", {status: 400});
    }
    return fetch("http://127.0.0.1:${origin.port}" + u.pathname);
  },
  websocket: {
    open(ws) {
      const upstream = new WebSocket("ws://127.0.0.1:${origin.port}/ws");
      ws.data = upstream;
      upstream.onmessage = (event) => ws.send(event.data);
      upstream.onclose = () => ws.close();
    },
    message(ws, message) { ws.data.send(message); },
    close(ws) { ws.data.close(); },
  },
});
`;
    await writeFile(executable, script, { mode: 0o700 });
    const port = await freePort();
    process.env.CF_TEST_SECRET = "mock-token";
    process.env.CF_OTHER_SECRET = "do-not-inherit";
    const s = await startCloudflare({ token: { env: "CF_TEST_SECRET" }, executable, metricsPort: port, restartDelayMs: 200 });
    sidecars.push(s);
    await until(() => s.ready());
    expect(s.status()).toBe("running");
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${edgePort}/`)).ok; } catch { return false; } });
    expect(await (await fetch(`http://127.0.0.1:${edgePort}/`)).text()).toBe("origin response");
    const result = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${edgePort}/ws`);
      ws.onerror = () => reject(new Error("Mock WebSocket failed"));
      ws.onmessage = (event) => {
        if (event.data === "ready") ws.send("hello");
        else { resolve(String(event.data)); ws.close(); }
      };
    });
    expect(result).toBe("echo:hello");
    origin.stop(true);
    await fetch(`http://127.0.0.1:${port}/kill`);
    await until(() => s.status() === "restarting");
    expect(await s.ready()).toBe(false);
    await until(() => s.ready());
    expect(await s.stop()).toBe(true);
    expect(s.status()).toBe("stopped");
    expect(await s.ready()).toBe(false);
  });
});
