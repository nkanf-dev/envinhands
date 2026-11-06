import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture=join(import.meta.dir,"fixtures/mesh-audit-process.ts");
const token="fixture-token";
const a={hostId:"host",agentId:"id",parentId:null,name:"A",state:"active"}, b={...a,name:"B"};
function start(dbPath:string,machineId="control") {
  const queued: unknown[]=[];
  let waiting: ((message:unknown)=>void) | undefined;
  const proc=Bun.spawn([process.execPath,"run",fixture,dbPath,machineId],{
    stdout:"ignore",stderr:"inherit",ipc(message) { if (waiting) {const f=waiting; waiting=undefined; f(message);} else queued.push(message); }
  });
  const next=():Promise<unknown>=> queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve=>{waiting=resolve;});
  return {proc,next};
}
const post=(url:string,value:unknown,actor="actor",gate: string | false=false)=>fetch(url+"v1/native-mesh/agents",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json",
  "x-envinhands-registration":Buffer.from(JSON.stringify({registrationId:actor,agentId:actor,sessionId:actor,machineId:"client",signature:"fixture"})).toString("base64url"),
  "x-envinhands-operation-id":"operation",...(gate ? {"x-fixture-gate":gate} : {})},body:JSON.stringify(value)});
const ready=async (p:ReturnType<typeof start>) => (await p.next() as {ready:string}).ready;

test("two independent servers share a DB without stale ABA completions, survive a kill and restart",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mesh-process-")),dbPath=join(dir,"db.sqlite");
  const one=start(dbPath), url1=await ready(one), two=start(dbPath), url2=await ready(two);
  const db=new Database(dbPath); let three:ReturnType<typeof start>|undefined;
  const records=()=>db.query("SELECT payload FROM change_records ORDER BY sequence").all() as {payload:string}[];
  try {
    // The first process has persisted the mesh mutation but has not written completion.
    const old=post(url1,a,"old","after-write"); expect(await one.next()).toBe("committed");
    expect((await post(url2,b,"middle")).status).toBe(200);
    expect((await post(url2,a,"new")).status).toBe(200);
    const binding=JSON.stringify(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all());
    one.proc.send("release"); expect((await old).status).toBe(200);
    expect(JSON.stringify(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all())).toBe(binding);
    let count=records().length; expect((await post(url1,a,"old")).status).toBe(200); expect(records()).toHaveLength(count+2);
    count=records().length;
    const responses=await Promise.all(Array.from({length:40},(_,i)=>post(i%2?url1:url2,a,"old")));
    expect(responses.every(r=>r.status===200)).toBe(true); expect(records()).toHaveLength(count);
    // Kill after mesh commit, before result audit. Unknown intent remains and no
    // new binding is possible for B; retry after restart must add a full pair.
    const pending=post(url1,b,"old","after-write").catch(()=>null); expect(await one.next()).toBe("committed");
    const before=records().length; expect(JSON.parse(records().at(-1)!.payload).outcome).toBe("unknown");
    one.proc.kill("SIGKILL"); await one.proc.exited; await pending;
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    three=start(dbPath); const url3=await ready(three);
    expect((await post(url3,b,"old")).status).toBe(200); expect(records()).toHaveLength(before+2);
    expect((await post(url2,b,"old")).status).toBe(200); expect(records()).toHaveLength(before+2);
    expect((db.query("PRAGMA integrity_check").get() as {integrity_check:string}).integrity_check).toBe("ok");
  } finally {one.proc.kill(); two.proc.kill(); three?.proc.kill(); await Promise.all([one.proc.exited,two.proc.exited,three?.proc.exited]); db.close();rmSync(dir,{recursive:true,force:true});}
},15000);

test("logical audit domain is part of the binding across processes",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mesh-domain-")),dbPath=join(dir,"db.sqlite");
  const one=start(dbPath,"machine-one"), url1=await ready(one), two=start(dbPath,"machine-two"), url2=await ready(two);
  const db=new Database(dbPath), count=()=> (db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n;
  try {
    expect((await post(url1,a)).status).toBe(200); expect(count()).toBe(2);
    expect((await post(url2,a)).status).toBe(200); expect(count()).toBe(4);
    expect((await post(url2,a)).status).toBe(200); expect(count()).toBe(4);
    expect((await post(url1,a)).status).toBe(200); expect(count()).toBe(6);
  } finally {one.proc.kill();two.proc.kill();await Promise.all([one.proc.exited,two.proc.exited]);db.close();rmSync(dir,{recursive:true,force:true});}
},15000);


test("killing after intent or completion leaves recoverable audit evidence",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mesh-crash-")),dbPath=join(dir,"db.sqlite");
  const one=start(dbPath), url1=await ready(one); let two:ReturnType<typeof start>|undefined, three:ReturnType<typeof start>|undefined;
  const db=new Database(dbPath), records=()=>db.query("SELECT payload FROM change_records ORDER BY sequence").all() as {payload:string}[];
  try {
    const pending=post(url1,a,"actor","after-intent").catch(()=>null); expect(await one.next()).toBe("intent");
    one.proc.kill("SIGKILL"); await one.proc.exited; await pending;
    expect(records()).toHaveLength(1); expect(JSON.parse(records()[0]!.payload).outcome).toBe("unknown");
    expect(db.query("SELECT * FROM native_mesh_agents_v1").all()).toHaveLength(0);
    two=start(dbPath);const url2=await ready(two);
    const pending2=post(url2,a,"actor","after-completion").catch(()=>null); expect(await two.next()).toBe("completion");
    two.proc.kill("SIGKILL");await two.proc.exited;await pending2;
    expect(records()).toHaveLength(3); expect(JSON.parse(records()[2]!.payload).outcome).toBe("success");
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    three=start(dbPath);const url3=await ready(three);
    expect((await post(url3,a)).status).toBe(200); expect(records()).toHaveLength(5);
    expect((await post(url3,a)).status).toBe(200); expect(records()).toHaveLength(5);
  } finally {one.proc.kill();two?.proc.kill();three?.proc.kill();await Promise.all([one.proc.exited,two?.proc.exited,three?.proc.exited]);db.close();rmSync(dir,{recursive:true,force:true});}
},15000);

test("deferred constraint failure at audit COMMIT rolls back completion and prevents a new binding",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mesh-commit-")),dbPath=join(dir,"db.sqlite");
  const server=start(dbPath),url=await ready(server); const db=new Database(dbPath);
  const count=()=> (db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n;
  try {
    expect((await post(url,a)).status).toBe(200); expect(count()).toBe(2);
    db.exec(`CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE fixture_child (id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fixture_commit_failure AFTER INSERT ON change_records
      WHEN json_extract(NEW.payload,'$.outcome')='success'
      BEGIN INSERT INTO fixture_child VALUES (123); END;`);
    expect((await post(url,b)).status).toBe(503); expect(count()).toBe(3);
    expect((db.query("SELECT name FROM native_mesh_agents_v1").get() as {name:string}).name).toBe("B");
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    expect(db.query("SELECT * FROM fixture_child").all()).toHaveLength(0);
    db.exec("DROP TRIGGER fixture_commit_failure");
    expect((await post(url,b)).status).toBe(200);expect(count()).toBe(5);
    db.exec(`CREATE TRIGGER fixture_binding_failure BEFORE INSERT ON native_mesh_audit_dedup_v2 BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    // Changing declaration invalidates existing binding. A failed optimization
    // after an audited success is harmless and cannot justify a future skip.
    expect((await post(url,a)).status).toBe(200);expect(count()).toBe(7);
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    expect((await post(url,a)).status).toBe(200);expect(count()).toBe(9);
  } finally {server.proc.kill();await server.proc.exited;db.close();rmSync(dir,{recursive:true,force:true});}
},15000);


test("a reader lock forces mesh COMMIT failure and the mutation rolls back",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mesh-mesh-commit-")),dbPath=join(dir,"db.sqlite");
  const server=start(dbPath),url=await ready(server); const db=new Database(dbPath);
  try {
    expect((await post(url,a)).status).toBe(200);
    const pending=post(url,b,"actor","commit-lock"); expect(await server.next()).toBe("intent");
    db.exec("BEGIN; SELECT * FROM native_mesh_agents_v1");
    server.proc.send("release"); expect(await server.next()).toBe("mesh-finished");
    db.exec("ROLLBACK"); server.proc.send("release");
    expect((await pending).status).toBe(500);
    expect((db.query("SELECT name FROM native_mesh_agents_v1").get() as {name:string}).name).toBe("A");
    const rows=db.query("SELECT payload FROM change_records ORDER BY sequence").all() as {payload:string}[];
    expect(rows).toHaveLength(4);expect(JSON.parse(rows[3]!.payload).outcome).toBe("unknown");
    // A rollback must preserve the old binding, not create one for B.
    expect((await post(url,b)).status).toBe(200);
    expect((db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n).toBe(6);
  } finally {try {db.exec("ROLLBACK");} catch {} server.proc.kill();await server.proc.exited;db.close();rmSync(dir,{recursive:true,force:true});}
},20000);


test("a failed fast-path COMMIT rolls back before audited fallback",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mesh-fast-commit-")),dbPath=join(dir,"db.sqlite");
  const server=start(dbPath),url=await ready(server);const db=new Database(dbPath);
  try {
    expect((await post(url,a)).status).toBe(200);
    const rev=()=> (db.query("SELECT revision FROM native_mesh_revision_v2").get() as {revision:number}).revision;
    const count=()=> (db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n;
    const before=rev(), pending=post(url,a,"actor","candidate-lock");
    expect(await server.next()).toBe("before-candidate");
    db.exec("BEGIN; SELECT * FROM native_mesh_agents_v1");
    server.proc.send("release");expect(await server.next()).toBe("after-candidate");
    expect(rev()).toBe(before);expect(count()).toBe(2);
    db.exec("ROLLBACK");server.proc.send("release");
    expect((await pending).status).toBe(200);expect(count()).toBe(4);expect(rev()).toBe(before+1);
  } finally {try {db.exec("ROLLBACK");} catch {} server.proc.kill();await server.proc.exited;db.close();rmSync(dir,{recursive:true,force:true});}
},20000);


test("external and old-writer declaration ABA invalidates bindings and stale completions",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mesh-external-")),dbPath=join(dir,"db.sqlite");
  const server=start(dbPath),url=await ready(server);const db=new Database(dbPath);
  const count=()=> (db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n;
  try {
    expect((await post(url,a)).status).toBe(200);expect(count()).toBe(2);
    db.query("UPDATE native_mesh_agents_v1 SET name=?").run("B");
    db.query("UPDATE native_mesh_agents_v1 SET name=?").run("A");
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    expect((await post(url,a)).status).toBe(200);expect(count()).toBe(4);
    const old=post(url,b,"other","after-write");expect(await server.next()).toBe("committed");
    db.query("UPDATE native_mesh_agents_v1 SET name=?").run("A");
    db.query("UPDATE native_mesh_agents_v1 SET name=?").run("B");
    server.proc.send("release");expect((await old).status).toBe(200);
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    const before=count();expect((await post(url,b,"other")).status).toBe(200);expect(count()).toBe(before+2);
  } finally {server.proc.kill();await server.proc.exited;db.close();rmSync(dir,{recursive:true,force:true});}
},15000);
