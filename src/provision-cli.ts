import {createHash} from "node:crypto";
import {runWindowsRegistration} from "./registration/windows.ts";
import {runUnixRegistration} from "./registration/apply.ts";
import {runAuditedOperation} from "./audited-operation.ts";
import {ChangeSpool} from "./change-spool.ts";
import {ChangeClient} from "./change-client.ts";
import {cliRegistration} from "./cli-registration.ts";
import {isAbsolute} from "node:path";
import type {ChangeCliIO} from "./change-cli.ts";
/** Explicit local owner-confirmed provisioning. Does not grant readiness by installation alone. */
export async function runProvisionCli(args:string[],env:NodeJS.ProcessEnv,io:ChangeCliIO):Promise<number>{
 try{
  if(args.length)throw new Error();
  const registration=cliRegistration(env),directory=env.ENVINHANDS_CHANGE_SPOOL;
  if(!directory||!isAbsolute(directory))throw new Error();
  const input=await io.readInput();if(Buffer.byteLength(input)>16384||(env.ENVINHANDS_TOKEN&&input.includes(env.ENVINHANDS_TOKEN)))throw new Error();
  const request=JSON.parse(input);
  if(!request||typeof request!=="object"||Array.isArray(request)||Object.keys(request).some(k=>!["action","operationId","user","publicKey","confirm","grantAdministrator","revokeAdministrator"].includes(k)))throw new Error();
  if (process.platform!=="win32" && (request.grantAdministrator!==undefined || request.revokeAdministrator!==undefined)) throw new Error();
  const auditOperationId="provision-"+createHash("sha256").update(JSON.stringify([request.action,request.operationId,request.revokeAdministrator===true])).digest("hex");
  const spool=new ChangeSpool(directory);let result:Awaited<ReturnType<typeof runUnixRegistration>>|undefined;
  const audit=await runAuditedOperation(registration,{registrationId:registration.registrationId,operationId:auditOperationId,
   targetMachineId:registration.machineId,resourceId:request.action==="apply"?`ssh-account:${request.user}`:`registration-operation:${request.operationId}`,
   action:"os-registration-"+request.action,summary:"Explicit owner-confirmed local public-key/administrator policy change",reason:"Owner requested shared account access",
   authority:"Explicit confirm plus existing administrator process; not authorization from remote messages",beforeSha256:null,afterSha256:null,evidenceRef:null},spool,async()=>{
    result=process.platform==="win32"?await runWindowsRegistration(request,{powershellPath:env.ENVINHANDS_POWERSHELL}):await runUnixRegistration(request,{pythonPath:env.ENVINHANDS_PYTHON,visudoPath:env.ENVINHANDS_VISUDO});
    return {outcome:result.status==="applied"||result.status==="revoked"?"success":result.status==="partial"?"partial":"failed",evidenceRef:"Owned receipt stored by local provisioning helper"};
   });
  let synced=false;if(env.ENVINHANDS_URL&&env.ENVINHANDS_TOKEN){const url=new URL(env.ENVINHANDS_URL);if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))throw new Error();try{synced=(await spool.flush(new ChangeClient({baseUrl:env.ENVINHANDS_URL,token:env.ENVINHANDS_TOKEN,fetch:io.fetch}))).pending===0;}catch{}}
  io.write(JSON.stringify({untrusted:true,result,audit,synced,ready:false})+"\n");
  return audit.outcome==="success"&&audit.locallyRecorded?0:1;
 }catch{io.error("Provisioning rejected or effects unknown. Explicit local owner confirmation, administrator context and registered durable spool are required; inspect existing operation before retry.\n");return 1;}
}
