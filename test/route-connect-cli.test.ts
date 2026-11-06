import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRouteConnectCli, type RouteConnectDependencies } from "../src/route-connect-cli.ts";

const token = "secret-token-value";
const env = {ENVINHANDS_URL:"http://localhost:1234", ENVINHANDS_TOKEN:token, ENVINHANDS_SSH_IDENTITY:"/tmp/id", ENVINHANDS_SSH_KNOWN_HOSTS:"/tmp/known", ENVINHANDS_PROXY_BINARY:"/tmp/proxy", ENVINHANDS_RELAY_URL:"wss://relay.example/", ENVINHANDS_RELAY_SECRET:"relay-secret"};
const route = (kind:string, overrides:Record<string,unknown> = {}) => ({machineId:"node-1",routeId:kind,kind,controller:"c",priority:1,observedAt:Date.now()-1,ttlMs:60000,status:"observed",...(kind === "relay" ? {relayNodeId:"target"} : {host:"127.0.0.1",port:22}),...overrides});
const fetcher = (routes:unknown[]): NonNullable<RouteConnectDependencies["fetch"]> => async (_url, init) => { assert.equal((init.headers as Record<string,string>).authorization, `Bearer ${token}`); return Response.json({machineId:"node-1",routes}); };
function fakeChild(code = 0):ChildProcess { const child = new EventEmitter() as ChildProcess; child.kill = () => true; queueMicrotask(() => child.emit("close",code,null)); return child; }

test("probes P2P then relay and opens exactly one interactive session with strict stable trust", async () => {
  const probes:string[][] = [], sessions:{args:string[];options:any}[] = [], errors:string[] = [];
  const rc = await runRouteConnectCli(["connect","node-1","alice"], {env, isTTY:true, fetch:fetcher([route("relay"),route("easytier")]), stderr:s=>errors.push(s),
    runner:async (_c,args) => { probes.push([...args]); return {exitCode: probes.length === 1 ? 255 : 0}; },
    spawn:(_c,args,options) => { sessions.push({args:[...args],options}); return fakeChild(17); }});
  assert.equal(rc,17); assert.equal(probes.length,2); assert.equal(sessions.length,1);
  for (const args of probes) { assert.deepEqual(args.slice(-2),["echo","envinhands-probe"]); assert.ok(args.includes("-T")); assert.ok(args.includes("-n")); assert.ok(args.includes("StrictHostKeyChecking=yes")); assert.ok(args.includes("HostKeyAlias=node-1")); assert.ok(args.includes("UserKnownHostsFile=/tmp/known")); }
  const session = sessions[0]; assert.ok(session.args.includes("-tt")); assert.ok(!session.args.includes("-T") && !session.args.includes("-n") && !session.args.includes("true")); assert.ok(session.args.some(a=>a.includes("ProxyCommand="))); assert.equal(session.options.shell,false); assert.equal(session.options.stdio,"inherit"); assert.equal(session.options.env.ENVINHANDS_TOKEN,undefined);
  assert.ok(errors.join(" ").includes("not retried")); assert.ok(!JSON.stringify({probes,sessions,errors}).includes(token));
});

test("changed endpoint cannot alter trust; Windows filters unsupported relay and tries direct", async () => {
  const seen:string[][]=[];
  for (const host of ["10.0.0.1","10.0.0.2"]) {
    const rc = await runRouteConnectCli(["connect","node-1","alice"], {env,isTTY:true,platform:"win32",fetch:fetcher([route("relay"),route("direct",{host})]),runner:async (_c,args)=>{seen.push([...args]);return {exitCode:0};},spawn:()=>fakeChild()});
    assert.equal(rc,0);
  }
  for (const a of seen) { assert.ok(a.includes("StrictHostKeyChecking=yes")); assert.ok(a.includes("HostKeyAlias=node-1")); assert.ok(a.includes("UserKnownHostsFile=/tmp/known")); assert.ok(a.includes("GlobalKnownHostsFile=none")); }
  assert.ok(seen[0].includes("10.0.0.1")); assert.ok(seen[1].includes("10.0.0.2"));
});

test("rejects unsafe inputs, redacts thrown errors, and explains no TTY/no routes", async () => {
  let calls=0; const messages:string[]=[]; const stderr=(s:string)=>messages.push(s);
  assert.equal(await runRouteConnectCli(["connect","node;bad","u"],{stderr}),2);
  assert.equal(await runRouteConnectCli(["connect","node-1","-oBad"],{stderr}),2);
  assert.equal(await runRouteConnectCli(["connect","node-1","u"],{env,isTTY:false,stderr}),2);
  assert.equal(await runRouteConnectCli(["connect","node-1","u"],{env,isTTY:true,stderr,fetch:async()=>{throw new Error(token)}}),1);
  assert.equal(await runRouteConnectCli(["connect","node-1","u"],{env,isTTY:true,stderr,fetch:fetcher([route("relay")]),platform:"win32",runner:async()=>{calls++;return {exitCode:0}}}),1);
  assert.equal(calls,0); assert.ok(messages.join(" ").includes("TTY")); assert.ok(messages.join(" ").includes("Relay unavailable")); assert.ok(!messages.join(" ").includes(token));
});

test("abort during probe never opens interactive ssh", async () => {
  const controller=new AbortController(); let launched=0;
  const rc=await runRouteConnectCli(["connect","node-1","alice"],{env,isTTY:true,signal:controller.signal,fetch:fetcher([route("direct")]),stderr:()=>{},runner:async()=>{controller.abort(); return {exitCode:0};},spawn:()=>{launched++;return fakeChild();}});
  assert.equal(rc,130); assert.equal(launched,0);
});

test("actual OpenSSH invokes configured fake relay proxy and fails closed", async () => {
  if (process.platform === "win32") return;
  const dir=mkdtempSync(join(tmpdir(),"route-connect-")); const proxy=join(dir,"proxy"), marker=join(dir,"called");
  try {
    writeFileSync(proxy,`#!/bin/sh\nprintf '%s' "$*" > '${marker}'\nexit 1\n`,{mode:0o700});
    const messages:string[]=[];
    const rc=await runRouteConnectCli(["connect","node-1","alice"],{env:{...process.env,...env,ENVINHANDS_PROXY_BINARY:proxy},isTTY:true,fetch:fetcher([route("relay")]),stderr:s=>messages.push(s),probeTimeoutMs:3000,totalBudgetMs:5000});
    assert.equal(rc,1); assert.ok(existsSync(marker)); assert.ok(messages.join(" ").includes("No verified SSH route"));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("abort cancels a pending catalog fetch or an active interactive child", async () => {
  const a=new AbortController(); let launched=0;
  const fetching=runRouteConnectCli(["connect","node-1","alice"],{env,isTTY:true,signal:a.signal,stderr:()=>{},fetch:async()=>new Promise<Response>(()=>{}),spawn:()=>{launched++;return fakeChild();}});
  a.abort(); assert.equal(await fetching,130); assert.equal(launched,0);
  const b=new AbortController(); let killed=false;
  const rc=await runRouteConnectCli(["connect","node-1","alice"],{env,isTTY:true,signal:b.signal,stderr:()=>{},fetch:fetcher([route("direct")]),runner:async()=>({exitCode:0}),spawn:()=>{
    launched++; const child=new EventEmitter() as ChildProcess; child.kill=()=>{killed=true; return true;}; queueMicrotask(()=>b.abort()); return child;
  }});
  assert.equal(rc,130); assert.equal(launched,1); assert.equal(killed,true);
});


test("machine IDs with underscores and space-containing SSH users remain separate argv", async () => {
  let probe: string[] = [], interactive: string[] = [];
  const r = route("direct", { machineId: "nas_1" });
  const rc = await runRouteConnectCli(["connect", "nas_1", "Jane Doe"], { env, isTTY:true,
    fetch: async () => Response.json({ machineId: "nas_1", routes: [r] }),
    runner: async (_cmd, args) => { probe = [...args]; return { exitCode: 0 }; },
    spawn: (_cmd, args, options) => { assert.equal(options.shell, false); interactive = [...args]; return fakeChild(); },
  });
  assert.equal(rc, 0);
  for (const args of [probe, interactive]) {
    assert.ok(args.includes("HostKeyAlias=nas_1"));
    assert.equal(args[args.indexOf("-l") + 1], "Jane Doe");
  }
  for (const user of ["-bad", "Jane ", "Jane.", "Jane\n", "Jane;id", "A".repeat(65)])
    assert.equal(await runRouteConnectCli(["connect", "nas_1", user], {stderr:()=>{}}), 2);
  for (const id of ["nas%h", "nas 1", "nas\n", 'nas"1'])
    assert.equal(await runRouteConnectCli(["connect", id, "Jane Doe"], {stderr:()=>{}}), 2);
});
