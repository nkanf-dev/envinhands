import { test, expect } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFrpClient } from "../src/transports/frp";

type RawConfig = {
  serverAddr?: unknown; serverPort?: unknown;
  auth?: { method?: unknown; token?: unknown };
  proxies?: Array<{ name?: unknown; remotePort?: unknown }>;
};

// Deliberately return only a generic error: TOML parser diagnostics can echo
// the original text, which may contain a token.
function parsePrivate(source: string): RawConfig {
  try { return Bun.TOML.parse(source) as RawConfig; }
  catch { throw new Error("Invalid FRP configuration"); }
}

async function exercise(path: string): Promise<void> {
  const sourceText = await readFile(path, "utf8");
  const original = parsePrivate(sourceText);
  if (typeof original.serverAddr !== "string" || typeof original.serverPort !== "number" ||
      original.auth?.method !== "token" || typeof original.auth.token !== "string" ||
      !Array.isArray(original.proxies)) throw new Error("Unsupported FRP configuration");
  const names = new Set(original.proxies.map(p => p.name));
  const ports = new Set(original.proxies.map(p => p.remotePort));
  let index = 0;
  while (names.has(`envinhands-offline-${index}`)) index++;
  const name = `envinhands-offline-${index}`;
  const port = Array.from({ length: 64512 }, (_, i) => i + 1024).find(p => !ports.has(p));
  if (!port) throw new Error("No test port available in source configuration");
  const dir = await mkdtemp(join(tmpdir(), "frp-existing-offline-"));
  const fake = join(dir, "fake-frpc");
  const result = join(dir, "result");
  // This fake never connects to a network. It compares secrets only in memory
  // and writes only ok/fail, never file contents or parser diagnostics.
  const program = `#!/usr/bin/env bun
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
let ok = false;
try {
  const source = Bun.TOML.parse(readFileSync(process.env.FRP_SOURCE!, "utf8")) as any;
  const derived = Bun.TOML.parse(readFileSync(process.argv[3]!, "utf8")) as any;
  const p = derived.proxies;
  ok = process.argv[2] === "-c" && (statSync(process.argv[3]!).mode & 0o777) === 0o600 &&
    (statSync(dirname(process.argv[3]!)).mode & 0o777) === 0o700 && source.serverAddr === derived.serverAddr &&
    source.serverPort === derived.serverPort && source.auth.token === derived.auth.token &&
    derived.auth.method === "token" && derived.transport.tls.enable === true &&
    Array.isArray(p) && p.length === 1 && p[0].type === "tcp" && p[0].localIP === "127.0.0.1" &&
    p[0].localPort === 22 && p[0].name === process.env.FRP_NAME &&
    p[0].remotePort === Number(process.env.FRP_PORT) &&
    !(source.proxies as any[]).some(x => x.name === p[0].name || x.remotePort === p[0].remotePort);
} catch {}
writeFileSync(process.env.FRP_RESULT!, ok ? "ok" : "fail", { mode: 0o600 });
setInterval(() => {}, 1000);
`;
  await writeFile(fake, program, { mode: 0o700 });
  await chmod(fake, 0o700);
  // startFrpClient inherits environment. Values here are paths and test metadata,
  // never credentials. Restore the caller environment afterwards.
  const keys = ["FRP_SOURCE", "FRP_RESULT", "FRP_NAME", "FRP_PORT"] as const;
  const saved = keys.map(k => process.env[k]);
  process.env.FRP_SOURCE = path; process.env.FRP_RESULT = result;
  process.env.FRP_NAME = name; process.env.FRP_PORT = String(port);
  let client: Awaited<ReturnType<typeof startFrpClient>> | undefined;
  try {
    client = await startFrpClient({ executable: fake, serverAddress: original.serverAddr,
      serverPort: original.serverPort, token: original.auth.token, proxyName: name, remotePort: port });
    let status = "";
    for (let i = 0; i < 150; i++) {
      try { status = await readFile(result, "utf8"); break; } catch { await Bun.sleep(20); }
    }
    expect(status).toBe("ok");
    // Never print the original text even if the comparison fails.
    expect((await stat(path)).isFile()).toBe(true);
    expect((await readFile(path, "utf8")) === sourceText).toBe(true);
  } finally {
    try { await client?.stop(); } finally {
      for (let i = 0; i < keys.length; i++) {
        if (saved[i] === undefined) delete process.env[keys[i]!]; else process.env[keys[i]!] = saved[i];
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
}

test("offline derivation from a synthetic existing FRP config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frp-source-offline-"));
  const path = join(dir, "source.toml");
  try {
    await writeFile(path, `serverAddr = "127.0.0.1"
serverPort = 7000
[auth]
method = "token"
token = "synthetic-not-a-credential"
[[proxies]]
name = "owned"
remotePort = 1024
`);
    await exercise(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const realPath = process.env.FRP_EXISTING_CONFIG_TEST;
(realPath ? test : test.skip)("offline derivation from user config without touching live FRP", async () => {
  await exercise(realPath!);
});
