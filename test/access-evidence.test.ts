import { test } from "node:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createChangeApi } from "../src/change-api.ts";
import { createAccessEvidenceApi } from "../src/access-evidence-api.ts";
import { AccessEvidenceClient } from "../src/access-evidence-client.ts";
import { ChangeClient } from "../src/change-client.ts";
import { isClientAccessFresh, verifyClientAccess } from "../src/client-access.ts";
import { createChangeStore } from "../src/change-store.ts";
import { createAccessEvidenceStore } from "../src/access-evidence-store.ts";
import { Storage } from "../src/storage.ts";
import { parseAccessEvidence, type ClientAccessEvidence } from "../src/access-evidence-model.ts";

const registration = { registrationId: "registration-a", agentId: "agent-a", sessionId: "session-a", machineId: "client-a", signature: "Agent A" };
const evidence: ClientAccessEvidence = { registrationId: registration.registrationId, agentId: registration.agentId, sessionId: registration.sessionId, targetMachineId: "vm", routeId: "route-a",
  sshIdentityRef: "SHA256:" + "A".repeat(43), sshUser: "agent", hostKeyAlias: "trusted.host", os: "linux", checkedAt: "2026-11-05T20:00:00.000Z", expiresAt: "2026-11-05T20:00:00.100Z",
  ready: true, status: "ready", verificationScope: "actual-client-ssh-identity-and-route" };

test("ordinary HTTP persists per-registration/public-key observations across restart without marking the machine ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "access-evidence-api-")), dbPath = join(dir, "catalog.sqlite"), token = randomBytes(32).toString("hex");
  let changes = createChangeApi({ dbPath, token }), access = createAccessEvidenceApi({ dbPath, token });
  let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname === "/v1/access-evidence" ? access.fetch(req) : changes.fetch(req) });
  const storage = Storage.open(dbPath); storage.registerMachine({ id: "vm", name: "VM", host: "vm.local", os: "linux", sshUser: "agent" });
  try {
    const origin = () => `http://127.0.0.1:${server.port}`;
    let client = new AccessEvidenceClient({ baseUrl: origin(), token, fetch });
    await assert.rejects(client.submit("missing", evidence), error => (error as {status?:number}).status === 404);
    const registered = await new ChangeClient({ baseUrl: origin(), token, fetch }).register(registration);
    const first = await client.submit("request-a", evidence); assert.equal(first.duplicate, false); assert.deepEqual(first.record.registration, registered.registration);
    assert.equal((await client.submit("request-a", evidence)).duplicate, true);
    await assert.rejects(client.submit("request-a", { ...evidence, ready: false, status: "not-ready" }), error => (error as {status?:number}).status === 409);
    await assert.rejects(client.submit("wrong-session", { ...evidence, sessionId: "different" }), error => (error as {status?:number}).status === 409);
    await client.submit("replacement-key", { ...evidence, sshIdentityRef: "SHA256:" + "B".repeat(43), ready: false, status: "not-ready" });
    const page = await client.list({ registrationId: registration.registrationId, targetMachineId: "vm", limit: 1 }); assert.equal(page.records.length, 1); assert.equal(page.nextAfter, first.record.sequence);
    assert.equal((await client.list({ registrationId: "other-registration", targetMachineId: "vm" })).records.length, 0);
    const expected = { registrationId: evidence.registrationId, agentId: evidence.agentId, sessionId: evidence.sessionId, targetMachineId: evidence.targetMachineId, routeId: evidence.routeId,
      sshIdentityRef: evidence.sshIdentityRef, sshUser: evidence.sshUser, hostKeyAlias: evidence.hostKeyAlias };
    assert.equal(isClientAccessFresh(first.record.evidence, expected, Date.parse(evidence.expiresAt) - 1), true);
    assert.equal(isClientAccessFresh(first.record.evidence, expected, Date.parse(evidence.expiresAt)), false);
    const negative = await client.submit("same-key-negative", { ...evidence, ready: false, status: "not-ready" });
    const latest = await client.latest({ registrationId: evidence.registrationId, targetMachineId: "vm", routeId: evidence.routeId, sshIdentityRef: evidence.sshIdentityRef, sshUser: evidence.sshUser });
    assert.equal(latest!.sequence, negative.record.sequence); assert.equal(isClientAccessFresh(latest!.evidence, expected, Date.parse(evidence.checkedAt)), false);
    assert.equal(storage.getMachine("vm")!.status, "pending");
    await server.stop(true); changes.close(); access.close();
    changes = createChangeApi({ dbPath, token }); access = createAccessEvidenceApi({ dbPath, token });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname === "/v1/access-evidence" ? access.fetch(req) : changes.fetch(req) });
    client = new AccessEvidenceClient({ baseUrl: origin(), token, fetch });
    const restored = await client.list({ registrationId: registration.registrationId, targetMachineId: "vm", sshIdentityRef: evidence.sshIdentityRef }); assert.deepEqual(restored.records, [first.record, negative.record]);
    const denied = await fetch(origin() + "/v1/access-evidence?registrationId=registration-a&targetMachineId=vm"); assert.equal(denied.status, 401); await denied.body?.cancel();
    const malformed = await fetch(origin() + "/v1/access-evidence?registrationId=registration-a&targetMachineId=vm&after=01", { headers: {authorization:`Bearer ${token}`} }); assert.equal(malformed.status, 400); await malformed.body?.cancel();
    assert.throws(() => parseAccessEvidence({ ...evidence, expiresAt: "2026-11-05T20:10:00.000Z" }));
  } finally { await server.stop(true); changes.close(); access.close(); storage.close(); await rm(dir, { recursive: true, force: true }); }
});

// Characterization tests: these demonstrate current protocol gaps, not desired behavior.
test("KNOWN BUG: later completion of an older verification replaces newer negative", async () => {
  const dir = await mkdtemp(join(tmpdir(), "access-race-")), path = join(dir, "evidence.sqlite");
  const changes = createChangeStore(path); changes.register(registration); changes.close();
  const store = createAccessEvidenceStore(path);
  try {
    const options = { registration, targetMachineId: "vm", os: "linux" as const,
      routes: [{ id: "route-a", host: "localhost" }], access: { user: "agent", hostKeyAlias: "trusted.host", identityFile: "/tmp/unused-mocked-key" },
      priority: ["route-a"], totalBudgetMs: 10000, ttlMs: 10000 };
    const fingerprint = async () => evidence.sshIdentityRef;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let oldCalls = 0;
    const old = verifyClientAccess(options, { fingerprint, now: () => 1000, runner: async () => {
      if (++oldCalls === 1) { began(); await gate; } return { exitCode: 0 };
    } });
    await started;
    let calls = 0;
    const newer = await verifyClientAccess(options, { fingerprint, now: () => 2000, runner: async () => ({ exitCode: ++calls === 1 ? 0 : 1 }) });
    assert.equal(newer.ready, false);
    store.append({ requestId: "newer-failure", evidence: newer });
    release();
    const older = await old; assert.equal(older.ready, true);
    store.append({ requestId: "older-late", evidence: older });
    const latest = store.list({ registrationId: registration.registrationId, targetMachineId: "vm", routeId: "route-a", sshIdentityRef: evidence.sshIdentityRef, after: 0, limit: 10 }).records.at(-1)!;
    assert.equal(latest.evidence.ready, true); // reader currently picks append order, not verification order
    assert.ok(Date.parse(latest.evidence.checkedAt) < Date.parse(newer.checkedAt));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("KNOWN GAP: unknown identity cannot be represented as a negative observation", () => {
  assert.throws(() => parseAccessEvidence({ ...evidence, sshIdentityRef: null, ready: false, status: "not-ready" }));
  assert.throws(() => parseAccessEvidence({ ...evidence, routeId: null, ready: false, status: "not-ready" }));
  assert.throws(() => parseAccessEvidence({ ...evidence, sshIdentityRef: "unknown", ready: false, status: "not-ready" }));
});

test("KNOWN GAP: failed offline negative submission leaves persisted ready unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "access-offline-")), path = join(dir, "evidence.sqlite");
  const changes = createChangeStore(path); changes.register(registration); changes.close();
  const store = createAccessEvidenceStore(path);
  try {
    store.append({ requestId: "positive", evidence });
    const client = new AccessEvidenceClient({ baseUrl: "http://127.0.0.1:1234", token: "offline-test", fetch: async () => { throw new Error("offline"); } });
    await assert.rejects(client.submit("negative", { ...evidence, ready: false, status: "not-ready" }));
    const records = store.list({ registrationId: registration.registrationId, targetMachineId: "vm", routeId: evidence.routeId, sshIdentityRef: evidence.sshIdentityRef, after: 0, limit: 10 }).records;
    assert.equal(records.length, 1); assert.equal(records[0].evidence.ready, true);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

// V2 is opt-in. Legacy reads and writes are intentionally not readiness authorities.
test("generation checks serialize begin/commit across connections and survive restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "access-v2-")), path = join(dir, "state.sqlite");
  const changes = createChangeStore(path); changes.register(registration);
  changes.register({ ...registration, registrationId:"registration-b", agentId:"agent-b", sessionId:"session-b", machineId:"client-b" }); changes.close();
  let a = createAccessEvidenceStore(path), b = createAccessEvidenceStore(path);
  const scope = { registrationId: registration.registrationId, agentId: registration.agentId, sessionId: registration.sessionId, targetMachineId: "vm" };
  const other = { ...scope, targetMachineId: "other" };
  const begin = (store: typeof a, id: string, sc = scope) => store.begin({ action:"begin", beginId:id, scope:sc });
  const commit = (store: typeof a, generation: string, result: unknown, sc = scope) => store.commit({ action:"commit", generation, scope:sc, result });
  const fresh = (ready: boolean, begunAt?: string) => { const now=begunAt ? Date.parse(begunAt) : Date.now(); return { ...evidence, checkedAt:new Date(now).toISOString(), expiresAt:new Date(now+60000).toISOString(), ready, status:ready?"ready":"not-ready" }; };
  try {
    assert.equal(a.current(scope).status, "unknown");
    const first=begin(a,"first"), positive=fresh(true,first.begunAt); commit(b, first.generation, positive);
    assert.equal(a.current(scope).status, "ready");
    const unrelated=begin(b,"other",other); assert.equal(a.current(scope).status,"ready");
    const otherClient = { ...scope, registrationId:"registration-b", agentId:"agent-b", sessionId:"session-b" };
    const otherBegin=begin(a,"other-client",otherClient);
    assert.equal(a.current(otherClient).status,"unknown"); assert.equal(b.current(scope).status,"ready");
    commit(b,otherBegin.generation,{status:"unknown"},otherClient);
    const second=begin(b,"second"); assert.equal(a.current(scope).status,"unknown");
    assert.equal(begin(a,"first").generation, first.generation); // retry must not roll back the newer begin
    assert.throws(() => commit(a, first.generation, positive), /not pending/);
    const failure=fresh(false,second.begunAt); commit(a, second.generation, failure);
    assert.equal(b.current(scope).status,"not-ready");
    assert.throws(() => commit(a, second.generation, fresh(true)), /not pending/);
    commit(b, unrelated.generation, {status:"unknown"}, other);
    assert.equal(a.current(other).status,"unknown");
    assert.throws(() => begin(a,"first",other), /conflict/);
    assert.throws(() => begin(a,"bad",{...scope,sessionId:"wrong"}), /identity/);
    const third=begin(a,"third");
    assert.throws(() => commit(b,third.generation,{...fresh(true),targetMachineId:"other"}), /scope/);
    assert.equal(b.current(scope).status,"unknown");
    commit(a,third.generation,{status:"unknown"});
    assert.equal(a.current(scope).status,"unknown");
    a.close(); b.close(); a=createAccessEvidenceStore(path); b=createAccessEvidenceStore(path);
    assert.equal(a.current(scope).status,"unknown");
    assert.throws(() => commit(a,second.generation,fresh(true)), /not pending/);
    const fourth=begin(a,"fourth"); const expiring={...fresh(true,fourth.begunAt)}; expiring.expiresAt=new Date(Date.parse(expiring.checkedAt)+200).toISOString();
    commit(a,fourth.generation,expiring); assert.equal(b.current(scope).status,"ready");
    await Bun.sleep(220); assert.equal(b.current(scope).status,"unknown");
    const fifth=begin(a,"fifth");
    assert.throws(() => commit(a,fifth.generation,expiring), /time/);
  } finally { a.close(); b.close(); await rm(dir,{recursive:true,force:true}); }
});

test("generation Request API fails closed and keeps legacy API unchanged", async () => {
  const dir=await mkdtemp(join(tmpdir(),"access-v2-api-")), path=join(dir,"state.sqlite"), token="test-token";
  const changes=createChangeStore(path); changes.register(registration); changes.close();
  const api=createAccessEvidenceApi({dbPath:path,token});
  const scope={registrationId:registration.registrationId,agentId:registration.agentId,sessionId:registration.sessionId,targetMachineId:"vm"};
  const post=(value:unknown) => api.fetch(new Request("http://local/v1/access-evidence",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(value)}));
  const get=() => api.fetch(new Request(`http://local/v1/access-evidence?${new URLSearchParams({view:"current",...scope})}`,{headers:{authorization:`Bearer ${token}`}}));
  try {
    const initial=await get(); assert.equal(initial.headers.get("cache-control"),"no-store"); assert.equal(((await initial.json()) as {status:string}).status,"unknown");
    const r=await post({action:"begin",beginId:"http-begin",scope}); assert.equal(r.status,201); const {generation,begunAt}=await r.json() as {generation:string;begunAt:string};
    const now=Date.parse(begunAt), result={...evidence,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString()};
    assert.equal((await post({action:"commit",generation,scope,result})).status,200);
    assert.equal(((await (await get()).json()) as {status:string}).status,"ready");
    assert.equal((await post({action:"begin",beginId:"http-next",scope})).status,201);
    assert.equal(((await (await get()).json()) as {status:string}).status,"unknown");
    assert.equal((await post({action:"commit",generation,scope,result})).status,409);
    assert.equal((await post({action:"commit",generation,scope,result:{status:"unknown",sshIdentityRef:"unknown"}})).status,400);
    const competing=await Promise.all([post({action:"begin",beginId:"race-a",scope}),post({action:"begin",beginId:"race-b",scope})]);
    const gens=await Promise.all(competing.map(async r => (await r.json() as {generation:string}).generation));
    const state=await (await get()).json() as {generation:string;status:string};
    const stale=gens.find(g => g !== state.generation)!;
    assert.equal(state.status,"unknown");
    assert.equal((await post({action:"commit",generation:stale,scope,result})).status,409);
    assert.equal((await post({action:"commit",generation:state.generation,scope,result:{status:"unknown"}})).status,200);
    assert.equal((await api.fetch(new Request("http://local/v1/access-evidence?view=current"))).status,401);
    api.close(); assert.equal((await get()).status,503);
  } finally { api.close(); await rm(dir,{recursive:true,force:true}); }
});


test("v2 detects server wall clock rollback against monotonic elapsed and never resurrects expiry", async () => {
  const dir=await mkdtemp(join(tmpdir(),"access-clock-")), path=join(dir,"state.sqlite");
  const changes=createChangeStore(path);changes.register(registration);changes.close();
  let wall=Date.now(), monotonic=0;
  const store=createAccessEvidenceStore(path,{now:()=>wall,monotonic:()=>monotonic});
  const scope={registrationId:registration.registrationId,agentId:registration.agentId,sessionId:registration.sessionId,targetMachineId:"vm"};
  try {
    const begun=store.begin({action:"begin",beginId:"clock-one",scope});
    const observation={...evidence,checkedAt:begun.begunAt,expiresAt:new Date(Date.parse(begun.begunAt)+10000).toISOString()};
    store.commit({action:"commit",generation:begun.generation,scope,result:observation});
    assert.equal(store.current(scope).status,"ready");
    monotonic+=1000;wall+=500;
    assert.ok(Date.parse(store.current(scope).serverNow) - Date.parse(begun.begunAt) >= 1000); // slow wall slew cannot extend TTL
    monotonic+=3000;wall+=3000;assert.equal(store.current(scope).status,"ready");
    monotonic+=3000;wall-=1000;assert.equal(store.current(scope).status,"unknown");
    assert.equal(store.current(scope).status,"unknown"); // old epoch remains invalid after rebasing
    const fixed=store.begin({action:"begin",beginId:"after-clock-change",scope});
    const newObservation={...observation,checkedAt:fixed.begunAt,expiresAt:new Date(Date.parse(fixed.begunAt)+10000).toISOString()};
    store.commit({action:"commit",generation:fixed.generation,scope,result:newObservation});
    assert.equal(store.current(scope).status,"ready");
    wall+=20000;monotonic+=20000;assert.equal(store.current(scope).status,"unknown");
    wall-=12000;assert.equal(store.current(scope).status,"unknown"); // no resurrection after forward then rollback
    const recovered=store.begin({action:"begin",beginId:"backwards-recovered",scope});
    assert.ok(recovered.generation); // no NTP wait: a new check is permitted
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});


test("a new service process never resurrects pre-restart ready or commits an old pending check",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-clock-restart-")),path=join(dir,"db.sqlite");
 const changes=createChangeStore(path);changes.register(registration);changes.close();
 const scope={registrationId:registration.registrationId,agentId:registration.agentId,sessionId:registration.sessionId,targetMachineId:"vm"};
 const a=createAccessEvidenceStore(path,{epoch:"process-one"});
 try{
  const before=a.begin({action:"begin",beginId:"restart-1",scope});
  const observed={...evidence,checkedAt:before.begunAt,expiresAt:new Date(Date.parse(before.begunAt)+60000).toISOString()};
  a.commit({action:"commit",scope,generation:before.generation,result:observed});assert.equal(a.current(scope).status,"ready");
  const b=createAccessEvidenceStore(path,{epoch:"process-two"});
  try{
   assert.equal(b.current(scope).status,"unknown");
   assert.throws(()=>b.commit({action:"commit",scope,generation:before.generation,result:observed}),/server restarted/);
   const fresh=b.begin({action:"begin",beginId:"restart-2",scope});
   const renewed={...observed,checkedAt:fresh.begunAt,expiresAt:new Date(Date.parse(fresh.begunAt)+60000).toISOString()};
   b.commit({action:"commit",scope,generation:fresh.generation,result:renewed});assert.equal(b.current(scope).status,"ready");
  }finally{b.close();}
 }finally{a.close();await rm(dir,{recursive:true,force:true});}
});


test("old v2 SQLite schema upgrades in place before using clock epochs",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"access-clock-migration-")),path=join(dir,"db.sqlite");
 const changes=createChangeStore(path);changes.register(registration);changes.close();
 const db=new Database(path);db.exec("CREATE TABLE access_check_current(scope TEXT PRIMARY KEY,generation TEXT NOT NULL,begun_at TEXT NOT NULL,result TEXT)");db.close();
 const store=createAccessEvidenceStore(path);
 const scope={registrationId:registration.registrationId,agentId:registration.agentId,sessionId:registration.sessionId,targetMachineId:"vm"};
 try {
  const b=store.begin({action:"begin",beginId:"after-migration",scope});
  const e={...evidence,checkedAt:b.begunAt,expiresAt:new Date(Date.parse(b.begunAt)+60000).toISOString()};
  store.commit({action:"commit",scope,generation:b.generation,result:e});assert.equal(store.current(scope).status,"ready");
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});


test("Windows usernames follow directory syntax without relaxing Unix or allowing control characters",()=>{
 const win={...evidence,os:"windows",sshUser:"Jane Doe"};
 assert.equal(parseAccessEvidence(win).sshUser,"Jane Doe");
 for(const name of ["Jane Doe ","Jane Doe.","Jane\nDoe","Jane;command","-bad"," Jane"])assert.throws(()=>parseAccessEvidence({...win,sshUser:name}));
 assert.throws(()=>parseAccessEvidence({...win,os:"linux"}));
 assert.throws(()=>parseAccessEvidence({...win,os:"macos"}));
});
