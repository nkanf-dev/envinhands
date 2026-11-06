import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudflareQuick, type QuickTunnel } from "../src/transports/cloudflare-quick";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(f: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!f() && Date.now() < deadline) await pause(30);
  if (!f()) throw new Error("Timed out waiting for quick tunnel state");
}

describe("quick tunnel", () => {
  test("requires explicit consent and a loopback port", async () => {
    await expect(startCloudflareQuick({ exposePublicly: false as true, localPort: 80 })).rejects.toThrow();
    await expect(startCloudflareQuick({ exposePublicly: true, localPort: 0 })).rejects.toThrow();
  });
  test("supervises restarts, invalidates the old URL, filters output and cleans up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-mock-"));
    const exe = join(dir, "fake"); const marker = join(dir, "marker");
    const code = `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
if (!existsSync(marker)) {
  writeFileSync(marker, "x");
  console.error("sensitive-DO-NOT-LOG");
  console.error("| https://first-test.trycloudflare.com |");
  setTimeout(() => process.exit(1), 120);
} else {
  console.error("| https://second-test.trycloudflare.com |");
  setInterval(() => {}, 1000);
}
`;
    await writeFile(exe, code, { mode: 0o700 });
    const events: string[] = []; let tunnel: QuickTunnel | undefined;
    try {
      tunnel = await startCloudflareQuick({ exposePublicly: true, localPort: 12345, executable: exe, restartDelayMs: 100, onEvent: e => events.push(e) });
      await waitFor(() => tunnel!.snapshot().url === "https://first-test.trycloudflare.com");
      await waitFor(() => tunnel!.snapshot().state === "restarting");
      expect(tunnel.snapshot().url).toBeNull();
      await waitFor(() => tunnel!.snapshot().url === "https://second-test.trycloudflare.com");
      expect(tunnel.snapshot().generation).toBe(2);
      await Promise.all([tunnel.stop(), tunnel.stop()]);
      expect(tunnel.snapshot().state).toBe("stopped");
      expect(tunnel.snapshot().url).toBeNull();
      expect(events).toContain("restart-scheduled");
      expect(events.at(-1)).toBe("stopped");
      expect(events.join(" ")).not.toContain("sensitive-DO-NOT-LOG");
    } finally { await tunnel?.stop(); await rm(dir, { recursive: true, force: true }); }
  });
  test("spawn failures retry, and stop cancels retries", async () => {
    const events: string[] = [];
    const t = await startCloudflareQuick({ exposePublicly: true, localPort: 12345, executable: "/no/such/cloudflared", restartDelayMs: 50, onEvent: e => events.push(e) });
    try { await waitFor(() => events.includes("spawn-error")); } finally { await t.stop(); }
    const count = t.snapshot().generation; await pause(130);
    expect(t.snapshot().generation).toBe(count); expect(t.snapshot().state).toBe("stopped");
  });
});

// Explicit, opt-in live network test. Never points at an existing service.
// Caller supplies a locally installed official cloudflared via CLOUDFLARED_QUICK_LIVE.
const live = process.env.CLOUDFLARED_QUICK_LIVE;
test.skipIf(!live)("live quick tunnel HTTP and WebSocket", async () => {
  const body = crypto.randomUUID(); // Deliberately non-secret public test data.
  const server = Bun.serve<{ marker: string }>({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") {
        if (server.upgrade(req, { data: { marker: body } })) return;
        return new Response("upgrade required", { status: 400 });
      }
      return new Response(body);
    },
    websocket: { open(ws) { ws.send(ws.data.marker); }, message() {} },
  });
  let t: QuickTunnel | undefined;
  try {
    t = await startCloudflareQuick({ exposePublicly: true, localPort: server.port!, executable: live });
    await waitFor(() => t!.snapshot().url !== null, 45000);
    const url = t.snapshot().url!;
    const deadline = Date.now() + 45000;
    let ok = false;
    while (Date.now() < deadline && t.snapshot().url === url) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" }); if (r.ok && await r.text() === body) { ok = true; break; } } catch { /* transient provider/DNS readiness */ }
      await pause(500);
    }
    expect(ok).toBe(true);
    const received = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url.replace("https:", "wss:") + "/ws");
      const timer = setTimeout(() => { ws.close(); reject(new Error("WebSocket timeout")); }, 10000);
      ws.onmessage = event => { clearTimeout(timer); resolve(String(event.data)); ws.close(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); };
    });
    expect(received).toBe(body);
  } finally { await t?.stop(); server.stop(true); }
}, 110000);
