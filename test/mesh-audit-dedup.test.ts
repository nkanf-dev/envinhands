import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentBusServer } from "../src/server.ts";
import { createNativeMeshApi, qualifiedAgentId } from "../src/integrations/native-mesh.ts";
import { createMutationAudit } from "../src/mutation-audit.ts";

test("only unchanged successful heartbeats by an audited actor are deduplicated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-audit-")), dbPath = join(dir, "db.sqlite"), token = "fixture-token";
  let server = startAgentBusServer({dbPath, token, hostname:"127.0.0.1", port:0, requireSignedMutations:true});
  const db = new Database(dbPath);
  const count = () => (db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n;
  const revision = () => (db.query("SELECT revision AS n FROM native_mesh_revision_v2").get() as {n:number}).n;
  const headers = (actor = "a") => ({authorization:`Bearer ${token}`, "content-type":"application/json",
    "x-envinhands-registration":Buffer.from(JSON.stringify({registrationId:`reg-${actor}`,agentId:`agent-${actor}`,sessionId:`session-${actor}`,machineId:"client",signature:"test"})).toString("base64url"),
    "x-envinhands-operation-id":"fixture-operation"});
  const post = (value:unknown, actor="a") => fetch(server.url + "/v1/native-mesh/agents", {method:"POST",headers:headers(actor),body:JSON.stringify(value)});
  const a={hostId:"host",agentId:"mesh",parentId:null as string | null,name:"private-name",state:"active"};
  try {
    expect((await post(a)).status).toBe(200); expect(count()).toBe(2);
    const before=revision();
    const responses=await Promise.all(Array.from({length:25},()=>post(a)));
    expect(responses.every(r=>r.status===200)).toBe(true);
    expect(count()).toBe(2); expect(revision()).toBe(before+25);
    expect((await responses[0]!.json() as {agent:{name:string}}).agent.name).toBe(a.name);
    expect((await post(a,"b")).status).toBe(200); expect(count()).toBe(4);
    expect((await post(a,"b")).status).toBe(200); expect(count()).toBe(4);
    const changes=[{...a,name:"different"},{...a,state:"inactive"},{...a,parentId:qualifiedAgentId("other","parent")},{...a,agentId:"other"},{...a,hostId:"other"}];
    for (const value of changes) { const n=count(); expect((await post(value,"b")).status).toBe(200); expect(count()).toBe(n+2); }
    const n=count(); expect((await post({...a,state:"bad"},"b")).status).toBe(400); expect(count()).toBe(n+2);
    const truncated=count();
    expect((await fetch(server.url+"/v1/native-mesh/agents",{method:"POST",headers:headers("b"),body:'{"hostId":'})).status).toBe(400);
    expect(count()).toBe(truncated+2);
    expect((await fetch(server.url+"/v1/native-mesh/agents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(a)})).status).toBe(401);
    expect(count()).toBe(truncated+2); // Existing pre-attribution rejection semantics.
    expect((await post(a,"b")).status).toBe(200);
    const audited=count(); expect((await post(a,"b")).status).toBe(200); expect(count()).toBe(audited);
    await server.stop(); server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0,requireSignedMutations:true});
    expect((await post(a,"b")).status).toBe(200); expect(count()).toBe(audited);
    const all = JSON.stringify(db.query("SELECT payload FROM change_records").all());
    expect(all).not.toContain(a.name); expect(all).not.toContain(token);
    // A database failure in the conditional update must fall back and be audited.
    db.exec("CREATE TRIGGER reject_heartbeat BEFORE UPDATE ON native_mesh_agents_v1 BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect((await post(a,"b")).status).toBe(500); expect(count()).toBe(audited+2);
  } finally { await server.stop(); db.close(); rmSync(dir,{recursive:true,force:true}); }
});


test("ABA and overlapping actors cannot restore an old audit binding", async () => {
  const dir=mkdtempSync(join(tmpdir(),"mesh-aba-")), dbPath=join(dir,"db.sqlite"), token="fixture-token";
  const mesh=createNativeMeshApi({dbPath,token}), audit=createMutationAudit({dbPath,token,machineId:"control",requireSignedMutations:true});
  const db=new Database(dbPath);
  const a={hostId:"host",agentId:"id",parentId:null,name:"A",state:"active"}, b={...a,name:"B"};
  const req=(value:unknown, actor:string) => new Request("http://localhost/v1/native-mesh/agents",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json",
    "x-envinhands-registration":Buffer.from(JSON.stringify({registrationId:actor,agentId:actor,sessionId:actor,machineId:"client",signature:"fixture"})).toString("base64url"),"x-envinhands-operation-id":"op"},body:JSON.stringify(value)});
  const send=(value:unknown,actor:string) => audit.dispatch(req(value,actor), r=>mesh.fetch(r),mesh);
  let release!:()=>void, reached!:()=>void;
  const wait=new Promise<void>(resolve=>release=resolve), entered=new Promise<void>(resolve=>reached=resolve);
  try {
    const old=audit.dispatch(req(a,"old"), async r=>{const result=await mesh.fetch(r); reached(); await wait; return result;},mesh);
    await entered;
    expect((await send(b,"middle")).status).toBe(200);
    expect((await send(a,"new")).status).toBe(200);
    const binding=JSON.stringify(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all());
    release(); expect((await old).status).toBe(200);
    expect(JSON.stringify(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all())).toBe(binding);
    const count=()=> (db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n;
    const before=count(); expect((await send(a,"old")).status).toBe(200); expect(count()).toBe(before+2);
    const now=count(); expect((await send(a,"old")).status).toBe(200); expect(count()).toBe(now);
    // A failed completion leaves the new declaration without a binding.
    db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON change_records WHEN json_extract(NEW.payload, '$.outcome') = 'success' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect((await send(b,"old")).status).toBe(503);
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    db.exec("DROP TRIGGER reject_completion");
    const missing=count(); expect((await send(b,"old")).status).toBe(200); expect(count()).toBe(missing+2);
    // No intent means a changed declaration is not dispatched at all.
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON change_records BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect((await send(a,"old")).status).toBe(503);
    expect((db.query("SELECT name FROM native_mesh_agents_v1").get() as {name:string}).name).toBe("B");
  } finally { release(); audit.close(); mesh.close(); db.close(); rmSync(dir,{recursive:true,force:true}); }
});


test("legacy unsigned callers are always audited", async () => {
  const dir=mkdtempSync(join(tmpdir(),"mesh-legacy-")), dbPath=join(dir,"db.sqlite"), token="fixture-token";
  const server=startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0});
  const db=new Database(dbPath);
  try {
    const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
    const body=JSON.stringify({hostId:"host",agentId:"agent",parentId:null,name:"name",state:"active"});
    for (let i=1;i<=3;i++) {
      expect((await fetch(server.url+"/v1/native-mesh/agents",{method:"POST",headers,body})).status).toBe(200);
      expect((db.query("SELECT count(*) AS n FROM change_records").get() as {n:number}).n).toBe(i*2);
    }
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
  } finally { await server.stop(); db.close(); rmSync(dir,{recursive:true,force:true}); }
});


test("migration discards only untrusted v2 optimization bindings once", async () => {
  const dir=mkdtempSync(join(tmpdir(),"mesh-migration-")),dbPath=join(dir,"db.sqlite");
  const db=new Database(dbPath);
  db.exec(`CREATE TABLE native_mesh_audit_dedup_v1 (id TEXT PRIMARY KEY, actor_hash TEXT NOT NULL, declaration_hash TEXT NOT NULL);
    INSERT INTO native_mesh_audit_dedup_v1 VALUES ('old','old','old');
    CREATE TABLE native_mesh_audit_dedup_v2 (id TEXT PRIMARY KEY, actor_hash TEXT NOT NULL, declaration_hash TEXT NOT NULL);
    INSERT INTO native_mesh_audit_dedup_v2 VALUES ('untrusted','old','old');`);
  let mesh=createNativeMeshApi({dbPath,token:"fixture"});
  try {
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(0);
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v1").all()).toHaveLength(1);
    db.exec("INSERT INTO native_mesh_audit_dedup_v2 VALUES ('trusted','x','y')");
    mesh.close();mesh=createNativeMeshApi({dbPath,token:"fixture"});
    expect(db.query("SELECT * FROM native_mesh_audit_dedup_v2").all()).toHaveLength(1);
  } finally {mesh.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
