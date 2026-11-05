import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { prepareLinuxRegistration } from "./linux.ts";

export type WindowsRegistrationRequest =
 | {action:"apply";operationId:string;user:string;publicKey:string;confirm:true;grantAdministrator?:boolean}
 | {action:"revoke";operationId:string;confirm:true;revokeAdministrator?:boolean};
export interface WindowsRegistrationOptions {
 powershellPath?: string;
 timeoutMs?: number;
 fixtureRoot?: string;
 /** Test-only OS identity/group primitives, never accepted without fixtureRoot. */
 fixtureIdentity?: {accountName:string;administrator:boolean};
}
export interface WindowsRegistrationResult {
 status:"applied"|"revoked"|"partial"|"failed";
 ready:false;
 fixture:boolean;
 receipt?:Record<string,unknown>;
 message:string;
}
/** Existing effective admin only; no UAC or privilege elevation. Payload uses stdin. */
export async function runWindowsRegistration(request:WindowsRegistrationRequest,options:WindowsRegistrationOptions={}):Promise<WindowsRegistrationResult>{
 const fixture=options.fixtureRoot!==undefined;
 let child:Bun.Subprocess<"pipe","pipe","pipe">|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(process.platform!=="win32"||!request||request.confirm!==true||!["apply","revoke"].includes(request.action)||
   !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(request.operationId)||/[\r\n]/.test(request.operationId))throw new Error();
  if(request.action==="revoke"&&request.revokeAdministrator!==undefined&&typeof request.revokeAdministrator!=="boolean")throw new Error();
  if(request.action==="apply"){
   if(typeof request.user!=="string"||!request.user.trim()||request.user.length>64||/[\x00-\x1f\x7f\\/:*?"<>|]/.test(request.user)||
    (request.grantAdministrator!==undefined&&typeof request.grantAdministrator!=="boolean"))throw new Error();
   // Reuse the strict public-key parser without imposing Unix account names on Windows.
   prepareLinuxRegistration({user:"agent",publicKey:request.publicKey});
  }
  const timeout=options.timeoutMs??20000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>2147483647||
   (fixture&&(!isAbsolute(options.fixtureRoot!)||!options.fixtureIdentity||typeof options.fixtureIdentity.administrator!=="boolean"))||
   (!fixture&&options.fixtureIdentity!==undefined))throw new Error();
  const payload=JSON.stringify({request,options:{fixtureRoot:options.fixtureRoot,fixtureIdentity:options.fixtureIdentity}});
  if(Buffer.byteLength(payload)>16384)throw new Error();
  child=Bun.spawn([options.powershellPath??"powershell.exe","-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("./windows-helper.ps1",import.meta.url))],
   {stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  child.stdin.write(payload);child.stdin.end();
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child?.kill();reject(new Error("timeout"));},timeout);});
  const [stdout,_stderr,code]=await Promise.race([Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),expired]);
  if(Buffer.byteLength(stdout)>65536)throw new Error();
  const result=JSON.parse(stdout) as WindowsRegistrationResult;
  if(!["applied","revoked","partial","failed"].includes(result.status)||result.ready!==false||result.fixture!==fixture||typeof result.message!=="string"||
   (["applied","revoked"].includes(result.status)&&code!==0))throw new Error();
  return result;
 }catch{return {status:child?"partial":"failed",ready:false,fixture,message:"Windows registration unavailable or outcome unknown; inspect the owned receipt before retry."};}
 finally{if(timer)clearTimeout(timer);if(child&&child.exitCode===null){child.kill();await child.exited;}}
}
