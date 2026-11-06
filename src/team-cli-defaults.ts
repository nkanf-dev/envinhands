/** Local CLI defaults. Resolve lazily, and never log credentials. */
import { homedir } from "node:os";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, parse, resolve, win32 } from "node:path";
import { readTeamPrimeConfig, type WindowsRunner } from "./team-prime-config.ts";
import { createTeamIdentitiesClient } from "./team-identities.ts";
import { bodyBytes } from "./http.ts";
import { validSshUser, validSshHostKeyAlias } from "./transports/ssh-routes.ts";

type Env = NodeJS.ProcessEnv;
export interface TeamCliOptions { env?: Env; home?: string; platform?: NodeJS.Platform; windowsRunner?: WindowsRunner }
export interface TeamCliEnvResult { env: Env; source: "env"|"team"|"none"|"partial"|"error"; diagnostic?: string; relayDiagnostic?: string }
/** Each explicit pair stays together. Relay errors never prevent direct routes. */
export async function resolveTeamCliEnv(options: TeamCliOptions = {}): Promise<TeamCliEnvResult> {
  const env = { ...(options.env ?? process.env) };
  // Even an explicitly empty value is a deliberate override, not permission to mix sources.
  const hasUrl = env.ENVINHANDS_URL !== undefined, hasToken = env.ENVINHANDS_TOKEN !== undefined;
  const hasRelayUrl = env.ENVINHANDS_RELAY_URL !== undefined, hasRelaySecret = env.ENVINHANDS_RELAY_SECRET !== undefined;
  const relayDiagnostic = hasRelayUrl !== hasRelaySecret
    ? "E_RELAY_CONFIG_PARTIAL"
    : undefined;
  const extra = relayDiagnostic ? {relayDiagnostic} : {};
  if (hasUrl !== hasToken) return {env,source:"partial",diagnostic:"E_TEAM_CONFIG_PARTIAL",...extra};
  // If the explicit control and relay pairs are present, never touch a local file.
  if (hasUrl && (hasRelayUrl || hasRelaySecret)) return {env,source:"env",...extra};
  try {
    const config = await readTeamPrimeConfig({home:options.home,platform:options.platform,windowsRunner:options.windowsRunner});
    if (!config) return {env,source:hasUrl ? "env" : "none",...extra};
    if (!hasUrl) {
      env.ENVINHANDS_URL=config.url; env.ENVINHANDS_TOKEN=config.token;
      if (env.ENVINHANDS_MACHINE_ID === undefined) env.ENVINHANDS_MACHINE_ID=config.machineId;
    }
    // Do not silently pair a different explicit control plane with Team relay credentials.
    const sameControl = !hasUrl || (env.ENVINHANDS_URL===config.url && env.ENVINHANDS_TOKEN===config.token);
    if (!hasRelayUrl && !hasRelaySecret && config.relay && sameControl) {
      env.ENVINHANDS_RELAY_URL=config.relay.url;
      env.ENVINHANDS_RELAY_SECRET=config.relay.secret;
    }
    return {env,source:hasUrl ? "env" : "team",...extra};
  } catch {
    // An explicit control pair still works if optional Team relay defaults are unsafe.
    if (hasUrl) return {env,source:"env",relayDiagnostic:"E_RELAY_CONFIG"};
    return {env,source:"error",diagnostic:"E_TEAM_CONFIG",...extra};
  }
}

/** Generates paths only; this does not install, validate or trust any file. */
export function teamCliSshPaths(home: string, platform: NodeJS.Platform = process.platform): {privateKeyPath:string;knownHostsPath:string} {
  const path=platform === "win32" ? win32 : {isAbsolute,join,parse,resolve};
  if (!path.isAbsolute(home) || /[%\x00-\x1f\x7f]/.test(home) || home.split(/[\\/]/).includes("..")) throw new Error("E_SSH_HOME");
  const dir=path.join(home,".envinhands-team");
  return {privateKeyPath:path.join(dir,"client_ed25519"),knownHostsPath:path.join(dir,"known_hosts")};
}

// Follow no links; accept only private owned team files and a recognizable
// onboarding snapshot. This check does not establish the truth of a pin.
async function safeTeamFile(home:string, path:string, snapshot:boolean):Promise<boolean> {
  try {
    let part=parse(home).root;
    for (const segment of resolve(home).slice(part.length).split("/").filter(Boolean)) {
      part=join(part,segment); const st=await fs.lstat(part);
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid!==0 && st.uid!==process.getuid()) ||
          ((st.mode & 0o022)!==0 && !(st.uid===0 && (st.mode & 0o1000)!==0))) return false;
    }
    const h=await fs.lstat(home), d=await fs.lstat(join(home,".envinhands-team"));
    if ((process.getuid && (h.uid!==process.getuid() || d.uid!==process.getuid())) || !d.isDirectory() || d.isSymbolicLink() || (d.mode & 0o077)!==0) return false;
    const f=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const st=await f.stat();
      if (!st.isFile() || st.nlink!==1 || (process.getuid && st.uid!==process.getuid()) || (st.mode & 0o077)!==0 || st.size===0 || st.size>3_000_100) return false;
      if (!snapshot) return true;
      const b=Buffer.alloc(Math.min(st.size,128)); const r=await f.read(b,0,b.length,0);
      return /^# envinhands-snapshot (0|[1-9][0-9]*)\n/.test(b.subarray(0,r.bytesRead).toString("ascii"));
    } finally { await f.close(); }
  } catch { return false; }
}
export interface TeamSshEnvResult { env: Env; diagnostic?: string }
/** Only call before SSH. Explicit paths are left untouched and remain the caller's trust decision. */
export async function resolveTeamSshEnv(options: Pick<TeamCliOptions,"env"|"home"|"platform"> = {}):Promise<TeamSshEnvResult> {
  const env={...(options.env ?? process.env)};
  const needKey=env.ENVINHANDS_SSH_IDENTITY===undefined, needHosts=env.ENVINHANDS_SSH_KNOWN_HOSTS===undefined;
  if (!needKey && !needHosts) return {env};
  if ((options.platform ?? process.platform)==="win32") return {env,diagnostic:"E_SSH_PLATFORM"};
  let home:string, paths:ReturnType<typeof teamCliSshPaths>;
  try { home=options.home ?? homedir(); paths=teamCliSshPaths(home,options.platform); }
  catch { return {env,diagnostic:"E_SSH_HOME"}; }
  if (needKey && await safeTeamFile(home,paths.privateKeyPath,false)) env.ENVINHANDS_SSH_IDENTITY=paths.privateKeyPath;
  if (needHosts && await safeTeamFile(home,paths.knownHostsPath,true)) env.ENVINHANDS_SSH_KNOWN_HOSTS=paths.knownHostsPath;
  if (needKey && !env.ENVINHANDS_SSH_IDENTITY) return {env,diagnostic:"E_SSH_KEY"};
  if (needHosts && !env.ENVINHANDS_SSH_KNOWN_HOSTS) return {env,diagnostic:"E_SSH_HOSTS"};
  return {env};
}

/** A directory username is a connection parameter, never access evidence. */
export async function resolveTeamSshUser(options:{machineId:string;user?:string;env:Env;fetch?:(input:URL,init?:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number}):Promise<{user?:string;diagnostic?:string}> {
  if (!validSshHostKeyAlias(options.machineId)) return {diagnostic:"E_MACHINE_ID"};
  if (options.user!==undefined) return validSshUser(options.user) ? {user:options.user} : {diagnostic:"E_SSH_USER"};
  const url=options.env.ENVINHANDS_URL, token=options.env.ENVINHANDS_TOKEN;
  if (!url || !token) return {diagnostic:"E_TEAM_CONFIG"};
  const timeout=options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout<1 || timeout>2147483647) return {diagnostic:"E_TEAM_DIRECTORY"};
  // One deadline covers both requests and response consumption, including injected
  // fetchers that ignore AbortSignal. Abort never triggers a fallback request.
  const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>controller.abort();options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted) abort();
  timer=setTimeout(abort,timeout);
  const bounded=<T>(promise:Promise<T>):Promise<T> => new Promise((resolve,reject)=>{
    const cancelled=()=>{controller.signal.removeEventListener("abort",cancelled);reject(new Error("aborted"));};
    controller.signal.addEventListener("abort",cancelled,{once:true});
    promise.then(value=>{controller.signal.removeEventListener("abort",cancelled);resolve(value);},error=>{controller.signal.removeEventListener("abort",cancelled);reject(error);});
    if(controller.signal.aborted)cancelled();
  });
  try {
    // Constructor validates origin and bearer before either authenticated request.
    const client=createTeamIdentitiesClient({baseUrl:url,token,fetch:options.fetch});
    try {
      const {record}=await bounded(client.getDevice(options.machineId,{signal:controller.signal}));
      if (!record || !validSshUser(record.user)) return {diagnostic:"E_SSH_USER"};
      return {user:record.user};
    } catch { if(controller.signal.aborted) return {diagnostic:"E_TEAM_DIRECTORY"}; }
    const target=new URL("/v1/machines",url);
    target.search=new URLSearchParams({includePending:"true",includeNotReady:"true"}).toString();
    const response=await bounded((options.fetch ?? fetch)(target,{method:"GET",redirect:"error",signal:controller.signal,headers:{authorization:`Bearer ${token}`}}));
    if(!response.ok) return {diagnostic:"E_TEAM_DIRECTORY"};
    const bytes=await bounded(bodyBytes(response,2*1024*1024));
    const parsed:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(!parsed || typeof parsed!=="object" || !Array.isArray((parsed as {machines?:unknown}).machines)) return {diagnostic:"E_TEAM_DIRECTORY"};
    const matches=(parsed as {machines:unknown[]}).machines.filter((v):v is Record<string,unknown> => !!v && typeof v==="object" && !Array.isArray(v) && (v as Record<string,unknown>).id===options.machineId);
    if(matches.length>1) return {diagnostic:"E_TEAM_DIRECTORY"};
    if(matches.length!==1) return {diagnostic:"E_SSH_USER"};
    const {sshUser,os}=matches[0]!;
    if(typeof os!=="string" || !validSshUser(sshUser)) return {diagnostic:"E_SSH_USER"};
    const kind=os.toLowerCase();
    const valid=kind==="linux" ? /^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser) && sshUser!=="root" :
      kind==="macos" ? /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(sshUser) && sshUser.toLowerCase()!=="root" :
      kind==="windows" ? /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/.test(sshUser) && !/[ .]$/.test(sshUser) : false;
    return valid ? {user:sshUser} : {diagnostic:"E_SSH_USER"};
  } catch { return {diagnostic:"E_TEAM_DIRECTORY"}; }
  finally {if(timer)clearTimeout(timer);options.signal?.removeEventListener("abort",abort);controller.abort();}
}
