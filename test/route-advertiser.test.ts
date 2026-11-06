import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTransportCatalogApi } from "../src/transport-catalog.ts";
import { startRouteAdvertiser } from "../src/route-advertiser.ts";
import type { RouteAdvertiserDependencies } from "../src/route-advertiser.ts";

class Timers {
  time = 0; next = 1; tasks = new Map<number,{at:number;callback:()=>void}>();
  set = (callback:()=>void, ms:number) => { const id=this.next++; this.tasks.set(id,{at:this.time+ms,callback}); return id as unknown as ReturnType<typeof setTimeout>; };
  clear = (id:ReturnType<typeof setTimeout>) => { this.tasks.delete(id as unknown as number); };
  async tick(ms=0) {
    const end=this.time+ms;
    for (let i=0;i<200;i++) {
      await Promise.resolve(); await Promise.resolve();
      const task=[...this.tasks].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!task) { for(let j=0;j<20;j++) await Promise.resolve(); if (![...this.tasks.values()].some(x=>x.at<=end)) break; else continue; }
      this.time=task[1].at; this.tasks.delete(task[0]); task[1].callback();
      for(let j=0;j<20;j++) await Promise.resolve();
    }
    this.time=end;
  }
}
const opts={baseUrl:"http://127.0.0.1:99",token:"secret",machineId:"node",controller:"controller-a",relayNodeId:"node",intervalMs:100,ttlMs:300,retryInitialMs:10,retryMaxMs:40,requestTimeoutMs:1000};
const iface=(address:string,internal=false)=>({address,netmask:"255.255.255.0",family:"IPv4" as const,mac:"00:00:00:00:00:00",internal,cidr:null});
const date="Wed, 01 Jan 2020 00:00:00 GMT";

test("stable deduplicated routes, explicit EasyTier, relay state and cancellation",async()=>{
  const t=new Timers(), posts:any[]=[], events:any[]=[]; let interfaces:any={eth0:[iface("10.0.0.1"),iface("10.0.0.1")],utun3:[iface("10.2.0.1")],easy0:[iface("10.3.0.1")],lo:[iface("127.0.0.1",true)]};
  const deps:RouteAdvertiserDependencies={setTimeout:t.set,clearTimeout:t.clear,networkInterfaces:()=>interfaces,fetch:async (_url,init)=>{if(init.method==="POST") posts.push(JSON.parse(init.body as string)); return new Response("{}",{headers:{date}});}};
  const a=startRouteAdvertiser({...opts,easytierInterfaces:["easy0"],onEvent:(...e)=>events.push(e)},deps);
  await t.tick(); assert.equal(posts.length,3);
  assert.equal(posts.find(x=>x.host==="10.2.0.1").kind,"direct"); assert.equal(posts.find(x=>x.host==="10.3.0.1").kind,"easytier");
  const first=posts.find(x=>x.host==="10.0.0.1").routeId;
  a.setRelayConnected(true); await t.tick(); assert.equal(posts.filter(x=>x.kind==="relay").length,1);
  assert.equal(posts.filter(x=>x.host==="10.0.0.1").at(-1).routeId,first);
  a.setRelayConnected(false); interfaces={eth0:[iface("10.0.0.2")]}; await t.tick();
  const count=posts.filter(x=>x.kind==="relay").length; await t.tick(100); assert.equal(posts.filter(x=>x.kind==="relay").length,count);
  a.setRelayConnected(true); await t.tick(); assert.equal(posts.filter(x=>x.kind==="relay").length,count+1);
  a.stop(); await t.tick(1000); assert.equal(t.tasks.size,0);
  assert.ok(!JSON.stringify(events).includes("10.0.0") && !JSON.stringify(events).includes("secret"));
  const other:any[]=[]; const b=startRouteAdvertiser({...opts,controller:"controller-b"},{...deps,networkInterfaces:()=>({eth0:[iface("10.0.0.1")]}),fetch:async (_u,i)=>{if(i.method==="POST") other.push(JSON.parse(i.body as string)); return new Response("{}",{headers:{date}});}});
  await t.tick(); assert.notEqual(other[0].routeId,first); b.stop(); assert.equal(t.tasks.size,0);
});

test("offline retries with exponential jitter, missing server time fails closed, recovery and stop abort",async()=>{
  const t=new Timers(), waits:number[]=[], posts:any[]=[]; let mode="offline";
  const a=startRouteAdvertiser({...opts,onEvent:(event,f)=>{if(event==="retry") waits.push(f.delayMs!);}},{setTimeout:t.set,clearTimeout:t.clear,random:()=>0,networkInterfaces:()=>({eth0:[iface("10.0.0.1")]}),fetch:async (_u,i)=>{if(mode==="offline") throw Error("secret 10.0.0.1"); if(mode==="nodate") return new Response("{}"); if(i.method==="POST") posts.push(JSON.parse(i.body as string)); return new Response("{}",{headers:{date}});}});
  await t.tick(); await t.tick(8); assert.deepEqual(waits,[8,16]);
  mode="nodate"; await t.tick(16); assert.deepEqual(waits,[8,16,32]); assert.equal(posts.length,0);
  mode="ok"; await t.tick(32); assert.equal(posts.length,1); assert.equal(posts[0].observedAt,Date.parse(date));
  a.stop(); assert.equal(t.tasks.size,0);
  let aborted=false;
  const b=startRouteAdvertiser(opts,{setTimeout:t.set,clearTimeout:t.clear,fetch:async (_u,i)=>new Promise((_r,reject)=>i.signal!.addEventListener("abort",()=>{aborted=true;reject(Error("abort"));}))});
  await t.tick(); b.stop(); await t.tick(); assert.equal(aborted,true); assert.equal(t.tasks.size,0);
});

test("real authenticated HTTP catalog: server clock, offline interfaces and relay expiry",async()=>{
  let clock=Date.parse(date); const token="test-team-token";
  const api=createTransportCatalogApi({dbPath:":memory:",allowInMemory:true,token,now:()=>clock});
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:async req=>{const res=await api.fetch(req); const h=new Headers(res.headers); h.set("date",new Date(clock).toUTCString()); return new Response(res.body,{status:res.status,headers:h});}});
  const t=new Timers(); let interfaces:any={};
  // Pretend the local wall clock is decades ahead; publisher never reads it.
  const originalNow=Date.now; Date.now=()=>clock+20*365*86400000;
  const signedFetch:NonNullable<RouteAdvertiserDependencies["fetch"]>=async (url,init)=>fetch(url,{...init,headers:{...init.headers as Record<string,string>,"x-envinhands-registration":"test"}});
  const a=startRouteAdvertiser({...opts,baseUrl:String(server.url),token},{setTimeout:t.set,clearTimeout:t.clear,networkInterfaces:()=>interfaces,fetch:signedFetch});
  const settle=async()=>{for(let i=0;i<30;i++){await Bun.sleep(2); await t.tick();}};
  const read=async()=>await (await fetch(new URL("/v1/transport-catalog?machineId=node",server.url),{headers:{authorization:`Bearer ${token}`}})).json() as {routes:any[]};
  try {
    await t.tick(); await settle(); assert.equal((await read()).routes.length,0);
    interfaces={eth0:[iface("10.8.0.1")]}; a.setRelayConnected(true); await t.tick(); await settle();
    const routes=(await read()).routes; assert.deepEqual(new Set(routes.map(x=>x.kind)),new Set(["direct","relay"])); assert.ok(routes.every(x=>x.observedAt===clock));
    a.setRelayConnected(false); interfaces={}; await t.tick(); await settle(); clock+=301;
    assert.ok((await read()).routes.every(x=>x.status==="unknown"));
  } finally {a.stop(); Date.now=originalNow; server.stop(true); api.close();}
});
