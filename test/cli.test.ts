import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, symlinkSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli as actualRunCli, reapDebugLogs, debugLogWriterName, type CliDependencies } from "../src/cli.ts";
import { startAgentBusServer } from "../src/server.ts";
import { createRelayServer } from "../src/relay.ts";
import { writeTeamPrimeConfig } from "../src/team-prime-config.ts";
import { createHash } from "node:crypto";
import { verifyClientAccess, UNIX_ROOT_SHELL_CHECK } from "../src/client-access.ts";
import { createMachineApi } from "../src/machine-api.ts";

const testLogs = mkdtempSync(join(tmpdir(), "env-cli-logs-"));
afterAll(() => rmSync(testLogs, { recursive: true, force: true }));
function runCli(args: string[], env: NodeJS.ProcessEnv, deps: Partial<CliDependencies> = {}) {
  return actualRunCli(args, ["server", "node", "relay"].includes(args[0] ?? "") ? { ENVINHANDS_LOG_DIR: testLogs, ...(args[0] === "node" ? { ENVINHANDS_TEAM_AUTO_KEYS: "0" } : {}), ...env } : env, deps);
}

function context() {
  const signals = new EventEmitter();
  let output = "";
  return { signals, stderr: { write(s: string) { output += s; } }, output: () => output };
}

describe("CLI validation and isolation", () => {
  test("rejects extra arguments and malformed configuration without revealing them", async () => {
    const c = context();
    const leak = "secret-do-not-print";
    expect(await runCli(["server", leak], { ENVINHANDS_TOKEN: leak }, c)).toBe(1);
    expect(await runCli(["server"], { ENVINHANDS_TOKEN: leak, ENVINHANDS_PORT: "87oops" }, c)).toBe(1);
    expect(await runCli(["node", "../bad"], { ENVINHANDS_RELAY_SECRET: leak }, c)).toBe(1);
    expect(await runCli(["proxy", "n"], { ENVINHANDS_RELAY_URL: `ws://user:${leak}@localhost/`, ENVINHANDS_RELAY_SECRET: leak }, c)).toBe(1);
    expect(c.output()).not.toContain(leak);
  });
  test("requires secrets and checks port range", async () => {
    const c = context();
    expect(await runCli(["server"], {}, c)).toBe(1);
    expect(await runCli(["relay"], {}, c)).toBe(1);
    expect(await runCli(["node", "n"], { ENVINHANDS_RELAY_URL: "wss://example.org", ENVINHANDS_RELAY_SECRET: "s", ENVINHANDS_SSH_PORT: "0" }, c)).toBe(1);
    expect(await runCli(["relay"], { ENVINHANDS_RELAY_SECRET: "s", ENVINHANDS_RELAY_PORT: "65536" }, c)).toBe(1);
  });
  test("help lists core commands and Team SSH configuration", async () => {
    const c = context();
    expect(await runCli(["--help"], {}, c)).toBe(0);
    expect(c.output()).toContain("register FLAGS");
    expect(c.output()).toContain("connect MACHINE_ID");
    expect(c.output()).toContain("ENVINHANDS_SSH_IDENTITY");
    expect(c.output()).toContain("ENVINHANDS_SSH_KNOWN_HOSTS");
  });
  test("proxy passes environment settings and hides errors, never writes stdout", async () => {
    const c = context();
    let captured: unknown;
    const startProxy: CliDependencies["startProxy"] = async (opts) => { captured = opts; throw new Error("secret-do-not-print"); };
    const result = await runCli(["proxy", "node-1"], { ENVINHANDS_RELAY_URL: "wss://relay.example", ENVINHANDS_RELAY_SECRET: "secret-do-not-print" }, { ...c, startProxy });
    expect(result).toBe(1);
    expect(captured).toEqual({ relayUrl: "wss://relay.example", nodeId: "node-1", secret: "secret-do-not-print" });
    expect(c.output()).toContain("Command failed");
    expect(c.output()).not.toContain("secret-do-not-print");
  });
  test("node starts reconnecting runtime with defaults and cleans up on signal", async () => {
    const c = context();
    let resolve!: () => void;
    const finished = new Promise<void>(r => { resolve = r; });
    let captured: unknown, closes = 0;
    const startNode: CliDependencies["startNode"] = (opts) => {
      captured = opts;
      return { ready: Promise.resolve(), finished, close() { closes++; resolve(); } };
    };
    const result = runCli(["node", "n"], { ENVINHANDS_RELAY_URL: "ws://localhost:8788", ENVINHANDS_RELAY_SECRET: "s" }, { ...c, startNode });
    c.signals.emit("SIGTERM"); c.signals.emit("SIGINT");
    expect(await result).toBe(0);
    expect(captured).toEqual({ relayUrl: "ws://localhost:8788", nodeId: "n", secret: "s", sshPort: 22, onEvent: expect.any(Function) });
    expect(closes).toBe(1);
    expect(c.signals.listenerCount("SIGTERM")).toBe(0);
    expect(c.output()).toContain("wss://");
  });
});

test("real loopback bus CLI starts, authenticates, and releases its port on SIGTERM", async () => {
  const c = context();
  const dir = mkdtempSync(join(tmpdir(), "env-cli-"));
  let server: ReturnType<typeof startAgentBusServer> | undefined;
  const startServer: CliDependencies["startServer"] = options => { server = startAgentBusServer(options); return server; };
  const task = runCli(["server"], { ENVINHANDS_TOKEN: "test-token", ENVINHANDS_HOST: "127.0.0.1", ENVINHANDS_PORT: "0", ENVINHANDS_DB: join(dir, "db.sqlite") }, { ...c, startServer });
  try {
    expect(server).toBeDefined();
    const url = server!.url;
    expect((await fetch(url + "/v1/agents")).status).toBe(401);
    expect((await fetch(url + "/v1/agents", { headers: { authorization: "Bearer test-token" } })).status).toBe(200);
    c.signals.emit("SIGTERM");
    expect(await task).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
    expect(c.output()).not.toContain("test-token");
  } finally { c.signals.emit("SIGTERM"); await task; rmSync(dir, { recursive: true, force: true }); }
});

test("real loopback relay CLI requires its bearer secret and stops on SIGINT", async () => {
  const c = context();
  let server: ReturnType<typeof createRelayServer> | undefined;
  const startRelay: CliDependencies["startRelay"] = options => { server = createRelayServer(options); return server; };
  const task = runCli(["relay"], { ENVINHANDS_RELAY_SECRET: "relay-test-token", ENVINHANDS_RELAY_HOST: "127.0.0.1", ENVINHANDS_RELAY_PORT: "0" }, { ...c, startRelay });
  try {
    expect(server).toBeDefined();
    const url = `http://127.0.0.1:${server!.port}/node?id=n`;
    expect((await fetch(url)).status).toBe(401);
    c.signals.emit("SIGINT");
    expect(await task).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
    expect(c.output()).not.toContain("relay-test-token");
  } finally { c.signals.emit("SIGINT"); await task; }
});


test("proxy executable sends errors to stderr and leaves stdout empty", async () => {
  const secret = "secret-process-test";
  const child = Bun.spawn([process.execPath, "src/cli.ts", "proxy", "n"], {
    cwd: process.cwd(),
    env: { ...process.env, ENVINHANDS_RELAY_URL: "ws://127.0.0.1:1", ENVINHANDS_RELAY_SECRET: secret },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("Command failed");
  expect(stderr).not.toContain(secret);
});

test("unexpected runtime failure closes the runtime without leaking errors", async () => {
  const c = context();
  let closes = 0;
  const startNode: CliDependencies["startNode"] = () => ({
    ready: Promise.resolve(), finished: Promise.reject(new Error("sensitive failure")), close() { closes++; },
  });
  expect(await runCli(["node", "n"], { ENVINHANDS_RELAY_URL: "wss://relay.example", ENVINHANDS_RELAY_SECRET: "s" }, { ...c, startNode })).toBe(1);
  expect(closes).toBe(1);
  expect(c.output()).not.toContain("sensitive failure");
  expect(c.signals.listenerCount("SIGTERM")).toBe(0);
});


describe("register CLI", () => {
  const args = ["register", "--id", "node-1", "--name", "Node One", "--host", "host.example", "--os", "linux", "--ssh-user", "admin", "--ssh-port", "2222"];
  const env = { ENVINHANDS_URL: "https://example.org", ENVINHANDS_TOKEN: "secret-register-token", ENVINHANDS_AGENT_ID: "cli-test", ENVINHANDS_MACHINE_ID: "client", ENVINHANDS_SESSION_ID: "cli-session", ENVINHANDS_AUDIT_SIGNATURE: "CLI test", ENVINHANDS_SSH_IDENTITY: "/tmp/test-client-key", ENVINHANDS_SSH_KNOWN_HOSTS: "/tmp/test-known-hosts" };
  const machine = { id:"node-1", name:"Node One", host:"host.example", os:"linux", sshUser:"admin", sshPort:2222, relayNodeId:null };
  function ctx() { let stdout = ""; const c = context(); return { ...c, stdout: { write(s: string) { stdout += s; } }, out: () => stdout }; }
  function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
  // Use the real verifier but replace SSH and key fingerprinting. No host, key,
  // or sudo settings on the machine running the tests are accessed.
  function verifier(exitCodes: number[] = [0, 0]) {
    const commands: Array<{ command:string; args:readonly string[] }> = [];
    const optionsSeen: Array<Parameters<typeof verifyClientAccess>[0]> = [];
    const verify: typeof verifyClientAccess = (options, dependencies) => {
      optionsSeen.push(options);
      return verifyClientAccess(options, {
        ...dependencies, fingerprint: async () => "SHA256:" + "A".repeat(43),
        runner: async (command, args) => { commands.push({command, args}); return {exitCode:exitCodes[commands.length - 1] ?? 0}; },
      });
    };
    return {verify, commands, optionsSeen};
  }
  test("server readiness plus real local client verification gives JSON success", async () => {
    const c = ctx(); const calls: Array<{url:string; init?:RequestInit}> = []; const v = verifier();
    const fake: CliDependencies["fetch"] = async (url, init) => {
      calls.push({url:String(url), init}); const path = new URL(String(url)).pathname;
      if (path === "/v1/machines") return json({machine:{...machine,status:"pending"}}, 202);
      if (path.endsWith("/verify")) return json({machine:{...machine,status:"ready"},verificationScope:"server"});
      return json({error:"not found"}, 404);
    };
    expect(await runCli(args, env, { ...c, fetch:fake, verifyClientAccess:v.verify })).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({ok:true,data:{id:"node-1",status:"ready"},meta:{}});
    expect(c.output()).toBe("");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({id:"node-1",name:"Node One",host:"host.example",os:"linux",sshUser:"admin",sshPort:2222});
    expect(calls[0]!.init!.redirect).toBe("error");
    expect(calls.some(x=>x.url.endsWith("/v1/machines/node-1/verify") && x.init?.body === undefined)).toBe(true);
    expect(v.commands.length).toBe(2);
    expect(v.commands[0]!.args.slice(-2)).toEqual(["echo", "envinhands-probe"]);
    expect(v.commands[1]!.args.at(-1)).toBe(UNIX_ROOT_SHELL_CHECK);
    expect(c.out() + c.output()).not.toContain(env.ENVINHANDS_TOKEN);
  });
  test("repeated ID reads existing record, never overwrites, and verifies only a matching relay", async () => {
    for (const existingRelay of ["relay-1", "different-relay"]) {
      const c = ctx(); const calls: Array<{url:string; method:string}> = []; const v = verifier();
      // Only the relay must match. Probe the validated server record, not the
      // new command's host, OS, user, or port.
      const existing = {...machine, name:"Server Name", host:"old.example", os:"macos", sshUser:"olduser", sshPort:2022, relayNodeId:existingRelay};
      const fake: CliDependencies["fetch"] = async (url, init) => {
        const u = new URL(String(url)); const method = init?.method ?? "GET"; calls.push({url:String(url),method});
        if (u.pathname === "/v1/machines" && method === "POST") return json({error:"exists"},409);
        if (u.pathname === "/v1/machines" && method === "GET") return json({machines:[existing]});
        if (u.pathname.endsWith("/verify")) return json({machine:{...existing,status:"ready"}});
        return json({},404);
      };
      const result = await runCli([...args,"--relay-node","relay-1"],env,{...c,fetch:fake,verifyClientAccess:v.verify});
      const listed = calls.find(x=>x.method === "GET" && new URL(x.url).pathname === "/v1/machines");
      expect(listed).toBeDefined(); expect(new URL(listed!.url).searchParams.get("includePending")).toBe("true");
      expect(new URL(listed!.url).searchParams.get("includeNotReady")).toBe("true");
      expect(calls.filter(x=>x.method === "POST" && new URL(x.url).pathname === "/v1/machines")).toHaveLength(1);
      expect(calls.some(x=>["PUT","PATCH","DELETE"].includes(x.method))).toBe(false);
      if (existingRelay === "relay-1") {
        expect(result).toBe(0); expect(JSON.parse(c.out()).ok).toBe(true); expect(v.commands).toHaveLength(2);
        expect(v.optionsSeen).toHaveLength(1);
        expect(v.optionsSeen[0]).toMatchObject({os:"macos",access:{user:"olduser"},routes:[{host:"old.example",port:2022}]});
        expect(v.commands[0]!.args).toContain("old.example"); expect(v.commands[0]!.args).toContain("olduser");
        expect(v.commands[0]!.args).toContain("2022");
        expect(calls.some(x=>x.url.endsWith("/verify"))).toBe(true);
      } else {
        expect(result).not.toBe(0); expect(c.out()).toBe(""); expect(JSON.parse(c.output())).toMatchObject({ok:false,error:{code:"E_NODE_CONFLICT"}});
        expect(calls.some(x=>x.url.endsWith("/verify"))).toBe(false); expect(v.commands).toHaveLength(0);
      }
      expect(c.out()+c.output()).not.toContain(env.ENVINHANDS_TOKEN);
    }
  });
  test("repeated ID rejects invalid or ambiguous existing directory records before verifying", async () => {
    for (const records of [
      [{...machine,sshUser:"bad;user"}], [{...machine,sshPort:0}],
      [machine,machine], [],
    ]) {
      const c=ctx(), v=verifier(); const calls:string[]=[];
      const fake: CliDependencies["fetch"] = async (url,init)=>{
        const u=new URL(String(url)); calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
        if (u.pathname === "/v1/machines" && init?.method === "POST") return json({},409);
        if (u.pathname === "/v1/machines") return json({machines:records});
        return json({},404);
      };
      expect(await runCli(args,env,{...c,fetch:fake,verifyClientAccess:v.verify})).not.toBe(0);
      expect(JSON.parse(c.output())).toMatchObject({ok:false,error:{code:"E_DIRECTORY"}});
      expect(c.out()).toBe(""); expect(v.commands).toHaveLength(0);
      expect(calls.some(x=>x.endsWith("/verify"))).toBe(false);
    }
  });
  test("server failure and failed client admin check return deterministic JSON errors", async () => {
    for (const mode of ["server", "client", "throw"] as const) {
      const outputs: string[] = [];
      for (let attempt=0; attempt<2; attempt++) {
        const c = ctx(); const v = verifier([0,1]);
        const fake: CliDependencies["fetch"] = async (url) => {
          const path = new URL(String(url)).pathname;
          if (mode === "throw") throw new Error(env.ENVINHANDS_TOKEN);
          if (path === "/v1/machines") return json({machine:{...machine,status:"pending"}},202);
          if (path.endsWith("/verify")) return json({machine:{...machine,status:mode === "server" ? "pending" : "ready"}});
          return json({},404);
        };
        expect(await runCli(args,env,{...c,fetch:fake,verifyClientAccess:v.verify})).not.toBe(0);
        expect(c.out()).toBe(""); const error=JSON.parse(c.output());
        expect(error.ok).toBe(false); expect(typeof error.error.code).toBe("string");
        expect(c.output()).not.toContain(env.ENVINHANDS_TOKEN); outputs.push(c.output());
        if (mode === "server") expect(v.commands).toHaveLength(0);
        if (mode === "client") expect(v.commands).toHaveLength(2);
      }
      expect(outputs[0]).toBe(outputs[1]);
    }
  });
  test("rejects malformed flags and URLs without network access or secret leakage", async () => {
    for (const [argv, url] of [[args,"https://user:secret-register-token@example.org"], [[...args,"--id","other"],env.ENVINHANDS_URL], [args.map(x=>x === "2222" ? "22;evil" : x),env.ENVINHANDS_URL]] as Array<[string[],string]>) {
      const c=ctx(); let calls=0;
      expect(await runCli(argv,{...env,ENVINHANDS_URL:url},{...c,fetch:async()=>{calls++;throw new Error("unexpected");}})).not.toBe(0);
      expect(calls).toBe(0); expect(c.out()).toBe(""); expect(JSON.parse(c.output()).ok).toBe(false);
      expect(c.output()).not.toContain(env.ENVINHANDS_TOKEN);
    }
  });
  test("loopback machine API persists a repeated ID without overwriting it", async () => {
    const dir=mkdtempSync(join(tmpdir(),"env-register-api-")); let serverChecks=0;
    const api=createMachineApi({dbPath:join(dir,"machines.sqlite"),token:env.ENVINHANDS_TOKEN,
      verifier:async()=>{serverChecks++; return {status:"ready",ready:true,message:"fixture"};}});
    const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>api.fetch(req)});
    const localEnv={...env,ENVINHANDS_URL:`http://127.0.0.1:${server.port}`};
    try {
      for (let n=0; n<2; n++) {
        const c=ctx(), v=verifier();
        const input = n === 0 ? args : args.map(x=>({"host.example":"new.example","linux":"macos","admin":"newuser","2222":"3333"} as Record<string,string>)[x] ?? x);
        expect(await runCli([...input,"--relay-node","relay-1"],localEnv,{...c,verifyClientAccess:v.verify})).toBe(0);
        expect(JSON.parse(c.out())).toMatchObject({ok:true,data:{id:"node-1",status:"ready"}});
        expect(c.output()).toBe(""); expect(v.commands).toHaveLength(2);
        expect(v.optionsSeen[0]).toMatchObject({os:"linux",access:{user:"admin"},routes:[{host:"host.example",port:2222}]});
      }
      const c=ctx(), v=verifier();
      expect(await runCli([...args,"--relay-node","relay-2"],localEnv,{...c,verifyClientAccess:v.verify})).not.toBe(0);
      expect(JSON.parse(c.output())).toMatchObject({ok:false,error:{code:"E_NODE_CONFLICT"}});
      expect(c.out()).toBe(""); expect(v.commands).toHaveLength(0); expect(serverChecks).toBe(2);
      const response=await fetch(`${localEnv.ENVINHANDS_URL}/v1/machines?includePending=true&includeNotReady=true`,{headers:{authorization:`Bearer ${env.ENVINHANDS_TOKEN}`}});
      const page=await response.json() as {machines:Array<Record<string,unknown>>};
      expect(page.machines).toHaveLength(1); expect(page.machines[0]).toMatchObject({...machine,relayNodeId:"relay-1"});
    } finally {server.stop(true);api.close();rmSync(dir,{recursive:true,force:true});}
  });
  test("request timeout returns redacted JSON and aborts a fetch that ignores abort", async () => {
    const c=ctx(); let signal:AbortSignal | undefined;
    const fake: CliDependencies["fetch"] = async (_url,init)=>{signal=init?.signal ?? undefined; return await new Promise<Response>(()=>{});};
    expect(await runCli(args,env,{...c,fetch:fake,requestTimeoutMs:10})).not.toBe(0);
    expect(signal?.aborted).toBe(true); expect(c.out()).toBe(""); expect(JSON.parse(c.output()).ok).toBe(false);
    expect(c.output()).not.toContain(env.ENVINHANDS_TOKEN);
  });
});


describe("tmux over relay CLI", () => {
  const env = { ENVINHANDS_RELAY_URL: "wss://relay.example", ENVINHANDS_RELAY_SECRET: "relay-secret-do-not-print", ENVINHANDS_PROXY_BINARY: "/opt/envin hands/it's%cli" };
  const ready = { stdinIsTTY: true, stdoutIsTTY: true, platform: "linux" as const, compiled: false };
  test("passes builder argv and inherited environment without exposing the secret", async () => {
    const c = context(); let captured: string[] = []; let passedEnv: NodeJS.ProcessEnv | undefined;
    const runSsh: CliDependencies["runSsh"] = async (argv, childEnv) => { captured = argv; passedEnv = childEnv; return 23; };
    const status = await runCli(["tmux", "node-1", "job_1", "alice"], env, { ...c, ...ready, runSsh });
    if (process.platform === "win32") {
      expect(status).toBe(1); expect(captured).toEqual([]);
      expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      return;
    }
    expect(status).toBe(23);
    expect(captured.slice(0, 4)).toEqual(["ssh", "-tt", "-o", "StrictHostKeyChecking=yes"]);
    expect(captured).toContain("-l"); expect(captured).toContain("alice");
    expect(captured).toContain("ProxyCommand='/opt/envin hands/it'\\''s%%cli' proxy 'node-1'");
    expect(captured.slice(-5)).toEqual(["tmux", "new-session", "-A", "-s", "envinhands-job_1"]);
    expect(captured.join(" ")).not.toContain(env.ENVINHANDS_RELAY_SECRET);
    expect(passedEnv).toBe(env); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
  });
  test("requires TTYs, valid environment, safe arguments and compiled executable", async () => {
    const c = context(); let calls = 0;
    const runSsh: CliDependencies["runSsh"] = async () => { calls++; return 0; };
    const cases: Array<[string[], NodeJS.ProcessEnv, Partial<CliDependencies>]> = [
      [["tmux", "n", "s"], env, { stdinIsTTY: false }],
      [["tmux", "n", "s"], env, { stdoutIsTTY: false }],
      [["tmux", "n", "s"], env, { platform: "win32" }],
      [["tmux", "n"], env, {}], [["tmux", "n", "s", "u", "extra"], env, {}],
      [["tmux", "../n", "s"], env, {}], [["tmux", "n", "s;bad"], env, {}],
      [["tmux", "n", "s", "-bad"], env, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_PROXY_BINARY: "relative" }, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_PROXY_BINARY: undefined }, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_RELAY_SECRET: undefined }, {}],
      [["tmux", "n", "s"], { ...env, ENVINHANDS_RELAY_URL: "wss://user:password@host" }, {}],
    ];
    for (const [args, e, override] of cases) expect(await runCli(args, e, { ...c, ...ready, ...override, runSsh })).toBe(1);
    expect(calls).toBe(0); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
  });
  test("compiled mode uses execPath, failures are redacted, plaintext warns", async () => {
    const c = context(); let argv: string[] = [];
    const runSsh: CliDependencies["runSsh"] = async a => { argv = a; throw new Error(env.ENVINHANDS_RELAY_SECRET); };
    expect(await runCli(["tmux", "n", "s"], { ...env, ENVINHANDS_PROXY_BINARY: undefined, ENVINHANDS_RELAY_URL: "ws://localhost" }, { ...c, ...ready, compiled: true, execPath: "/opt/cli", runSsh })).toBe(1);
    if (process.platform === "win32") {
      expect(argv).toEqual([]); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      return;
    }
    expect(argv.join(" ")).toContain("'/opt/cli'"); expect(c.output()).toContain("Warning");
    expect(c.output()).toContain("Command failed"); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
  });
  test("real runner launches fake local ssh directly, inherits env and forwards exit status", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "fake ssh "));
    try {
      const resultFile = join(dir, "result");
      writeFileSync(join(dir, "ssh"), '#!/bin/sh\nprintf "%s" "$ENVINHANDS_RELAY_SECRET" > "$RESULT_FILE"\nexit 17\n', { mode: 0o755 });
      const c = context();
      expect(await runCli(["tmux", "n", "s"], { ...env, PATH: dir, RESULT_FILE: resultFile }, { ...c, ...ready })).toBe(17);
      expect(readFileSync(resultFile, "utf8")).toBe(env.ENVINHANDS_RELAY_SECRET);
      expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      expect(c.signals.listenerCount("SIGINT")).toBe(0); expect(c.signals.listenerCount("SIGTERM")).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("missing ssh executable is redacted and removes signal handlers", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "no-ssh-"));
    try {
      const c = context();
      expect(await runCli(["tmux", "n", "s"], { ...env, PATH: dir }, { ...c, ...ready })).toBe(1);
      expect(c.output()).toContain("Command failed"); expect(c.output()).not.toContain(env.ENVINHANDS_RELAY_SECRET);
      expect(c.signals.listenerCount("SIGINT")).toBe(0); expect(c.signals.listenerCount("SIGTERM")).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("signal is forwarded to ssh and handlers are removed", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "fake-ssh-"));
    try {
      writeFileSync(join(dir, "ssh"), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o755 });
      for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
        const c = context();
        const task = runCli(["tmux", "n", "s"], { ...env, PATH: dir }, { ...c, ...ready });
        c.signals.emit(signal);
        expect(await task).toBe(status);
        expect(c.signals.listenerCount("SIGINT")).toBe(0); expect(c.signals.listenerCount("SIGTERM")).toBe(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


test("CLI writes private metadata, redacts known secrets, and warns on faults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-cli-private-"));
  const c = context();
  let options!: Parameters<CliDependencies["startRelay"]>[0];
  const task = runCli(["relay"], { ENVINHANDS_LOG_DIR: dir, ENVINHANDS_RELAY_SECRET: "sensitive-secret" }, {
    ...c, startRelay: opts => { options = opts; opts.onEvent?.("node_connected", { machineId: "sensitive-secret" }); return { hostname: "127.0.0.1", port: 1, stop() {} }; },
  });
  c.signals.emit("SIGTERM"); expect(await task).toBe(0);
  const folders = readdirSync(dir); expect(folders).toHaveLength(1);
  const folder = join(dir, folders[0]!); const file = join(folder, "events.jsonl");
  const data = readFileSync(file, "utf8");
  expect(data).toContain("REDACTED"); expect(data).not.toContain("sensitive-secret");
  expect(statSync(folder).mode & 0o777).toBe(0o700); expect(statSync(file).mode & 0o777).toBe(0o600);
  const fault = context();
  const failed = runCli(["relay"], { ENVINHANDS_LOG_DIR: "relative", ENVINHANDS_RELAY_SECRET: "sensitive-secret" }, {
    ...fault, startRelay: () => ({ hostname: "127.0.0.1", port: 1, stop() {} }),
  });
  fault.signals.emit("SIGTERM"); expect(await failed).toBe(0);
  expect(fault.output()).toContain("Logging fault"); expect(fault.output()).not.toContain("sensitive-secret");
  const win = context();
  const degraded = runCli(["relay"], { ENVINHANDS_LOG_DIR: dir, ENVINHANDS_RELAY_SECRET: "sensitive-secret" }, {
    ...win, platform: "win32", startRelay: () => ({ hostname: "127.0.0.1", port: 1, stop() {} }),
  });
  win.signals.emit("SIGTERM"); expect(await degraded).toBe(0);
  expect(win.output()).toContain("unsupported_windows_acl");
  rmSync(dir, { recursive: true, force: true });
});


test("retention prunes only validated stopped writers, preserves live and unsafe paths", async () => {
  if (process.platform !== "linux") return;
  const base = mkdtempSync(join(tmpdir(), "env-retention-"));
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  const deadPid = child.pid; await child.exited;
  const create = (pid: number) => {
    const dir = join(base, debugLogWriterName("server", pid)); mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, "events.jsonl");
    writeFileSync(file, JSON.stringify({ component: "server", event: "server_started", timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return { dir, file };
  };
  const stopped1 = create(deadPid), stopped2 = create(deadPid), live = create(process.pid);
  const unknown = join(base, "ordinary-user-data"); mkdirSync(unknown);
  const target = join(base, "target"); mkdirSync(target);
  const link = join(base, debugLogWriterName("server", deadPid)); symlinkSync(target, link);
  const unsafe = join(base, debugLogWriterName("server", deadPid)); mkdirSync(unsafe, { mode: 0o700 });
  symlinkSync(stopped1.file, join(unsafe, "events.jsonl"));
  const foreign = create(deadPid); writeFileSync(foreign.file, "user content\n", { mode: 0o600 });
  const otherNsName = debugLogWriterName("server", deadPid).replace(/-([0-9]+)$/, (_, ns: string) => `-${ns}9`);
  const otherNs = join(base, otherNsName); mkdirSync(otherNs, { mode: 0o700 });
  writeFileSync(join(otherNs, "events.jsonl"), JSON.stringify({ component: "server", event: "server_started", timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 });
  const age = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  for (const e of [stopped1, stopped2, live, foreign]) { utimesSync(e.file, age, age); utimesSync(e.dir, age, age); }
  try {
    const first = reapDebugLogs(base, { maxAgeMs: 1000, maxTotalBytes: 1 });
    expect(first.removed).toBe(2); expect(first.failures).toBeGreaterThanOrEqual(3);
    expect(existsSync(stopped1.dir)).toBe(false); expect(existsSync(stopped2.dir)).toBe(false);
    for (const path of [live.dir, unknown, target, link, unsafe, foreign.dir, otherNs]) expect(existsSync(path)).toBe(true);
    const second = reapDebugLogs(base, { maxAgeMs: 1000, maxTotalBytes: 1 });
    expect(second.removed).toBe(0); expect(existsSync(live.file)).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});


test("real short-lived relay processes leave logs that concurrent startup cleanup can reap", async () => {
  if (process.platform !== "linux") return;
  const base = mkdtempSync(join(tmpdir(), "env-restarts-"));
  try {
    for (let i = 0; i < 2; i++) {
      const child = Bun.spawn([process.execPath, "src/cli.ts", "relay"], {
        env: { ...process.env, ENVINHANDS_LOG_DIR: base, ENVINHANDS_RELAY_SECRET: "test-retention-secret", ENVINHANDS_RELAY_HOST: "127.0.0.1", ENVINHANDS_RELAY_PORT: "0" },
        stdout: "ignore", stderr: "pipe",
      });
      try {
        const reader = child.stderr.getReader(); let output = "";
        while (!output.includes("Relay started.")) {
          const result = await reader.read(); if (result.done) throw new Error("relay exited before start");
          output += new TextDecoder().decode(result.value);
        }
        child.kill("SIGTERM"); expect([0, 143]).toContain(await child.exited); reader.releaseLock();
      } finally { child.kill("SIGTERM"); await child.exited; }
    }
    expect(readdirSync(base)).toHaveLength(2);
    const script = `import { reapDebugLogs } from ${JSON.stringify(join(process.cwd(), "src/cli.ts"))}; reapDebugLogs(${JSON.stringify(base)}, { maxTotalBytes: 0, maxAgeMs: 0 });`;
    const a = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
    const b = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    expect(readdirSync(base)).toHaveLength(0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});


test("node automatically advertises observed routes without blocking relay and cleans up", async () => {
  const c = context(); let finish!: () => void; const finished = new Promise<void>(r => { finish = r; });
  let nodeOptions: Parameters<CliDependencies["startNode"]>[0] | undefined;
  let observerOptions: Parameters<CliDependencies["startRouteAdvertiser"]>[0] | undefined;
  let observerDeps: Parameters<CliDependencies["startRouteAdvertiser"]>[1] | undefined;
  let stopped = 0, closes = 0; const connected: boolean[] = [];
  const startNode: CliDependencies["startNode"] = options => { nodeOptions=options; return {ready:Promise.resolve(),finished,close(){closes++;finish();}}; };
  const startRouteAdvertiser: CliDependencies["startRouteAdvertiser"] = (options, dependencies) => {
    observerOptions=options; observerDeps=dependencies;
    return {setRelayConnected(value){connected.push(value);}, refresh(){}, stop(){stopped++;}};
  };
  let headers: Headers | undefined;
  const testFetch: CliDependencies["fetch"] = async (_url, init) => {headers=new Headers(init?.headers);return new Response("ok");};
  const task = runCli(["node","node-a"], {ENVINHANDS_RELAY_URL:"ws://localhost:8788",ENVINHANDS_RELAY_SECRET:"relay-test",ENVINHANDS_URL:"http://127.0.0.1:28787",ENVINHANDS_TOKEN:"api-test",ENVINHANDS_EASYTIER_INTERFACES:"et0, et1"}, {...c,startNode,startRouteAdvertiser,fetch:testFetch});
  expect(observerOptions?.machineId).toBe("node-a"); expect(observerOptions?.relayNodeId).toBe("node-a");
  expect(observerOptions?.easytierInterfaces).toEqual(["et0","et1"]); expect(observerOptions?.controller).toMatch(/^node-[a-f0-9]{64}$/);
  await observerDeps!.fetch!(new URL("http://127.0.0.1:28787/v1/transport-catalog"), {method:"POST"});
  expect(headers?.get("x-envinhands-registration")).toBeTruthy(); expect(headers?.get("x-envinhands-operation-id")).toBeTruthy();
  nodeOptions!.onEvent!("node_registered",{}); nodeOptions!.onEvent!("node_disconnected",{});
  expect(connected).toEqual([true,false]); c.signals.emit("SIGTERM");
  expect(await task).toBe(0); expect(stopped).toBe(1); expect(closes).toBe(1); expect(c.output()).not.toContain("api-test");
});

test("automatic route setup failure never blocks the relay node", async () => {
  const c=context(); let finish!:()=>void; const finished=new Promise<void>(r=>{finish=r;}); let started=false;
  const task=runCli(["node","n"],{ENVINHANDS_RELAY_URL:"wss://localhost",ENVINHANDS_RELAY_SECRET:"r",ENVINHANDS_URL:"http://127.0.0.1",ENVINHANDS_TOKEN:"secret-test"},{...c,
    startRouteAdvertiser:()=>{throw new Error("secret-test");}, startNode:()=>{started=true;return {ready:Promise.resolve(),finished,close(){finish();}};}});
  expect(started).toBe(true); expect(c.output()).toContain("Relay remains available"); expect(c.output()).not.toContain("secret-test");
  c.signals.emit("SIGINT"); expect(await task).toBe(0);
});


test("real node publishes relay and direct observations to the signed control server", async () => {
  const c=context(), dir=mkdtempSync(join(tmpdir(),"env-observer-"));
  const control=startAgentBusServer({token:"ctrl-test",dbPath:join(dir,"db.sqlite"),hostname:"127.0.0.1",port:0});
  const relay=createRelayServer({secret:"relay-test",hostname:"127.0.0.1",port:0});
  const task=runCli(["node","route-node"],{ENVINHANDS_RELAY_URL:`ws://127.0.0.1:${relay.port}`,ENVINHANDS_RELAY_SECRET:"relay-test",ENVINHANDS_URL:control.url,ENVINHANDS_TOKEN:"ctrl-test"},c);
  try {
    let routes: any[]=[];
    for(let n=0;n<80;n++) {
      const res=await fetch(`${control.url}/v1/transport-catalog?machineId=route-node`,{headers:{authorization:"Bearer ctrl-test"}});
      routes=(await res.json() as {routes:any[]}).routes;
      if(routes.some(x=>x.kind==="relay" && x.status==="observed")) break;
      await Bun.sleep(25);
    }
    expect(routes.some(x=>x.kind==="relay" && x.relayNodeId==="route-node" && x.status==="observed")).toBe(true);
    expect(routes.every(x=>x.controller.startsWith("node-"))).toBe(true);
  } finally {c.signals.emit("SIGTERM"); await task; await control.stop(); relay.stop(); rmSync(dir,{recursive:true,force:true});}
});


describe("node team auto onboarding", () => {
  const env = { ENVINHANDS_RELAY_URL: "wss://relay.example", ENVINHANDS_RELAY_SECRET: "relay-secret-private", ENVINHANDS_URL: "https://control.example", ENVINHANDS_TOKEN: "token-private", ENVINHANDS_TEAM_AUTO_KEYS: "1" };
  function runtime(events: string[]): CliDependencies["startNode"] {
    return () => { events.push("runtime-start"); let finish!: () => void; const finished = new Promise<void>(r => { finish = r; });
      return {ready: Promise.resolve(), finished, close() { events.push("runtime-close"); finish(); }}; };
  }
  function advertiser(events: string[]): CliDependencies["startRouteAdvertiser"] {
    return () => ({ stop() { events.push("advertiser-stop"); }, setRelayConnected() {}, refresh() {} });
  }
  test("starts once with the route actor and closes runtime before awaiting onboarding then advertiser", async () => {
    const c = context(), events: string[] = []; let opts!: Parameters<CliDependencies["createTeamNodeOnboard"]>[0];
    let done!: () => void; const stopDone = new Promise<void>(r => { done = r; });
    const createTeamNodeOnboard: CliDependencies["createTeamNodeOnboard"] = o => { opts = o; return {
      sshPaths: () => ({privateKeyPath:"", knownHostsPath:"",hostKeyAlias:""}),
      start() { events.push("onboard-start"); }, async stop() { events.push("onboard-stop"); await stopDone; events.push("onboard-stopped"); }
    }; };
    const task = runCli(["node", "n"], env, {...c, platform:"linux", currentUserHome:()=>"/isolated", startNode: runtime(events), startRouteAdvertiser: advertiser(events), createTeamNodeOnboard});
    expect(events).toEqual(["runtime-start", "onboard-start"]); expect(opts.home).toBe("/isolated"); expect(opts.deviceId).toBe("n");
    expect(opts.hostPublicKeyPath).toBe("/etc/ssh/ssh_host_ed25519_key.pub"); expect(opts.fullTeamTrust).toBe(true);
    expect(opts.registration.machineId).toBe("n"); expect(opts.registration.agentId).toMatch(/^node-[0-9a-f]{64}$/);
    expect(opts.registration.signature).toBe("EnvInHands node route observer");
    c.signals.emit("SIGTERM"); await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(["runtime-start", "onboard-start", "runtime-close", "onboard-stop"]);
    done(); expect(await task).toBe(0); expect(events.slice(-2)).toEqual(["onboard-stopped", "advertiser-stop"]);
    expect(c.output()).not.toContain("token-private"); expect(c.output()).not.toContain("relay-secret-private");
  });
  test("disabled and Windows never call onboarding; Windows says unsupported", async () => {
    for (const [platform, extra, expected] of [["linux", {ENVINHANDS_TEAM_AUTO_KEYS:"0"}, false], ["win32", {}, true]] as const) {
      const c=context(), events:string[]=[]; let called=0;
      const task=runCli(["node","n"], {...env,...extra}, {...c, platform, startNode:runtime(events), startRouteAdvertiser:advertiser(events), createTeamNodeOnboard:()=>{called++; throw new Error();}});
      c.signals.emit("SIGTERM"); expect(await task).toBe(0); expect(called).toBe(0); expect(c.output().includes("unsupported")).toBe(expected);
    }
  });
  test("onboarding setup failures and unsafe host path do not stop relay or expose secrets", async () => {
    for (const host of ["/safe/host.pub", "../bad"]) {
      const c=context(), events:string[]=[]; let called=0;
      const task=runCli(["node","n"], {...env, ENVINHANDS_SSH_HOST_PUBLIC_KEY:host}, {...c, platform:"linux", currentUserHome:()=>"/isolated", startNode:runtime(events), startRouteAdvertiser:advertiser(events), createTeamNodeOnboard:()=>{called++; throw new Error("token-private");}});
      expect(events).toContain("runtime-start"); expect(c.output()).toContain("E_TEAM_SYNC"); expect(c.output()).not.toContain("token-private");
      expect(called).toBe(host.startsWith("/") ? 1 : 0); c.signals.emit("SIGINT"); expect(await task).toBe(0);
    }
  });
});


test("node CLI runs real relay and onboarding against an isolated loopback directory", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const { createTeamIdentitiesApi } = await import("../src/team-identities.ts");
  const { createTeamNodeOnboard } = await import("../src/team-node-onboard.ts");
  const dir=mkdtempSync(join(tmpdir(),"env-cli-team-"));
  const key=join(dir,"host");
  const keygen=Bun.spawn(["/usr/bin/ssh-keygen","-q","-t","ed25519","-N","","-f",key],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  expect(await keygen.exited).toBe(0);
  const api=createTeamIdentitiesApi({dbPath:join(dir,"test.sqlite"),token:"private-team-token"});
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api.fetch});
  const relay=createRelayServer({hostname:"127.0.0.1",port:0,secret:"private-relay-token"});
  const c=context(); let synced!:()=>void, registered!:()=>void;
  const synchronization=new Promise<void>(r=>{synced=r;}); const registration=new Promise<void>(r=>{registered=r;});
  const task=runCli(["node","node-fixture"], {ENVINHANDS_TEAM_AUTO_KEYS:"1", ENVINHANDS_RELAY_URL:`ws://127.0.0.1:${relay.port}`, ENVINHANDS_RELAY_SECRET:"private-relay-token", ENVINHANDS_URL:`http://127.0.0.1:${server.port}`, ENVINHANDS_TOKEN:"private-team-token", ENVINHANDS_SSH_HOST_PUBLIC_KEY:key+".pub"}, {
    ...c, currentUserHome:()=>dir,
    startNode: opts => { const inst = require("../src/node-runtime.ts").startNodeRuntime(opts); void inst.ready.then(registered,()=>{}); return inst; },
    createTeamNodeOnboard: opts => createTeamNodeOnboard({...opts, onStatus: status=>{opts.onStatus?.(status);if(status.code==="synchronized")synced();}}),
  });
  try {
    await Promise.race([Promise.all([synchronization,registration]), new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("fixture timeout")),15000))]);
    const privateKey=readFileSync(join(dir,".envinhands-team","client_ed25519"),"utf8");
    expect(readFileSync(join(dir,".envinhands-team","known_hosts"),"utf8")).toContain("node-fixture ssh-ed25519");
    expect(readFileSync(join(dir,".ssh","authorized_keys"),"utf8")).toContain("ssh-ed25519");
    expect(c.output()).not.toContain(privateKey); expect(c.output()).not.toContain("private-team-token"); expect(c.output()).not.toContain("private-relay-token");
  } finally {c.signals.emit("SIGTERM"); await task; relay.stop(); server.stop(true); api.close(); rmSync(dir,{recursive:true,force:true});}
}, 20000);

describe("Team defaults at the CLI boundary", () => {
  test("resource commands use private defaults but explicit pairs win and partial pairs never mix", async () => {
    const home = mkdtempSync(join(tmpdir(), "env-cli-team-"));
    try {
      await writeTeamPrimeConfig({url:"https://team.example", token:"team-secret-xyz", machineId:"workstation"}, {home});
      const seen: {url:string; auth:string|null}[] = [];
      const c = context();
      const deps = {...c, stdout:{write(_:string) {}}, fetch: async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({url:String(input), auth:new Headers(init?.headers).get("authorization")});
        return Response.json({agents:[]});
      }};
      await runCli(["collaborate", "agents"], {HOME:home}, deps);
      expect(seen[0]?.url).toContain("https://team.example/");
      expect(seen[0]?.auth).toBe("Bearer team-secret-xyz");
      seen.length = 0;
      await runCli(["collaborate", "agents"], {HOME:home, ENVINHANDS_URL:"https://other.example", ENVINHANDS_TOKEN:"explicit-secret"}, deps);
      expect(seen[0]?.url).toContain("https://other.example/");
      expect(seen[0]?.auth).toBe("Bearer explicit-secret");
      seen.length = 0;
      expect(await runCli(["collaborate", "agents"], {HOME:home, ENVINHANDS_URL:"https://other.example"}, deps)).toBe(1);
      expect(seen).toHaveLength(0);
      expect(c.output()).toContain("E_TEAM_CONFIG_PARTIAL");
      expect(c.output()).not.toContain("team-secret-xyz");
      seen.length = 0;
      expect(await runCli(["collaborate", "agents"], {}, deps)).toBe(1);
      expect(seen).toHaveLength(0);
    } finally { rmSync(home, {recursive:true, force:true}); }
  });

  test("connect uses private SSH paths and resolves optional user with authenticated identities", async () => {
    const home = mkdtempSync(join(tmpdir(), "env-cli-connect-"));
    try {
      await writeTeamPrimeConfig({url:"https://team.example", token:"team-secret-xyz", machineId:"workstation"}, {home});
      const dir=join(home,".envinhands-team"); mkdirSync(dir, {mode:0o700});
      writeFileSync(join(dir,"client_ed25519"), "private-key", {mode:0o600});
      writeFileSync(join(dir,"known_hosts"), "# envinhands-snapshot 1\n", {mode:0o600});
      const keyBytes=Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from("ssh-ed25519"), Buffer.from([0,0,0,32]), Buffer.alloc(32, 1)]);
      const key="ssh-ed25519 "+keyBytes.toString("base64");
      const fingerprint="SHA256:"+createHash("sha256").update(keyBytes).digest("base64").replace(/=+$/, "");
      const record={deviceId:"target",os:"linux",user:"alice",publicKey:key,hostKey:key,publicKeyFingerprint:fingerprint,hostKeyFingerprint:fingerprint,revision:1};
      const seen: {url:string; auth:string|null}[]=[];
      const c=context();
      const deps={...c, stdinIsTTY:true, stdoutIsTTY:true, fetch:async (input:string | URL | Request, init?:RequestInit) => {
        seen.push({url:String(input),auth:new Headers(init?.headers).get("authorization")});
        return String(input).includes("/v1/team-identities") ? Response.json({record,revision:1}) : new Response("",{status:503});
      }};
      expect(await runCli(["connect", "target"], {HOME:home}, deps)).toBe(1);
      expect(seen).toHaveLength(2);
      expect(seen[0]!.url).toContain("/v1/team-identities?deviceId=target");
      expect(seen[0]!.auth).toBe("Bearer team-secret-xyz");
      expect(seen[1]!.url).toContain("transport");
      expect(c.output()).not.toContain("Team SSH files are missing");
      seen.length=0;
      await runCli(["connect", "target", "bob"], {HOME:home}, deps);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toContain("transport");
      seen.length=0;
      await runCli(["connect", "target", "-bad"], {HOME:home}, deps);
      expect(seen).toHaveLength(0);
      expect(c.output()).not.toContain("team-secret-xyz");
      expect(c.signals.listenerCount("SIGTERM")).toBe(0);
    } finally { rmSync(home, {recursive:true, force:true}); }
  });
});

test("connect relay binary defaults and TTY gate", async () => {
  const env={ENVINHANDS_URL:"https://team.example", ENVINHANDS_TOKEN:"secret-value", ENVINHANDS_RELAY_URL:"wss://relay.example", ENVINHANDS_RELAY_SECRET:"relay-secret", ENVINHANDS_SSH_IDENTITY:"/tmp/key", ENVINHANDS_SSH_KNOWN_HOSTS:"/tmp/known"};
  let requests=0;
  const fetcher=async () => { requests++; return new Response("",{status:503}); };
  const noTty=context();
  expect(await runCli(["connect","target"], env, {...noTty,fetch:fetcher,stdinIsTTY:false,stdoutIsTTY:false})).toBe(2);
  expect(requests).toBe(0);
  const source=context();
  await runCli(["connect","target","alice"], env, {...source,fetch:fetcher,stdinIsTTY:true,stdoutIsTTY:true,compiled:false,platform:"linux"});
  expect(source.output()).toContain("ENVINHANDS_PROXY_BINARY");
  const compiled=context();
  await runCli(["connect","target","alice"], env, {...compiled,fetch:fetcher,stdinIsTTY:true,stdoutIsTTY:true,compiled:true,execPath:"/opt/envinhands",platform:"linux"});
  expect(compiled.output()).not.toContain("ENVINHANDS_PROXY_BINARY");
  const unsafe=context();
  await runCli(["connect","target","alice"], env, {...unsafe,fetch:fetcher,stdinIsTTY:true,stdoutIsTTY:true,compiled:true,execPath:"/bad/%path",platform:"linux"});
  expect(unsafe.output()).toContain("ENVINHANDS_PROXY_BINARY");
});


test("node defaults to onboarding on macOS and preserves relay on worker errors", async () => {
  const c=context(); let finish!:()=>void, closes=0, starts=0, stops=0;
  const finished=new Promise<void>(r=>{finish=r;});
  const task=actualRunCli(["node","mac-node"], {ENVINHANDS_LOG_DIR:testLogs, ENVINHANDS_RELAY_URL:"wss://relay.example", ENVINHANDS_RELAY_SECRET:"relay-secret", ENVINHANDS_URL:"https://control.example", ENVINHANDS_TOKEN:"control-secret"}, {
    ...c, platform:"darwin", currentUserHome:()=>"/isolated", startRouteAdvertiser:()=>({setRelayConnected(){},refresh(){},stop(){}}),
    startNode:()=>({ready:Promise.resolve(),finished,close(){closes++;finish();}}),
    createTeamNodeOnboard:opts=>{
      expect(opts.hostPublicKeyPath).toBe("/private/etc/ssh/ssh_host_ed25519_key.pub");
      return {sshPaths:()=>({privateKeyPath:"",knownHostsPath:"",hostKeyAlias:""}),start(){starts++;opts.onStatus?.({code:"retry",message:"control-secret",ready:false});},async stop(){stops++;}};
    },
  });
  expect(starts).toBe(1); expect(closes).toBe(0); expect(c.output()).toContain("E_TEAM_SYNC: synchronization incomplete; retrying."); expect(c.output()).not.toContain("control-secret");
  c.signals.emit("SIGTERM"); expect(await task).toBe(0); expect(closes).toBe(1); expect(stops).toBe(1);
});


test("connect stops when the machine is absent from Team identities", async () => {
  const c=context(); let calls=0;
  const env={ENVINHANDS_URL:"https://control.example",ENVINHANDS_TOKEN:"hidden-token", ENVINHANDS_SSH_IDENTITY:"/tmp/unused-private",ENVINHANDS_SSH_KNOWN_HOSTS:"/tmp/unused-known"};
  const result=await runCli(["connect","missing"],env,{...c,stdinIsTTY:true,stdoutIsTTY:true,fetch:async ()=>{calls++;return Response.json({record:null,revision:null});}});
  expect(result).toBe(1);expect(calls).toBe(1);expect(c.output()).toContain("E_SSH_USER");expect(c.output()).not.toContain("hidden-token");
});


test("connect directory timeout returns a safe actionable error", async () => {
  const c=context();let signal:AbortSignal|undefined;
  const env={ENVINHANDS_URL:"https://control.example",ENVINHANDS_TOKEN:"hidden-token",ENVINHANDS_SSH_IDENTITY:"/tmp/no-key",ENVINHANDS_SSH_KNOWN_HOSTS:"/tmp/no-hosts"};
  const result=await runCli(["connect","target"],env,{...c,stdinIsTTY:true,stdoutIsTTY:true,requestTimeoutMs:10,fetch:async (_url,init)=>{signal=init?.signal??undefined;return new Promise<Response>(()=>{});}});
  expect(result).toBe(1);expect(signal?.aborted).toBe(true);expect(c.output()).toContain("E_TEAM_DIRECTORY");expect(c.output()).not.toContain("hidden-token");
});


test("status and machines use Team defaults through the unified CLI", async () => {
  const home = mkdtempSync(join(tmpdir(), "env-cli-status-"));
  const auth: string[] = [];
  const server = Bun.serve({hostname:"127.0.0.1", port:0, fetch(req) {
    auth.push(req.headers.get("authorization") ?? "");
    return Response.json({machines:[{id:"node-a",name:"Node A",os:"linux",sshUser:"alice",relayNodeId:null,status:"ready",host:"127.0.0.1",sshPort:22,checkedAt:null}]});
  }});
  let stdout = "", stderr = "", requests = 0;
  const deps: Partial<CliDependencies> = {
    stdout:{write(text){stdout += text;}}, stderr:{write(text){stderr += text;}}, requestTimeoutMs:1000,
    fetch: async (input, init) => { requests++; expect(init?.signal).toBeDefined(); return fetch(input, init); },
  };
  try {
    await writeTeamPrimeConfig({url:`http://127.0.0.1:${server.port}`,token:"private-status-token",machineId:"local-node"}, {home});
    expect(await runCli(["status"], {HOME:home}, deps)).toBe(0);
    const result=JSON.parse(stdout); expect(result.ok).toBe(true); expect(result.data.command).toBe("status");
    expect(result.data.localMachineId).toBe("local-node"); expect(result.data.machines[0].id).toBe("node-a");
    expect(auth).toEqual(["Bearer private-status-token"]); expect(stderr).toBe("");
    stdout="";
    expect(await runCli(["machines","--format","table"], {HOME:home}, deps)).toBe(0);
    expect(stdout).toContain("ID\tSTATUS\tOS\tUSER"); expect(stdout).toContain("node-a\tready\tlinux\talice");
    expect(requests).toBe(2); expect(stdout + stderr).not.toContain("private-status-token");
    stdout=""; stderr="";
    expect(await runCli(["machines","--bad"], {HOME:home}, deps)).toBe(2);
    expect(JSON.parse(stderr).error.code).toBe("USAGE"); expect(requests).toBe(2);
  } finally { server.stop(true); rmSync(home,{recursive:true,force:true}); }
});

test("status uses injected request timeout and does not read the real home", async () => {
  let stderr="", stdout="", observed:AbortSignal | null | undefined;
  const code = await runCli(["status"], {ENVINHANDS_URL:"http://127.0.0.1:1", ENVINHANDS_TOKEN:"hidden-token"}, {
    stderr:{write(text){stderr += text;}}, stdout:{write(text){stdout += text;}}, requestTimeoutMs:10,
    fetch: async (_url, init) => {observed=init?.signal; return await new Promise<Response>(()=>{});},
  });
  expect(code).toBe(4); expect(JSON.parse(stderr).error.code).toBe("TIMEOUT"); expect(observed?.aborted).toBe(true);
  expect(stdout).toBe(""); expect(stderr).not.toContain("hidden-token");
});


test("register uses Team defaults and a declared local actor", async () => {
  const home=mkdtempSync(join(tmpdir(),"env-cli-register-team-"));
  const requests: {auth:string; actor:string; body:string}[]=[];
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
    requests.push({auth:req.headers.get("authorization")??"",actor:req.headers.get("x-envinhands-registration")??"",body:await req.text()});
    return Response.json({machine:{status:"pending"}},{status:202});
  }});
  const c=context(); const args=["register","--id","target","--name","Target","--host","localhost","--os","linux","--ssh-user","alice"];
  try {
    await writeTeamPrimeConfig({url:`http://127.0.0.1:${server.port}`,token:"private-team-register",machineId:"local-client"},{home});
    expect(await runCli(args,{HOME:home},c)).toBe(1);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.every(r=>r.auth==="Bearer private-team-register")).toBe(true);
    const actor=JSON.parse(Buffer.from(requests[0]!.actor,"base64url").toString());
    expect(actor.machineId).toBe("local-client"); expect(actor.agentId).toMatch(/^cli-[a-f0-9]{64}$/);
    expect(actor.sessionId).toMatch(/^[a-f0-9-]{36}$/); expect(actor.signature).toBe("EnvInHands CLI registration");
    expect(JSON.parse(requests[0]!.body).id).toBe("target"); expect(c.output()).not.toContain("private-team-register");
  } finally {server.stop(true);rmSync(home,{recursive:true,force:true});}
});

test("register reports actor and partial Team configuration errors without fetching", async () => {
  const args=["register","--id","target","--name","Target","--host","localhost","--os","linux","--ssh-user","alice"];
  let requests=0; const c=context(); const deps={...c,fetch:async()=>{requests++;throw new Error("private-token");}};
  expect(await runCli(args,{ENVINHANDS_URL:"https://example.org",ENVINHANDS_TOKEN:"private-token"},deps)).toBe(1);
  expect(c.output()).toContain("E_ACTOR"); expect(requests).toBe(0);
  expect(await runCli(args,{ENVINHANDS_URL:"https://example.org",ENVINHANDS_MACHINE_ID:"local"},deps)).toBe(1);
  expect(c.output()).toContain("E_TEAM_CONFIG_PARTIAL"); expect(requests).toBe(0); expect(c.output()).not.toContain("private-token");
  expect(await runCli(args,{ENVINHANDS_URL:"https://example.org",ENVINHANDS_TOKEN:"private-token",ENVINHANDS_MACHINE_ID:"../bad"},deps)).toBe(1);
  expect(c.output().trim().split("\n").map(line=>JSON.parse(line).error.code)).toEqual(["E_ACTOR","E_TEAM_CONFIG_PARTIAL","E_ACTOR"]); expect(requests).toBe(0);
});


test("register on Windows selects a relay catalog route for the real access verifier", async () => {
  const token="private-win-token", secret="private-win-relay";
  const args=["register","--id","win-node","--name","Windows","--host","unreachable.example","--os","windows","--ssh-user","alice"];
  const env={ENVINHANDS_URL:"https://control.example",ENVINHANDS_TOKEN:token,ENVINHANDS_MACHINE_ID:"client",
    ENVINHANDS_SSH_IDENTITY:"/isolated/key",ENVINHANDS_SSH_KNOWN_HOSTS:"/isolated/hosts",
    ENVINHANDS_RELAY_URL:"wss://relay.example",ENVINHANDS_RELAY_SECRET:secret,ENVINHANDS_PROXY_BINARY:"/isolated/envinhands.exe"};
  let stdout="",stderr=""; const commands:string[][]=[];
  const result=await runCli(args,env,{
    platform:"win32", stdout:{write(text){stdout+=text;}},stderr:{write(text){stderr+=text;}},
    fetch:async (input,init)=>{
      const u=new URL(String(input));
      if(u.pathname==="/v1/machines")return Response.json({machine:{}},{status:202});
      if(u.pathname.endsWith("/verify"))return Response.json({machine:{status:"ready"}});
      if(u.pathname==="/v1/transport-catalog") return Response.json({machineId:"win-node",routes:[{
        machineId:"win-node",routeId:"relay-route",kind:"relay",controller:"test",relayNodeId:"win-node",
        priority:1,observedAt:Date.now()-1,ttlMs:60000,status:"observed"}]});
      return new Response(null,{status:404});
    },
    verifyClientAccess:(options,dependencies)=>verifyClientAccess(options,{
      ...dependencies, fingerprint:async()=>"SHA256:"+"A".repeat(43),
      runner:async (command,argv)=>{expect(command).toBe("ssh");commands.push([...argv]);return {exitCode:0};},
    }),
  });
  expect(result).toBe(0);expect(JSON.parse(stdout).data.status).toBe("ready");expect(stderr).toBe("");
  expect(commands).toHaveLength(2);expect(commands[0]!.join(" ")).toContain("ProxyCommand=");
  expect(commands[0]!.join(" ")).toContain("win-node");
  expect(commands[1]).toContain("powershell.exe");expect(commands[1]).toContain("-EncodedCommand");
  expect(JSON.stringify(commands)+stdout+stderr).not.toContain(token);expect(JSON.stringify(commands)+stdout+stderr).not.toContain(secret);
});


test("register accepts Windows SSH users with spaces or leading digits, not for Unix", async () => {
  const env={ENVINHANDS_URL:"https://control.example",ENVINHANDS_TOKEN:"private-token",ENVINHANDS_MACHINE_ID:"client",
    ENVINHANDS_SSH_IDENTITY:"/isolated/key",ENVINHANDS_SSH_KNOWN_HOSTS:"/isolated/hosts"};
  const argv=(os:string,user:string)=>["register","--id","machine","--name","Machine","--host","host.example","--os",os,"--ssh-user",user];
  let requests=0, output="", errors=""; const commands:string[][]=[];
  const deps:Partial<CliDependencies>={
    stdout:{write(text){output+=text;}},stderr:{write(text){errors+=text;}},
    fetch:async (input,init)=>{requests++;const path=new URL(String(input)).pathname;
      if(path==="/v1/machines")return Response.json({machine:{}},{status:202});
      if(path.endsWith("/verify"))return Response.json({machine:{status:"ready"}});
      return new Response(null,{status:404});},
    verifyClientAccess:(options,dependencies)=>verifyClientAccess(options,{...dependencies,
      fingerprint:async()=>"SHA256:"+"A".repeat(43),runner:async (_command,args)=>{commands.push([...args]);return {exitCode:0};}}),
  };
  for(const user of ["123agent","Team Member"]) {
    output="";errors="";commands.length=0;
    expect(await runCli(argv("windows",user),env,deps)).toBe(0);
    expect(JSON.parse(output).data.status).toBe("ready");expect(errors).toBe("");
    expect(commands).toHaveLength(2);expect(commands[0]).toContain(user);expect(commands[1]).toContain("powershell.exe");
  }
  for(const [os,user] of [["linux","123agent"],["macos","Team Member"],["windows","bad;command"],["windows","bad "]]) {
    const before=requests; output="";errors="";
    expect(await runCli(argv(os!,user!),env,deps)).toBe(1); expect(requests).toBe(before);
    expect(JSON.parse(errors)).toEqual({ok:false,error:{code:"E_USAGE"}});expect(output).toBe("");
  }
  expect(output+errors+JSON.stringify(commands)).not.toContain("private-token");
});
