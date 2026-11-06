/** Team-wide public identity directory. Possession of the bearer grants full write access.
 * Nothing here installs keys, grants admin, probes SSH, or implies readiness.
 * History is retained indefinitely. There is no heartbeat expiry. An explicit delete
 * creates a tombstone; clients must reconcile removals carefully with local ownership.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { bearerAuth, bodyBytes, HttpError, json, response } from "./http.ts";
import { parseRegistration, type AgentRegistrationInput } from "./change-model.ts";

export interface TeamIdentityInput {
  deviceId: string; os: "linux" | "macos" | "windows"; user: string;
  publicKey: string; hostKey: string;
}
export interface TeamIdentity extends TeamIdentityInput {
  publicKeyFingerprint: string; hostKeyFingerprint: string; revision: number;
}
export interface TeamIdentityPage { snapshot: number; records: TeamIdentity[]; nextAfter: string | null }
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const BAD = () => new HttpError(400, "Invalid identity request");
function id(v: unknown): string { if(typeof v !== "string" || !ID.test(v) || /[\r\n]/.test(v)) throw BAD(); return v; }
function fingerprint(v: unknown): string {
  if(typeof v !== "string" || v.length > 128) throw BAD();
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if(!m || m[0] !== v) throw BAD();
  const b=Buffer.from(m[1],"base64");
  if(b.toString("base64")!==m[1] || b.length!==51 || b.readUInt32BE(0)!==11 ||
    !b.subarray(4,15).equals(Buffer.from("ssh-ed25519")) || b.readUInt32BE(15)!==32) throw BAD();
  return `SHA256:${createHash("sha256").update(b).digest("base64").replace(/=+$/, "")}`;
}
function input(value: unknown): TeamIdentityInput {
  if(!value || typeof value!=="object" || Array.isArray(value)) throw BAD();
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="deviceId,hostKey,os,publicKey,user") throw BAD();
  const deviceId=id(v.deviceId);
  if(v.os!=="linux" && v.os!=="macos" && v.os!=="windows") throw BAD();
  if(typeof v.user!=="string" || /[\x00-\x1f\x7f]/.test(v.user) || (v.os==="linux" ? !/^[a-z_][a-z0-9_-]{0,31}$/.test(v.user) || v.user==="root" : v.os==="macos" ? !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(v.user) || v.user.toLowerCase()==="root" :
    !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/.test(v.user) || v.user.endsWith(" ") || v.user.endsWith("."))) throw BAD();
  fingerprint(v.publicKey); fingerprint(v.hostKey);
  return {deviceId,os:v.os,user:v.user,publicKey:v.publicKey as string,hostKey:v.hostKey as string};
}
function revision(v:unknown): number|null {if(v===null)return null;if(typeof v!=="number"||!Number.isSafeInteger(v)||v<1)throw BAD();return v;}
function integer(v: string | null, fallback: number, min: number, max: number): number {
  if(v===null) return fallback;
  if(!/^(0|[1-9][0-9]*)$/.test(v)) throw BAD();
  const n=Number(v); if(!Number.isSafeInteger(n)||n<min||n>max) throw BAD(); return n;
}
function query(url: URL, keys: string[]) {
  for(const k of url.searchParams.keys()) if(!keys.includes(k)||url.searchParams.getAll(k).length!==1) throw BAD();
}
export function createTeamIdentitiesApi(options: {dbPath:string; token:string}) {
  const auth=bearerAuth(options.token);
  if(!options.dbPath || options.dbPath===":memory:") throw new Error("Persistent database required");
  const db=new Database(options.dbPath,{create:true,strict:true});
  try { db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS team_identity_history (
      revision INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS team_identity_history_device ON team_identity_history(device_id,revision DESC);
    CREATE INDEX IF NOT EXISTS team_identity_history_device_nocase ON team_identity_history(device_id COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS team_identity_operations (
      operation_id TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL
    );`);
  } catch(e) { db.close(); throw e; }
  type Row={revision:number;device_id:string;payload:string|null};
  const record=(r:Row): TeamIdentity => {const v=input(JSON.parse(r.payload!));return {...v,publicKeyFingerprint:fingerprint(v.publicKey),hostKeyFingerprint:fingerprint(v.hostKey),revision:r.revision};};
  const current=(deviceId:string)=>db.query<Row,[string]>("SELECT * FROM team_identity_history WHERE device_id=? ORDER BY revision DESC LIMIT 1").get(deviceId);
  // IDs are ASCII. SQLite NOCASE therefore matches OpenSSH alias case folding.
  // Preserve existing historical spellings so legacy collisions can be diagnosed
  // and reduced by explicitly deleting all but one of their live records.
  const otherHistory=(deviceId:string)=>db.query<{device_id:string},[string,string]>("SELECT device_id FROM team_identity_history WHERE device_id = ? COLLATE NOCASE AND device_id != ? COLLATE BINARY LIMIT 1").get(deviceId,deviceId);
  const otherLive=(deviceId:string)=>db.query<{device_id:string},[string,string]>(`SELECT h.device_id FROM team_identity_history h
    WHERE h.device_id = ? COLLATE NOCASE AND h.device_id != ? COLLATE BINARY AND h.payload IS NOT NULL
    AND h.revision=(SELECT MAX(x.revision) FROM team_identity_history x WHERE x.device_id=h.device_id) LIMIT 1`).get(deviceId,deviceId);
  const caseConflict=(deviceId:string)=>current(deviceId)?!!otherLive(deviceId):!!otherHistory(deviceId);
  const put=db.transaction((v:TeamIdentityInput)=>{
    if(caseConflict(v.deviceId)) throw new HttpError(409,"Device ID case conflicts with existing history");
    const payload=JSON.stringify(v), old=current(v.deviceId);
    if(old?.payload===payload) return {record:record(old),duplicate:true};
    db.query("INSERT INTO team_identity_history(device_id,payload) VALUES(?,?)").run(v.deviceId,payload);
    return {record:record(current(v.deviceId)!),duplicate:false};
  });
  const remove=db.transaction((deviceId:string)=>{
    const old=current(deviceId);
    if(!old&&otherHistory(deviceId)) throw new HttpError(409,"Device ID case conflicts with existing history");
    if(!old||old.payload===null) return {deleted:false,revision:old?.revision??null};
    const r=db.query<{revision:number},[string]>("INSERT INTO team_identity_history(device_id,payload) VALUES(?,NULL) RETURNING revision").get(deviceId)!;
    return {deleted:true,revision:r.revision};
  });
  // An operation ID belongs to one normalized mutation forever. Journal and
  // mutation commit atomically, including no-op deletions and duplicate upserts.
  const mutate=db.transaction((operationId:string, action:"upsert"|"delete", value:TeamIdentityInput|string, expectedRevision:number|null)=>{
    const payload=JSON.stringify({action,value,expectedRevision});
    const hash=createHash("sha256").update(payload).digest("hex");
    const prior=db.query<{payload_hash:string;result:string},[string]>("SELECT payload_hash,result FROM team_identity_operations WHERE operation_id=?").get(operationId);
    if(prior) {
      if(prior.payload_hash!==hash) throw new HttpError(409,"Operation ID conflict");
      const saved=JSON.parse(prior.result);
      return saved && (saved.status===200 || saved.status===409) && Object.hasOwn(saved,"body") ? saved : {status:200,body:saved};
    }
    const deviceId=typeof value==="string"?value:value.deviceId;
    const existing=current(deviceId);
    const actual=existing?.revision??null;
    const result=actual!==expectedRevision
      ? {status:409,body:{error:"Identity revision conflict"}}
      : ((action==="upsert" && caseConflict(deviceId)) || (action==="delete" && !existing && !!otherHistory(deviceId)))
        ? {status:409,body:{error:"Device ID case conflicts with existing history"}}
        : {status:200,body:action==="upsert"?put(value as TeamIdentityInput):remove(value as string)};
    db.query("INSERT INTO team_identity_operations(operation_id,payload_hash,result) VALUES(?,?,?)").run(operationId,hash,JSON.stringify(result));
    return result;
  });
  // One SQL statement per page reads a stable historical watermark. Historical rows
  // are never pruned, so concurrent writes/deletes cannot change later pages.
  const page=(url:URL):TeamIdentityPage=>{
    query(url,["snapshot","after","limit"]);
    const sp=url.searchParams;
    if(sp.has("after")&&!sp.has("snapshot")) throw BAD();
    const max=db.query<{n:number},[]>("SELECT COALESCE(MAX(revision),0) AS n FROM team_identity_history").get()!.n;
    const snap=integer(sp.get("snapshot"),max,0,max),limit=integer(sp.get("limit"),100,1,200);
    const after=sp.has("after")?id(sp.get("after")):"";
    // A legacy database may contain colliding live names. Never return a page
    // that a caller could mistake for a safe host-key snapshot; GET by exact ID
    // and explicit deletion remain available for diagnosis and recovery.
    const collision=db.query<{device_id:string},[number]>(`SELECT h.device_id FROM team_identity_history h
      WHERE h.revision=(SELECT MAX(x.revision) FROM team_identity_history x WHERE x.device_id=h.device_id AND x.revision<=?)
      AND h.payload IS NOT NULL GROUP BY h.device_id COLLATE NOCASE HAVING COUNT(*)>1 LIMIT 1`).get(snap);
    if(collision) throw new HttpError(409,"Live device IDs conflict by case; inspect and delete conflicting exact IDs");
    const rows=db.query<Row,[number,string,number]>(`SELECT h.* FROM team_identity_history h
      WHERE h.revision=(SELECT MAX(x.revision) FROM team_identity_history x WHERE x.device_id=h.device_id AND x.revision<=?)
      AND h.device_id>? AND h.payload IS NOT NULL ORDER BY h.device_id COLLATE BINARY LIMIT ?`).all(snap,after,limit+1);
    const records=rows.slice(0,limit).map(record);
    return {snapshot:snap,records,nextAfter:rows.length>limit?records.at(-1)!.deviceId:null};
  };
  let closed=false;
  return {async fetch(req:Request):Promise<Response>{
    try {
      if(closed)return response(503,{error:"Directory closed"});
      if(!auth(req))return response(401,{error:"Unauthorized"},{"www-authenticate":"Bearer"});
      const url=new URL(req.url);if(url.pathname!=="/v1/team-identities") return response(404,{error:"Not found"});
      if(req.method==="GET") {
        if(url.searchParams.has("deviceId")) {
          query(url,["deviceId"]); const deviceId=id(url.searchParams.get("deviceId"));const row=current(deviceId);
          if(!row&&otherHistory(deviceId)) throw new HttpError(409,"Device ID case conflicts with existing history");
          return response(200,{record:row?.payload?record(row):null,revision:row?.revision??null});
        }
        return response(200,page(url));
      }
      if(req.method==="POST") {
        query(url,[]); const body=await json(req);
        const auditOperationId=req.headers.get("x-envinhands-operation-id");
        if(auditOperationId!==null && auditOperationId!==body.operationId) throw new HttpError(409,"Operation attribution mismatch");
        if(body.action==="upsert" && Object.keys(body).sort().join(",")==="action,expectedRevision,identity,operationId") {const r=mutate.immediate(id(body.operationId),"upsert",input(body.identity),revision(body.expectedRevision));return response(r.status,r.body);}
        if(body.action==="delete" && Object.keys(body).sort().join(",")==="action,deviceId,expectedRevision,operationId") {const r=mutate.immediate(id(body.operationId),"delete",id(body.deviceId),revision(body.expectedRevision));return response(r.status,r.body);}
        throw BAD();
      }
      if(req.method==="PUT") {query(url,[]);return response(200,put.immediate(input(await json(req))));}
      if(req.method==="DELETE") {query(url,["deviceId"]);return response(200,remove.immediate(id(url.searchParams.get("deviceId"))));}
      return response(405,{error:"Method not allowed"},{allow:"GET, POST, PUT, DELETE"});
    } catch(e) {return e instanceof HttpError?response(e.status,{error:e.message}):response(500,{error:"Internal error"});}
  },close(){if(!closed){closed=true;db.close();}}};
}

/**
 * Supply a unique, durably saved operationId before each POST. A lost response
 * can be retried only with the same ID and body; the journal returns the original
 * result and never reapplies it. A replayed result may no longer be current.
 * expectedRevision null means no prior history; a number must match the latest
 * revision, including a tombstone. A conflict is journaled and cannot apply later.
 * Legacy PUT/DELETE are not journaled: re-read before any controlled cleanup;
 * blindly retrying can overwrite a later mutation. Never infer installed access.
 * HTTPS is mandatory except for literal loopback, and redirects are disabled so
 * credentials cannot be forwarded to another origin.
 */
export function createTeamIdentitiesClient(options:{baseUrl:string;token:string;registration?:AgentRegistrationInput;fetch?:(input: URL, init?: RequestInit)=>Promise<Response>}) {
  bearerAuth(options.token);
  let declaration: string | undefined;
  if(options.registration!==undefined) {
    try {
      const registration=parseRegistration(options.registration);
      const encoded=JSON.stringify(registration);
      if(encoded.includes(options.token)) throw new Error();
      declaration=Buffer.from(encoded).toString("base64url");
    } catch {throw new Error("Invalid mutation registration");}
  }
  const base=new URL(options.baseUrl);
  if(base.username||base.password||base.search||base.hash||base.pathname!=="/"||
     (base.protocol!=="https:" && !(base.protocol==="http:" && ["127.0.0.1","[::1]","localhost"].includes(base.hostname)))) throw new Error("Use an HTTPS origin or loopback HTTP origin");
  const f=options.fetch??fetch;
  async function call(method:string,params?:URLSearchParams,body?:unknown,signal?:AbortSignal,operationId?:string):Promise<unknown>{
    const url=new URL("/v1/team-identities",base);if(params)url.search=params.toString();
    if(method!=="GET" && (!declaration||!operationId)) throw new Error("Mutation requires a registered agent and a persisted operation ID");
    let r:Response;
    try {r=await f(url,{method,redirect:"error",signal,headers:{authorization:`Bearer ${options.token}`,...(body?{"content-type":"application/json"}:{}),...(declaration&&operationId?{"x-envinhands-registration":declaration,"x-envinhands-operation-id":operationId}:{})},body:body?JSON.stringify(body):undefined});}
    catch {throw new Error(method==="GET"?"Directory request failed":"Directory mutation outcome unknown; retry only with the same persisted operation ID and body");}
    if(!r.ok) {
      if(method!=="GET"&&r.status===409)throw new Error("Directory mutation HTTP 409; inspect current revision and use a new persisted operation ID for any changed request");
      throw new Error(method==="GET"?`Directory HTTP ${r.status}`:`Directory mutation HTTP ${r.status}; retry only with the same persisted operation ID and body`);
    }
    try {const bytes=await bodyBytes(r, 256*1024);return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));} catch {throw new Error(method==="GET"?"Invalid directory response":"Invalid mutation response; outcome unknown; retry only with the same persisted operation ID and body");}
  }
  function validateRecord(r:TeamIdentity): TeamIdentity {
    if(!r||typeof r!=="object")throw new Error("Invalid directory response");
    const v=input({deviceId:r.deviceId,os:r.os,user:r.user,publicKey:r.publicKey,hostKey:r.hostKey});
    if(!Number.isSafeInteger(r.revision)||r.revision<1||r.publicKeyFingerprint!==fingerprint(v.publicKey)||r.hostKeyFingerprint!==fingerprint(v.hostKey))throw new Error("Invalid directory response");
    return r;
  }
  return {
    async getDevice(deviceId:string,options:{signal?:AbortSignal}={}):Promise<{record:TeamIdentity|null;revision:number|null}>{
      const device=id(deviceId);
      const v=await call("GET",new URLSearchParams({deviceId:device}),undefined,options.signal) as {record:TeamIdentity|null;revision:number|null};
      if(!v||typeof v!=="object"||!(v.revision===null||(typeof v.revision==="number"&&Number.isSafeInteger(v.revision)&&v.revision>=1)))throw new Error("Invalid directory response");
      if(v.record!==null) {const r=validateRecord(v.record);if(r.deviceId!==device||r.revision!==v.revision)throw new Error("Invalid directory response");}
      return v;
    },
    async upsert(v:TeamIdentityInput,operationId:string,expectedRevision:number|null,options:{signal?:AbortSignal}={}){const op=id(operationId);return await call("POST",undefined,{action:"upsert",identity:input(v),operationId:op,expectedRevision:revision(expectedRevision)},options.signal,op);},
    async delete(deviceId:string,operationId:string,expectedRevision:number|null,options:{signal?:AbortSignal}={}){const op=id(operationId);return await call("POST",undefined,{action:"delete",deviceId:id(deviceId),operationId:op,expectedRevision:revision(expectedRevision)},options.signal,op);},
    async listPage(options:{snapshot?:number;after?:string;limit?:number;signal?:AbortSignal}={}):Promise<TeamIdentityPage>{
      const q=new URLSearchParams(); if(options.snapshot!==undefined)q.set("snapshot",String(options.snapshot));if(options.after!==undefined)q.set("after",id(options.after));if(options.limit!==undefined)q.set("limit",String(options.limit));
      const p=await call("GET",q,undefined,options.signal) as TeamIdentityPage;
      if(!p||!Number.isSafeInteger(p.snapshot)||p.snapshot<0||!Array.isArray(p.records)||p.records.length>200||
         (options.snapshot!==undefined&&p.snapshot!==options.snapshot))throw new Error("Invalid directory response");
      let prev=options.after??"";
      for(const r of p.records){
        validateRecord(r);
        if(r.deviceId<=prev||r.revision>p.snapshot)throw new Error("Invalid directory response");prev=r.deviceId;
      }
      if(p.nextAfter!==null && (typeof p.nextAfter!=="string"||p.nextAfter!==prev||p.records.length===0))throw new Error("Invalid directory response");
      return p;
    }
  };
}
