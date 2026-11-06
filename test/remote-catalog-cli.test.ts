import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createTransportCatalogApi } from "../src/transport-catalog.ts";
import { runRemoteCli } from "../src/remote-cli.ts";

const registration = { registrationId: "reg", agentId: "agent", sessionId: "session", machineId: "host", signature: "Agent" };
const change = (operationId: string) => ({ operationId, registrationId: "reg", targetMachineId: "node-1", resourceId: "/tmp/fixture", action: "exec",
  summary: "Execute approved command", reason: "Test", authority: "Test request", beforeSha256: null, afterSha256: null, evidenceRef: null });

test("catalog exec uses real HTTP and SSH, preserves host trust and never replays an uncertain command", { timeout: 30000 }, async t => {
  if (process.platform === "win32") return t.skip("isolated sshd fixture requires POSIX");
  const sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"].find(existsSync);
  if (!sshd || spawnSync("ssh-keygen", ["-V"], { stdio: "ignore" }).error || spawnSync("ssh", ["-V"], { stdio: "ignore" }).error)
    return t.skip("OpenSSH server, client and keygen required");
  const dir = mkdtempSync(join(tmpdir(), "catalog-exec-"));
  const run = (exe: string, args: string[]) => spawnSync(exe, args, { encoding: "utf8", timeout: 5000 });
  let daemon: ReturnType<typeof spawn> | undefined;
  const api = createTransportCatalogApi({ dbPath: join(dir, "catalog.sqlite"), token: "catalog-secret" });
  const requests: Array<{ path: string; auth: string | null; intentCount: number }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    if (req.method === "GET") requests.push({ path: new URL(req.url).pathname + new URL(req.url).search, auth: req.headers.get("authorization"), intentCount: existsSync(join(dir, "spool")) ? readdirSync(join(dir, "spool")).filter(x => x.endsWith(".json")).length : 0 });
    return api.fetch(req);
  }});
  try {
    const hostKey = join(dir, "host"), identity = join(dir, "id"), known = join(dir, "known"), wrong = join(dir, "wrong");
    for (const key of [hostKey, identity]) assert.equal(run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]).status, 0);
    writeFileSync(join(dir, "authorized_keys"), readFileSync(identity + ".pub"));
    writeFileSync(known, `stable-host ${readFileSync(hostKey + ".pub", "utf8")}`);
    writeFileSync(wrong, "");
    const freePort = async () => {
      const s = createServer();
      await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); });
      const port = (s.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => s.close(err => err ? reject(err) : resolve()));
      return port;
    };
    const port = await freePort();
    const penalties = run(sshd, ["-T", "-f", "/dev/null", "-h", hostKey, "-o", "PerSourcePenalties=no"]).status === 0 ? "PerSourcePenalties no\n" : "";
    const config = join(dir, "sshd_config");
    writeFileSync(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${dir}/pid\nAuthorizedKeysFile ${dir}/authorized_keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n${penalties}LogLevel ERROR\n`);
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
    // Keep the first endpoint reserved and unable to speak SSH, so the preferred
    // route fails and the second route must be verified before the command.
    const dead = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => { dead.once("error", reject); dead.listen(0, "127.0.0.1", resolve); });
    try {
      const deadPort = (dead.address() as { port: number }).port;
      const now = Date.now();
      for (const route of [
        { routeId: "first", port: deadPort, priority: 0 },
        { routeId: "second", port, priority: 1 },
      ]) {
        const res = await fetch(new URL("/v1/transport-catalog", server.url), { method: "POST", headers: { authorization: "Bearer catalog-secret", "content-type": "application/json" },
          body: JSON.stringify({ machineId: "node-1", kind: "direct", controller: "controller", host: "127.0.0.1", observedAt: now, ttlMs: 60000, ...route }) });
        assert.equal(res.status, 200);
      }
      const spool = join(dir, "spool"), marker = join(dir, "marker");
      const env: NodeJS.ProcessEnv = { ...process.env, ENVINHANDS_URL: server.url.toString(), ENVINHANDS_TOKEN: "catalog-secret", ENVINHANDS_CHANGE_SPOOL: spool,
        ENVINHANDS_PROXY_BINARY: "/usr/bin/envinhands" };
      const access = { user: userInfo().username, hostKeyAlias: "stable-host", identityFile: identity, knownHostsFile: known };
      const execute = async (operationId: string, command: string, overrides: Record<string, unknown> = {}, customEnv = env) => {
        let output = "", errors = "";
        const payload = { registration, change: change(operationId), targetMachineId: "node-1", access, probeBudgetMs: 5000, command, timeoutMs: 5000, ...overrides };
        const rc = await runRemoteCli(["--catalog"], customEnv, { readInput: async () => JSON.stringify(payload), write: s => { output += s; }, error: s => { errors += s; } });
        assert.ok(!output.includes("catalog-secret") && !errors.includes("catalog-secret"));
        return { rc, output, errors, result: output ? JSON.parse(output).result : undefined };
      };
      const success = await execute("op-success", `printf 'ok\\n' >> '${marker}'`);
      assert.equal(success.rc, 0, success.errors + success.output);
      assert.equal(success.result.outcome, "success");
      assert.equal(success.result.routeId, "second");
      assert.equal(success.result.started, true);
      assert.equal(success.result.locallyRecorded, true);
      assert.equal(readFileSync(marker, "utf8"), "ok\n");
      const uncertain = await execute("op-uncertain", `printf 'once\\n' >> '${marker}'; exit 255`);
      assert.equal(uncertain.rc, 1);
      assert.equal(uncertain.result.outcome, "unknown");
      assert.equal(uncertain.result.started, true);
      assert.equal(uncertain.result.routeId, "second");
      assert.equal(readFileSync(marker, "utf8"), "ok\nonce\n");
      const repeat = await execute("op-uncertain", `printf 'replayed\\n' >> '${marker}'`);
      assert.equal(repeat.rc, 1);
      assert.equal(readFileSync(marker, "utf8"), "ok\nonce\n");
      const untrusted = await execute("op-untrusted", `printf 'unsafe\\n' >> '${marker}'`, { access: { ...access, knownHostsFile: wrong } });
      assert.equal(untrusted.rc, 1);
      assert.equal(untrusted.result.outcome, "unknown");
      assert.equal(untrusted.result.started, false);
      assert.equal(readFileSync(marker, "utf8"), "ok\nonce\n");
      // Relay is supplied locally and carries only a node ID from the catalog.
      // This real ProxyCommand forwards the OpenSSH byte stream to our sshd.
      const proxy = join(dir, "proxy"), proxyLog = join(dir, "proxy.log");
      writeFileSync(proxy, `#!${process.execPath}
import { connect } from "node:net";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(proxyLog)}, JSON.stringify({args:process.argv.slice(2), secret:process.env.ENVINHANDS_RELAY_SECRET}) + "\\n");
const socket = connect(${port}, "127.0.0.1");
process.stdin.pipe(socket); socket.pipe(process.stdout); socket.on("error", () => process.exit(1));
`, {mode:0o700});
      for (const route of [
        {routeId:"bad-direct",kind:"direct",host:"127.0.0.1",port:deadPort,priority:0},
        {routeId:"relay",kind:"relay",relayNodeId:"relay-node",priority:1},
      ]) {
        const res = await fetch(new URL("/v1/transport-catalog", server.url), {method:"POST", headers:{authorization:"Bearer catalog-secret", "content-type":"application/json"},
          body:JSON.stringify({machineId:"node-relay",controller:"controller",observedAt:Date.now(),ttlMs:60000,...route})});
        assert.equal(res.status, 200);
      }
      const originalUrl = process.env.ENVINHANDS_RELAY_URL, originalSecret = process.env.ENVINHANDS_RELAY_SECRET;
      try {
        process.env.ENVINHANDS_RELAY_URL = "ws://127.0.0.1:1";
        process.env.ENVINHANDS_RELAY_SECRET = "relay-secret";
        const relay = await execute("op-relay", `printf 'relay\\n' >> '${marker}'`, {targetMachineId:"node-relay",change:{...change("op-relay"),targetMachineId:"node-relay"}},
          {...env,ENVINHANDS_PROXY_BINARY:proxy,ENVINHANDS_RELAY_URL:process.env.ENVINHANDS_RELAY_URL,ENVINHANDS_RELAY_SECRET:process.env.ENVINHANDS_RELAY_SECRET});
        assert.equal(relay.rc, 0, relay.errors + relay.output);
        assert.equal(relay.result.routeId, "relay");
        assert.equal(relay.result.outcome, "success");
        assert.equal(readFileSync(marker, "utf8"), "ok\nonce\nrelay\n");
        const invocations = readFileSync(proxyLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.equal(invocations.length, 2); // Probe and exactly one task.
        assert.ok(invocations.every(x => JSON.stringify(x.args) === JSON.stringify(["proxy", "relay-node"]) && x.secret === "relay-secret"));
      } finally {
        if (originalUrl === undefined) delete process.env.ENVINHANDS_RELAY_URL; else process.env.ENVINHANDS_RELAY_URL = originalUrl;
        if (originalSecret === undefined) delete process.env.ENVINHANDS_RELAY_SECRET; else process.env.ENVINHANDS_RELAY_SECRET = originalSecret;
      }
      // Read secrets from a pre-existing file so the input JSON never contains
      // them. A remote program can still return them in untrusted output.
      const secretsFile = join(dir, "output-secrets");
      writeFileSync(secretsFile, "catalog-secret\nrelay-secret\n");
      const secretOutput = await execute("op-redact", `cat '${secretsFile}'`, {}, {...env, ENVINHANDS_RELAY_SECRET:"relay-secret"});
      assert.equal(secretOutput.rc, 0, secretOutput.errors);
      assert.ok(!secretOutput.output.includes("catalog-secret") && !secretOutput.output.includes("relay-secret"));
      assert.equal(secretOutput.result.stdout, "[REDACTED]\n[REDACTED]\n");
      const timeout = await execute("op-timeout", `printf 'timed\\n' >> '${marker}'; sleep 5`, {timeoutMs:300});
      assert.equal(timeout.rc, 1);
      assert.equal(timeout.result.outcome, "unknown");
      assert.equal(timeout.result.timedOut, true);
      assert.equal(timeout.result.started, true);
      assert.equal(readFileSync(marker, "utf8"), "ok\nonce\nrelay\ntimed\n");
      const timeoutRetry = await execute("op-timeout", `printf 'replayed\\n' >> '${marker}'`);
      assert.equal(timeoutRetry.rc, 1);
      assert.equal(readFileSync(marker, "utf8"), "ok\nonce\nrelay\ntimed\n");
      assert.ok(requests.length >= 6);
      assert.ok(requests.every(r => ["/v1/transport-catalog?machineId=node-1", "/v1/transport-catalog?machineId=node-relay"].includes(r.path) && r.auth === "Bearer catalog-secret" && r.intentCount > 0 && r.intentCount % 2 === 1));
      const records = readdirSync(spool).filter(x => x.endsWith(".json")).map(x => readFileSync(join(spool, x), "utf8"));
      assert.equal(records.length, 12);
      assert.ok(records.every(x => !x.includes("catalog-secret")));
    } finally { dead.close(); }
  } finally { daemon?.kill(); server.stop(true); api.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("catalog HTTP failures and forged routes fail closed after recording intent", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-exec-http-"));
  const marker = join(dir, "executed"), proxy = join(dir, "proxy"), proxyMarker = join(dir, "proxy-called");
  writeFileSync(proxy, `#!/bin/sh\nprintf called > '${proxyMarker}'\nexit 1\n`, { mode: 0o700 });
  let mode: "unauthorized" | "forged" | "hang" = "unauthorized", requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
    requests++;
    assert.equal(req.headers.get("authorization"), "Bearer catalog-secret");
    if (mode === "unauthorized") return new Response("no", { status: 401 });
    if (mode === "hang") return await new Promise<Response>(() => {});
    return Response.json({ machineId: "node-1", routes: [{ machineId: "node-1", routeId: "evil", kind: "relay", controller: "c",
      relayNodeId: "node", priority: 0, observedAt: Date.now(), ttlMs: 60000, status: "observed", binaryPath: proxy }] });
  }});
  try {
    const spool = join(dir, "spool");
    const env: NodeJS.ProcessEnv = { ...process.env, ENVINHANDS_URL: server.url.toString(), ENVINHANDS_TOKEN: "catalog-secret", ENVINHANDS_CHANGE_SPOOL: spool,
      ENVINHANDS_PROXY_BINARY: proxy, ENVINHANDS_RELAY_URL: "ws://127.0.0.1:1", ENVINHANDS_RELAY_SECRET: "relay-secret" };
    for (const current of ["unauthorized", "forged", "hang"] as const) {
      mode = current;
      let output = "", error = "";
      const payload = { registration, change: change(`op-${mode}`), targetMachineId: "node-1", access: { user: "agent", hostKeyAlias: "stable-host",
        identityFile: join(dir, "id"), knownHostsFile: join(dir, "known") }, probeBudgetMs: 300, command: `touch '${marker}'`, timeoutMs: 1000 };
      const start = Date.now();
      const rc = await runRemoteCli(["--catalog"], env, { readInput: async () => JSON.stringify(payload), write: s => { output += s; }, error: s => { error += s; } });
      assert.equal(rc, 1, error + output);
      assert.ok(Date.now() - start < 3000, "a stalled catalog must not hold the execution indefinitely");
      const result = JSON.parse(output).result;
      assert.equal(result.outcome, "unknown");
      assert.equal(result.started, false);
      assert.equal(result.locallyRecorded, true);
      assert.equal(result.routeId, null);
      assert.ok(!output.includes("catalog-secret") && !output.includes("relay-secret"));
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(proxyMarker), false);
    }
    assert.equal(requests, 3);
    assert.equal(readdirSync(spool).filter(x => x.endsWith(".json")).length, 6);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});


test("simulated Windows skips relay and can execute through a direct catalog route", { timeout: 10000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX fake SSH fixture; this only simulates Windows route policy");
  const dir = mkdtempSync(join(tmpdir(), "catalog-win-policy-")), calls = join(dir, "calls");
  const api = createTransportCatalogApi({ dbPath: join(dir, "catalog.sqlite"), token: "catalog-secret-windows" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => api.fetch(req) });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`, {mode:0o700});
    for (const route of [
      {routeId:"relay",kind:"relay",relayNodeId:"node",priority:0},
      {routeId:"direct",kind:"direct",host:"127.0.0.1",port:2222,priority:1},
    ]) {
      const response = await fetch(new URL("/v1/transport-catalog",server.url), {method:"POST",headers:{authorization:"Bearer catalog-secret-windows","content-type":"application/json"},
        body:JSON.stringify({machineId:"node-1",controller:"c",observedAt:Date.now(),ttlMs:60000,...route})});
      assert.equal(response.status,200);
    }
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    Object.defineProperty(process,"platform",{value:"win32",configurable:true});
    let output="", errors="";
    const payload = {registration,change:change("op-windows"),targetMachineId:"node-1",
      access:{user:"agent",hostKeyAlias:"stable-host",identityFile:"C:\\keys\\id",knownHostsFile:"C:\\keys\\known"},
      probeBudgetMs:5000,command:"echo hello",timeoutMs:1000};
    const rc = await runRemoteCli(["--catalog"],{...process.env,ENVINHANDS_URL:server.url.toString(),ENVINHANDS_TOKEN:"catalog-secret-windows",ENVINHANDS_CHANGE_SPOOL:join(dir,"spool")},
      {readInput:async()=>JSON.stringify(payload),write:s=>{output+=s;},error:s=>{errors+=s;}});
    assert.equal(rc,0,errors+output);
    const result=JSON.parse(output).result;
    assert.equal(result.routeId,"direct");
    assert.equal(result.outcome,"success");
    const lines=readFileSync(calls,"utf8").trim().split("\n");
    assert.equal(lines.length,2); // One direct probe and one task, never a relay probe.
    assert.ok(lines[0].endsWith("127.0.0.1 echo envinhands-probe"));
    assert.ok(lines[1].endsWith("127.0.0.1 echo hello"));
    assert.ok(lines.every(line=>line.includes("StrictHostKeyChecking=yes") && !line.includes("ProxyCommand=")));
  } finally {
    Object.defineProperty(process,"platform",platform);
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH=originalPath;
    server.stop(true); api.close(); rmSync(dir,{recursive:true,force:true});
  }
});


test("catalog target mismatch and JSON-escaped credentials are rejected before audit and fetch", async () => {
  const dir=mkdtempSync(join(tmpdir(),"catalog-validation-"));
  let requests=0;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>{requests++;return Response.json({machineId:"node-1",routes:[]});}});
  try {
    const spool=join(dir,"spool"), token="catalog-secret", relaySecret="relay-secret";
    const env={...process.env,ENVINHANDS_URL:server.url.toString(),ENVINHANDS_TOKEN:token,ENVINHANDS_RELAY_SECRET:relaySecret,ENVINHANDS_CHANGE_SPOOL:spool};
    const payload={registration,change:change("op-invalid"),targetMachineId:"node-1",access:{user:"agent",hostKeyAlias:"stable-host",identityFile:join(dir,"id"),knownHostsFile:join(dir,"known")},probeBudgetMs:1000,command:"true",timeoutMs:1000};
    const escaped=(secret:string)=>`\\u${secret.charCodeAt(0).toString(16).padStart(4,"0")}${secret.slice(1)}`;
    const inputs=[
      JSON.stringify({...payload,change:{...payload.change,targetMachineId:"other"}}),
      JSON.stringify({...payload,command:token}).replace(token,escaped(token)),
      JSON.stringify({...payload,change:{...payload.change,reason:relaySecret}}).replace(relaySecret,escaped(relaySecret)),
    ];
    for(const input of inputs){
      assert.ok(!input.includes(token) && !input.includes(relaySecret));
      let output="", errors="";
      const rc=await runRemoteCli(["--catalog"],env,{readInput:async()=>input,write:s=>{output+=s;},error:s=>{errors+=s;}});
      assert.equal(rc,1);
      assert.equal(output,"");
      assert.ok(!errors.includes(token) && !errors.includes(relaySecret));
      assert.equal(requests,0);
      assert.equal(existsSync(spool),false);
    }
  } finally {server.stop(true);rmSync(dir,{recursive:true,force:true});}
});


test("all execution modes reject raw and escaped token or relay secret in JSON keys and values", {timeout:30000}, async t => {
  if (process.platform === "win32") return t.skip("POSIX fake SSH fixture");
  const dir=mkdtempSync(join(tmpdir(),"exec-credential-matrix-")), marker=join(dir,"spawned"), originalPath=process.env.PATH;
  const token="catalog-token-credential-934", relaySecret="relay-secret-credential-827";
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>Response.json({machineId:"node-1",routes:[{machineId:"node-1",routeId:"route",kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt:Date.now(),ttlMs:60000,status:"observed"}]})});
  const failures:string[]=[];
  const scan=(path:string):string => {
    if (!existsSync(path)) return "";
    return readdirSync(path,{withFileTypes:true}).map(entry=>{
      const next=join(path,entry.name);
      return entry.name+(entry.isDirectory()?scan(next):readFileSync(next,"utf8"));
    }).join("\n");
  };
  try {
    writeFileSync(join(dir,"ssh"),`#!/bin/sh\nprintf spawned > '${marker}'\nexit 0\n`,{mode:0o700});
    process.env.PATH=`${dir}:${originalPath ?? ""}`;
    for (const mode of ["normal","local","catalog"] as const) {
      for (const encoding of ["raw","escaped"] as const) {
        for (const placement of ["key","value"] as const) {
          for (const secret of [token,relaySecret,"Q"]) {
            const kind=secret===token?"token":secret===relaySecret?"relay":"short";
            const label=`${mode}/${encoding}/${placement}/${kind}`;
            const spool=join(dir,`spool-${mode}-${encoding}-${placement}-${kind}`);
            const env={...process.env,ENVINHANDS_TOKEN:secret==="Q"?"Q":token,ENVINHANDS_RELAY_SECRET:relaySecret,ENVINHANDS_URL:server.url.toString(),ENVINHANDS_CHANGE_SPOOL:spool};
            const modifiedChange={...change(`op-${mode}-${encoding}-${placement}-${kind}`),
              ...(placement==="key" ? {[secret]:"unexpected"} : {reason:`prefix ${secret} suffix`})};
            const shared={registration,change:mode==="local"?{...modifiedChange,targetMachineId:registration.machineId}:modifiedChange,timeoutMs:1000};
            const access={user:"agent",hostKeyAlias:"stable-host",identityFile:join(dir,"id"),knownHostsFile:join(dir,"known")};
            const payload=mode==="local" ? {...shared,cwd:dir,executable:process.execPath,args:["-e",`await Bun.write(${JSON.stringify(marker)}, "spawned")`]} :
              mode==="catalog" ? {...shared,targetMachineId:"node-1",access,probeBudgetMs:1000,command:"true"} :
              {...shared,access,routes:[{id:"route",host:"127.0.0.1",port:22}],priority:["route"],probeBudgetMs:1000,command:"true"};
            let input=JSON.stringify(payload);
            if (encoding==="escaped") {
              const escaped=`\\u${secret.charCodeAt(0).toString(16).padStart(4,"0")}${secret.slice(1)}`;
              input=placement==="key" ? input.replace(`"${secret}":`, `"${escaped}":`) : input.replace(`prefix ${secret} suffix`, `prefix ${escaped} suffix`);
              assert.ok(input.includes(escaped), label);
              const decoded=JSON.parse(input);
              assert.ok(placement==="key" ? secret in decoded.change : decoded.change.reason.includes(secret), label);
            }
            let output="",errors="";
            const rc=await runRemoteCli(mode==="normal"?[]:[`--${mode}`],env,{readInput:async()=>input,write:s=>{output+=s;},error:s=>{errors+=s;}});
            if (rc!==1) failures.push(`${label}: accepted`);
            if (existsSync(marker)) { failures.push(`${label}: started a process`); rmSync(marker,{force:true}); }
            const spoolContent=scan(spool);
            if (spoolContent.includes(secret)||spoolContent.includes(token)||spoolContent.includes(relaySecret)) failures.push(`${label}: leaked a secret to spool`);
            if (output.includes(secret)||output.includes(token)||output.includes(relaySecret)||errors.includes(secret)||errors.includes(token)||errors.includes(relaySecret)) failures.push(`${label}: leaked a secret to output`);
          }
        }
      }
    }
    assert.deepEqual(failures,[]);
  } finally {
    if (originalPath===undefined) delete process.env.PATH; else process.env.PATH=originalPath;
    server.stop(true); rmSync(dir,{recursive:true,force:true});
  }
});


test("empty unconfigured credentials do not block existing execution modes", {timeout:10000}, async t => {
  if (process.platform === "win32") return t.skip("POSIX fake SSH fixture");
  const dir=mkdtempSync(join(tmpdir(),"exec-empty-secret-")), marker=join(dir,"processes"), originalPath=process.env.PATH;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>Response.json({machineId:"node-1",routes:[{machineId:"node-1",routeId:"route",kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt:Date.now(),ttlMs:60000,status:"observed"}]})});
  try {
    writeFileSync(join(dir,"ssh"),`#!/bin/sh\nprintf 'ssh\\n' >> '${marker}'\nexit 0\n`,{mode:0o700});
    process.env.PATH=`${dir}:${originalPath ?? ""}`;
    for(const mode of ["normal","local","catalog"] as const){
      const env={...process.env,ENVINHANDS_TOKEN:mode==="catalog"?"catalog-token-required":"",ENVINHANDS_RELAY_SECRET:"",
        ENVINHANDS_URL:server.url.toString(),ENVINHANDS_CHANGE_SPOOL:join(dir,`spool-${mode}`)};
      const shared={registration,change:{...change(`op-empty-${mode}`),targetMachineId:mode==="local"?registration.machineId:"node-1"},timeoutMs:1000};
      const access={user:"agent",hostKeyAlias:"stable-host",identityFile:join(dir,"id"),knownHostsFile:join(dir,"known")};
      const payload=mode==="local" ? {...shared,cwd:dir,executable:process.execPath,args:["-e",`await Bun.write(${JSON.stringify(join(dir,"local-ran"))}, "yes")`]} :
        mode==="catalog" ? {...shared,targetMachineId:"node-1",access,probeBudgetMs:1000,command:"true"} :
        {...shared,access,routes:[{id:"route",host:"127.0.0.1",port:22}],priority:["route"],probeBudgetMs:1000,command:"true"};
      let output="",errors="";
      const rc=await runRemoteCli(mode==="normal"?[]:[`--${mode}`],env,{readInput:async()=>JSON.stringify(payload),write:s=>{output+=s;},error:s=>{errors+=s;}});
      assert.equal(rc,0,`${mode}: ${errors} ${output}`);
      assert.equal(JSON.parse(output).result.outcome,"success");
      assert.equal(readdirSync(env.ENVINHANDS_CHANGE_SPOOL).filter(x=>x.endsWith(".json")).length,2);
    }
    assert.equal(readFileSync(join(dir,"local-ran"),"utf8"),"yes");
    assert.equal(readFileSync(marker,"utf8").trim().split("\n").length,4); // Two probes and two tasks.
  } finally {
    if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;
    server.stop(true);rmSync(dir,{recursive:true,force:true});
  }
});


test("fixed errors and JSON output keys redact even short secrets", async () => {
  const dir=mkdtempSync(join(tmpdir(),"exec-output-redact-"));
  try {
    for(const token of ["failed","unavailable","e"]) {
      let output="", errors="";
      const rc=await runRemoteCli(["--invalid"],{ENVINHANDS_TOKEN:token,ENVINHANDS_CHANGE_SPOOL:join(dir,"unused")},
        {readInput:async()=>{throw new Error("must not read");},write:s=>{output+=s;},error:s=>{errors+=s;}});
      assert.equal(rc,1);
      assert.equal(output,"");
      assert.ok(errors.length>0);
      assert.equal(errors.includes(token),false,`error leaked ${JSON.stringify(token)}`);
    }
    const token="outcome", secret="started", spool=join(dir,"spool");
    const input=JSON.stringify({registration,change:{...change("op-output-redact"),targetMachineId:registration.machineId},
      executable:process.execPath,args:["-e","process.exit(0)"],cwd:dir,timeoutMs:1000});
    assert.ok(!input.includes(token) && !input.includes(secret));
    let output="", errors="";
    const rc=await runRemoteCli(["--local"],{...process.env,ENVINHANDS_TOKEN:token,ENVINHANDS_RELAY_SECRET:secret,ENVINHANDS_CHANGE_SPOOL:spool},
      {readInput:async()=>input,write:s=>{output+=s;},error:s=>{errors+=s;}});
    assert.equal(rc,0,errors);
    const parsed=JSON.parse(output);
    const strings=(v:unknown):string[] => typeof v==="string"?[v]:Array.isArray(v)?v.flatMap(strings):
      v && typeof v==="object" ? Object.entries(v).flatMap(([key,value])=>[key,...strings(value)]) : [];
    const all=strings(parsed);
    assert.ok(!Object.hasOwn(parsed.result,"outcome") && !Object.hasOwn(parsed.result,"started"));
    assert.ok(all.every(s=>!s.includes(token)&&!s.includes(secret)),"output keys and values must not contain local secrets");
    assert.ok(!errors.includes(token)&&!errors.includes(secret));
    // A JSON boolean literal can itself contain the secret. In that case no
    // valid rendered result may be emitted; durable evidence still exists.
    for (const [index,literalToken] of ["true","{"].entries()) {
      const secondSpool=join(dir,`spool-literal-${index}`);
      const literalInput=JSON.stringify({registration,change:{...change(`op-json-literal-${index}`),targetMachineId:registration.machineId},
        executable:process.execPath,args:["-e","process.exit(0)"],cwd:dir,timeoutMs:1000});
      output=""; errors="";
      const literalRc=await runRemoteCli(["--local"],{...process.env,ENVINHANDS_TOKEN:literalToken,ENVINHANDS_RELAY_SECRET:"",ENVINHANDS_CHANGE_SPOOL:secondSpool},
        {readInput:async()=>literalInput,write:s=>{output+=s;},error:s=>{errors+=s;}});
      assert.equal(literalRc,1);
      assert.equal(output,"");
      assert.ok(errors.length>0 && !errors.includes(literalToken));
      assert.match(errors,/audit/i);
      assert.equal(readdirSync(secondSpool).filter(x=>x.endsWith(".json")).length,2);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
