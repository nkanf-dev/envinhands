import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFrpClient, startFrpClientReady } from "../src/transports/frp";

const base = { serverAddress: "127.0.0.1", serverPort: 7000, token: 'secret-"-not-in-argv', proxyName: "test", remotePort: 31337 };
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return (server.address() as { port: number }).port;
}
async function unusedPort() { const s = createServer(); const p = await listen(s); await new Promise<void>(r => s.close(() => r())); return p; }
async function until(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for test fixture");
}
async function tcpReady(port: number): Promise<boolean> {
  return new Promise(resolve => { const s = connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
}

describe("FRP client", () => {
  test("private config, argv, explicit bounded probes, termination and cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frp-test-"));
    const capture = join(dir, "argv.json");
    const fake = join(dir, "fake-frpc");
    await writeFile(fake, `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\nsetInterval(() => {}, 1000);\n`);
    await chmod(fake, 0o700);
    const c = await startFrpClient({ ...base, executable: fake });
    try {
      expect(c.state).toBe("running");
      await until(async () => { try { await stat(capture); return true; } catch { return false; } });
      const argv: string[] = JSON.parse(await readFile(capture, "utf8"));
      expect(argv[0]).toBe("-c");
      expect(JSON.stringify(argv)).not.toContain(base.token);
      const config = await readFile(argv[1]!, "utf8");
      expect(config).toContain('localIP = "127.0.0.1"');
      expect(config).toContain('localPort = 22');
      expect(config).toContain('auth.token = "secret-\\"-not-in-argv"');
      if (process.platform !== "win32") {
        expect((await stat(argv[1]!)).mode & 0o777).toBe(0o600);
        expect((await stat(join(argv[1]!, ".."))).mode & 0o777).toBe(0o700);
      }
      expect(await c.probe({ host: "127.0.0.1", port: await unusedPort(), attempts: 3, intervalMs: 10, timeoutMs: 50 })).toBe(false);
      await expect(c.probe({ host: "127.0.0.1", port: 1, attempts: 0 })).rejects.toThrow("Invalid FRP probe options");
      await c.stop(1000);
      expect((await c.outcome).kind).toBe("exit");
      expect(c.state).toBe("exited");
      await expect(stat(argv[1]!)).rejects.toThrow();
      await c.stop();
    } finally { await c.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
  });

  test("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frp-test-kill-"));
    const fake = join(dir, "fake");
    const ready = join(dir, "ready");
    await writeFile(fake, `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(ready)}, "ok");\nsetInterval(() => {}, 1000);\n`);
    await chmod(fake, 0o700);
    const c = await startFrpClient({ ...base, executable: fake });
    try {
      await until(async () => { try { await stat(ready); return true; } catch { return false; } });
      await c.stop(25);
      expect(await c.outcome).toEqual({ kind: "exit", code: null, signal: "SIGKILL" });
      await c.closed;
    } finally { await c.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
  });

  test("sanitizes failures and validates inputs", async () => {
    await expect(startFrpClient({ ...base, token: "" })).rejects.toThrow("Invalid FRP client options");
    await expect(startFrpClient({ ...base, tlsServerName: "server" })).rejects.toThrow("FRP TLS CA");
    await expect(startFrpClient({ ...base, executable: "/does/not/exist-secret" })).rejects.toThrow("Failed to start FRP client");
  });

  test("bounded readiness failure stops the owned process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frp-test-fail-"));
    const fake = join(dir, "fake");
    await writeFile(fake, '#!/usr/bin/env bun\nsetInterval(() => {}, 1000);\n'); await chmod(fake, 0o700);
    try {
      await expect(startFrpClientReady({ ...base, executable: fake }, { host: "127.0.0.1", port: await unusedPort(), attempts: 2, timeoutMs: 100, intervalMs: 10 })).rejects.toThrow("FRP TCP probe did not become ready");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// Opt in with FRP_BIN_DIR containing official same-version frpc and frps.
const binaries = process.env.FRP_BIN_DIR;
(binaries ? test : test.skip)("official frpc/frps forward a real bidirectional TCP payload on loopback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frp-e2e-"));
  const service = createServer(s => s.on("data", data => s.write(Buffer.concat([Buffer.from("reply:"), Buffer.from(data)]))));
  const localPort = await listen(service);
  const serverPort = await unusedPort();
  let remotePort = await unusedPort();
  while (remotePort === serverPort || remotePort === localPort) remotePort = await unusedPort();
  const token = "local-test-token-do-not-reuse";
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const openssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  if (openssl.status !== 0) throw new Error("openssl is required to create a local test certificate");
  const config = join(dir, "frps.toml");
  await writeFile(config, `bindAddr = "127.0.0.1"\nbindPort = ${serverPort}\nproxyBindAddr = "127.0.0.1"\nauth.method = "token"\nauth.token = "${token}"\ntransport.tls.certFile = "${cert}"\ntransport.tls.keyFile = "${key}"\ntransport.tls.force = true\n`, { mode: 0o600 });
  const server = spawn(join(binaries!, "frps"), ["-c", config], { shell: false, stdio: "ignore" });
  let client: Awaited<ReturnType<typeof startFrpClient>> | undefined;
  try {
    await until(() => tcpReady(serverPort));
    let badPort = await unusedPort();
    while (badPort === remotePort) badPort = await unusedPort();
    await expect(startFrpClientReady({ executable: join(binaries!, "frpc"), serverAddress: "127.0.0.1", serverPort, token, proxyName: "wrong-cert", remotePort: badPort, localPort, tlsTrustedCaFile: cert, tlsServerName: "wrong.invalid" },
      { host: "127.0.0.1", port: badPort, attempts: 5, intervalMs: 100, timeoutMs: 100 })).rejects.toThrow("FRP TCP probe did not become ready");
    client = await startFrpClientReady({ executable: join(binaries!, "frpc"), serverAddress: "127.0.0.1", serverPort, token, proxyName: "e2e", remotePort, localPort, tlsTrustedCaFile: cert, tlsServerName: "localhost" },
      { host: "127.0.0.1", port: remotePort, attempts: 60, intervalMs: 100, timeoutMs: 100 });
    const result = await new Promise<string>((resolve, reject) => {
      const s = connect(remotePort, "127.0.0.1");
      s.setTimeout(3000, () => { s.destroy(); reject(new Error("TCP round trip timed out")); });
      s.on("error", reject); s.on("connect", () => s.write("hello through frp"));
      s.on("data", chunk => { s.destroy(); resolve(chunk.toString()); });
    });
    expect(result).toBe("reply:hello through frp");
  } finally {
    await client?.stop().catch(() => {});
    server.kill("SIGTERM");
    if (server.exitCode === null && server.signalCode === null) await new Promise<void>(r => server.once("close", () => r()));
    await new Promise<void>(r => service.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
