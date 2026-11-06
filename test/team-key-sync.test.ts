import {describe,expect,test} from "bun:test";
import {mkdtemp,readFile,rm,mkdir,writeFile,symlink,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createTeamKeySync,createTeamSnapshotFetcher,createUnixTeamKeyWriter,createWindowsTeamKeyWriter,configureTeamAdministrator,UNIX_WRITER,createWindowsKeyVerifier,createExperimentalWindowsAppendRunner,windowsAppendSource} from "../src/team-key-sync.ts";
function key(n:number){return "ssh-ed25519 "+Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from("ssh-ed25519"),Buffer.from([0,0,0,32]),Buffer.alloc(32,n)]).toString("base64");}
const snapshot=(keys:string[])=>({version:1,complete:true,revision:"1",keys});
function patchedRunner(source:string){return async(program:string,input:string)=>{
 const child=Bun.spawn([program,"-c",source],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});child.stdin.write(input);child.stdin.end();
 const [out,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);if(code!==0)throw Error("fixture failure");return out;
};}

describe("team key synchronization",()=>{
 test("owner confirmation, disconnect, malformed inputs and recovery never remove old data",async()=>{
  let online=false, stored=[key(1)], writes=0;
  const s=createTeamKeySync({fullTeamTrust:true,fetchSnapshot:async()=>{if(!online)throw Error("secret not logged");return snapshot([key(2)]);},writeKeys:async keys=>{writes++;stored=[...new Set([...stored,...keys])];return {added:1};}});
  expect((await s.sync()).code).toBe("directory-unavailable");expect(stored).toEqual([key(1)]);online=true;
  expect((await s.sync()).ok).toBe(true);expect(stored).toEqual([key(1),key(2)]);expect(writes).toBe(1);
  const invalid=createTeamKeySync({fullTeamTrust:true,fetchSnapshot:async()=>snapshot([key(3)+"\ncommand=evil"]),writeKeys:async()=>{throw Error("must not write");}});
  expect((await invalid.sync()).code).toBe("invalid-directory");
  const denied=createTeamKeySync({fullTeamTrust:false,fetchSnapshot:async()=>{throw Error("must not fetch");},writeKeys:async()=>({added:0})});expect((await denied.sync()).code).toBe("authorization-required");
 });
 test("complete consistent page stream required, including pagination failure",async()=>{
  const fetcher=createTeamSnapshotFetcher({listPage:async p=>p.after?{snapshot:4,records:[{deviceId:"b",publicKey:key(2)}],nextAfter:null}:{snapshot:4,records:[{deviceId:"a",publicKey:key(1)}],nextAfter:"a"}});
  expect(await fetcher()).toEqual({version:1,complete:true,revision:"4",keys:[key(1),key(2)]});
  const broken=createTeamSnapshotFetcher({listPage:async p=>p.after?{snapshot:5,records:[],nextAfter:null}:{snapshot:4,records:[{deviceId:"a",publicKey:key(1)}],nextAfter:"a"}});
  expect(broken()).rejects.toThrow();
 });
 test("single flight and safe retry after unknown partial failure",async()=>{
  let count=0;let fail=true;const s=createTeamKeySync({fullTeamTrust:true,fetchSnapshot:async()=>snapshot([key(1)]),writeKeys:async()=>{count++;await Bun.sleep(10);if(fail)throw Error("private secret");return {added:1};}});
  const [a,b]=await Promise.all([s.sync(),s.sync()]);expect(count).toBe(1);expect(a.code).toBe("write-unknown");expect(JSON.stringify(a)).not.toContain("private secret");expect(b).toEqual(a);
  fail=false;expect((await s.sync()).ok).toBe(true);expect(count).toBe(2);
 });
 test("unix atomic append preserves unrelated bytes, permissions and repeat",async()=>{
  const home=await mkdtemp(join(tmpdir(),"team-sync-"));try{
   await mkdir(join(home,".ssh"),{mode:0o700});const path=join(home,".ssh","authorized_keys");const original="# user entry\r\n"+key(1)+" a comment";await writeFile(path,original,{mode:0o600});
   const write=createUnixTeamKeyWriter({home});expect(await write([key(1),key(2)])).toEqual({added:1});const content=await readFile(path,"utf8");expect(content.startsWith(original)).toBe(true);expect(content).toContain(key(2));expect(await write([key(1),key(2)])).toEqual({added:0});expect(await readFile(path,"utf8")).toBe(content);expect((await stat(path)).mode&0o777).toBe(0o600);
  }finally{await rm(home,{recursive:true,force:true});}
 });
 test("Unix recognizes only an uncommented physical LF key line, never an embedded CR",async()=>{
  const home=await mkdtemp(join(tmpdir(),"team-sync-"));try{
   await mkdir(join(home,".ssh"),{mode:0o700});const file=join(home,".ssh","authorized_keys");
   const original="#ignored\r"+key(1)+"\n # "+key(2)+"\n";await writeFile(file,original,{mode:0o600});
   const w=createUnixTeamKeyWriter({home});expect(await w([key(1),key(2)])).toEqual({added:2});const data=await readFile(file,"utf8");expect(data.startsWith(original)).toBe(true);expect(data).toContain("\n"+key(1)+" envinhands-team\n");expect(data).toContain("\n"+key(2)+" envinhands-team\n");
   expect(await w([key(1),key(2)])).toEqual({added:0});
  }finally{await rm(home,{recursive:true,force:true});}
 });
 // Explicit opt-in: a disposable user+mount namespace and private loopback sshd.
 test.skipIf(process.env.ENVINHANDS_RUN_ISOLATED_SSHD!=="1")("isolated sshd rejects a commented CR key and accepts the appended key",async()=>{
  const script=String.raw`import os, tempfile, subprocess, socket, time, pathlib, shutil, sys
if os.geteuid()!=0:raise SystemExit('namespace unavailable')
subprocess.run(['/usr/bin/mount','-t','tmpfs','tmpfs','/run'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.mkdir('/run/sshd',0o755)
subprocess.run(['/usr/bin/mount','--bind','/run/sshd','/usr/share/empty.sshd'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['/usr/bin/mount','-t','tmpfs','tmpfs','/etc'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
pathlib.Path('/etc/passwd').write_text('root:x:0:0:root:/tmp:/bin/sh\nsshd:x:0:0:sshd:/tmp:/bin/sh\nnobody:x:0:0:nobody:/tmp:/bin/sh\n')
pathlib.Path('/etc/group').write_text('root:x:0:\n')
pathlib.Path('/etc/shadow').write_text('root::20000:0:99999:7:::\nsshd:!:20000:0:99999:7:::\n')
os.chmod('/etc/shadow',0o600)
with tempfile.TemporaryDirectory(prefix='eih-sshd-',dir='/run') as tmp:
 home=pathlib.Path(tmp)/'home';home.mkdir(mode=0o700);ssh=home/'.ssh';ssh.mkdir(mode=0o700)
 host=pathlib.Path(tmp)/'host';identity=pathlib.Path(tmp)/'id'
 for key in (host,identity):subprocess.run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 pub=pathlib.Path(str(identity)+'.pub').read_text().split();public=' '.join(pub[:2]);authorized=ssh/'authorized_keys'
 authorized.write_bytes(b'#ignored\r'+public.encode()+b'\n');os.chmod(authorized,0o600)
 sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
 config=pathlib.Path(tmp)/'sshd_config';config.write_text('Port '+str(port)+'\nListenAddress 127.0.0.1\nHostKey '+str(host)+'\nPidFile '+tmp+'/sshd.pid\nAuthorizedKeysFile '+str(authorized)+'\nStrictModes no\nUsePAM no\nPermitRootLogin yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUseDNS no\nLogLevel ERROR\n')
 # A user namespace denies setgroups. Its only mapped identity is already the
 # caller, so an isolated shim permits sshd privilege separation to proceed.
 shim=pathlib.Path(tmp)/'shim.c';shim.write_text('#include <sys/types.h>\nint setgroups(size_t n,const gid_t *g){return 0;}\nint initgroups(const char *u,gid_t g){return 0;}\n')
 lib=pathlib.Path(tmp)/'shim.so';subprocess.run(['/usr/bin/cc','-shared','-fPIC','-o',str(lib),str(shim)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 log=open(pathlib.Path(tmp)/'sshd.log','w+')
 daemon=subprocess.Popen(['/usr/bin/sshd','-D','-e','-f',str(config)],stdout=subprocess.DEVNULL,stderr=log,env=dict(os.environ,LD_PRELOAD=str(lib)))
 try:
  for i in range(100):
   if daemon.poll() is not None:
    log.flush();log.seek(0);raise RuntimeError('isolated sshd failed to start: '+log.read())
   try:s=socket.create_connection(('127.0.0.1',port),0.1);s.close();break
   except OSError:time.sleep(0.03)
  else:raise RuntimeError('isolated sshd not listening')
  cmd=['/usr/bin/ssh','-F','/dev/null','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','BatchMode=yes','-o','PreferredAuthentications=publickey','-o','IdentitiesOnly=yes','-o','ConnectTimeout=3','-i',str(identity),'-p',str(port),'root@127.0.0.1','true']
  def login():return subprocess.run(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8).returncode
  if login()==0:raise RuntimeError('commented key unexpectedly authenticated')
  js="import {createUnixTeamKeyWriter} from './src/team-key-sync.ts';const k=await Bun.file(process.env.EIH_PUB).text();await createUnixTeamKeyWriter({home:process.env.EIH_HOME})([k.trim().split(' ').slice(0,2).join(' ')]);"
  env=dict(os.environ,EIH_HOME=str(home),EIH_PUB=str(identity)+'.pub')
  subprocess.run([shutil.which('bun'),'-e',js],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
  if login()!=0:raise RuntimeError('installed key did not authenticate')
 finally:
  daemon.terminate()
  try:daemon.wait(timeout=3)
  except subprocess.TimeoutExpired:daemon.kill();daemon.wait()
`;
  const child=Bun.spawn(["unshare","-Ur","-m","/usr/bin/python3","-c",script],{stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,stdout,stderr}).toEqual({code:0,stdout:"",stderr:""});
 },30000);
 test("symlink target and unsafe mode rejected without modifying other file",async()=>{
  const home=await mkdtemp(join(tmpdir(),"team-sync-"));try{await mkdir(join(home,".ssh"),{mode:0o700});const target=join(home,"target");await writeFile(target,"untouched");await symlink(target,join(home,".ssh","authorized_keys"));
   expect(createUnixTeamKeyWriter({home})([key(1)])).rejects.toThrow();expect(await readFile(target,"utf8")).toBe("untouched");
  }finally{await rm(home,{recursive:true,force:true});}
 });
 test("concurrent independent Unix writers retry safely after lock contention",async()=>{
  const home=await mkdtemp(join(tmpdir(),"team-sync-"));try{
   const one=createUnixTeamKeyWriter({home}),two=createUnixTeamKeyWriter({home});
   await Promise.allSettled([one([key(1)]),two([key(2)])]);
   await one([key(1),key(2)]);const text=await readFile(join(home,".ssh","authorized_keys"),"utf8");expect(text).toContain(key(1));expect(text).toContain(key(2));
  }finally{await rm(home,{recursive:true,force:true});}
 });
 test("external append is preserved; rename yields unknown and retry",async()=>{
  const home=await mkdtemp(join(tmpdir(),"team-sync-"));try{
   const before="if os.write(f,chunk)!=len(chunk):raise ValueError('short write')";
   const concurrent=UNIX_WRITER.replace(before,"other=os.open('authorized_keys',os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW,dir_fd=d);os.write(other,b'\\n# concurrent external append\\n');os.close(other)\n    "+before);
   await createUnixTeamKeyWriter({home,runner:patchedRunner(concurrent)})([key(1)]);
   let text=await readFile(join(home,".ssh","authorized_keys"),"utf8");expect(text).toContain("# concurrent external append");expect(text).toContain(key(1));
   const renamed=UNIX_WRITER.replace("os.fsync(f);same_file(h,d,f,home)","os.fsync(f);os.rename('authorized_keys','moved',src_dir_fd=d,dst_dir_fd=d);same_file(h,d,f,home)");
   await expect(createUnixTeamKeyWriter({home,runner:patchedRunner(renamed)})([key(2)])).rejects.toThrow();
   expect(await readFile(join(home,".ssh","moved"),"utf8")).toContain(key(2));
   await createUnixTeamKeyWriter({home})([key(1),key(2)]);text=await readFile(join(home,".ssh","authorized_keys"),"utf8");expect(text).toContain(key(1));expect(text).toContain(key(2));
  }finally{await rm(home,{recursive:true,force:true});}
 });
 test("short write or crash leaves partial prefix and retry repairs on a fresh line",async()=>{
  for(const crash of [false,true]){const home=await mkdtemp(join(tmpdir(),"team-sync-"));try{
   const line="if os.write(f,chunk)!=len(chunk):raise ValueError('short write')";
   const replacement=crash?"os.write(f,chunk[:20]);os._exit(9)":"if os.write(f,chunk[:20])!=len(chunk):raise ValueError('short write')";
   await expect(createUnixTeamKeyWriter({home,runner:patchedRunner(UNIX_WRITER.replace(line,replacement))})([key(1)])).rejects.toThrow();
   const path=join(home,".ssh","authorized_keys"),partial=await readFile(path,"utf8");expect(partial.length).toBeGreaterThan(0);
   await createUnixTeamKeyWriter({home})([key(1)]);const repaired=await readFile(path,"utf8");expect(repaired.startsWith(partial)).toBe(true);expect(repaired).toContain("\n"+key(1)+" envinhands-team\n");
  }finally{await rm(home,{recursive:true,force:true});}}
 });
 test("Windows partial failure continues later keys and is reported",async()=>{
  let calls=0;const writer=createWindowsTeamKeyWriter({user:"Test",runner:async()=>{calls++;return {status:calls===1?"partial":"applied",ready:false,fixture:true,receipt:{keyAdded:true},message:"mock"};}});
  await expect(writer([key(1),key(2)])).rejects.toThrow();expect(calls).toBe(2);
 });
 test("experimental Windows append uses stdin and needs independent verification",async()=>{
  let input="",verifications=0;const runner=createExperimentalWindowsAppendRunner({platform:"win32",run:async data=>{input=data;return true;}});
  const writer=createWindowsTeamKeyWriter({user:"Test",runner,verifyInstalled:async()=>++verifications===2});
  expect(await writer([key(1)])).toEqual({added:1});expect(JSON.parse(input)).toEqual({key:key(1)});expect(verifications).toBe(2);
  const script=windowsAppendSource();expect(script).toContain("CreateFile(target,0x00120084,3,IntPtr.Zero,3,0x00200000");expect(script).toContain("FlushFileBuffers(f)");expect(script).toContain("DriveType.Fixed");expect(script).toContain("[EihKeyCheck]::Append(");
 });
 test("Windows verifier sends key only as stdin data, rejects invalid keys and unknown platforms",async()=>{
  let input="",calls=0;const v=createWindowsKeyVerifier({platform:"win32",runner:async data=>{calls++;input=data;return true;}});
  expect(await v(key(1))).toBe(true);expect(JSON.parse(input)).toEqual({key:key(1)});expect(await v(key(1)+"\nmalicious")).toBe(false);expect(calls).toBe(1);
  expect(await createWindowsKeyVerifier({platform:"linux",runner:async()=>{throw Error("not called");}})(key(1))).toBe(false);
 });
 test("directory cursor repeats and record limits fail without writes",async()=>{
  const repeated=createTeamSnapshotFetcher({listPage:async p=>p.after?{snapshot:1,records:[{deviceId:"a",publicKey:key(1)}],nextAfter:"a"}:{snapshot:1,records:[{deviceId:"a",publicKey:key(1)}],nextAfter:"a"}});
  await expect(repeated()).rejects.toThrow();
  let count=0;const large=createTeamSnapshotFetcher({listPage:async()=>{const records=Array.from({length:100},()=>({deviceId:String(++count).padStart(6,"0"),publicKey:key(1)}));return {snapshot:1,records,nextAfter:records[records.length-1].deviceId};}});
  await expect(large()).rejects.toThrow();expect(count).toBe(10100);
 });
 test("Windows missing key is unknown without an explicit safe writer",async()=>{
  const writer=createWindowsTeamKeyWriter({user:"Test",verifyInstalled:async()=>false});
  await expect(writer([key(1)])).rejects.toThrow();
 });
 test("Windows receipt alone is not proof; injectable independent verifier can confirm",async()=>{
  let verified=0;const runner=async()=>({status:"partial" as const,ready:false as const,fixture:true,receipt:{stage:"applied"},message:"mock"});
  await expect(createWindowsTeamKeyWriter({user:"Test",runner})([key(1)])).rejects.toThrow();
  const writer=createWindowsTeamKeyWriter({user:"Test",runner,verifyInstalled:async k=>{verified++;return k===key(1);}});
  expect(await writer([key(1)])).toEqual({added:0});expect(verified).toBe(1);
 });
 test("Windows applied receipt is not a successful sync without live verification",async()=>{
  let checks=0;const writer=createWindowsTeamKeyWriter({user:"Test",verifyInstalled:async()=>{checks++;return false;},runner:async()=>({status:"applied",ready:false,fixture:true,receipt:{keyAdded:true},message:"mock"})});
  await expect(writer([key(1)])).rejects.toThrow();expect(checks).toBe(2);
 });
 test("Windows failed helper still needs a real post-write check",async()=>{
  let checks=0;const writer=createWindowsTeamKeyWriter({user:"Test",verifyInstalled:async()=>++checks===2,runner:async()=>({status:"failed",ready:false,fixture:true,message:"mock"})});
  expect(await writer([key(1)])).toEqual({added:0});expect(checks).toBe(2);
 });
 test("windows registration adapter and privilege gate use only public keys",async()=>{
  const requests:unknown[]=[];let checked=0;const writer=createWindowsTeamKeyWriter({user:"Test",verifyInstalled:async()=>++checked>1,runner:async request=>{requests.push(request);return {status:"applied",ready:false,fixture:true,receipt:{keyAdded:true},message:"mock"};}});
  expect(await writer([key(1)])).toEqual({added:1});expect(JSON.stringify(requests)).not.toContain("PRIVATE KEY");expect((requests[0] as {grantAdministrator:boolean}).grantAdministrator).toBe(false);
  const r=await configureTeamAdministrator({confirmFullTeamTrust:true,platform:"windows",elevated:false,operationId:"x",user:"Test",publicKey:key(1),windowsRunner:async()=>{throw Error("must not run");}});expect(r.status).toBe("elevation-required");
 });
 test("directory deadline aborts the injected transport and retains access",async()=>{
  let aborted=false,writes=0;
  const s=createTeamKeySync({fullTeamTrust:true,requestTimeoutMs:20,fetchSnapshot:signal=>new Promise((_resolve,reject)=>signal?.addEventListener("abort",()=>{aborted=true;reject(Error("cancelled"));})),writeKeys:async()=>{writes++;return {added:0};}});
  expect((await s.sync()).code).toBe("directory-unavailable");expect(aborted).toBe(true);expect(writes).toBe(0);await s.stop();
 });
 test("stop cancels a pending directory wait and prevents later writes",async()=>{
  let release!:(x:unknown)=>void,writes=0;const pending=new Promise<unknown>(r=>{release=r;});
  const s=createTeamKeySync({fullTeamTrust:true,fetchSnapshot:()=>pending,writeKeys:async()=>{writes++;return {added:0};}});
  const active=s.sync();await s.stop();expect((await active).code).toBe("stopped");release(snapshot([key(1)]));await Promise.resolve();expect(writes).toBe(0);
 });
 test("poll loop stops without blocking caller and retries",async()=>{
  let n=0;const s=createTeamKeySync({fullTeamTrust:true,intervalMs:100,fetchSnapshot:async()=>{n++;if(n===1)throw Error();return snapshot([]);},writeKeys:async()=>({added:0})});s.start();await Bun.sleep(260);await s.stop();let end=n;await Bun.sleep(130);expect(end).toBeGreaterThanOrEqual(2);expect(n).toBe(end);
 });
});
