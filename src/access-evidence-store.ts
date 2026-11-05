import { Database } from "bun:sqlite";
import { createChangeStore } from "./change-store.ts";
import { parseAccessEvidenceInput, parseAccessEvidenceQuery, type AccessEvidenceInput, type AccessEvidenceQuery } from "./access-evidence-model.ts";
import type { AgentRegistration } from "./change-model.ts";
export interface AccessEvidenceRecord extends AccessEvidenceInput { sequence: number; recordedAt: string; registration: AgentRegistration }
export interface AccessEvidencePage { records: AccessEvidenceRecord[]; nextAfter: number | null }
export class AccessEvidenceStoreError extends Error { constructor(readonly status: 404 | 409, message: string) { super(message); } }
/** Shares the existing immutable registration catalog, never updates machines. */
export function createAccessEvidenceStore(dbPath: string) {
  if (!dbPath || dbPath === ":memory:") throw new Error("Access evidence requires a persistent SQLite filename");
  const registrations = createChangeStore(dbPath); registrations.close();
  const db = new Database(dbPath, { create: true, strict: true });
  try { db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS access_evidence (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
      registration_id TEXT NOT NULL REFERENCES agent_registrations(registration_id),
      target_machine_id TEXT NOT NULL, route_id TEXT NOT NULL, public_key_fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL, recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS access_evidence_identity ON access_evidence(registration_id,target_machine_id,route_id,public_key_fingerprint,sequence);`); }
  catch(error) { db.close(); throw error; }
  type Row = { sequence:number;payload:string;recorded_at:string;registration_payload:string;registered_at:string };
  const select = `SELECT a.sequence,a.payload,a.recorded_at,r.payload AS registration_payload,r.registered_at FROM access_evidence a JOIN agent_registrations r ON r.registration_id=a.registration_id`;
  const toRecord = (row: Row): AccessEvidenceRecord => ({ ...JSON.parse(row.payload), sequence:row.sequence, recordedAt:row.recorded_at,
    registration:{...JSON.parse(row.registration_payload),registeredAt:row.registered_at} });
  const append = db.transaction((input: unknown) => {
    const value=parseAccessEvidenceInput(input),payload=JSON.stringify(value);
    const previous=db.query<Row,[string]>(select+" WHERE a.request_id=?").get(value.requestId);
    if(previous){if(previous.payload!==payload)throw new AccessEvidenceStoreError(409,"Access request ID conflict");return {record:toRecord(previous),duplicate:true};}
    const registration=db.query<{payload:string},[string]>("SELECT payload FROM agent_registrations WHERE registration_id=?").get(value.evidence.registrationId);
    if(!registration)throw new AccessEvidenceStoreError(404,"Registration not found");
    const registered=JSON.parse(registration.payload) as AgentRegistration;
    if(registered.agentId!==value.evidence.agentId||registered.sessionId!==value.evidence.sessionId)throw new AccessEvidenceStoreError(409,"Observation identity does not match registration");
    db.query("INSERT INTO access_evidence(request_id,registration_id,target_machine_id,route_id,public_key_fingerprint,payload,recorded_at) VALUES(?,?,?,?,?,?,?)")
      .run(value.requestId,value.evidence.registrationId,value.evidence.targetMachineId,value.evidence.routeId,value.evidence.sshIdentityRef,payload,new Date().toISOString());
    return {record:toRecord(db.query<Row,[string]>(select+" WHERE a.request_id=?").get(value.requestId)!),duplicate:false};
  });
  let closed=false;
  return { append,
    list(query:AccessEvidenceQuery):AccessEvidencePage {
      const params=new URLSearchParams();for(const [key,value]of Object.entries(query))params.set(key,String(value));const q=parseAccessEvidenceQuery(params);
      const clauses=["a.registration_id=?","a.target_machine_id=?","a.sequence>?"];const values:Array<string|number>=[q.registrationId,q.targetMachineId,q.after];
      if(q.routeId){clauses.push("a.route_id=?");values.push(q.routeId);}if(q.sshIdentityRef){clauses.push("a.public_key_fingerprint=?");values.push(q.sshIdentityRef);}
      values.push(q.limit+1);const rows=db.query<Row,Array<string|number>>(select+" WHERE "+clauses.join(" AND ")+" ORDER BY a.sequence LIMIT ?").all(...values);
      const records=rows.slice(0,q.limit).map(toRecord);return {records,nextAfter:rows.length>q.limit?records.at(-1)!.sequence:null};
    },
    close(){if(!closed){closed=true;db.close();}}
  };
}
