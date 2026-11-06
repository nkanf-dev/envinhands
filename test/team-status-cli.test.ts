import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTeamStatusCli } from "../src/team-status-cli.ts";
import { createMachineApi } from "../src/machine-api.ts";
import { writeTeamPrimeConfig, teamPrimeConfigPath } from "../src/team-prime-config.ts";
import type { ChangeCliIO } from "../src/change-cli.ts";
const homes:string[]=[];
async function home() { const h=await fs.mkdtemp(join(tmpdir(),"status-cli-")); homes.push(h); return h; }
afterEach(async()=>{for(const h of homes.splice(0)) await fs.rm(h,{recursive:true,force:true});});
function harness(fetcher: ChangeCliIO["fetch"] = fetch) {
  let out="", err="";
  return {io:{readInput:async()=>{throw Error("unexpected stdin");}, write:(x:string)=>{out+=x;}, error:(x:string)=>{err+=x;}, fetch:fetcher}, get out(){return out;}, get err(){return err;}};
}
const fixed={now:()=>new Date("2026-01-01T00:00:00.000Z")};
const machine={id:"node-1",status:"pending",host:"host.local",sshPort:22,checkedAt:null};
const env={ENVINHANDS_URL:"https://example.test",ENVINHANDS_TOKEN:"private-token",ENVINHANDS_RELAY_URL:"wss://relay.test",ENVINHANDS_RELAY_SECRET:"private-relay"};
describe("status and machines",()=>{
 test("real loopback catalog and private Team defaults, read only",async()=>{
  const h=await home(), token="loopback-private-token";
  const api=createMachineApi({dbPath:join(h,"db"),token});
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api.fetch});
  try {
   const url=`http://127.0.0.1:${server.port}`;
   const response=await fetch(`${url}/v1/machines`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({id:"node-a",name:"A",host:"127.0.0.1",os:"linux",sshUser:"alice"})});
   expect(response.status).toBe(202);
   await writeTeamPrimeConfig({url,token,machineId:"node-a"},{home:h});
   const before=await fs.readFile(teamPrimeConfigPath(h),"utf8");
   const x=harness(); const code=await runTeamStatusCli(["machines","--json"],{},x.io,{...fixed,team:{home:h}});
   expect(code).toBe(0); expect(x.err).toBe("");
   const result=JSON.parse(x.out);
   expect(result).toEqual({ok:true,data:{command:"machines",checkedAt:"2026-01-01T00:00:00.000Z",localMachineId:"node-a",machines:[{id:"node-a",state:"pending",endpoint:{host:"127.0.0.1",port:22},checkedAt:null,errorCode:null}]},meta:{}});
   expect(x.out).not.toContain(token);
   expect(await fs.readFile(teamPrimeConfigPath(h),"utf8")).toEqual(before);
   const y=harness(); expect(await runTeamStatusCli(["status","--format","table"],{},y.io,{...fixed,team:{home:h}})).toBe(0);
   expect(y.out).toContain("pending=1"); expect(y.err).toBe("");
  } finally {await server.stop(true);api.close();}
 });
 test("sorts stable IDs, shows stored state and checked timestamp, and uses GET only",async()=>{
  const calls:RequestInit[]=[];
  const x=harness(async (_url,init)=>{calls.push(init!);return Response.json({machines:[{...machine,id:"z",status:"not-ready",checkedAt:"2026-01-01T00:00:00.000Z"},machine]});});
  expect(await runTeamStatusCli(["machines","--json"],env,x.io,fixed)).toBe(0);
  expect(JSON.parse(x.out).data.machines.map((m:{id:string})=>m.id)).toEqual(["node-1","z"]);
  expect(JSON.parse(x.out).data.machines[1]).toEqual({id:"z",state:"not-ready",endpoint:{host:"host.local",port:22},checkedAt:"2026-01-01T00:00:00.000Z",errorCode:null});
  expect(calls).toHaveLength(1);expect(calls[0].method).toBe("GET");expect(calls[0].redirect).toBe("manual");expect(x.out).not.toContain("private-token");expect(x.out).not.toContain("private-relay");
 });
 test("table output and empty catalog",async()=>{
  const x=harness(async()=>Response.json({machines:[]}));expect(await runTeamStatusCli(["machines","--format","table"],env,x.io,fixed)).toBe(0);
  expect(x.out).toBe("ID\tCATALOG\tSSH ENDPOINT\tCHECKED AT\n");
 });
 test("config, usage and HTTP errors use stable exit codes and no secrets",async()=>{
  const cases:[string[],NodeJS.ProcessEnv,ChangeCliIO["fetch"],number,string][]=[
   [["machines","--bad"],env,fetch,2,"USAGE"],
   [["status"],{ENVINHANDS_URL:"https://example.test"},fetch,2,"CONFIG"],
   [["status"],{...env,ENVINHANDS_URL:"http://example.test"},fetch,2,"CONFIG"],
   [["status"],env,async()=>new Response("private-token",{status:401}),3,"AUTH"],
   [["status"],env,async()=>new Response("private-token",{status:503}),5,"HTTP_ERROR"],
   [["status"],env,async()=>{throw Error("private-token")},4,"NETWORK"],
  ];
  for(const [args,values,fetcher,code,error] of cases){const x=harness(fetcher);expect(await runTeamStatusCli([...args,"--json"],values,x.io,fixed)).toBe(code);const result=JSON.parse(x.err);expect(result.error.code).toBe(error);expect(x.err).not.toContain("private-token");expect(x.out).toBe("");}
 });
 test("default JSON, explicit JSON and table failure use consistent envelopes",async()=>{
  const x=harness(async()=>Response.json({machines:[machine]}));
  const y=harness(async()=>Response.json({machines:[machine]}));
  expect(await runTeamStatusCli(["machines"],env,x.io,fixed)).toBe(0);
  expect(await runTeamStatusCli(["machines","--json"],env,y.io,fixed)).toBe(0);
  expect(x.out).toBe(y.out);expect(JSON.parse(x.out).ok).toBe(true);expect(JSON.parse(x.out).meta).toEqual({});
  const z=harness(async()=>new Response("ignored",{status:401}));
  expect(await runTeamStatusCli(["status","--format","table"],env,z.io,fixed)).toBe(3);
  expect(z.out).toBe("");expect(JSON.parse(z.err)).toEqual({ok:false,error:{type:"auth",code:"AUTH",message:"Control service returned HTTP 401. Check token."}});
 });
 test("timeout bounds uncooperative fetch and error never leaks details",async()=>{
  const x=harness(async()=>new Promise<Response>(()=>{}));
  expect(await runTeamStatusCli(["status","--json"],env,x.io,{...fixed,timeoutMs:15})).toBe(4);
  expect(JSON.parse(x.err).error.code).toBe("TIMEOUT");
 });
 test("rejects malformed and secret-bearing catalog data",async()=>{
  for(const m of [{...machine,id:"private-token"},{...machine,host:"private-token"},{...machine,id:"bad\u001b[31m"},{...machine,checkedAt:"yesterday"}]){
   const x=harness(async()=>Response.json({machines:[m]}));expect(await runTeamStatusCli(["machines","--json"],env,x.io,fixed)).toBe(5);expect(JSON.parse(x.err).error.code).toBe("INVALID_RESPONSE");expect(x.err).not.toContain("private-token");
  }
 });
});
