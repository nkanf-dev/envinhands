import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTeamNodeOnboard, ensureLocalTeamClientKey, teamNodeSshPaths } from "../src/team-node-onboard.ts";
import { createTeamIdentitiesApi, createTeamIdentitiesClient } from "../src/team-identities.ts";

const homes:string[]=[];
async function home(){const h=await mkdtemp(join(tmpdir(),"eih-team-key-"));homes.push(h);return h;}
afterEach(async()=>{for(const h of homes.splice(0))await rm(h,{recursive:true,force:true});});

describe("local team client key primitive",()=>{
 test("creates and reuses a real Ed25519 key without replacing it",async()=>{
  const h=await home();const first=await ensureLocalTeamClientKey({home:h});expect(first.ok).toBe(true);
  if(!first.ok)throw new Error(first.message);
  const before=await readFile(first.privateKeyPath);expect(before.toString()).toContain("OPENSSH PRIVATE KEY");
  expect((await lstat(join(h,'.envinhands-team'))).mode & 0o777).toBe(0o700);
  expect((await lstat(first.privateKeyPath)).mode & 0o777).toBe(0o600);
  const next=await ensureLocalTeamClientKey({home:h});expect(next).toEqual(first);
  expect(await readFile(first.privateKeyPath)).toEqual(before);expect(first.ready).toBe(false);
 });
 test("refuses an unsafe directory and does not modify the target",async()=>{
  const h=await home(), target=await home();await symlink(target,join(h,'.envinhands-team'));
  const value=await ensureLocalTeamClientKey({home:h});expect(value.ok).toBe(false);
  expect(await Array.fromAsync(new Bun.Glob('*').scan({cwd:target,onlyFiles:false}))).toEqual([]);
 });
 test("refuses corrupt existing key without changing it",async()=>{
  const h=await home(), d=join(h,'.envinhands-team');await mkdir(d,{mode:0o700});
  const path=join(d,'client_ed25519');await writeFile(path,'original',{mode:0o600});
  const value=await ensureLocalTeamClientKey({home:h});expect(value.ok).toBe(false);
  expect(await readFile(path,'utf8')).toBe('original');
 });
 test("refuses permissive existing private key without changing permissions",async()=>{
  const h=await home();const first=await ensureLocalTeamClientKey({home:h});if(!first.ok)throw new Error(first.message);
  await chmod(first.privateKeyPath,0o644);const value=await ensureLocalTeamClientKey({home:h});expect(value.ok).toBe(false);
  expect((await lstat(first.privateKeyPath)).mode & 0o777).toBe(0o644);
 });
 test("recovers a key left at the pending path by a stopped generator",async()=>{
  const h=await home(),d=join(h,'.envinhands-team');await mkdir(d,{mode:0o700});
  const path=join(d,'client_ed25519.pending');
  const proc=Bun.spawn(['ssh-keygen','-q','-t','ed25519','-N','','-f',path],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
  expect(await proc.exited).toBe(0);const before=await readFile(path);
  const value=await ensureLocalTeamClientKey({home:h});expect(value.ok).toBe(true);
  if(!value.ok)throw new Error(value.message);
  expect(await readFile(value.privateKeyPath)).toEqual(before);
  expect(await lstat(value.privateKeyPath).then(s=>s.nlink)).toBe(1);
 });
 test("concurrent starts never create or replace two active keys",async()=>{
  const h=await home();const all=await Promise.all(Array.from({length:6},()=>ensureLocalTeamClientKey({home:h})));
  const successes=all.filter(x=>x.ok);expect(successes.length).toBeGreaterThan(0);
  expect(new Set(successes.map(x=>x.publicKey)).size).toBe(1);
  const value=await ensureLocalTeamClientKey({home:h});expect(value.ok).toBe(true);
  if(!value.ok)throw new Error(value.message);
  expect(value.publicKey).toBe(successes[0]!.publicKey);
 });

});


const reg={registrationId:'test-reg',agentId:'test-agent',sessionId:'test-session',machineId:'test-machine',signature:'test-declaration'};
async function eventually(f:()=>Promise<boolean>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await Bun.sleep(30);}throw new Error('condition not reached');}
async function hostkey(h:string){const path=join(h,'host');const p=Bun.spawn(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',path],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});expect(await p.exited).toBe(0);return path+'.pub';}

describe('onboarding real isolated HTTP and SQLite',()=>{
 test('two homes synchronize, recover a lost response and offline period, and preserve existing authorization',async()=>{
  const h1=await home(),h2=await home(),store=await home();const hp1=await hostkey(h1),hp2=await hostkey(h2);
  await mkdir(join(h1,'.ssh'),{mode:0o700});await writeFile(join(h1,'.ssh','authorized_keys'),'# untouched entry\n',{mode:0o600});
  const api=createTeamIdentitiesApi({dbPath:join(store,'identities.sqlite'),token:'test-token'});
  const requestBodies:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){if(req.method==='POST')requestBodies.push(await req.clone().text());return api.fetch(req);}});
  const baseUrl=`http://127.0.0.1:${server.port}`;
  const client=createTeamIdentitiesClient({baseUrl,token:'test-token',registration:reg});
  let offline=false,drop=true;const operations:string[]=[];const statuses:string[]=[];
  const controlled=async(input:URL,init?:RequestInit)=>{
   if(offline)throw new Error('offline');
   if(init?.method==='POST'){
    const b=JSON.parse(String(init.body));operations.push(b.operationId);
    const response=await fetch(input,init);
    if(drop){drop=false;throw new Error('lost response');}return response;
   }
   return fetch(input,init);
  };
  const opts={baseUrl,token:'test-token',registration:reg,fullTeamTrust:true,intervalMs:100,retryMinMs:30,retryMaxMs:100,requestTimeoutMs:2000,onStatus:(s:{code:string;message:string})=>statuses.push(JSON.stringify(s))};
  const a=createTeamNodeOnboard({...opts,home:h1,deviceId:'one',hostPublicKeyPath:hp1,fetch:controlled});
  const b=createTeamNodeOnboard({...opts,home:h2,deviceId:'two',hostPublicKeyPath:hp2});
  try{
   a.start();b.start();
   await eventually(async()=>{
    const x=(await client.getDevice('one')).record,y=(await client.getDevice('two')).record;
    if(!x||!y)return false;
    const aa=await readFile(join(h1,'.ssh','authorized_keys'),'utf8').catch(()=>''),bb=await readFile(join(h2,'.ssh','authorized_keys'),'utf8').catch(()=>'');
    return aa.includes(y.publicKey)&&bb.includes(x.publicKey);
   });
   expect(operations.length).toBeGreaterThanOrEqual(2);expect(operations[0]).toBe(operations[1]);
   expect((await readFile(join(h1,'.ssh','authorized_keys'),'utf8')).startsWith('# untouched entry\n')).toBe(true);
   offline=true;await Bun.sleep(200);offline=false;
   await eventually(async()=>statuses.filter(s=>s.includes('synchronized')).length>=2);
   await a.stop();
   const restarted=createTeamNodeOnboard({...opts,home:h1,deviceId:'one',hostPublicKeyPath:hp1,fetch:controlled});
   try{restarted.start();await eventually(async()=>statuses.filter(s=>s.includes('synchronized')).length>=3);}finally{await restarted.stop();}
   const logs=statuses.join('\n');expect(logs).not.toContain('test-token');expect(logs).not.toContain('PRIVATE KEY');expect(logs).not.toContain('127.0.0.1');
   const page=await client.listPage();const text=JSON.stringify(page);expect(text).not.toContain('PRIVATE KEY');expect(text).not.toContain('test-token');
   const allBodies=requestBodies.join('\n');
   for(const path of [join(h1,'.envinhands-team','client_ed25519'),join(h2,'.envinhands-team','client_ed25519'),join(h1,'host'),join(h2,'host')]){
    const privateBytes=await readFile(path,'utf8');expect(allBodies).not.toContain(privateBytes);expect(logs).not.toContain(privateBytes);
   }
   expect(allBodies).not.toContain('PRIVATE KEY');expect(allBodies).not.toContain('test-token');
  }finally{await Promise.all([a.stop(),b.stop()]);server.stop(true);api.close();}
 },30000);
});


test('durable unknown outcome is retried with the exact operation after worker restart',async()=>{
 const h=await home(),store=await home(),hp=await hostkey(h),api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch});const baseUrl=`http://127.0.0.1:${server.port}`;
 const bodies:string[]=[];let dropped=false;
 const controlled=async(input:URL,init?:RequestInit)=>{
  if(init?.method==='POST'){
   bodies.push(String(init.body));const r=await fetch(input,init);
   if(!dropped){dropped=true;throw new Error('lost response');}return r;
  }return fetch(input,init);
 };
 const statuses:string[]=[];const opts={baseUrl,token:'token',registration:reg,fullTeamTrust:true,intervalMs:100,retryMinMs:5000,retryMaxMs:5000,requestTimeoutMs:2000,home:h,deviceId:'restart',hostPublicKeyPath:hp,fetch:controlled,onStatus:(s:{code:string})=>statuses.push(s.code)};
 const first=createTeamNodeOnboard(opts);
 try{
  first.start();await eventually(async()=>statuses.includes('retry'));await first.stop();
  expect(JSON.parse(await readFile(join(h,'.envinhands-team','pending.json'),'utf8')).operationId).toBe(JSON.parse(bodies[0]!).operationId);
  const second=createTeamNodeOnboard(opts);try{second.start();await eventually(async()=>statuses.includes('synchronized'));}finally{await second.stop();}
  expect(bodies.length).toBe(2);expect(bodies[1]).toBe(bodies[0]);
  expect(await Bun.file(join(h,'.envinhands-team','pending.json')).exists()).toBe(false);
 }finally{await first.stop();server.stop(true);api.close();}
},15000);

test('concurrent starts share durable request, tombstone ABA is respected, and foreign identity is not overwritten',async()=>{
 const h=await home(),store=await home(),hp=await hostkey(h),api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch});const baseUrl=`http://127.0.0.1:${server.port}`;
 const client=createTeamIdentitiesClient({baseUrl,token:'token',registration:reg});
 const statuses:string[]=[];const opts={baseUrl,token:'token',registration:reg,fullTeamTrust:true,intervalMs:60,retryMinMs:30,retryMaxMs:60,requestTimeoutMs:2000,home:h,deviceId:'same',hostPublicKeyPath:hp,onStatus:(s:{code:string})=>statuses.push(s.code)};
 const first=createTeamNodeOnboard(opts),second=createTeamNodeOnboard(opts);
 try{
  first.start();second.start();await eventually(async()=>statuses.includes('synchronized'));
  const initial=await client.getDevice('same');expect(initial.record).not.toBeNull();
  await client.delete('same','test-delete',initial.revision);
  const tomb=await client.getDevice('same');expect(tomb.record).toBeNull();expect(tomb.revision).not.toBe(initial.revision);
  await eventually(async()=>{const x=await client.getDevice('same');return !!x.record&&x.revision!==initial.revision;});
  const fresh=await client.getDevice('same');expect(fresh.record!.publicKey).toBe(initial.record!.publicKey);
  const other=await hostkey(store);const different=(await readFile(other,'utf8')).trim().split(/\s+/).slice(0,2).join(' ');
  const r=fresh.record!;await client.upsert({deviceId:r.deviceId,os:r.os,user:r.user,publicKey:different,hostKey:different},'test-foreign',fresh.revision);
  await eventually(async()=>statuses.includes('identity-conflict'));
  await Bun.sleep(150);expect((await client.getDevice('same')).record!.publicKey).toBe(different);
 }finally{await Promise.all([first.stop(),second.stop()]);server.stop(true);api.close();}
},15000);


test('409 after an intervening writer re-reads and never overwrites the other identity',async()=>{
 const h=await home(),store=await home(),hp=await hostkey(h),other=await hostkey(store);
 const key=(await readFile(other,'utf8')).trim().split(/\s+/).slice(0,2).join(' ');
 const api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch});
 const baseUrl=`http://127.0.0.1:${server.port}`,client=createTeamIdentitiesClient({baseUrl,token:'token',registration:reg});let injected=false;
 const controlled=async(input:URL,init?:RequestInit)=>{
  if(init?.method==='POST'&&!injected){injected=true;const req=JSON.parse(String(init.body));await client.upsert({...req.identity,publicKey:key,hostKey:key},'intervening',null);}
  return fetch(input,init);
 };
 const statuses:string[]=[];const worker=createTeamNodeOnboard({home:h,deviceId:'race',hostPublicKeyPath:hp,baseUrl,token:'token',registration:reg,fullTeamTrust:true,fetch:controlled,intervalMs:60,retryMinMs:30,retryMaxMs:60,onStatus:s=>statuses.push(s.code)});
 try{worker.start();await eventually(async()=>statuses.includes('identity-conflict'));expect(statuses).toContain('conflict');expect((await client.getDevice('race')).record!.publicKey).toBe(key);}
 finally{await worker.stop();server.stop(true);api.close();}
},15000);


test('host pins use the device alias, rotate from complete snapshots, and survive directory failure',async()=>{
 const h=await home(),store=await home(),hp=await hostkey(h),hp2=await hostkey(store),hp3=await hostkey(await home());
 const host2=(await readFile(hp2,'utf8')).trim().split(/\s+/).slice(0,2).join(' '),host3=(await readFile(hp3,'utf8')).trim().split(/\s+/).slice(0,2).join(' ');
 await mkdir(join(h,'.ssh'),{mode:0o700});await writeFile(join(h,'.ssh','known_hosts'),'# user-owned unchanged\n',{mode:0o600});
 const api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch});
 const baseUrl=`http://127.0.0.1:${server.port}`,client=createTeamIdentitiesClient({baseUrl,token:'token',registration:reg});let failListing=false,partialPages=0;
 const controlled=async(input:URL,init?:RequestInit)=>{
  if(failListing&&init?.method==='GET'&&!input.searchParams.has('deviceId')){
   if(input.searchParams.has('after'))return new Response('unavailable',{status:503});
   const limited=new URL(input);limited.searchParams.set('limit','1');partialPages++;return fetch(limited,init);
  }
  return fetch(input,init);
 };
 const status:string[]=[];const w=createTeamNodeOnboard({home:h,deviceId:'local',hostPublicKeyPath:hp,baseUrl,token:'token',registration:reg,fullTeamTrust:true,fetch:controlled,intervalMs:60,retryMinMs:30,retryMaxMs:60,onStatus:s=>status.push(s.code)});
 try{
  w.start();await eventually(async()=>status.includes('synchronized'));const me=(await client.getDevice('local')).record!;
  const peer={deviceId:'peer-1',os:me.os,user:me.user,publicKey:me.publicKey,hostKey:host2};await client.upsert(peer,'peer-first',null);
  const paths=teamNodeSshPaths(h,'peer-1');expect(w.sshPaths('peer-1')).toEqual(paths);expect(paths.hostKeyAlias).toBe('peer-1');
  await eventually(async()=> (await readFile(paths.knownHostsPath,'utf8')).includes(`peer-1 ${host2}\n`));
  expect((await lstat(paths.knownHostsPath)).mode & 0o777).toBe(0o600);
  const lookup=Bun.spawn(['/usr/bin/ssh-keygen','-F',paths.hostKeyAlias,'-f',paths.knownHostsPath],{stdout:'pipe',stderr:'pipe'});expect(await lookup.exited).toBe(0);
  expect(await readFile(join(h,'.ssh','known_hosts'),'utf8')).toBe('# user-owned unchanged\n');
  const before=await readFile(paths.knownHostsPath);failListing=true;
  const current=await client.getDevice('peer-1');await client.upsert({...peer,hostKey:host3},'peer-rotate',current.revision);
  await eventually(async()=>status.includes('known-hosts'));expect(partialPages).toBeGreaterThan(0);expect(await readFile(paths.knownHostsPath)).toEqual(before);
  failListing=false;await eventually(async()=> (await readFile(paths.knownHostsPath,'utf8')).includes(`peer-1 ${host3}\n`));
  const after=await readFile(paths.knownHostsPath,'utf8');expect(after).not.toContain(`peer-1 ${host2}\n`);expect(after).toContain(`local ${me.hostKey}\n`);
  expect(await readFile(join(h,'.ssh','known_hosts'),'utf8')).toBe('# user-owned unchanged\n');
 }finally{await w.stop();server.stop(true);api.close();}
},15000);

test('refuses symlink and hardlink at the owned host pins file',async()=>{
 const h=await home(),store=await home(),hp=await hostkey(h),target=join(store,'target');await writeFile(target,'do not modify',{mode:0o600});
 const initial=await ensureLocalTeamClientKey({home:h});expect(initial.ok).toBe(true);
 const path=teamNodeSshPaths(h,'self').knownHostsPath;await symlink(target,path);
 const api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch}),baseUrl=`http://127.0.0.1:${server.port}`;
 const status:string[]=[];const w=createTeamNodeOnboard({home:h,deviceId:'self',hostPublicKeyPath:hp,baseUrl,token:'token',registration:reg,fullTeamTrust:true,intervalMs:60,retryMinMs:30,retryMaxMs:60,onStatus:s=>status.push(s.code)});
 try{
  w.start();await eventually(async()=>status.includes('host-pins-unknown'));expect(await readFile(target,'utf8')).toBe('do not modify');
  await rm(path);await Bun.write(path,'# envinhands-snapshot 1\n');await chmod(path,0o600);
  const link=join(store,'linked');await (await import('node:fs/promises')).link(path,link);const count=status.length;
  await eventually(async()=>status.slice(count).includes('host-pins-unknown'));expect(await readFile(link,'utf8')).toBe('# envinhands-snapshot 1\n');
 }finally{await w.stop();server.stop(true);api.close();}
},15000);


test('concurrent old snapshot cannot roll back a newer host pin',async()=>{
 const h=await home(),store=await home(),hp=await hostkey(h),hp2=await hostkey(store);
 const api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch}),baseUrl=`http://127.0.0.1:${server.port}`;
 const client=createTeamIdentitiesClient({baseUrl,token:'token',registration:reg});let release!:()=>void,hold=false,captured=false;
 const gate=new Promise<void>(r=>{release=r;});
 const delayed=async(input:URL,init?:RequestInit)=>{
  const response=await fetch(input,init);
  if(hold&&!captured&&init?.method==='GET'&&!input.searchParams.has('deviceId')){captured=true;await gate;}
  return response;
 };
 const common={home:h,deviceId:'same',hostPublicKeyPath:hp,baseUrl,token:'token',registration:reg,fullTeamTrust:true,intervalMs:60,retryMinMs:30,retryMaxMs:60,requestTimeoutMs:3000};
 const first=createTeamNodeOnboard({...common,fetch:delayed}),second=createTeamNodeOnboard(common);const path=teamNodeSshPaths(h,'same').knownHostsPath;
 try{
  first.start();await eventually(async()=>await Bun.file(path).exists());hold=true;
  await eventually(async()=>captured);const me=(await client.getDevice('same')).record!;
  const host2=(await readFile(hp2,'utf8')).trim().split(/\s+/).slice(0,2).join(' ');
  await client.upsert({deviceId:'peer',os:me.os,user:me.user,publicKey:me.publicKey,hostKey:host2},'concurrent-peer',null);
  second.start();await eventually(async()=> (await readFile(path,'utf8')).includes(`peer ${host2}\n`));
  release();await Bun.sleep(200);expect(await readFile(path,'utf8')).toContain(`peer ${host2}\n`);
 }finally{release();await Promise.all([first.stop(),second.stop()]);server.stop(true);api.close();}
},15000);


test('case-insensitive SSH aliases reject legacy collision across snapshot pages and recover',async()=>{
 const h=await home(),store=await home(),hp=await hostkey(h),hp2=await hostkey(store),path=join(store,'db');
 const key1=(await readFile(hp,'utf8')).trim().split(/\s+/).slice(0,2).join(' '),key2=(await readFile(hp2,'utf8')).trim().split(/\s+/).slice(0,2).join(' ');
 const probe=join(store,'probe');await writeFile(probe,`Foo ${key1}\nfoo ${key2}\n`,{mode:0o600});
 const cmd=Bun.spawn(['/usr/bin/ssh-keygen','-F','foo','-f',probe],{stdout:'pipe',stderr:'pipe'});const output=await new Response(cmd.stdout).text();expect(await cmd.exited).toBe(0);expect(output).toContain(key1);expect(output).toContain(key2);
 const api=createTeamIdentitiesApi({dbPath:path,token:'token'}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch}),baseUrl=`http://127.0.0.1:${server.port}`;
 const client=createTeamIdentitiesClient({baseUrl,token:'token',registration:reg});
 let spoof:{snapshot:number;records:any[]}|undefined;
 const controlled=async(input:URL,init?:RequestInit)=>{
  if(init?.method==='GET'&&!input.searchParams.has('deviceId')){
   if(spoof){const after=input.searchParams.get('after')??'';const records=spoof.records.filter(r=>r.deviceId>after).slice(0,1);const last=records[0]?.deviceId;const nextAfter=last&&spoof.records.some(r=>r.deviceId>last)?last:null;return Response.json({snapshot:spoof.snapshot,records,nextAfter});}
   const url=new URL(input);url.searchParams.set('limit','1');return fetch(url,init);
  }
  return fetch(input,init);
 };
 const status:string[]=[];const w=createTeamNodeOnboard({home:h,deviceId:'self',hostPublicKeyPath:hp,baseUrl,token:'token',registration:reg,fullTeamTrust:true,fetch:controlled,intervalMs:60,retryMinMs:30,retryMaxMs:60,onStatus:s=>status.push(s.code)});
 const {Database}=await import('bun:sqlite');const db=new Database(path);
 try{
  w.start();await eventually(async()=>status.includes('synchronized'));const me=(await client.getDevice('self')).record!;
  const one={deviceId:'Foo',os:me.os,user:me.user,publicKey:me.publicKey,hostKey:key1},two={...one,deviceId:'food',hostKey:key2};
  db.query('INSERT INTO team_identity_history(device_id,payload) VALUES(?,?)').run(one.deviceId,JSON.stringify(one));
  db.query('INSERT INTO team_identity_history(device_id,payload) VALUES(?,?)').run(two.deviceId,JSON.stringify(two));
  const file=teamNodeSshPaths(h,'Foo').knownHostsPath;await eventually(async()=>{const text=await readFile(file,'utf8');return text.includes(`Foo ${key1}\n`)&&text.includes(`food ${key2}\n`);});
  const before=await readFile(file);const page=await client.listPage();const source=page.records.find(r=>r.deviceId==='Foo')!;
  spoof={snapshot:page.snapshot,records:[...page.records,{...source,deviceId:'foo'}].sort((a,b)=>a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0)};
  await eventually(async()=>status.includes('host-alias-conflict'));expect(await readFile(file)).toEqual(before);
  const count=status.filter(s=>s==='synchronized').length;spoof=undefined;
  await eventually(async()=>status.filter(s=>s==='synchronized').length>count);expect(await readFile(file)).toEqual(before);
  const legacy={...one,deviceId:'foo'};db.query('INSERT INTO team_identity_history(device_id,payload) VALUES(?,?)').run(legacy.deviceId,JSON.stringify(legacy));
  await eventually(async()=>status.includes('directory-conflict'));expect(await readFile(file)).toEqual(before);
  db.query('INSERT INTO team_identity_history(device_id,payload) VALUES(?,NULL)').run('foo');
  const recovered=status.filter(s=>s==='synchronized').length;await eventually(async()=>status.filter(s=>s==='synchronized').length>recovered);
 }finally{await w.stop();db.close();server.stop(true);api.close();}
},15000);

test('never replays a pending old identity after a client key changes, regardless of commit outcome',async()=>{
 for(const committed of [false,true]){
  const h=await home(),store=await home(),hp=await hostkey(h),api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch}),baseUrl=`http://127.0.0.1:${server.port}`;
  let posts=0;const controlled=async(input:URL,init?:RequestInit)=>{if(init?.method==='POST'){posts++;if(committed)await fetch(input,init);throw new Error('lost');}return fetch(input,init);};
  const statuses:string[]=[];const opts={home:h,deviceId:'node',hostPublicKeyPath:hp,baseUrl,token:'token',registration:reg,fullTeamTrust:true,fetch:controlled,intervalMs:60,retryMinMs:5000,retryMaxMs:5000,onStatus:(s:{code:string})=>statuses.push(s.code)};
  const first=createTeamNodeOnboard(opts);let second:ReturnType<typeof createTeamNodeOnboard>|undefined;
  try{
   first.start();await eventually(async()=>statuses.includes('retry'));await first.stop();const journal=join(h,'.envinhands-team','pending.json'),before=await readFile(journal);
   const replacement=join(store,'replacement');const gen=Bun.spawn(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',replacement],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});expect(await gen.exited).toBe(0);
   await (await import('node:fs/promises')).rename(replacement,join(h,'.envinhands-team','client_ed25519'));
   second=createTeamNodeOnboard(opts);second.start();await eventually(async()=>statuses.includes(committed?'identity-changed':'identity-changed-unknown'));
   expect(posts).toBe(1);expect(await readFile(journal)).toEqual(before);
  }finally{await first.stop();await second?.stop();server.stop(true);api.close();}
 }
},15000);


test('host pin rename interruption is reverified or reported unknown and recovered on restart',async()=>{
 for(const fault of ['fsync','abort'] as const){
  const h=await home(),store=await home(),hp=await hostkey(h),api=createTeamIdentitiesApi({dbPath:join(store,'db'),token:'token'}),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:api.fetch}),baseUrl=`http://127.0.0.1:${server.port}`;
  const statuses:string[]=[];const opts={home:h,deviceId:'self',hostPublicKeyPath:hp,baseUrl,token:'token',registration:reg,fullTeamTrust:true,intervalMs:100,retryMinMs:5000,retryMaxMs:5000,onStatus:(s:{code:string})=>statuses.push(s.code)};
  const original=Bun.spawn;let worker:ReturnType<typeof createTeamNodeOnboard>|undefined;
  try{
   Bun.spawn=((...args:any[])=>{
    const cmd=args[0];
    if(Array.isArray(cmd)&&typeof cmd[2]==='string'&&cmd[2].includes('# envinhands-snapshot ')){
     const copy=[...cmd];
     const needle="os.rename(temp,'known_hosts',src_dir_fd=d,dst_dir_fd=d);os.fsync(d)";
     if(!copy[2].includes(needle))throw new Error('fault injection target missing');
     copy[2]=copy[2].replace(needle,"os.rename(temp,'known_hosts',src_dir_fd=d,dst_dir_fd=d);"+(fault==='fsync'?'raise OSError()':'os.kill(os.getpid(),9)'));
     if(fault==='abort')copy[2]=copy[2].replace("  if action in ('known-hosts','verify-known-hosts'):","  if action=='verify-known-hosts':raise ValueError()\n  if action in ('known-hosts','verify-known-hosts'):");
     args[0]=copy;
    }
    return (original as (...args:any[])=>any)(...args);
   }) as typeof Bun.spawn;
   worker=createTeamNodeOnboard(opts);worker.start();
   await eventually(async()=>statuses.includes(fault==='fsync'?'host-pins-recovered':'host-pins-unknown'));
   expect(await Bun.file(teamNodeSshPaths(h,'self').knownHostsPath).exists()).toBe(true);
   await worker.stop();Bun.spawn=original;
   const resumed=createTeamNodeOnboard(opts);worker=resumed;resumed.start();await eventually(async()=>statuses.includes('synchronized'));
  }finally{Bun.spawn=original;await worker?.stop();server.stop(true);api.close();}
 }
},15000);
