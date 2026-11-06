import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { prepareLinuxRegistration } from "./registration/linux.ts";
import { runUnixRegistration, type UnixRegistrationOptions, type UnixRegistrationResult } from "./registration/apply.ts";
import { runWindowsRegistration, type WindowsRegistrationOptions, type WindowsRegistrationResult } from "./registration/windows.ts";

/** Only a freshly retrieved, complete versioned snapshot is eligible for installation. */
export interface TeamKeySnapshot { version: 1; complete: true; revision: string; keys: readonly string[] }
export type SyncResult = {ok: boolean; code: string; message: string; installed?: number; retainedOldKeys: true};
export type KeyWriter = (keys: readonly string[], signal?:AbortSignal) => Promise<{added:number}>;
export interface TeamKeySyncOptions {
  /** Caller must retain an explicit local, owner-authorized full-team-trust decision. */
  fullTeamTrust: boolean;
  fetchSnapshot: (signal?:AbortSignal) => Promise<unknown>;
  writeKeys: KeyWriter;
  onResult?: (result: SyncResult) => void;
  intervalMs?: number;
  requestTimeoutMs?: number;
}
const result = (ok:boolean,code:string,message:string,installed?:number):SyncResult => ({ok,code,message,installed,retainedOldKeys:true});
function keysFromSnapshot(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid snapshot");
  const s = value as Partial<TeamKeySnapshot>;
  if (s.version !== 1 || s.complete !== true || typeof s.revision !== "string" || !s.revision || s.revision.length > 256 || /[\x00-\x1f\x7f]/.test(s.revision) || !Array.isArray(s.keys) || s.keys.length > 10000) throw new Error("invalid snapshot");
  for (const key of s.keys) prepareLinuxRegistration({user:"agent",publicKey:key});
  return [...new Set(s.keys)];
}
/** The caller supplies the directory client, which validates each record and fingerprint. */
export function createTeamSnapshotFetcher(client:{listPage:(options:{snapshot?:number;after?:string;limit?:number;signal?:AbortSignal})=>Promise<{snapshot:number;records:{deviceId:string;publicKey:string}[];nextAfter:string|null}>}):(signal?:AbortSignal)=>Promise<TeamKeySnapshot> {
 return async(signal)=>{
  let snapshot:number|undefined, after:string|undefined;const keys:string[]=[];
  for(let pages=0;pages<101;pages++){
   if(signal?.aborted)throw new Error("stopped");
   const page=await client.listPage({snapshot,after,limit:100,signal});
   if(signal?.aborted)throw new Error("stopped");
   if(!page||!Number.isSafeInteger(page.snapshot)||page.snapshot<0||(snapshot!==undefined&&page.snapshot!==snapshot)||!Array.isArray(page.records)||page.records.length>100)throw new Error("Invalid page");
   snapshot=page.snapshot;let previous=after??"";
   for(const record of page.records){if(!record||typeof record.deviceId!=="string"||record.deviceId<=previous)throw new Error("Invalid order");prepareLinuxRegistration({user:"agent",publicKey:record.publicKey});previous=record.deviceId;keys.push(record.publicKey);if(keys.length>10000)throw new Error("Directory too large");}
   if(page.nextAfter===null)return {version:1,complete:true,revision:String(snapshot),keys};
   if(typeof page.nextAfter!=="string"||page.nextAfter!==previous||page.records.length===0)throw new Error("Invalid cursor");
   after=page.nextAfter;
  }
  throw new Error("Directory too large");
 };
}
/** Serializes overlapping calls within an instance. Failures are structured and safe to retry. */
export function createTeamKeySync(options: TeamKeySyncOptions) {
  let inflight:Promise<SyncResult>|undefined;
  let currentAbort:AbortController|undefined;
  let stopped=false, timer:ReturnType<typeof setTimeout>|undefined;
  let cancelFetch!:()=>void;
  const stoppedPromise = new Promise<never>((_,reject)=>{cancelFetch=()=>reject(new Error("stopped"));});
  // Ensure stopping while idle cannot create an unhandled rejection.
  void stoppedPromise.catch(()=>{});
  const sync = ():Promise<SyncResult> => {
    if (inflight) return inflight;
    inflight = (async () => {
      if (stopped) return result(false,"stopped","Synchronization is stopped.");
      if (options.fullTeamTrust !== true) return result(false,"authorization-required","Explicit owner authorization for full team trust is required.");
      let snapshot:unknown;
      const controller=new AbortController();currentAbort=controller;
      let deadline:ReturnType<typeof setTimeout>|undefined;
      try {
        const ms=options.requestTimeoutMs??15000;
        if(!Number.isSafeInteger(ms)||ms<1||ms>2147483647) throw new Error("invalid timeout");
        const timeout=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{controller.abort();reject(new Error("timeout"));},ms);});
        snapshot=await Promise.race([options.fetchSnapshot(controller.signal),timeout,stoppedPromise]);
      } catch {return result(false,stopped?"stopped":"directory-unavailable",stopped?"Synchronization is stopped.":"Directory unavailable; existing keys retained. Retry later.");}
      finally {if(deadline)clearTimeout(deadline);}
      if(stopped) return result(false,"stopped","Synchronization is stopped.");
      let keys:string[];
      try {keys=keysFromSnapshot(snapshot);} catch {return result(false,"invalid-directory","Incomplete or invalid directory; existing keys retained. Retry after inspecting the directory.");}
      try {const written=await options.writeKeys(keys,controller.signal);return result(true,"applied","Keys synchronized. Previously installed or unknown keys are retained, including revoked keys; owner review is required.",written.added);}
      catch {return result(false,"write-unknown","Key update failed or its outcome is unknown. Existing keys were not intentionally revoked; inspect the target and retry. On Windows, an administrator must create a missing administrators_authorized_keys through the approved setup with secure ACLs.");}
    })().then(r=>{try{options.onResult?.(r);}catch{} return r;}).finally(()=>{currentAbort=undefined;inflight=undefined;});
    return inflight;
  };
  const start = () => {
    if(timer || stopped) return;
    const ms=options.intervalMs??60000;
    if(!Number.isSafeInteger(ms)||ms<100||ms>2147483647) throw new Error("Invalid interval");
    const tick=async()=>{timer=undefined; if(stopped)return; await sync(); if(!stopped)timer=setTimeout(tick,ms);};
    timer=setTimeout(tick,0);
  };
  const stop=async()=>{stopped=true;currentAbort?.abort();cancelFetch();if(timer)clearTimeout(timer);timer=undefined;await inflight;};
  return {sync,start,stop};
}

/** Bootstrap grants unrestricted administrator capability. Never silently elevates. */
export async function configureTeamAdministrator(input: {
  confirmFullTeamTrust: true; platform: "unix"|"windows"; elevated: boolean; operationId: string; user: string; publicKey: string;
  unixOptions?: UnixRegistrationOptions; windowsOptions?: WindowsRegistrationOptions;
  unixRunner?: typeof runUnixRegistration; windowsRunner?: typeof runWindowsRegistration;
}):Promise<{status:"applied"|"partial"|"failed"|"elevation-required";message:string}> {
  if(input.confirmFullTeamTrust!==true) return {status:"failed",message:"Explicit full-team trust confirmation is required."};
  if(!input.elevated) return {status:"elevation-required",message:input.platform==="windows"?"Run the explicit registration command once in an elevated Administrator PowerShell; then restart the node.":"Run the explicit registration command once as root using sudo; then restart the node."};
  let r:UnixRegistrationResult|WindowsRegistrationResult;
  try {
    if(input.platform==="unix") r=await (input.unixRunner??runUnixRegistration)({action:"apply",operationId:input.operationId,user:input.user,publicKey:input.publicKey,confirm:true},input.unixOptions);
    else r=await (input.windowsRunner??runWindowsRegistration)({action:"apply",operationId:input.operationId,user:input.user,publicKey:input.publicKey,confirm:true,grantAdministrator:true},input.windowsOptions);
    return {status:r.status==="applied"?"applied":r.status==="partial"?"partial":"failed",message:r.status==="applied"?"Owner-authorized registration applied; verify SSH and administrator access separately.":"Registration incomplete or uncertain; inspect its receipt before retry."};
  }catch{return {status:"failed",message:"Registration unavailable; inspect its receipt before retry."};}
}

// O_APPEND provides atomic positioning for each small write on local Linux/macOS
// filesystems. Network filesystems (including NFS) may not provide this guarantee.
// The helper never truncates, rewrites, renames, or removes authorized_keys.
export const UNIX_WRITER = String.raw`import os, sys, json, stat, pathlib, fcntl, re
MAX=1048576
def directory(path):
 if not os.path.isabs(path) or '..' in pathlib.PurePath(path).parts: raise ValueError('path')
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in pathlib.PurePath(path).parts[1:]:
   n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); s=os.fstat(n)
   if s.st_uid not in (0,os.geteuid()) or ((s.st_mode & 0o022) and not (s.st_uid==0 and s.st_mode & stat.S_ISVTX)): os.close(n); raise ValueError('unsafe directory')
   os.close(fd);fd=n
  return fd
 except BaseException: os.close(fd);raise
def check_file(f):
 s=os.fstat(f)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or s.st_nlink!=1 or s.st_mode & 0o077 or s.st_size>MAX:raise ValueError('unsafe file')
 return s
def same_file(h,d,f,home):
 a=directory(home)
 try:
  hs=os.fstat(h);ns=os.fstat(a)
  if (hs.st_dev,hs.st_ino)!=(ns.st_dev,ns.st_ino):raise ValueError('home changed')
 finally:os.close(a)
 ds=os.fstat(d);pdir=os.stat('.ssh',dir_fd=h,follow_symlinks=False)
 if not stat.S_ISDIR(pdir.st_mode) or (ds.st_dev,ds.st_ino)!=(pdir.st_dev,pdir.st_ino):raise ValueError('ssh directory changed')
 s=check_file(f)
 try: p=os.stat('authorized_keys',dir_fd=d,follow_symlinks=False)
 except FileNotFoundError:raise ValueError('target changed')
 if not stat.S_ISREG(p.st_mode) or (s.st_dev,s.st_ino)!=(p.st_dev,p.st_ino):raise ValueError('target changed')
def read_all(f):
 os.lseek(f,0,os.SEEK_SET);chunks=[];size=0
 while True:
  b=os.read(f,65536)
  if not b:break
  size+=len(b)
  if size>MAX:raise ValueError('file too large')
  chunks.append(b)
 return b''.join(chunks)
def has_key(lines,parts):
 for line in lines:
  if line.endswith(b'\r'):line=line[:-1]
  if any((b<32 and b!=9) or b==127 for b in line):continue
  line=line.lstrip(b' \t')
  if not line or line.startswith(b'#'):continue
  if re.split(b'[ \t]+',line,maxsplit=2)[:2]==parts:return True
 return False
def main():
 data=json.loads(sys.stdin.buffer.read(2097153));home=data['home'];keys=data['keys']
 h=directory(home);d=None;l=None;f=None
 try:
  if os.fstat(h).st_uid!=os.geteuid():raise ValueError('home owner')
  try:os.mkdir('.ssh',0o700,dir_fd=h);os.fsync(h)
  except FileExistsError:pass
  d=os.open('.ssh',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=h);ds=os.fstat(d)
  if ds.st_uid!=os.geteuid() or ds.st_mode & 0o077:raise ValueError('unsafe ssh directory')
  l=os.open('.envinhands.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=d);ls=os.fstat(l)
  if not stat.S_ISREG(ls.st_mode) or ls.st_uid!=os.geteuid() or ls.st_nlink!=1 or ls.st_mode & 0o077:raise ValueError('unsafe lock')
  fcntl.flock(l,fcntl.LOCK_EX|fcntl.LOCK_NB)
  try:
   f=os.open('authorized_keys',os.O_RDWR|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=d);os.fsync(d)
  except FileExistsError:
   f=os.open('authorized_keys',os.O_RDWR|os.O_APPEND|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
  same_file(h,d,f,home);lines=read_all(f).split(b'\n');added=0
  for key in keys:
   kb=key.encode('ascii');parts=kb.split(b' ')
   if not has_key(lines,parts):
    same_file(h,d,f,home)
    chunk=b'\n'+kb+b' envinhands-team\n'
    if os.fstat(f).st_size+len(chunk)>MAX:raise ValueError('file too large')
    # A single O_APPEND write per validated key, including a fresh line boundary.
    if os.write(f,chunk)!=len(chunk):raise ValueError('short write')
    os.fsync(f);same_file(h,d,f,home)
    now=read_all(f).split(b'\n')
    if not has_key(now,parts):raise ValueError('write unconfirmed')
    lines=now;added+=1
  same_file(h,d,f,home)
  print(json.dumps({'added':added}))
 finally:
  for fd in (f,l,d,h):
   if fd is not None:os.close(fd)
try:main()
except BaseException: sys.exit(1)
`;
export interface UnixWriterOptions {home:string; pythonPath?:string; timeoutMs?:number; runner?:(program:string,input:string,timeout:number,signal?:AbortSignal)=>Promise<string>}
async function runPython(program:string,input:string,timeout:number,signal?:AbortSignal):Promise<string>{
 const child=Bun.spawn([program,"-c",UNIX_WRITER],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const abort=()=>child.kill();
 signal?.addEventListener("abort",abort,{once:true});
 if(signal?.aborted)abort();
 try{
  child.stdin.write(input);child.stdin.end();
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(new Error("timeout"));},timeout);});
  const [out,_err,code]=await Promise.race([Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),expired]);
  if(code!==0||out.length>1024)throw new Error("writer failed");return out;
 }finally{signal?.removeEventListener("abort",abort);if(timer)clearTimeout(timer);if(child.exitCode===null){child.kill();await child.exited;}}
}
export function createUnixTeamKeyWriter(options:UnixWriterOptions):KeyWriter {
 return async (keys,signal)=>{
  for(const key of keys)prepareLinuxRegistration({user:"agent",publicKey:key});
  const timeout=options.timeoutMs??15000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>2147483647)throw new Error("invalid timeout");
  const response=await (options.runner??runPython)(options.pythonPath??"python3",JSON.stringify({home:options.home,keys}),timeout,signal);
  const parsed=JSON.parse(response) as {added?:unknown};
  if(!Number.isSafeInteger(parsed.added)||Number(parsed.added)<0||Number(parsed.added)>keys.length)throw new Error("bad writer response");
  return {added:Number(parsed.added)};
 };
}
/**
 * Conservative read-only Windows check. Directory handles deny delete sharing;
 * the file handle denies write and delete sharing while open. Reparse points, hard-linked files, unfamiliar ACEs,
 * untrusted owners, and oversized files are rejected. It does not prove SSH or admin.
 * This code has mock tests only; it MUST be verified on the target Windows versions.
 */
const WINDOWS_VERIFY = String.raw`$ErrorActionPreference='Stop'
try {
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class EihKeyCheck {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFile(string n,uint access,uint share,IntPtr sec,uint create,uint flags,IntPtr template);
 [StructLayout(LayoutKind.Sequential)] struct Info {
  public uint attributes,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,uint type,uint requested,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr sd);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 static bool Trusted(SecurityIdentifier sid) {return sid!=null && (sid.Value=="S-1-5-18" || sid.Value=="S-1-5-32-544");}
 static byte[] Acl(SafeFileHandle h) {
  IntPtr owner,group,dacl,sacl,sd; uint rc=GetSecurityInfo(h,1,5,out owner,out group,out dacl,out sacl,out sd);
  if(rc!=0 || sd==IntPtr.Zero) throw new Exception();
  try {
   uint len=GetSecurityDescriptorLength(sd);if(len<20 || len>65536)throw new Exception();
   byte[] bytes=new byte[len];Marshal.Copy(sd,bytes,0,(int)len);
   RawSecurityDescriptor descriptor=new RawSecurityDescriptor(bytes,0);
   if(!Trusted(descriptor.Owner)||descriptor.DiscretionaryAcl==null||descriptor.DiscretionaryAcl.Count==0)throw new Exception();
   foreach(GenericAce a in descriptor.DiscretionaryAcl) {
    QualifiedAce q=a as QualifiedAce;
    if(q==null || !Trusted(q.SecurityIdentifier) || (q.AceQualifier!=AceQualifier.AccessAllowed && q.AceQualifier!=AceQualifier.AccessDenied))throw new Exception();
   }
   return bytes;
  } finally {LocalFree(sd);}
 }
 static Info Check(SafeFileHandle h,bool dir) {
  if(h==null||h.IsInvalid)throw new Exception();Info i;if(!GetFileInformationByHandle(h,out i))throw new Exception();
  if((i.attributes&0x400)!=0 || (((i.attributes&0x10)!=0)!=dir))throw new Exception();
  return i;
 }
 public static bool Verify(string key) {
  var handles=new List<SafeFileHandle>();
  try {
   string baseDir=Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
   string target=Path.GetFullPath(Path.Combine(baseDir,"ssh","administrators_authorized_keys"));
   string root=Path.GetPathRoot(target);if(String.IsNullOrEmpty(root)||root.StartsWith("\\\\"))throw new Exception();
   string[] parts=target.Substring(root.Length).Split(new char[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries);
   string path=root;
   SafeFileHandle rh=CreateFile(path,0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);handles.Add(rh);Check(rh,true);
   for(int n=0;n<parts.Length-1;n++) {
    path=Path.Combine(path,parts[n]);
    SafeFileHandle dh=CreateFile(path,0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);handles.Add(dh);Check(dh,true);
   }
   SafeFileHandle f=CreateFile(target,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);handles.Add(f);
   Info before=Check(f,false);if(before.links!=1||before.sizeHigh!=0||before.sizeLow>1048576)throw new Exception();byte[] security=Acl(f);
   byte[] b=new byte[before.sizeLow];int offset=0;
   using(FileStream stream=new FileStream(f,FileAccess.Read)) {
    while(offset<b.Length){int n=stream.Read(b,offset,b.Length-offset);if(n==0)throw new Exception();offset+=n;}
    if(stream.ReadByte()!=-1)throw new Exception();
    Info after=Check(f,false);
    if(after.volume!=before.volume||after.indexHigh!=before.indexHigh||after.indexLow!=before.indexLow||after.sizeHigh!=before.sizeHigh||after.sizeLow!=before.sizeLow||after.writeHigh!=before.writeHigh||after.writeLow!=before.writeLow||after.links!=1||!security.SequenceEqual(Acl(f)))throw new Exception();
   }
   string text=new UTF8Encoding(false,true).GetString(b);
   foreach(string rawLine in text.Split('\n')) {
    string line=rawLine.EndsWith("\r") ? rawLine.Substring(0,rawLine.Length-1) : rawLine;
    if(line.Any(ch => (Char.IsControl(ch) && ch!='\t') || ch=='\u007f'))continue;
    line=line.TrimStart(' ','\t');if(line.Length==0 || line[0]=='#')continue;
    string[] fields=line.Split(new char[]{' ','\t'},StringSplitOptions.RemoveEmptyEntries);
    if(fields.Length>=2 && fields[0]+" "+fields[1]==key)return true;
   }
   return false;
  } catch {return false;} finally {for(int i=handles.Count-1;i>=0;i--)if(handles[i]!=null)handles[i].Dispose();}
 }
}
'@
 $raw=[Console]::In.ReadToEnd(); if($raw.Length -gt 1024){throw 'input'}
 $v=ConvertFrom-Json -InputObject $raw
 if([EihKeyCheck]::Verify([string]$v.key)){[Console]::Out.Write('1')}else{[Console]::Out.Write('0')}
} catch {[Console]::Out.Write('0')}`;
async function runWindowsVerifier(input:string,signal?:AbortSignal):Promise<boolean> {
 if(process.platform!=="win32")return false;
 // Fixed PowerShell source only is encoded in argv. Key data goes exclusively on stdin.
 const source=Buffer.from(WINDOWS_VERIFY,"utf16le").toString("base64");
 const root=process.env.SystemRoot;
 if(!root||!win32.isAbsolute(root)||/[\x00-\x1f]/.test(root)||root.split(/[\\/]/).includes(".."))return false;
 const executable=win32.join(root,"System32","WindowsPowerShell","v1.0","powershell.exe");
 const child=Bun.spawn([executable,"-NoProfile","-NonInteractive","-EncodedCommand",source],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const abort=()=>child.kill();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
 try {
  child.stdin.write(input);child.stdin.end();
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(new Error("timeout"));},15000);});
  const [out,_err,code]=await Promise.race([Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),expired]);
  return code===0&&out.trim()==="1"&&!signal?.aborted;
 } catch{return false;}
 finally{signal?.removeEventListener("abort",abort);if(timer)clearTimeout(timer);if(child.exitCode===null){child.kill();await child.exited;}}
}
export function createWindowsKeyVerifier(options:{platform?:NodeJS.Platform;runner?:(input:string,signal?:AbortSignal)=>Promise<boolean>}={}) {
 return async(key:string,signal?:AbortSignal):Promise<boolean>=>{
  try {
   prepareLinuxRegistration({user:"agent",publicKey:key});
   if((options.platform??process.platform)!=="win32"||signal?.aborted)return false;
   return await (options.runner??runWindowsVerifier)(JSON.stringify({key}),signal);
  } catch{return false;}
 };
}

/** Experimental opt-in only until separately exercised and reviewed on Windows.
 * Microsoft documents that FILE_APPEND_DATA without FILE_WRITE_DATA cannot
 * overwrite existing data on local files. Network/unknown drives are rejected.
 */
export function windowsAppendSource():string {
 const start=WINDOWS_VERIFY.indexOf(" public static bool Verify(string key) {");
 const end=WINDOWS_VERIFY.indexOf("\n}\n'@",start);
 if(start<0||end<0)throw new Error("Windows append source unavailable");
 const method=String.raw` [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] buffer,uint count,out uint written,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 public static bool Append(string key) {
  var handles=new List<SafeFileHandle>();
  try {
   string baseDir=Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
   string target=Path.GetFullPath(Path.Combine(baseDir,"ssh","administrators_authorized_keys"));
   string root=Path.GetPathRoot(target);if(String.IsNullOrEmpty(root)||root.StartsWith("\\\\"))throw new Exception();
   DriveType kind=new DriveInfo(root).DriveType;if(kind!=DriveType.Fixed && kind!=DriveType.Removable)throw new Exception();
   string[] parts=target.Substring(root.Length).Split(new char[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries);
   string path=root;
   SafeFileHandle rh=CreateFile(path,0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);handles.Add(rh);Check(rh,true);
   for(int n=0;n<parts.Length-1;n++) {
    path=Path.Combine(path,parts[n]);SafeFileHandle dh=CreateFile(path,0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);handles.Add(dh);Check(dh,true);
   }
   // FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
   // deliberately exclude FILE_WRITE_DATA and OPEN_ALWAYS/CREATE_ALWAYS.
   SafeFileHandle f=CreateFile(target,0x00120084,3,IntPtr.Zero,3,0x00200000,IntPtr.Zero);handles.Add(f);
   Info before=Check(f,false);if(before.links!=1||before.sizeHigh!=0||before.sizeLow>1048300)throw new Exception();
   byte[] security=Acl(f);byte[] block=Encoding.ASCII.GetBytes("\n"+key+" envinhands-team\r\n");
   if(block.Length>256)throw new Exception();uint written;
   if(!WriteFile(f,block,(uint)block.Length,out written,IntPtr.Zero)||written!=block.Length)throw new Exception();
   if(!FlushFileBuffers(f))throw new Exception();
   Info after=Check(f,false);
   if(after.volume!=before.volume||after.indexHigh!=before.indexHigh||after.indexLow!=before.indexLow||after.links!=1||!security.SequenceEqual(Acl(f)))throw new Exception();
   return true;
  } catch{return false;} finally {for(int i=handles.Count-1;i>=0;i--)if(handles[i]!=null)handles[i].Dispose();}
 }
`;
 return (WINDOWS_VERIFY.slice(0,start)+method+WINDOWS_VERIFY.slice(end)).replace("[EihKeyCheck]::Verify(","[EihKeyCheck]::Append(");
}
async function runWindowsAppend(input:string):Promise<boolean>{
 if(process.platform!=="win32")return false;
 const root=process.env.SystemRoot;
 if(!root||!win32.isAbsolute(root)||/[\x00-\x1f]/.test(root)||root.split(/[\\/]/).includes(".."))return false;
 const executable=win32.join(root,"System32","WindowsPowerShell","v1.0","powershell.exe");
 const source=Buffer.from(windowsAppendSource(),"utf16le").toString("base64");
 const child=Bun.spawn([executable,"-NoProfile","-NonInteractive","-EncodedCommand",source],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  child.stdin.write(input);child.stdin.end();
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(new Error("timeout"));},15000);});
  const [out,_err,code]=await Promise.race([Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),expired]);
  return code===0&&out.trim()==="1";
 } catch{return false;} finally{if(timer)clearTimeout(timer);if(child.exitCode===null){child.kill();await child.exited;}}
}
/** Opt-in until native Windows verification; caller must perform live verification afterward. */
export function createExperimentalWindowsAppendRunner(options:{platform?:NodeJS.Platform;run?:(input:string)=>Promise<boolean>}={}):typeof runWindowsRegistration {
 return async(request,registrationOptions)=>{
  const fixture=registrationOptions?.fixtureRoot!==undefined;
  try {
   if((options.platform??process.platform)!=="win32"||fixture||request.action!=="apply"||request.confirm!==true||request.grantAdministrator===true)throw new Error();
   prepareLinuxRegistration({user:"agent",publicKey:request.publicKey});
   const ok=await (options.run??runWindowsAppend)(JSON.stringify({key:request.publicKey}));
   return {status:ok?"applied":"partial",ready:false,fixture:false,receipt:ok?{keyAdded:true}:undefined,
    message:ok?"Append attempted; independent live key verification is required.":"Append unavailable or outcome unknown; inspect ACL/path and create missing admin file via approved setup before retry."};
  } catch {return {status:"failed",ready:false,fixture,message:"Append rejected or unavailable; inspect the target before retry."};}
 };
}

/** Existing keys can be verified read-only. A new key requires an explicitly injected
 * race-safe writer; the existing registration helper uses compare-then-replace and
 * can overwrite a non-cooperating concurrent editor, so it is not the default. */
export function createWindowsTeamKeyWriter(options:{user:string; registrationOptions?:WindowsRegistrationOptions; runner?:typeof runWindowsRegistration;
 /** Trusted local adapter: independently inspect the live target with no-reparse and ACL checks.
  * A receipt alone is not evidence. Success does not establish administrator/SSH readiness. */
 verifyInstalled?:(key:string,signal?:AbortSignal)=>Promise<boolean>}):KeyWriter {
 return async (keys,signal)=>{
  let added=0, incomplete=false;
  const verify=options.verifyInstalled??createWindowsKeyVerifier();
  for(const key of keys){
   if(signal?.aborted)throw new Error("stopped");
   prepareLinuxRegistration({user:"agent",publicKey:key});
   if(await verify(key,signal))continue;
   if(!options.runner){incomplete=true;continue;}
   const operationId="team-"+createHash("sha256").update(options.user+"\0"+key).digest("hex");
   let receipt:WindowsRegistrationResult|undefined;
   try {
    receipt=await options.runner({action:"apply",operationId,user:options.user,publicKey:key,confirm:true,grantAdministrator:false},options.registrationOptions);
   } catch { /* Outcome is unknown. Independently inspect the target below. */ }
   try {
    if(!await verify(key,signal))incomplete=true;
    else if(receipt?.status==="applied" && receipt.receipt?.keyAdded===true)added++;
   } catch {incomplete=true;}
  }
  if(incomplete)throw new Error("inspect Windows registration receipts");
  return {added};
 };
}
