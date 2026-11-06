import { PrimeBridge, BridgeError } from "./prime-bridge.ts";
import { randomUUID } from "node:crypto";
import { parseAccessEvidence, parseAccessEvidenceInput, parseAccessEvidenceQuery, parseAccessCheckScope, parseAccessCheckBegin, parseAccessCheckCommit, accessId, type AccessCheckScope, type ClientAccessEvidence, type AccessEvidenceQuery } from "./access-evidence-model.ts";
import { parseRegistration } from "./change-model.ts";
import type { AccessEvidencePage, AccessEvidenceRecord } from "./access-evidence-store.ts";
function record(value:unknown):AccessEvidenceRecord {
  const v=value as AccessEvidenceRecord|null;
  if(!v||!Number.isSafeInteger(v.sequence)||v.sequence<1||typeof v.recordedAt!=="string"||!Number.isFinite(Date.parse(v.recordedAt)))throw new BridgeError("Invalid access response");
  const input=parseAccessEvidenceInput({requestId:v.requestId,evidence:v.evidence});
  if(!v.registration||typeof v.registration.registeredAt!=="string")throw new BridgeError("Invalid access response");
  const {registeredAt,...identity}=v.registration;const registration=parseRegistration(identity);
  if(registration.registrationId!==input.evidence.registrationId||registration.agentId!==input.evidence.agentId||registration.sessionId!==input.evidence.sessionId)throw new BridgeError("Invalid access response");
  return {...input,sequence:v.sequence,recordedAt:v.recordedAt,registration:{...registration,registeredAt}};
}
export type AccessCheckResult = ClientAccessEvidence | {status: "unknown"};
/** This is a snapshot, not a cacheable lease. Re-read online before each use. */
export interface AccessCurrent { scope: AccessCheckScope; generation: string | null; status: "ready" | "not-ready" | "unknown"; evidence: ClientAccessEvidence | null; serverNow: string; remainingMs: number }
export type AccessExpectation = Pick<ClientAccessEvidence, "registrationId" | "agentId" | "sessionId" | "targetMachineId" | "routeId" | "sshIdentityRef" | "sshUser" | "hostKeyAlias"> & {os: ClientAccessEvidence["os"]};

export class AccessEvidenceClient extends PrimeBridge {
  /** The same begin ID is safe to retry, but does not start a new generation. */
  async begin(beginId: string, scope: AccessCheckScope): Promise<{generation:string;begunAt:string;duplicate:boolean}> {
    const v = parseAccessCheckBegin({action:"begin", beginId, scope});
    const r = await this.request("/v1/access-evidence", "POST", {action:"begin", ...v}, true, 16384) as Record<string, unknown>;
    try {
      if (!r || typeof r.duplicate !== "boolean" || typeof r.begunAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.begunAt) || !Number.isFinite(Date.parse(r.begunAt)) || new Date(r.begunAt).toISOString() !== r.begunAt) throw new Error();
      return {generation:accessId(r.generation), begunAt:r.begunAt, duplicate:r.duplicate};
    } catch { throw new BridgeError("Invalid access begin response"); }
  }
  /** Safe to retry exactly the same payload after a lost response. Never replay a superseded result. */
  async commit(scope: AccessCheckScope, generation: string, result: AccessCheckResult): Promise<void> {
    const v = parseAccessCheckCommit({action:"commit", scope, generation, result});
    const normalized = v.result ?? {status:"unknown"};
    const r = await this.request("/v1/access-evidence", "POST", {action:"commit", scope:v.scope, generation:v.generation, result:normalized}, true, 16384) as Record<string, unknown>;
    if (!r || r.generation !== v.generation || (r.duplicate !== undefined && typeof r.duplicate !== "boolean")) throw new BridgeError("Invalid access commit response");
  }
  /** Online-only current state. Shared bearer records are declarations, not identity proofs. */
  async current(scope: AccessCheckScope): Promise<AccessCurrent> {
    const sc = parseAccessCheckScope(scope);
    const nonce = randomUUID();
    const params = new URLSearchParams({view:"current", ...sc, nonce});
    const started = performance.now();
    let r: Record<string, unknown>;
    try { r = await this.request(`/v1/access-evidence?${params}`, "GET", undefined, true, 16384) as Record<string, unknown>; }
    catch (error) {
      if (error instanceof BridgeError && error.status === 400) throw new BridgeError("Access current requires nonce/serverNow support; upgrade the service", 400);
      throw error;
    }
    const elapsed = performance.now() - started;
    try {
      if (!r || r.nonce !== nonce || JSON.stringify(parseAccessCheckScope(r.scope)) !== JSON.stringify(sc) || !["ready","not-ready","unknown"].includes(String(r.status)) ||
          typeof r.serverNow !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.serverNow) || !Number.isFinite(Date.parse(r.serverNow)) || new Date(r.serverNow).toISOString() !== r.serverNow || !Number.isFinite(elapsed) || elapsed < 0) throw new Error();
      const serverNow = r.serverNow;
      const generation = r.generation === null ? null : accessId(r.generation);
      const unknown = (): AccessCurrent => ({scope:sc,generation,status:"unknown",evidence:null,serverNow,remainingMs:0});
      if (r.status === "unknown") { if (r.evidence !== null) throw new Error(); return unknown(); }
      const e = parseAccessEvidence(r.evidence);
      if (!generation || e.status !== r.status || e.registrationId !== sc.registrationId || e.agentId !== sc.agentId || e.sessionId !== sc.sessionId || e.targetMachineId !== sc.targetMachineId) throw new Error();
      const serverTime = Date.parse(serverNow);
      // Subtract the entire request duration: uncertainty can shorten, never extend, TTL.
      const remainingMs = Date.parse(e.expiresAt) - serverTime - elapsed;
      if (Date.parse(e.checkedAt) > serverTime || remainingMs <= 0) return unknown();
      return {scope:sc,generation,status:e.status,evidence:e,serverNow,remainingMs};
    } catch { throw new BridgeError("Invalid access current response; server may need a v2 clock upgrade"); }
  }
  /** Require an independently supplied expected key, route and host alias. */
  async currentReady(scope: AccessCheckScope, expected: AccessExpectation): Promise<boolean> {
    const state = await this.current(scope);
    const e = state.evidence;
    return state.status === "ready" && e !== null && e.os === expected.os &&
      Object.entries(expected).every(([key,value]) => e[key as keyof ClientAccessEvidence] === value);
  }

  /** @deprecated Legacy append order is not a readiness authority. Use currentReady(). */
  async latest(query: { registrationId:string; targetMachineId:string; routeId:string; sshIdentityRef:string; sshUser:string }): Promise<AccessEvidenceRecord | null> {
    let after=0, latest:AccessEvidenceRecord|null=null;
    while (true) {
      const {sshUser,...scope}=query;
      const page=await this.list({...scope,after,limit:100});
      for(const item of page.records)if(item.evidence.sshUser===sshUser)latest=item;
      if(page.nextAfter===null)return latest;
      after=page.nextAfter;
    }
  }
  /** @deprecated Legacy append-only history; use begin/commit for current readiness. */
  async submit(requestId:string,evidence:ClientAccessEvidence):Promise<{record:AccessEvidenceRecord;duplicate:boolean}> {
    const input=parseAccessEvidenceInput({requestId,evidence});const value=await this.request("/v1/access-evidence","POST",input,true,256*1024) as {record?:unknown;duplicate?:unknown};
    try{if(!value||typeof value.duplicate!=="boolean")throw new Error();const saved=record(value.record);
      if(saved.requestId!==input.requestId||JSON.stringify(saved.evidence)!==JSON.stringify(input.evidence))throw new Error();return {record:saved,duplicate:value.duplicate};}
    catch{throw new BridgeError("Invalid access response");}
  }
  async list(query:Omit<AccessEvidenceQuery,"after"|"limit">&{after?:number;limit?:number}):Promise<AccessEvidencePage>{
    const params=new URLSearchParams();for(const[key,value]of Object.entries({...query,after:query.after??0,limit:query.limit??10}))params.set(key,String(value));const q=parseAccessEvidenceQuery(params);
    const value=await this.request(`/v1/access-evidence?${params}`,"GET",undefined,true,256*1024) as AccessEvidencePage;
    try{if(!value||!Array.isArray(value.records)||value.records.length>q.limit)throw new Error();const records=value.records.map(record);let previous=q.after;
      for(const item of records){const e=parseAccessEvidence(item.evidence);if(item.sequence<=previous||e.registrationId!==q.registrationId||e.targetMachineId!==q.targetMachineId||q.routeId&&e.routeId!==q.routeId||q.sshIdentityRef&&e.sshIdentityRef!==q.sshIdentityRef)throw new Error();previous=item.sequence;}
      if(value.nextAfter!==null&&(records.length!==q.limit||value.nextAfter!==previous))throw new Error();return {records,nextAfter:value.nextAfter};}
    catch{throw new BridgeError("Invalid access response");}
  }
}
