/** Unix user-space team onboarding. Publication and local key installation do
 * not grant administrator rights or establish SSH readiness. The standalone
 * key primitive below performs neither publication nor key installation. */
import { prepareLinuxRegistration } from "./registration/linux.ts";

// Static helper source, not user input, is passed as an argument. Input and the
// resulting public key travel over pipes; private key bytes never leave disk.
// flock is kernel-owned, so crashes release the lock without a wall-clock lease.
const KEY_HELPER = String.raw`import os, sys, json, stat, pathlib, fcntl, subprocess

def directory(path):
 if not os.path.isabs(path) or '..' in pathlib.PurePath(path).parts: raise ValueError()
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in pathlib.PurePath(path).parts[1:]:
   n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); s=os.fstat(n)
   if s.st_uid not in (0,os.geteuid()) or ((s.st_mode & 0o022) and not (s.st_uid==0 and s.st_mode & stat.S_ISVTX)): os.close(n); raise ValueError()
   os.close(fd);fd=n
  if os.fstat(fd).st_uid!=os.geteuid():raise ValueError()
  return fd
 except BaseException: os.close(fd);raise

def regular(d,name,private=True):
 f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
 try:
  s=os.fstat(f)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or (private and s.st_mode & 0o077) or s.st_nlink>2 or s.st_size>65536:raise ValueError()
  return s
 finally:os.close(f)

def exists(d,name):
 try: os.stat(name,dir_fd=d,follow_symlinks=False);return True
 except FileNotFoundError:return False

def main():
 v=json.loads(sys.stdin.buffer.read(4097));home=v['home']; h=directory(home); d=None;l=None
 try:
  try:os.mkdir('.envinhands-team',0o700,dir_fd=h);os.fsync(h)
  except FileExistsError:pass
  d=os.open('.envinhands-team',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=h); st=os.fstat(d)
  if st.st_uid!=os.geteuid() or st.st_mode & 0o077:raise ValueError()
  l=os.open('key.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=d);ls=os.fstat(l)
  if not stat.S_ISREG(ls.st_mode) or ls.st_uid!=os.geteuid() or ls.st_nlink!=1 or ls.st_mode & 0o077:raise ValueError()
  try:fcntl.flock(l,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:print(json.dumps({'error':'busy'}));return
  folder=os.path.join(home,'.envinhands-team'); final=os.path.join(folder,'client_ed25519'); pending=os.path.join(folder,'client_ed25519.pending')
  if not exists(d,'client_ed25519'):
   if not exists(d,'client_ed25519.pending'):
    if exists(d,'client_ed25519.pending.pub'):raise ValueError()
    p=subprocess.run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',pending],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,pass_fds=(l,))
    if p.returncode!=0:raise ValueError()
   ps=regular(d,'client_ed25519.pending')
   if ps.st_nlink!=1:raise ValueError()
   k=os.open('client_ed25519.pending',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=d)
   try:os.fsync(k)
   finally:os.close(k)
   p=subprocess.run(['/usr/bin/ssh-keygen','-y','-P','','-f',pending],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,pass_fds=(l,))
   if p.returncode!=0 or len(p.stdout)>1024:raise ValueError()
   os.link('client_ed25519.pending','client_ed25519',src_dir_fd=d,dst_dir_fd=d,follow_symlinks=False);os.fsync(d)
  regular(d,'client_ed25519')
  p=subprocess.run(['/usr/bin/ssh-keygen','-y','-P','','-f',final],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,pass_fds=(l,))
  if p.returncode!=0 or len(p.stdout)>1024:raise ValueError()
  parts=p.stdout.decode('ascii').split()
  if len(parts)<2:raise ValueError()
  # An interrupted generation can leave both names hardlinked to the same key.
  if exists(d,'client_ed25519.pending'):
   a=regular(d,'client_ed25519');b=regular(d,'client_ed25519.pending')
   if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise ValueError()
   os.unlink('client_ed25519.pending',dir_fd=d);os.fsync(d)
  if regular(d,'client_ed25519').st_nlink!=1:raise ValueError()
  print(json.dumps({'publicKey':parts[0]+' '+parts[1]}))
 finally:
  if l is not None:os.close(l)
  if d is not None:os.close(d)
  os.close(h)
try:main()
except BaseException:print(json.dumps({'error':'unsafe-or-unavailable'}))`;

export type LocalTeamKeyResult =
  | {ok:true; privateKeyPath:string; publicKey:string; ready:false}
  | {ok:false; code:"unsupported"|"busy"|"unsafe-or-unavailable"; message:string; ready:false};

/**
 * Creates or reuses one local unencrypted Ed25519 key. Requires an owned home on
 * a local Unix filesystem. A complete interrupted pending key can be recovered;
 * a corrupt or incomplete pending key needs inspection and is never replaced.
 * This narrow primitive is NOT the automatic team onboarding service.
 */
export async function ensureLocalTeamClientKey(options:{home:string;signal?:AbortSignal}):Promise<LocalTeamKeyResult> {
 const fail=(code:"unsupported"|"busy"|"unsafe-or-unavailable",message:string):LocalTeamKeyResult=>({ok:false,code,message,ready:false});
 if (!['linux','darwin'].includes(process.platform)) return fail('unsupported','Secure Windows key generation is not implemented.');
 if (!options.home.startsWith('/') || options.home.includes('\0') || options.signal?.aborted) return fail('unsafe-or-unavailable','Use an absolute, owned local home directory.');
 let child: ReturnType<typeof Bun.spawn<'pipe','pipe','pipe'>>;
 try {child=Bun.spawn(['/usr/bin/python3','-c',KEY_HELPER],{stdin:'pipe',stdout:'pipe',stderr:'pipe',detached:true});}
 catch {return fail('unsafe-or-unavailable','The local key helper could not be started.');}
 let timer:ReturnType<typeof setTimeout>|undefined;
 const abort=()=>{try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');}}; options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 try {
  child.stdin.write(JSON.stringify({home:options.home}));child.stdin.end();
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort();reject(new Error());},35000);});
  const [out,_err,exit]=await Promise.race([Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),timeout]);
  if(exit!==0||out.length>2048||options.signal?.aborted) throw new Error();
  const parsed=JSON.parse(out) as {publicKey?:unknown;error?:unknown};
  if(parsed.error==='busy')return fail('busy','Another key operation holds the local lock. Retry.');
  if(typeof parsed.publicKey!=='string') throw new Error();
  prepareLinuxRegistration({user:'agent',publicKey:parsed.publicKey});
  return {ok:true,privateKeyPath:options.home.replace(/\/$/,'')+'/.envinhands-team/client_ed25519',publicKey:parsed.publicKey,ready:false};
 } catch {return fail('unsafe-or-unavailable','Key unavailable or local path unsafe. Inspect the private key directory before retrying.');}
 finally {if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(child.exitCode===null){abort();await child.exited;}}
}


import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { createTeamIdentitiesClient, type TeamIdentityInput } from "./team-identities.ts";
import { createTeamKeySync, createTeamSnapshotFetcher, createUnixTeamKeyWriter } from "./team-key-sync.ts";
import type { AgentRegistrationInput } from "./change-model.ts";

// Journal operations are serialized across processes. Every pending request is
// durable before network I/O, including the exact expected revision and body.
// The helper rejects symlinks, unsafe owners/modes and hard-linked journal files.
const STATE_HELPER = String.raw`import os,sys,json,stat,pathlib,fcntl

def dirs(path):
 if not os.path.isabs(path) or '..' in pathlib.PurePath(path).parts:raise ValueError()
 f=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for p in pathlib.PurePath(path).parts[1:]:
   n=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=f);s=os.fstat(n)
   if s.st_uid not in (0,os.geteuid()) or ((s.st_mode & 0o022) and not (s.st_uid==0 and s.st_mode & stat.S_ISVTX)):os.close(n);raise ValueError()
   os.close(f);f=n
  return f
 except BaseException:os.close(f);raise

def readfile(d,n,private=False):
 f=os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
 try:
  s=os.fstat(f)
  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>65536 or s.st_uid not in ((os.geteuid(),) if private else (0,os.geteuid())) or (s.st_mode & (0o077 if private else 0o022)):raise ValueError()
  b=os.read(f,65537)
  if len(b)>65536:raise ValueError()
  return b
 finally:os.close(f)
def main():
 v=json.loads(sys.stdin.buffer.read(3145729));action=v['action']
 if action=='host':
  p=pathlib.PurePath(v['path'])
  if not p.is_absolute() or '..' in p.parts:raise ValueError()
  d=dirs(str(p.parent))
  try:
   parts=readfile(d,p.name).decode('ascii').split()
   if len(parts)<2:raise ValueError()
   print(json.dumps({'key':parts[0]+' '+parts[1]}))
  finally:os.close(d)
  return
 h=dirs(v['home']);d=None;l=None
 try:
  if os.fstat(h).st_uid!=os.geteuid():raise ValueError()
  d=os.open('.envinhands-team',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=h);s=os.fstat(d)
  if s.st_uid!=os.geteuid() or s.st_mode & 0o077:raise ValueError()
  l=os.open('journal.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=d);s=os.fstat(l)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or s.st_nlink!=1 or s.st_mode & 0o077:raise ValueError()
  fcntl.flock(l,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if action in ('known-hosts','verify-known-hosts'):
   revision=v['revision'];body=v['content'].encode('ascii')
   if not isinstance(revision,int) or isinstance(revision,bool) or revision<0 or len(body)>3000000:raise ValueError()
   data=('# envinhands-snapshot '+str(revision)+'\n').encode()+body
   try:
    f=os.open('known_hosts',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
    try:
     s=os.fstat(f)
     if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or s.st_nlink!=1 or s.st_mode & 0o077 or s.st_size>3000100:raise ValueError()
     chunks=[]
     while True:
      b=os.read(f,65536)
      if not b:break
      chunks.append(b)
     previous=b''.join(chunks)
    finally:os.close(f)
    header=previous.split(b'\n',1)[0];prefix=b'# envinhands-snapshot '
    if not header.startswith(prefix) or not header[len(prefix):].isdigit():raise ValueError()
    prior=int(header[len(prefix):])
    if action=='verify-known-hosts':
     if previous!=data:raise ValueError()
     os.fsync(d)
     print(json.dumps({'ok':True}));return
    if revision<prior:raise ValueError()
    if revision==prior:
     if previous!=data:raise ValueError()
     os.fsync(d)
     print(json.dumps({'ok':True}));return
   except FileNotFoundError:
    if action=='verify-known-hosts':raise
   temp='known_hosts.'+os.urandom(16).hex();f=None
   try:
    f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
    n=0
    while n<len(data):
     written=os.write(f,data[n:])
     if written<=0:raise ValueError()
     n+=written
    os.fsync(f);os.close(f);f=None
    os.rename(temp,'known_hosts',src_dir_fd=d,dst_dir_fd=d);os.fsync(d)
   finally:
    if f is not None:os.close(f)
    try:os.unlink(temp,dir_fd=d)
    except FileNotFoundError:pass
   print(json.dumps({'ok':True}));return
  try:old=json.loads(readfile(d,'pending.json',True))
  except FileNotFoundError:old=None
  if action=='ensure' and old is None:
   raw=json.dumps(v['pending'],separators=(',',':')).encode()
   temp='journal.'+os.urandom(16).hex()
   f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
   try:
    if os.write(f,raw)!=len(raw):raise ValueError()
    os.fsync(f)
   finally:os.close(f)
   os.rename(temp,'pending.json',src_dir_fd=d,dst_dir_fd=d);os.fsync(d);old=v['pending']
  elif action=='clear' and old is not None and old.get('operationId')==v['operationId']:
   os.unlink('pending.json',dir_fd=d);os.fsync(d);old=None
  print(json.dumps({'pending':old}))
 finally:
  for f in (l,d,h):
   if f is not None:os.close(f)
try:main()
except BaseException:sys.exit(1)`;

type PendingRegistration={operationId:string;expectedRevision:number|null;identity:TeamIdentityInput};
async function localState(input:unknown,signal:AbortSignal):Promise<any>{
 const child=Bun.spawn(['/usr/bin/python3','-c',STATE_HELPER],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  child.stdin.write(JSON.stringify(input));child.stdin.end();
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort();reject(new Error('timeout'));},10000);});
  const [out,,code]=await Promise.race([Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),timeout]);
  if(code!==0||out.length>65536||signal.aborted)throw new Error('local state unavailable');return JSON.parse(out);
 }finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);if(child.exitCode===null){abort();await child.exited;}}
}
function validPending(v:unknown):PendingRegistration {
 if(!v||typeof v!=='object')throw new Error('invalid journal');
 const p=v as PendingRegistration;
 if(!/^team-[0-9a-f-]{36}$/.test(p.operationId)||!(p.expectedRevision===null||(Number.isSafeInteger(p.expectedRevision)&&p.expectedRevision!>0))||!p.identity||! /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(p.identity.deviceId)||!['linux','macos'].includes(p.identity.os)||typeof p.identity.user!=='string')throw new Error('invalid journal');
 prepareLinuxRegistration({user:'agent',publicKey:p.identity.publicKey});prepareLinuxRegistration({user:'agent',publicKey:p.identity.hostKey});
 return p;
}

export interface TeamOnboardOptions {
 home:string;
 /** Stable registered node identity. Must match the intended SSH target. */
 deviceId:string;
 /** Public server host key for this node, never a private key. The caller must
  * ensure sshd actually uses it and that consumers pin it to this deviceId. */
 hostPublicKeyPath:string;
 baseUrl:string;token:string;registration:AgentRegistrationInput;
 /** Must reflect the owner's durable decision to trust the whole team. */
 fullTeamTrust:boolean;
 intervalMs?:number;retryMinMs?:number;retryMaxMs?:number;requestTimeoutMs?:number;
 onStatus?:(status:{code:string;message:string;ready:false})=>void;
 fetch?:(input:URL,init?:RequestInit)=>Promise<Response>;
}
/** Use HostKeyAlias for the device ID, not the connection address. The
 * directory is the team's declaration of host identity, not independent proof. */
export function teamNodeSshPaths(home:string,deviceId:string) {
 if(!home.startsWith('/')||home.includes('\0')||home.split('/').includes('..')||! /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(deviceId))throw new Error('Invalid team SSH identity');
 const dir=home.replace(/\/$/,'')+'/.envinhands-team';
 return {privateKeyPath:dir+'/client_ed25519',knownHostsPath:dir+'/known_hosts',hostKeyAlias:deviceId};
}

/** Independent worker. No enrollment step establishes SSH or admin readiness. */
export function createTeamNodeOnboard(options:TeamOnboardOptions) {
 const ac=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 let stopped=false,started=false,inflight:Promise<void>|undefined, failures=0;
 const interval=options.intervalMs??60000,min=options.retryMinMs??1000,max=options.retryMaxMs??60000,timeout=options.requestTimeoutMs??15000;
 for(const n of [interval,min,max,timeout])if(!Number.isSafeInteger(n)||n<1||n>2147483647)throw new Error('Invalid onboarding interval');
 if(min>max)throw new Error('Invalid retry interval');
 const notify=(code:string,message:string)=>{try{options.onStatus?.({code,message,ready:false});}catch{}};
 const client=createTeamIdentitiesClient({baseUrl:options.baseUrl,token:options.token,registration:options.registration,fetch:options.fetch});
 const sync=createTeamKeySync({fullTeamTrust:options.fullTeamTrust,fetchSnapshot:createTeamSnapshotFetcher(client),writeKeys:createUnixTeamKeyWriter({home:options.home}),requestTimeoutMs:timeout});
 const deadline=async<T>(fn:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();const abort=()=>controller.abort();ac.signal.addEventListener('abort',abort,{once:true});if(ac.signal.aborted)abort();let t:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([fn(controller.signal),new Promise<never>((_,reject)=>{t=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},timeout);}),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}))]);}
  finally{if(t)clearTimeout(t);ac.signal.removeEventListener('abort',abort);}
 };
 const one=async()=>{
  if(!options.fullTeamTrust){notify('trust-required','Confirm and persist the owner’s full-team trust decision, then restart onboarding.');throw new Error();}
  if(!['linux','darwin'].includes(process.platform)){notify('unsupported','Windows automatic installation is not verified; use an approved adapter and independent probe.');throw new Error();}
  const key=await ensureLocalTeamClientKey({home:options.home,signal:ac.signal});
  if(!key.ok){notify('client-key',key.message);throw new Error();}
  let host:string;
  try{const v=await localState({action:'host',path:options.hostPublicKeyPath},ac.signal);host=v.key;prepareLinuxRegistration({user:'agent',publicKey:host});}
  catch{notify('host-key','Provide a safe readable sshd Ed25519 public host-key file for this device; confirm sshd uses it.');throw new Error();}
  const identity:TeamIdentityInput={deviceId:options.deviceId,os:process.platform==='darwin'?'macos':'linux',user:userInfo().username,publicKey:key.publicKey,hostKey:host};
  let state:{pending:unknown};
  try{state=await localState({action:'get',home:options.home},ac.signal);}catch{notify('journal','Inspect the owned private .envinhands-team journal and lock; retain pending requests before retry.');throw new Error();}
  let pending=state.pending===null?null:validPending(state.pending);
  if(!pending){
   const current=await deadline(s=>client.getDevice(identity.deviceId,{signal:s}));
   const r=current.record;
   if(r && (r.user!==identity.user||r.os!==identity.os||r.publicKey!==identity.publicKey||r.hostKey!==identity.hostKey)){
    notify('identity-conflict','This device ID already has a different identity. Verify ownership and host key, then explicitly resolve the directory entry before retrying.');
    throw new Error('identity conflict');
   }
   if(!r){
    const candidate:PendingRegistration={operationId:'team-'+randomUUID(),expectedRevision:current.revision,identity};
    state=await localState({action:'ensure',home:options.home,pending:candidate},ac.signal);pending=validPending(state.pending);
   }
  }
  if(pending){
   const old=pending.identity;
   if(old.deviceId!==identity.deviceId||old.os!==identity.os||old.user!==identity.user||old.publicKey!==identity.publicKey||old.hostKey!==identity.hostKey){
    let matches=false;
    try {
     const current=await deadline(s=>client.getDevice(old.deviceId,{signal:s}));const r=current.record;
     matches=!!r&&r.deviceId===old.deviceId&&r.os===old.os&&r.user===old.user&&r.publicKey===old.publicKey&&r.hostKey===old.hostKey;
    } catch { /* No mutation. Its outcome remains unknown. */ }
    notify(matches?'identity-changed':'identity-changed-unknown',matches
     ?'Local identity changed while a request was pending; the directory currently shows the old identity. Inspect the journal and directory before resolving; the old request was not resent.'
     :'Local identity changed while a request was pending; its outcome is unknown. Inspect the journal and directory before resolving; the old request was not resent.');
    throw new Error('pending identity changed');
   }
   try{await deadline(s=>client.upsert(pending!.identity,pending!.operationId,pending!.expectedRevision,{signal:s}));}
   catch(e){
    if(e instanceof Error&&e.message.startsWith('Directory mutation HTTP 409;')){
     // Conflict is definitive and journaled. Next pass re-reads the latest revision;
     // it never rewrites a body under the old operation ID.
     await localState({action:'clear',home:options.home,operationId:pending.operationId},ac.signal);
     notify('conflict','Directory changed; re-read its latest revision and retry.');
    }
    throw e;
   }
   await localState({action:'clear',home:options.home,operationId:pending.operationId},ac.signal);
   // A replayed success can be historical. Re-read next pass before reporting sync.
   const latest=await deadline(s=>client.getDevice(identity.deviceId,{signal:s}));
   const r=latest.record;
   if(!r||r.os!==identity.os||r.user!==identity.user||r.publicKey!==identity.publicKey||r.hostKey!==identity.hostKey)throw new Error('stale');
  }
  // Never install a partial view. The client validates each host key, cursor,
  // revision and fingerprint; every page stays at the first page's watermark.
  let snapshot:number|undefined,after:string|undefined;const lines:string[]=[];
  const aliases=new Set<string>();let aliasCollision=false,writeAttempted=false;
  try {
   await deadline(async signal=>{
    for(let pages=0;pages<101;pages++){
     const page=await client.listPage({snapshot,after,limit:100,signal});
     snapshot=page.snapshot;
     for(const r of page.records){
      const folded=r.deviceId.toLowerCase();
      if(aliases.has(folded)){aliasCollision=true;throw new Error('ambiguous host alias');}
      aliases.add(folded);lines.push(`${r.deviceId} ${r.hostKey}\n`);
      if(lines.length>10000)throw new Error('directory too large');
     }
     if(page.nextAfter===null)return;
     after=page.nextAfter;
    }
    throw new Error('directory too large');
   });
   if(snapshot===undefined||ac.signal.aborted)throw new Error('incomplete');
   writeAttempted=true;
   await localState({action:'known-hosts',home:options.home,revision:snapshot,content:lines.join('')},ac.signal);
  } catch(error) {
   if(writeAttempted && snapshot!==undefined){
    try {
     // A failed helper may have renamed the new file before it died. Reopen
     // and compare the whole validated snapshot, then fsync the directory.
     await localState({action:'verify-known-hosts',home:options.home,revision:snapshot,content:lines.join('')},ac.signal);
     notify('host-pins-recovered','The new host pin snapshot was verified and committed after an interrupted write.');
    } catch {
     notify('host-pins-unknown','Host pin update outcome is unknown. Inspect the private known_hosts file and retry a complete snapshot; do not assume old or new pins.');
     throw new Error('host pins outcome unknown');
    }
   } else {
    if(aliasCollision)notify('host-alias-conflict','Directory contains device IDs that differ only by ASCII letter case. Resolve the duplicate device IDs in the directory, then retry; this attempt did not replace host pins.');
    else if(error instanceof Error && error.message==='Directory HTTP 409')notify('directory-conflict','Directory rejected the snapshot. Inspect and resolve conflicting device IDs, including IDs differing only by ASCII letter case; this attempt did not replace host pins.');
    else notify('known-hosts','Could not read a complete authenticated directory snapshot. Check the connection and retry; this attempt did not replace host pins.');
    throw new Error('host pins unavailable');
   }
  }
  const result=await sync.sync();
  if(!result.ok){notify(result.code,result.message);throw new Error();}
  notify('synchronized','Team public keys synchronized without deleting existing authorization. SSH and administrator access require separate probes.');
 };
 const tick=()=>{
  if(stopped)return;
  inflight=one().then(()=>{failures=0;},()=>{if(!ac.signal.aborted){failures=Math.min(failures+1,30);notify('retry','Onboarding incomplete. Check network, directory credentials, local permissions and earlier status; retrying.');}}).finally(()=>{
   inflight=undefined;if(!stopped){const delay=failures?Math.min(max,min*2**Math.min(failures-1,30)):interval;timer=setTimeout(tick,delay);}
  });
 };
 return {sshPaths:(deviceId:string)=>teamNodeSshPaths(options.home,deviceId),start(){if(!started&&!stopped){started=true;tick();}},async stop(){if(stopped)return;stopped=true;ac.abort();if(timer)clearTimeout(timer);await sync.stop();await inflight;}};
}
