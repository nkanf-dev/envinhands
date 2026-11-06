import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransportCatalogApi, fetchTransportCatalog, transportCatalogCandidates, selectCatalogSshRoute } from "../src/transport-catalog.ts";

test("real HTTP and SQLite: team observations, isolation, expiry, restart and safe failover", async () => {
  const dir=mkdtempSync(join(tmpdir(),"transport-catalog-")), dbPath=join(dir,"test.sqlite");
  const token="team-token", now=Date.now(); let clock=now;
  let api=createTransportCatalogApi({dbPath,token,now:()=>clock});
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>api.fetch(req)}), base=server.url.toString();
  const post = (value:unknown, auth=token) => fetch(new URL("/v1/transport-catalog",base),{method:"POST",headers:{authorization:`Bearer ${auth}`,"content-type":"application/json"},body:JSON.stringify(value)});
  const get = (machineId:string,auth=token) => fetch(new URL(`/v1/transport-catalog?machineId=${machineId}`,base),{headers:{authorization:`Bearer ${auth}`}});
  const p2p={machineId:"node-1",routeId:"p2p",kind:"easytier",controller:"controller-1",host:"127.0.0.2",port:22,priority:50,observedAt:now,ttlMs:5000};
  const relay={machineId:"node-1",routeId:"nas",kind:"relay",controller:"controller-1",relayNodeId:"nas-1",priority:0,observedAt:now,ttlMs:5000};
  const direct={...p2p,routeId:"direct",kind:"direct",priority:1,host:"10.0.0.1"};
  const local={access:{user:"agent",hostKeyAlias:"stable-host",identityFile:"/tmp/local-identity",knownHostsFile:"/tmp/local-known-hosts"},relayBinaryPath:"/opt/local/envinhands"};
  try {
    assert.equal((await post(p2p,"wrong")).status,401);
    for(const v of [p2p,relay,direct,{...p2p,machineId:"node-2",routeId:"other"}]) assert.equal((await post(v)).status,200);
    assert.equal((await get("node-2","wrong")).status,401);
    assert.equal((await post({...p2p,host:"host;touch /tmp/no"})).status,400);
    assert.equal((await post({...p2p,command:"id"})).status,400);
    assert.equal((await post({...relay,relayNodeId:"nas;id"})).status,400);
    assert.equal((await post({...relay,binaryPath:"/evil",secret:"oops"})).status,400);
    assert.equal((await post({...p2p,observedAt:now-1})).status,409);
    assert.equal((await post({...p2p,host:"10.0.0.9",observedAt:now+1})).status,400);
    clock++; assert.equal((await post({...p2p,host:"10.0.0.9",observedAt:clock})).status,200);
    api.close(); api=createTransportCatalogApi({dbPath,token,now:()=>clock});
    const page=await fetchTransportCatalog(base,token,"node-1");
    assert.equal(page.routes.length,3); assert.equal(page.routes.find(r=>r.routeId==="p2p")?.host,"10.0.0.9");
    assert.equal((await fetchTransportCatalog(base,token,"node-2")).routes.length,1);
    assert.deepEqual(transportCatalogCandidates(page,"node-1",local,clock).priority,["direct","p2p","nas"]);
    assert.throws(()=>transportCatalogCandidates(page,"node-2",local,clock));
    assert.throws(()=>transportCatalogCandidates(page,"node-1",{...local,relayBinaryPath:"/evil/%h"},clock));
    const calls:string[][]=[];
    const selected=await selectCatalogSshRoute(page,"node-1",local,{totalBudgetMs:1000},{now:()=>clock,runner:async (_exe,args)=>{calls.push([...args]); return {exitCode:calls.length<3?255:0};}});
    assert.equal(selected.route.id,"nas"); assert.deepEqual(selected.observations.map(x=>x.status),["failed","failed","healthy"]);
    assert.ok(calls[2].includes("ProxyCommand='/opt/local/envinhands' proxy 'nas-1'"));
    for(const args of calls) { assert.equal(args.at(-1),"true"); assert.ok(args.includes("HostKeyAlias=stable-host")); assert.ok(args.includes("UserKnownHostsFile=/tmp/local-known-hosts")); }
    assert.equal(selected.argv.includes("true"),false);
    clock+=6000; const expired=await (await get("node-1")).json() as {routes:{status:string}[]};
    assert.ok(expired.routes.every(r=>r.status==="unknown"));
    assert.equal(transportCatalogCandidates(expired as typeof page & {machineId:string},"node-1",local,clock).routes.length,0);
  } finally { server.stop(true); api.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("in-memory databases require opt-in and are isolated and volatile", async () => {
  const token="t", now=Date.now();
  assert.throws(()=>createTransportCatalogApi({dbPath:":memory:",token}), /persistent SQLite filename/);
  assert.throws(()=>createTransportCatalogApi({dbPath:":memory:",token,allowInMemory:false}), /persistent SQLite filename/);
  assert.throws(()=>createTransportCatalogApi({dbPath:"",token,allowInMemory:true}), /persistent SQLite filename/);
  const options={dbPath:":memory:",token,allowInMemory:true,now:()=>now};
  const api=createTransportCatalogApi(options), other=createTransportCatalogApi(options);
  const route={machineId:"node",routeId:"direct",kind:"direct",controller:"controller",host:"127.0.0.1",port:22,priority:1,observedAt:now,ttlMs:5000};
  const get=(catalog:typeof api)=>catalog.fetch(new Request("http://localhost/v1/transport-catalog?machineId=node",{headers:{authorization:`Bearer ${token}`}}));
  try {
    assert.equal((await api.fetch(new Request("http://localhost/v1/transport-catalog",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(route)}))).status,200);
    const page=await (await get(api)).json() as {routes:unknown[]};
    assert.deepEqual(page.routes,[{...route,status:"observed"}]);
    assert.deepEqual((await (await get(other)).json() as {routes:unknown[]}).routes,[]);
    api.close();
    assert.equal((await get(api)).status,503);
    const recreated=createTransportCatalogApi(options);
    try { assert.deepEqual((await (await get(recreated)).json() as {routes:unknown[]}).routes,[]); }
    finally { recreated.close(); }
  } finally { api.close(); other.close(); }
});

test("bounded input, query and forged responses reject before running anything",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"catalog-bounds-")); const api=createTransportCatalogApi({dbPath:join(dir,"a.db"),token:"t"});
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:r=>api.fetch(r)});
  try {
    const base=server.url.toString();
    assert.equal((await fetch(new URL("/v1/transport-catalog",base),{method:"POST",headers:{authorization:"Bearer t"},body:"x".repeat(17000)})).status,413);
    assert.equal((await fetch(new URL("/v1/transport-catalog?machineId=a&machineId=b",base),{headers:{authorization:"Bearer t"}})).status,400);
    await assert.rejects(fetchTransportCatalog("http://remote.example", "t", "node"));
    const evil={machineId:"node",routes:[{machineId:"node",routeId:"r",kind:"relay",controller:"c",relayNodeId:"node",priority:1,observedAt:Date.now(),ttlMs:1000,status:"observed",binaryPath:"/evil"}]};
    await assert.rejects(fetchTransportCatalog(base,"t","node",async()=>new Response(JSON.stringify(evil))));
    const local={access:{user:"agent",hostKeyAlias:"host",identityFile:"/tmp/id",knownHostsFile:"/tmp/known"},relayBinaryPath:"/local/bin"};
    assert.throws(()=>transportCatalogCandidates(evil as never,"node",local));
  } finally {server.stop(true);api.close();rmSync(dir,{recursive:true,force:true});}
});


test("capacity cleanup removes expired rows only for the target machine and preserves live routes across restart", async () => {
  const dir=mkdtempSync(join(tmpdir(),"catalog-gc-")), dbPath=join(dir,"catalog.sqlite");
  let clock=1000;
  let api=createTransportCatalogApi({dbPath,token:"t",now:()=>clock});
  const route=(machineId:string,routeId:string,ttlMs:number)=>({machineId,routeId,kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt:1000,ttlMs});
  const post=(v:unknown)=>api.fetch(new Request("http://localhost/v1/transport-catalog",{method:"POST",headers:{authorization:"Bearer t","content-type":"application/json"},body:JSON.stringify(v)}));
  const get=async(machineId:string)=>(await (await api.fetch(new Request(`http://localhost/v1/transport-catalog?machineId=${machineId}`,{headers:{authorization:"Bearer t"}}))).json()) as {routes:{routeId:string;status:string}[]};
  try {
    assert.equal((await post(route("other","other-expired",1))).status,200);
    for(let i=0;i<64;i++) assert.equal((await post(route("node",`r${i}`,i===0?1:100))).status,200);
    clock=1001;
    assert.equal((await get("node")).routes.find(r=>r.routeId==="r0")?.status,"unknown");
    assert.equal((await post({...route("node","new",100),observedAt:clock})).status,200);
    const rows=(await get("node")).routes;
    assert.equal(rows.length,64);
    assert.equal(rows.some(r=>r.routeId==="r0"),false);
    assert.equal(rows.filter(r=>r.status==="observed").length,64);
    for(let i=1;i<64;i++) assert.ok(rows.some(r=>r.routeId===`r${i}`));
    assert.deepEqual((await get("other")).routes.map(r=>[r.routeId,r.status]),[["other-expired","unknown"]]);
    api.close(); api=createTransportCatalogApi({dbPath,token:"t",now:()=>clock});
    assert.deepEqual((await get("node")).routes,rows);
  } finally { api.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("POST uses one clock sample for validation and expiration at the exact boundary", async () => {
  let clock=1000, calls=0, advance=false;
  const api=createTransportCatalogApi({dbPath:":memory:",allowInMemory:true,token:"t",now:()=>{calls++; return clock+(advance?calls-1:0);}});
  const route=(routeId:string,observedAt=1000)=>({machineId:"node",routeId,kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt,ttlMs:1});
  const post=(v:unknown)=>api.fetch(new Request("http://localhost/v1/transport-catalog",{method:"POST",headers:{authorization:"Bearer t","content-type":"application/json"},body:JSON.stringify(v)}));
  try {
    for(let i=0;i<64;i++) assert.equal((await post(route(`r${i}`))).status,200);
    calls=0; advance=true;
    assert.equal((await post(route("new"))).status,409); // At 1000, all rows are still live.
    assert.equal(calls,1);
    advance=false; clock=1001; calls=0;
    assert.equal((await post(route("new",1001))).status,200); // Expiry is inclusive at 1001.
    assert.equal(calls,1);
    const page=await (await api.fetch(new Request("http://localhost/v1/transport-catalog?machineId=node",{headers:{authorization:"Bearer t"}}))).json() as {routes:{routeId:string;status:string}[]};
    assert.equal(page.routes.length,64);
    assert.equal(page.routes.find(r=>r.routeId==="new")?.status,"observed");
    assert.equal(page.routes.some(r=>r.routeId==="r0"),false);
    assert.equal(page.routes.filter(r=>r.status==="unknown").length,63);
  } finally { api.close(); }
});

test("a stale update conflicts and does not remove expired rows at capacity", async () => {
  let clock=1000;
  const api=createTransportCatalogApi({dbPath:":memory:",allowInMemory:true,token:"t",now:()=>clock});
  const route=(routeId:string,ttlMs:number)=>({machineId:"node",routeId,kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt:1000,ttlMs});
  const post=(v:unknown)=>api.fetch(new Request("http://localhost/v1/transport-catalog",{method:"POST",headers:{authorization:"Bearer t","content-type":"application/json"},body:JSON.stringify(v)}));
  const get=async()=>(await (await api.fetch(new Request("http://localhost/v1/transport-catalog?machineId=node",{headers:{authorization:"Bearer t"}}))).json()) as {routes:{routeId:string;status:string}[]};
  try {
    for(let i=0;i<64;i++) assert.equal((await post(route(`r${i}`,i===0?100:1))).status,200);
    clock=1001;
    const before=(await get()).routes;
    assert.equal((await post({...route("r0",100),observedAt:999})).status,409);
    assert.equal((await post({...route("r1",100),observedAt:999})).status,409); // Expired rows also guard against stale updates.
    assert.deepEqual((await get()).routes,before);
    assert.equal((await post({...route("r1",100),observedAt:1001})).status,200);
    assert.equal((await get()).routes.find(r=>r.routeId==="r1")?.status,"observed");
  } finally { api.close(); }
});

test("concurrent inserts compete for the last live slot across SQLite connections", async () => {
  const dir=mkdtempSync(join(tmpdir(),"catalog-race-")), dbPath=join(dir,"catalog.sqlite"), now=1000;
  const api=createTransportCatalogApi({dbPath,token:"t",now:()=>now}), other=createTransportCatalogApi({dbPath,token:"t",now:()=>now});
  const route=(routeId:string)=>({machineId:"node",routeId,kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt:now,ttlMs:100});
  const post=(a:typeof api,routeId:string)=>a.fetch(new Request("http://localhost/v1/transport-catalog",{method:"POST",headers:{authorization:"Bearer t","content-type":"application/json"},body:JSON.stringify(route(routeId))}));
  try {
    for(let i=0;i<63;i++) assert.equal((await post(api,`r${i}`)).status,200);
    const results=await Promise.all([post(api,"first"),post(other,"second")]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const page=await (await api.fetch(new Request("http://localhost/v1/transport-catalog?machineId=node",{headers:{authorization:"Bearer t"}}))).json() as {routes:{routeId:string}[]};
    assert.equal(page.routes.length,64);
    assert.equal(page.routes.filter(r=>r.routeId==="first" || r.routeId==="second").length,1);
  } finally { api.close(); other.close(); rmSync(dir,{recursive:true,force:true}); }
});


test("eviction chooses earliest expiry then route ID and drops its stale guard", async () => {
  let clock=1000;
  const api=createTransportCatalogApi({dbPath:":memory:",allowInMemory:true,token:"t",now:()=>clock});
  const route=(routeId:string,ttlMs:number,observedAt=1000)=>({machineId:"node",routeId,kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt,ttlMs});
  const post=(v:unknown)=>api.fetch(new Request("http://localhost/v1/transport-catalog",{method:"POST",headers:{authorization:"Bearer t","content-type":"application/json"},body:JSON.stringify(v)}));
  const get=async()=>(await (await api.fetch(new Request("http://localhost/v1/transport-catalog?machineId=node",{headers:{authorization:"Bearer t"}}))).json()) as {routes:{routeId:string}[]};
  try {
    for(let i=0;i<64;i++) assert.equal((await post(route(`r${i}`,i===2 || i===3?1:i===1?2:3))).status,200);
    clock=1003;
    assert.equal((await post(route("new",100,clock))).status,200);
    let rows=(await get()).routes;
    assert.equal(rows.length,64);
    assert.equal(rows.some(r=>r.routeId==="r2"),false); // r2 and r3 tie for earliest expiry.
    assert.ok(rows.some(r=>r.routeId==="r3"));
    assert.ok(rows.some(r=>r.routeId==="r0")); // Lexically first, but expires later.
    assert.equal((await post(route("r2",100,999))).status,200); // The reclaimed row's timestamp is gone.
    rows=(await get()).routes;
    assert.equal(rows.length,64);
    assert.ok(rows.some(r=>r.routeId==="r2"));
    assert.equal(rows.some(r=>r.routeId==="r3"),false);
  } finally { api.close(); }
});

test("concurrent same-route updates preserve the newest observation across connections", async () => {
  const dir=mkdtempSync(join(tmpdir(),"catalog-order-")), dbPath=join(dir,"catalog.sqlite");
  const api=createTransportCatalogApi({dbPath,token:"t",now:()=>1000}), other=createTransportCatalogApi({dbPath,token:"t",now:()=>1000});
  const post=(a:typeof api,routeId:string,observedAt:number)=>a.fetch(new Request("http://localhost/v1/transport-catalog",{method:"POST",headers:{authorization:"Bearer t","content-type":"application/json"},body:JSON.stringify({machineId:"node",routeId,kind:"direct",controller:"c",host:"127.0.0.1",port:22,priority:1,observedAt,ttlMs:100})}));
  try {
    const [olderFirst,newerSecond]=await Promise.all([post(api,"old-first",999),post(other,"old-first",1000)]);
    assert.ok(olderFirst.status===200 || olderFirst.status===409);
    assert.equal(newerSecond.status,200);
    const [newerFirst,olderSecond]=await Promise.all([post(other,"new-first",1000),post(api,"new-first",999)]);
    assert.equal(newerFirst.status,200);
    assert.ok(olderSecond.status===200 || olderSecond.status===409);
    const page=await (await api.fetch(new Request("http://localhost/v1/transport-catalog?machineId=node",{headers:{authorization:"Bearer t"}}))).json() as {routes:{routeId:string;observedAt:number}[]};
    assert.equal(page.routes.length,2);
    assert.ok(page.routes.every(r=>r.observedAt===1000));
    assert.equal((await post(api,"old-first",999)).status,409);
    assert.equal((await post(other,"new-first",999)).status,409);
  } finally { api.close(); other.close(); rmSync(dir,{recursive:true,force:true}); }
});
