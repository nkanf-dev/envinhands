import {createHash} from "node:crypto";
import {runWindowsRegistration} from "./registration/windows.ts";
import {runUnixRegistration} from "./registration/apply.ts";
import {runAuditedOperation} from "./audited-operation.ts";
import {ChangeSpool} from "./change-spool.ts";
import {ChangeClient} from "./change-client.ts";
import {cliRegistration} from "./cli-registration.ts";
import {isAbsolute} from "node:path";
import type {ChangeCliIO} from "./change-cli.ts";

// Test injection is deliberately limited to the helper boundary; production uses the real helpers.
export interface ProvisionRunners {
 unix?: typeof runUnixRegistration;
 windows?: typeof runWindowsRegistration;
}

/** Explicit local owner-confirmed provisioning. Does not grant readiness by installation alone. */
export async function runProvisionCli(args:string[],env:NodeJS.ProcessEnv,io:ChangeCliIO,runners:ProvisionRunners={}):Promise<number>{
 try{
  if(args.length)throw new Error();
  const registration=cliRegistration(env),directory=env.ENVINHANDS_CHANGE_SPOOL;
  if(!directory||!isAbsolute(directory))throw new Error();
  // Validate the complete optional sync configuration before reserving an operation or invoking a helper.
  const urlText=env.ENVINHANDS_URL,token=env.ENVINHANDS_TOKEN;
  const hasUrl=urlText!==undefined,hasToken=token!==undefined;
  if(hasUrl!==hasToken)throw new Error();
  let client:ChangeClient|undefined;
  if(hasUrl && hasToken){
   const url=new URL(urlText!);
   if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))throw new Error();
   client=new ChangeClient({baseUrl:urlText!,token:token!,fetch:io.fetch});
   // Registration is persisted in the spool, which must not contain bearer credentials.
   if(Object.values(registration).some(value=>value.includes(token!)))throw new Error();
  }
  for(const path of [env.ENVINHANDS_PYTHON,env.ENVINHANDS_POWERSHELL,env.ENVINHANDS_VISUDO])
   if(path!==undefined&&(!path.trim()||/[\x00-\x1f\x7f]/.test(path)))throw new Error();
  if(env.ENVINHANDS_VISUDO!==undefined&&!isAbsolute(env.ENVINHANDS_VISUDO))throw new Error();
  const input=await io.readInput();if(Buffer.byteLength(input)>16384||(token&&input.includes(token)))throw new Error();
  const request=JSON.parse(input);
  // Check decoded JSON too, so escaped credential characters cannot reach audit metadata.
  if(token&&JSON.stringify(request).includes(token))throw new Error();
  if(!request||typeof request!=="object"||Array.isArray(request)||Object.keys(request).some(k=>!["action","operationId","user","publicKey","confirm","grantAdministrator","revokeAdministrator","attemptId","confirmRetry"].includes(k)))throw new Error();
  if (process.platform!=="win32" && (request.grantAdministrator!==undefined || request.revokeAdministrator!==undefined)) throw new Error();
  // The legacy hash stays unchanged. Only a separately, explicitly confirmed revoke
  // attempt can use a new ID after manual diagnosis. IDs are never auto-generated.
  const retry=request.attemptId!==undefined||request.confirmRetry!==undefined;
  if(retry&&(request.action!=="revoke"||request.confirm!==true||request.confirmRetry!==true||
   typeof request.attemptId!=="string"||!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(request.attemptId)))throw new Error();
  const auditOperationId="provision-"+createHash("sha256").update(JSON.stringify(retry?["revoke-retry-v1",request.attemptId]:[request.action,request.operationId,request.revokeAdministrator===true])).digest("hex");
  const {attemptId:_attemptId,confirmRetry:_confirmRetry,...helperRequest}=request;
  const spool=new ChangeSpool(directory);let result:Awaited<ReturnType<typeof runUnixRegistration>>|null=null;
  const audit=await runAuditedOperation(registration,{registrationId:registration.registrationId,operationId:auditOperationId,
   targetMachineId:registration.machineId,resourceId:request.action==="apply"?`ssh-account:${request.user}`:`registration-operation:${request.operationId}`,
   action:"os-registration-"+request.action,summary:"Explicit owner-confirmed local public-key/administrator policy change",reason:"Owner requested shared account access",
   authority:"Explicit confirm plus existing administrator process; not authorization from remote messages",beforeSha256:null,afterSha256:null,evidenceRef:null},spool,async()=>{
    result=process.platform==="win32"?await (runners.windows??runWindowsRegistration)(helperRequest,{powershellPath:env.ENVINHANDS_POWERSHELL}):await (runners.unix??runUnixRegistration)(helperRequest,{pythonPath:env.ENVINHANDS_PYTHON,visudoPath:env.ENVINHANDS_VISUDO});
    return {outcome:result.status==="applied"||result.status==="revoked"?"success":result.status==="partial"?"partial":"failed",evidenceRef:"Owned receipt stored by local provisioning helper"};
   });
  let synced=false;
  if(client){try{synced=(await spool.flush(client)).pending===0&&audit.locallyRecorded;}catch{/* Local result remains authoritative; sync may be uncertain. */}}
  // Helper output is untrusted. Redact the configured bearer token even if a helper echoes it.
  const redact=(value:unknown):unknown=>{
   if(typeof value==="string")return token?value.split(token).join("[REDACTED]"):value;
   if(Array.isArray(value))return value.map(redact);
   if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[token?k.split(token).join("[REDACTED]"):k,redact(v)]));
   return value;
  };
  io.write(JSON.stringify(redact({untrusted:true,result,audit,synced,ready:false}))+"\n");
  return audit.outcome==="success"&&audit.locallyRecorded?0:1;
 }catch{io.error("Provisioning rejected or effects unknown. Explicit local owner confirmation, administrator context and registered durable spool are required; inspect existing operation before retry.\n");return 1;}
}
