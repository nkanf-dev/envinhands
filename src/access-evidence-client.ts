import { PrimeBridge, BridgeError } from "./prime-bridge.ts";
import { parseAccessEvidence, parseAccessEvidenceInput, parseAccessEvidenceQuery, type ClientAccessEvidence, type AccessEvidenceQuery } from "./access-evidence-model.ts";
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
export class AccessEvidenceClient extends PrimeBridge {
  /** Latest observation for one exact identity scope; never select any older ready row. */
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
