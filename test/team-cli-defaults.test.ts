import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTeamPrimeConfig, teamPrimeConfigPath } from "../src/team-prime-config.ts";
import { resolveTeamCliEnv, resolveTeamSshEnv, resolveTeamSshUser, teamCliSshPaths } from "../src/team-cli-defaults.ts";
import { createTeamIdentitiesApi } from "../src/team-identities.ts";
const homes:string[]=[];
async function home(){const h=await fs.mkdtemp(join(tmpdir(),"team-cli-defaults-"));homes.push(h);return h;}
afterEach(async()=>{for(const h of homes.splice(0)) await fs.rm(h,{recursive:true,force:true});});
const value={url:"https://mesh.example",token:"test-secret-token",machineId:"local-node"};
async function files(h:string){const dir=join(h,".envinhands-team");await fs.mkdir(dir,{mode:0o700});const p=teamCliSshPaths(h);await fs.writeFile(p.privateKeyPath,"private secret bytes",{mode:0o600});await fs.writeFile(p.knownHostsPath,"# envinhands-snapshot 1\nnode ssh-ed25519 test\n",{mode:0o600});return p;}
describe("CLI private defaults",()=>{
 test("team config fallback, precedence, and no mutation",async()=>{
  const h=await home();await writeTeamPrimeConfig(value,{home:h});
  const input={OTHER:"ok"}; const r=await resolveTeamCliEnv({home:h,env:input});
  expect(r.source).toBe("team");expect(r.env).toEqual({...input,ENVINHANDS_URL:value.url,ENVINHANDS_TOKEN:value.token,ENVINHANDS_MACHINE_ID:value.machineId});expect(input).toEqual({OTHER:"ok"});
  const explicit={ENVINHANDS_URL:"https://explicit.example",ENVINHANDS_TOKEN:"explicit",ENVINHANDS_MACHINE_ID:"mine"};
  expect(await resolveTeamCliEnv({home:h,env:explicit})).toEqual({env:explicit,source:"env"});
  expect((await resolveTeamCliEnv({home:h,env:{ENVINHANDS_MACHINE_ID:"mine"}})).env.ENVINHANDS_MACHINE_ID).toBe("mine");
 });
 test("partial pairs and empty overrides never mix; missing file is not an error",async()=>{
  const h=await home();expect((await resolveTeamCliEnv({home:h,env:{}})).source).toBe("none");await writeTeamPrimeConfig(value,{home:h});
  for(const env of [{ENVINHANDS_URL:"https://x.example"},{ENVINHANDS_TOKEN:"secret-only"},{ENVINHANDS_URL:""}]) {const r=await resolveTeamCliEnv({home:h,env});expect(r.source).toBe("partial");expect(r.env).toEqual(env);expect(r.diagnostic).toBe("E_TEAM_CONFIG_PARTIAL");expect(r.diagnostic).not.toContain("secret-only");}
 });
 test("relay pairs come only from the same trusted Team config and are never mixed",async()=>{
  const h=await home();const relay={url:"wss://relay.example/ws",secret:"fake-relay-secret"};
  // The mock uses the same secure config reader's Windows adapter contract.
  const windowsRunner=()=>JSON.stringify({...value,relay});
  const options={home:h,platform:"win32" as const,windowsRunner};
  const auto=await resolveTeamCliEnv({...options,env:{}});expect(auto.source).toBe("team");expect(auto.env.ENVINHANDS_RELAY_URL).toBe(relay.url);expect(auto.env.ENVINHANDS_RELAY_SECRET).toBe(relay.secret);
  const explicitControl={ENVINHANDS_URL:value.url,ENVINHANDS_TOKEN:value.token};
  const same=await resolveTeamCliEnv({...options,env:explicitControl});expect(same.source).toBe("env");expect(same.env.ENVINHANDS_RELAY_SECRET).toBe(relay.secret);
  const different=await resolveTeamCliEnv({...options,env:{ENVINHANDS_URL:"https://another.example",ENVINHANDS_TOKEN:"other-token"}});expect(different.env.ENVINHANDS_RELAY_URL).toBeUndefined();expect(different.env.ENVINHANDS_RELAY_SECRET).toBeUndefined();
  const explicit={ENVINHANDS_RELAY_URL:"wss://other.example",ENVINHANDS_RELAY_SECRET:"other-secret"};const both=await resolveTeamCliEnv({...options,env:explicit});expect(both.env.ENVINHANDS_RELAY_URL).toBe(explicit.ENVINHANDS_RELAY_URL);expect(both.env.ENVINHANDS_RELAY_SECRET).toBe(explicit.ENVINHANDS_RELAY_SECRET);
  for(const partial of [{ENVINHANDS_RELAY_URL:"wss://other.example"},{ENVINHANDS_RELAY_SECRET:"partial-secret"},{ENVINHANDS_RELAY_URL:""}]){
   const r=await resolveTeamCliEnv({...options,env:partial});expect(r.relayDiagnostic).toBe("E_RELAY_CONFIG_PARTIAL");expect(r.relayDiagnostic).not.toContain("partial-secret");expect(r.env.ENVINHANDS_RELAY_URL).toBe(partial.ENVINHANDS_RELAY_URL);expect(r.env.ENVINHANDS_RELAY_SECRET).toBe(partial.ENVINHANDS_RELAY_SECRET);expect(r.env.ENVINHANDS_URL).toBe(value.url);
  }
  const none=await resolveTeamCliEnv({...options,windowsRunner:()=>JSON.stringify(value),env:{}});expect(none.env.ENVINHANDS_RELAY_SECRET).toBeUndefined();
 });
 test("relay fallback uses private on-disk Team config",async()=>{
  const h=await home();const relay={url:"wss://relay.example/tunnel",secret:"private-relay-secret"};
  await writeTeamPrimeConfig({...value,relay},{home:h});
  const result=await resolveTeamCliEnv({home:h,env:{}});
  expect(result.env.ENVINHANDS_RELAY_URL).toBe(relay.url);expect(result.env.ENVINHANDS_RELAY_SECRET).toBe(relay.secret);expect(result.relayDiagnostic).toBeUndefined();
  const path=teamPrimeConfigPath(h);await fs.chmod(path,0o644);
  const failure=await resolveTeamCliEnv({home:h,env:{ENVINHANDS_URL:value.url,ENVINHANDS_TOKEN:value.token}});
  expect(failure.source).toBe("env");expect(failure.env.ENVINHANDS_RELAY_SECRET).toBeUndefined();expect(failure.relayDiagnostic).not.toContain(relay.secret);
 });
 test("unsafe config gives delayed generic diagnosis; explicit pair bypasses it",async()=>{
  const h=await home();await writeTeamPrimeConfig(value,{home:h});await fs.chmod(teamPrimeConfigPath(h),0o644);
  const r=await resolveTeamCliEnv({home:h,env:{}});expect(r.source).toBe("error");expect(r.diagnostic).not.toContain(value.token);
  expect((await resolveTeamCliEnv({home:h,env:{ENVINHANDS_URL:"https://x",ENVINHANDS_TOKEN:"x"}})).source).toBe("env");
 });
 test("SSH defaults are lazy, explicit paths win, recognized private snapshot is unchanged",async()=>{
  const h=await home(),p=await files(h);const before=await fs.readFile(p.knownHostsPath,"utf8");
  expect((await resolveTeamCliEnv({home:h,env:{}})).env.ENVINHANDS_SSH_IDENTITY).toBeUndefined();
  const r=await resolveTeamSshEnv({home:h,env:{}});expect(r.diagnostic).toBeUndefined();expect(r.env.ENVINHANDS_SSH_IDENTITY).toBe(p.privateKeyPath);expect(r.env.ENVINHANDS_SSH_KNOWN_HOSTS).toBe(p.knownHostsPath);expect(await fs.readFile(p.knownHostsPath,"utf8")).toBe(before);
  const explicit={ENVINHANDS_SSH_IDENTITY:"/explicit/key",ENVINHANDS_SSH_KNOWN_HOSTS:"/explicit/hosts"};expect((await resolveTeamSshEnv({home:h,env:explicit})).env).toEqual(explicit);
  expect((await resolveTeamSshEnv({home:h,env:{ENVINHANDS_SSH_IDENTITY:"/explicit/key"}})).env.ENVINHANDS_SSH_KNOWN_HOSTS).toBe(p.knownHostsPath);
 });
 test("missing, unsafe, symlink or unrecognized files are not silently trusted",async()=>{
  const h=await home();const no=await resolveTeamSshEnv({home:h,env:{}});expect(no.diagnostic).toBe("E_SSH_KEY");
  const p=await files(h);await fs.writeFile(p.knownHostsPath,"node ssh-ed25519 unknown\n");let r=await resolveTeamSshEnv({home:h,env:{}});expect(r.env.ENVINHANDS_SSH_KNOWN_HOSTS).toBeUndefined();expect(r.diagnostic).toBe("E_SSH_HOSTS");
  await fs.writeFile(p.knownHostsPath,"# envinhands-snapshot 1\nnode ssh-ed25519 test\n");await fs.chmod(p.privateKeyPath,0o644);r=await resolveTeamSshEnv({home:h,env:{}});expect(r.env.ENVINHANDS_SSH_IDENTITY).toBeUndefined();expect(r.diagnostic).not.toContain("private secret bytes");
  await fs.unlink(p.privateKeyPath);await fs.symlink(p.knownHostsPath,p.privateKeyPath);r=await resolveTeamSshEnv({home:h,env:{}});expect(r.env.ENVINHANDS_SSH_IDENTITY).toBeUndefined();
 });
 test("Windows runner and paths are mockable without claiming installation",async()=>{
  const h=await home();let reads=0;const r=await resolveTeamCliEnv({home:h,env:{},platform:"win32",windowsRunner:()=>{reads++;return JSON.stringify(value);}});expect(r.source).toBe("team");expect(reads).toBe(1);
  expect(teamCliSshPaths("C:\\Users\\test","win32").privateKeyPath).toBe("C:\\Users\\test\\.envinhands-team\\client_ed25519");
  const s=await resolveTeamSshEnv({home:h,env:{},platform:"win32"});expect(s.diagnostic).toBe("E_SSH_PLATFORM");expect(s.env.ENVINHANDS_SSH_IDENTITY).toBeUndefined();
 });
 test("old authenticated loopback machine API fallback with three exact records",async()=>{
  const token="legacy-test-secret";let seen=0;
  const rows=[{id:"linux",os:"linux",sshUser:"alice"},{id:"mac",os:"macos",sshUser:"Bob"},{id:"win",os:"windows",sshUser:"Agent Name"}];
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){const u=new URL(req.url);if(req.headers.get("authorization")!==`Bearer ${token}`)return new Response(null,{status:401});if(u.pathname==="/v1/team-identities")return new Response(null,{status:404});if(u.pathname==="/v1/machines"&&u.searchParams.get("includePending")==="true"&&u.searchParams.get("includeNotReady")==="true"){seen++;return Response.json({machines:rows});}return new Response(null,{status:404});}});
  try {const env={ENVINHANDS_URL:`http://127.0.0.1:${server.port}`,ENVINHANDS_TOKEN:token};
   for(const row of rows)expect(await resolveTeamSshUser({machineId:row.id,env})).toEqual({user:row.sshUser});
   expect((await resolveTeamSshUser({machineId:"Linux",env})).diagnostic).toBe("E_SSH_USER");expect(seen).toBe(4);
   expect(await resolveTeamSshUser({machineId:"linux",user:"override",env,fetch:async()=>{throw Error("not called");}})).toEqual({user:"override"});
  }finally{await server.stop(true);}
 });
 test("legacy fallback rejects malformed records, duplicates and timeouts without secret disclosure",async()=>{
  const env={ENVINHANDS_URL:"http://127.0.0.1:12345",ENVINHANDS_TOKEN:"fallback-secret"};
  const fetchRows=(rows:unknown[])=>(async(url:URL)=>url.pathname==="/v1/team-identities"?new Response(null,{status:404}):Response.json({machines:rows}));
  for(const item of [{id:"node",os:"linux",sshUser:"root"},{id:"node",os:"linux",sshUser:"alice\n-oProxyCommand=bad"},{id:"node",os:"macos",sshUser:"ROOT"},{id:"node",os:"windows",sshUser:"bad "},{id:"node",os:"other",sshUser:"alice"}]){
    const r=await resolveTeamSshUser({machineId:"node",env,fetch:fetchRows([item])});expect(r.diagnostic).toBe("E_SSH_USER");expect(JSON.stringify(r)).not.toContain(env.ENVINHANDS_TOKEN);
  }
  const row={id:"node",os:"linux",sshUser:"alice"};expect((await resolveTeamSshUser({machineId:"node",env,fetch:fetchRows([row,row])})).diagnostic).toBe("E_TEAM_DIRECTORY");
  const timeout=await resolveTeamSshUser({machineId:"node",env,timeoutMs:10,fetch:async()=>new Promise<Response>(()=>{})});expect(timeout).toEqual({diagnostic:"E_TEAM_DIRECTORY"});
  const failure=await resolveTeamSshUser({machineId:"node",env,fetch:async()=>{throw new Error(env.ENVINHANDS_TOKEN);}});expect(failure).toEqual({diagnostic:"E_TEAM_DIRECTORY"});
 });
 test("authenticated HTTP identity lookup, override and safe failures",async()=>{
  const h=await home(),api=createTeamIdentitiesApi({dbPath:join(h,"db"),token:value.token});const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api.fetch});const url=`http://127.0.0.1:${server.port}`;
  function key(n:number){const b=Buffer.alloc(51);b.writeUInt32BE(11,0);b.write("ssh-ed25519",4);b.writeUInt32BE(32,15);b.fill(n,19);return `ssh-ed25519 ${b.toString("base64")}`;}
  try{
   const put=await fetch(`${url}/v1/team-identities`,{method:"PUT",headers:{authorization:`Bearer ${value.token}`,"content-type":"application/json"},body:JSON.stringify({deviceId:"node",os:"linux",user:"alice",publicKey:key(1),hostKey:key(2)})});expect(put.status).toBe(200);
   const env={ENVINHANDS_URL:url,ENVINHANDS_TOKEN:value.token};expect(await resolveTeamSshUser({machineId:"node",env})).toEqual({user:"alice"});expect((await resolveTeamSshUser({machineId:"missing",env})).diagnostic).toBe("E_SSH_USER");
   expect(await resolveTeamSshUser({machineId:"node",user:"override",env:{},fetch:async()=>{throw Error("must not call");}})).toEqual({user:"override"});
   const bad=await resolveTeamSshUser({machineId:"node",env:{ENVINHANDS_URL:url,ENVINHANDS_TOKEN:"wrong-secret"}});expect(bad.diagnostic).toBe("E_TEAM_DIRECTORY");expect(bad.diagnostic).not.toContain("wrong-secret");
  }finally{await server.stop(true);api.close();}
 });
});
