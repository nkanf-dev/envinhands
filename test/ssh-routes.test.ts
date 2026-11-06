import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { buildSshRouteArgv, selectSshRoute, SshRoutesUnavailable } from "../src/transports/ssh-routes.ts";
const access = { user: "agent", hostKeyAlias: "trusted-host" };

test("real probe orchestration tries preferred route then falls back, keeping the same host trust identity", async () => {
  const calls: Array<readonly string[]> = [];
  const result = await selectSshRoute([{ id: "backup", host: "10.0.0.2" }, { id: "primary", host: "10.0.0.1" }], access,
    { priority: ["primary", "backup"], totalBudgetMs: 20000 }, { now: () => 0,
      runner: async (_command, args) => { calls.push(args); return { exitCode: calls.length === 1 ? 255 : 0 }; } });
  assert.equal(result.route.id, "backup"); assert.deepEqual(result.observations.map(o => o.status), ["failed", "healthy"]);
  for (const args of calls) {
    assert.ok(args.includes("StrictHostKeyChecking=yes")); assert.ok(args.includes("HostKeyAlias=trusted-host"));
    assert.deepEqual(args.slice(-2), ["echo", "envinhands-probe"]); assert.ok(args.includes("BatchMode=yes"));
  }
  assert.equal(result.argv.includes("true"), false); // No remote task was run by route selection.
});

test("total budget stops probing and a caller never receives an unverified route", async () => {
  let time = 0, calls = 0;
  await assert.rejects(selectSshRoute([{ id: "one", host: "10.0.0.1" }, { id: "two", host: "10.0.0.2" }], access,
    { priority: [], totalBudgetMs: 10 }, { now: () => time,
      runner: async (_cmd, _args, timeout) => { assert.equal(timeout, 10); calls++; time = 10; return { exitCode: 255 }; } }), SshRoutesUnavailable);
  assert.equal(calls, 1);
});

test("unsafe host, route IDs, alias and credential paths fail before any SSH process", async () => {
  for (const host of ["-bad", "host;id", "x\n", "a b", "ssh://host"])
    assert.throws(() => buildSshRouteArgv({ id: "r", host }, access));
  assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost" }, { ...access, hostKeyAlias: "-oUnsafe" }));
  assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost" }, { ...access, identityFile: "relative" }));
  let called = false;
  await assert.rejects(selectSshRoute([{ id: "r", host: "localhost" }, { id: "r", host: "localhost" }], access,
    { priority: [], totalBudgetMs: 100 }, { runner: async () => { called = true; return { exitCode: 0 }; } }));
  assert.equal(called, false);
});


test("relay fallback keeps the same trust and returns exactly the probed SSH argv", async () => {
  const routes = [
    { id: "direct", host: "127.0.0.1", port: 2222 },
    { id: "reverse", host: "internal.example", relay: { relayNodeId: "nas-1", binaryPath: "/opt/envinhands" } },
  ];
  const calls: string[][] = [];
  const selected = await selectSshRoute(routes, { ...access, knownHostsFile: "/tmp/trusted" },
    { priority: ["direct", "reverse"], totalBudgetMs: 100 }, { now: () => 0, runner: async (exe, args) => {
      assert.equal(exe, "ssh"); calls.push([...args]); return { exitCode: calls.length === 1 ? 255 : 0 };
    } });
  assert.equal(selected.route.id, "reverse");
  assert.deepEqual(calls[1], [...selected.argv, "echo", "envinhands-probe"]);
  assert.ok(calls[1].includes("ProxyCommand='/opt/envinhands' proxy 'nas-1'"));
  for (const args of calls) {
    assert.ok(args.includes("HostKeyAlias=trusted-host"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("UserKnownHostsFile=/tmp/trusted"));
  }
  assert.deepEqual(selected.observations.map(x => x.exitCode), [255, 0]);
});

test("relay rejects unsafe input before probing, including percent tokens and mixed jump routes", async () => {
  const valid = { relayNodeId: "nas", binaryPath: "/usr/local/bin/envinhands" };
  const invalid: unknown[] = [null, [], {}, { ...valid, relayNodeId: "nas;id" },
    { ...valid, relayNodeId: "nas\n" }, { ...valid, relayNodeId: "a".repeat(129) },
    { ...valid, binaryPath: "relative" }, { ...valid, binaryPath: "/tmp/%h" },
    { ...valid, binaryPath: "/tmp/a\n" }, { ...valid, command: "id" }];
  for (const relay of invalid) {
    assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost", relay: relay as typeof valid }, access));
  }
  assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost", jump: "jump", relay: valid }, access));
  let calls = 0;
  await assert.rejects(selectSshRoute([{ id: "ok", host: "localhost" },
    { id: "bad", host: "localhost", relay: { ...valid, binaryPath: "/tmp/%h" } }], access,
    { priority: [], totalBudgetMs: 100 }, { runner: async () => { calls++; return { exitCode: 0 }; } }));
  assert.equal(calls, 0);
});

test("relay ProxyCommand quotes shell metacharacters and does not include inherited secrets", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "ssh-route-"));
  try {
    const binary = join(dir, "bin ' ; $(touch INJECTED)");
    writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(binary, 0o700);
    const args = buildSshRouteArgv({ id: "relay", host: "localhost",
      relay: { relayNodeId: "nas-1", binaryPath: binary } }, access);
    const option = args.find(x => x.startsWith("ProxyCommand="))!;
    const secret = "secret-not-in-argv";
    const result = spawnSync("/bin/sh", ["-c", option.slice("ProxyCommand=".length)],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ENVINHANDS_RELAY_SECRET: secret } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "proxy\nnas-1\n");
    assert.ok(!args.join(" ").includes(secret));
    assert.ok(!result.stderr.includes(secret));
    assert.equal(existsSync(join(dir, "INJECTED")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows direct and relay routes use isolated SSH and a fixed quoted proxy", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.throws(() => buildSshRouteArgv({ id: "relay", host: "localhost",
      relay: { relayNodeId: "nas", binaryPath: "/usr/bin/envinhands" } }, access), /Invalid SSH relay/);
    for (const binaryPath of ["C:\\Program Files\\EnvInHands\\envinhands.exe", "C:\\tool\\envinhands.exe"]) {
      const relay = buildSshRouteArgv({ id: "relay", host: "localhost", relay: { relayNodeId: "nas-1", binaryPath } }, access);
      const expected = `ProxyCommand="${binaryPath.replaceAll("\\", "/")}" proxy nas-1`;
      assert.ok(relay.includes(expected));
      assert.ok(relay.includes("StrictHostKeyChecking=yes"));
      assert.ok(relay.includes("IdentitiesOnly=yes"));
      assert.ok(relay.includes("ControlPath=none"));
      assert.ok(!relay.join(" ").includes("relay-secret"));
      const effective = [...relay]; effective[1] = original.value === "win32" ? "NUL" : "/dev/null";
      const check = spawnSync("ssh", ["-G", ...effective], { encoding: "utf8" });
      assert.equal(check.status, 0);
      assert.ok(check.stdout.includes(expected.replace("ProxyCommand=", "proxycommand ")));
    }
    for (const binaryPath of ['C:\\evil&calc.exe', 'C:\\evil%PATH%.exe', 'C:\\bad"x.exe', 'C:\\bad!x.exe', 'C:\\foo.bat', 'C:\\foo\\..\\env.exe'])
      assert.throws(() => buildSshRouteArgv({ id:"relay", host:"localhost", relay:{relayNodeId:"nas", binaryPath} }, access));
    const args = buildSshRouteArgv({ id: "direct", host: "localhost" }, { ...access,
      identityFile: "C:\\Users\\Agent\\id", knownHostsFile: "C:\\Users\\Agent Name\\known_hosts" });
    assert.deepEqual(args.slice(0, 2), ["-F", "NUL"]);
    assert.equal(args[args.indexOf("-i") + 1], "C:/Users/Agent/id");
    assert.ok(args.includes('UserKnownHostsFile="C:/Users/Agent Name/known_hosts"'));
    assert.ok(args.includes("ControlPath=none"));
    assert.ok(args.includes("IdentityAgent=none"));
    assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost", jump: "jump" }, access), /Windows/);
    assert.throws(() => buildSshRouteArgv({ id: "r", host: "localhost" }, { ...access, identityFile: "C:relative" }));
  } finally { Object.defineProperty(process, "platform", original); }
});


test("real ssh isolates identity from appended config keys and existing masters", { timeout: 30000 }, async (t) => {
  if (process.platform === "win32") return t.skip("this fixture requires POSIX sshd");
  const sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"].find(existsSync);
  if (!sshd || spawnSync("ssh-keygen", ["-V"], { stdio: "ignore" }).error || spawnSync("ssh", ["-V"], { stdio: "ignore" }).error)
    return t.skip("local OpenSSH server and client are required");
  const dir = mkdtempSync(join(tmpdir(), "envinhands-ssh-"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  let daemon: ReturnType<typeof spawn> | undefined;
  const masterSocket = join(dir, "master.sock");
  const run = (command: string, args: string[]) => spawnSync(command, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const keyA = join(dir, "a"), keyB = join(dir, "b"), hostKey = join(dir, "host");
    for (const key of [keyA, keyB, hostKey]) assert.equal(run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]).status, 0);
    const { readFileSync } = await import("node:fs");
    writeFileSync(join(dir, "authorized_keys"), readFileSync(keyB + ".pub"));
    const known = join(dir, "known hosts"), alias = "nas_1";
    writeFileSync(known, `${alias} ${readFileSync(hostKey + ".pub", "utf8")}`);
    const user = userInfo().username;
    const config = join(dir, "sshd_config");
    const penalties = run(sshd, ["-T", "-f", "/dev/null", "-h", hostKey, "-o", "PerSourcePenalties=no"]).status === 0 ? "PerSourcePenalties no\n" : "";
    writeFileSync(config, `Port ${port}
ListenAddress 127.0.0.1
HostKey ${hostKey}
PidFile ${dir}/pid
AuthorizedKeysFile ${dir}/authorized_keys
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
${penalties}LogLevel ERROR
`);
    daemon = spawn(sshd, ["-D", "-e", "-f", config], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      const ready = await new Promise<boolean>(resolve => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (ready) break;
      if (daemon.exitCode !== null || i === 99) throw new Error("isolated sshd failed to start");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const route = { id: "local", host: "127.0.0.1", port };
    const accessA = { user, hostKeyAlias: alias, identityFile: keyA, knownHostsFile: known };
    const argsA = buildSshRouteArgv(route, accessA), argsB = buildSshRouteArgv(route, { ...accessA, identityFile: keyB });
    assert.equal(run("ssh", [...argsB, "true"]).status, 0, "key B must authenticate with nas_1 host trust");
    const selected = await selectSshRoute([route], { ...accessA, identityFile: keyB },
      { priority: [], totalBudgetMs: 5000 }, { runner: async (_exe, args) => {
        assert.deepEqual(args.slice(-2), ["echo", "envinhands-probe"]);
        const probe = run("ssh", [...args]);
        assert.equal(probe.stdout.trim(), "envinhands-probe");
        return { exitCode: probe.status };
      } });
    assert.equal(selected.observations[0]?.status, "healthy");
    const wrongAlias = buildSshRouteArgv(route, { ...accessA, identityFile: keyB, hostKeyAlias: "nas_2" });
    assert.notEqual(run("ssh", [...wrongAlias, "true"]).status, 0, "different aliases must not share host trust");
    assert.notEqual(run("ssh", [...argsA, "true"]).status, 0, "key A must be rejected");
    const extra = join(dir, "client_config"), socket = masterSocket;
    writeFileSync(extra, `Host *
  IdentityFile ${keyB}
`);
    const withConfig = (args: string[]) => ["-F", extra, ...args.slice(2)];
    assert.equal(run("ssh", [...withConfig(argsA), "true"]).status, 0, "control: config appends B even with IdentitiesOnly");
    assert.notEqual(run("ssh", [...argsA, "true"]).status, 0, "isolated target must not read appended B");
    const master = run("ssh", ["-M", "-S", socket, "-f", "-N", ...argsB]);
    // -S must override our ControlPath=none, so establish a deliberately unsafe master separately.
    if (master.status !== 0 || !existsSync(socket)) {
      const unsafeB = argsB.filter((arg, index) => !(arg === "ControlPath=none" || (arg === "-o" && argsB[index + 1] === "ControlPath=none")));
      assert.equal(run("ssh", ["-M", "-S", socket, "-f", "-N", ...unsafeB]).status, 0, "prebuild master");
    }
    assert.ok(existsSync(socket));
    assert.equal(run("ssh", ["-S", socket, ...argsA, "true"]).status, 0, "control: A can reuse B master without isolation");
    writeFileSync(extra, `Host *
  IdentityFile ${keyB}
  ControlMaster auto
  ControlPath ${socket}
  ControlPersist yes
`);
    assert.notEqual(run("ssh", [...argsA, "true"]).status, 0, "key A must not reuse B master");
    run("ssh", ["-S", socket, "-O", "exit", "127.0.0.1"]);
    // The destination ignores local config, but the separate jump SSH still
    // reads it. A wrapper supplies a private config, not the user's real one.
    const jumpConfig = join(dir, "jump_config");
    writeFileSync(jumpConfig, `Host private-jump
  HostName 127.0.0.1
  Port ${port}
  User ${user}
  IdentityFile ${keyB}
  IdentityAgent none
  IdentitiesOnly yes
  HostKeyAlias ${alias}
  UserKnownHostsFile "${known}"
  StrictHostKeyChecking yes
`);
    const wrapper = join(dir, "ssh");
    writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/ssh -F '${jumpConfig}' "$@"\n`);
    chmodSync(wrapper, 0o700);
    const jump = (identityFile: string) => spawnSync("/usr/bin/ssh", [...buildSshRouteArgv({ ...route, jump: "private-jump" }, { ...accessA, identityFile }), "true"],
      { encoding: "utf8", timeout: 5000, env: { ...process.env, SHELL: "/bin/sh", PATH: `${dir}:${process.env.PATH ?? ""}` } });
    const jumpB = jump(keyB);
    assert.equal(jumpB.status, 0, `configured jump alias must work: ${jumpB.stderr}`);
    assert.notEqual(jump(keyA).status, 0, "jump credentials must not authenticate the target");
  } finally {
    if (existsSync(masterSocket)) run("ssh", ["-S", masterSocket, "-O", "exit", "127.0.0.1"]);
    daemon?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("OpenSSH receives a Windows-style user as one -l argument", () => {
  const route = { id: "r", host: "127.0.0.1" };
  for (const user of ["Jane Doe", "123agent", "_service"]) {
    const args = buildSshRouteArgv(route, { ...access, user, hostKeyAlias: "nas_1" });
    assert.equal(args[args.indexOf("-l") + 1], user);
    const result = spawnSync("ssh", ["-G", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.split(/\r?\n/).includes(`user ${user}`));
    assert.ok(result.stdout.split(/\r?\n/).includes("hostkeyalias nas_1"));
  }
  for (const user of ["", "-bad", "Jane ", "Jane.", "Jane\n", "Jane\tDoe", "Jane;touch", "Jane $(id)", "A".repeat(65)])
    assert.throws(() => buildSshRouteArgv(route, { ...access, user }));
  for (const hostKeyAlias of ["-bad", "nas 1", "nas%h", 'nas"1', "nas\n", "a".repeat(129)])
    assert.throws(() => buildSshRouteArgv(route, { ...access, hostKeyAlias }));
  assert.throws(() => buildSshRouteArgv({ ...route, host: "nas_1" }, access));
});
