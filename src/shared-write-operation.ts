/** Caller-visible correlation only: no replay or new task storage. */
import { randomUUID } from "node:crypto";
import { SharedFilesClient } from "./shared-files-client.ts";
import { ChangeClient } from "./change-client.ts";
import { BridgeError, type Fetcher } from "./prime-bridge.ts";
import { createSignedFetch } from "./signed-fetch.ts";
import type { AgentRegistrationInput, ChangeRecord } from "./change-model.ts";
import type { SharedFileWrite, SharedFileWriteReceipt } from "./shared-files-model.ts";
export interface SharedOperationHost { hostId: string; baseUrl: string; token: string; fetch: Fetcher }
export type SharedWriteOperation = {hostId:string;operationId:string;status:"success"} & SharedFileWriteReceipt |
  {hostId:string;operationId:string;status:"conflict"|"unknown"};
function checkHost(host:SharedOperationHost):void {
  const url=new URL(host.baseUrl);if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))throw new Error("Shared operation requires encrypted or approved loopback access");
}
export async function writeSharedOperation(host:SharedOperationHost, registration:AgentRegistrationInput, input:SharedFileWrite):Promise<SharedWriteOperation> {
  checkHost(host);
  const operationId=randomUUID(), reference={hostId:host.hostId,operationId};
  const signed=createSignedFetch({baseUrl:host.baseUrl, registration:()=>registration, fetch:host.fetch, operationId:()=>operationId});
  try {
    const receipt=await new SharedFilesClient({...host,fetch:signed}).write(input);
    return {...reference,status:"success",...receipt};
  } catch(error) {return {...reference,status:error instanceof BridgeError && error.status===409?"conflict":"unknown"};}
}
/** Explicit pages let a caller continue large logs without scanning an unbounded history. */
export async function inspectSharedOperation(host:SharedOperationHost, operationId:string, after=0):Promise<{hostId:string;operationId:string;records:ChangeRecord[];nextAfter:number|null}> {
  if(!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(operationId)||/[\r\n]/.test(operationId)||!Number.isSafeInteger(after)||after<0)throw new Error("Invalid shared operation reference");
  checkHost(host);
  const client=new ChangeClient(host), records:ChangeRecord[]=[];
  let cursor=after;
  for(let page=0;page<10;page++) {
    const result=await client.listChanges(cursor,10);
    records.push(...result.records.filter(record=>record.operationId===operationId));
    if(result.nextAfter===null)return {hostId:host.hostId,operationId,records,nextAfter:null};
    cursor=result.nextAfter;
  }
  return {hostId:host.hostId,operationId,records,nextAfter:cursor};
}
