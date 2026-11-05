import helperSource from "./windows-file-replace.ps1" with {type:"text"};
import {materializeRegistrationHelper} from "./registration/helper-asset.ts";
import {isAbsolute,dirname,resolve} from "node:path";

/** Existing same-directory Windows target only. No rename fallback or ACL grants. */
export async function replaceWindowsFile(tempAbsolute:string,targetAbsolute:string):Promise<void>{
 const failure=()=>new Error("Windows file replacement failed or effects are unknown; inspect the target before retry.");
 let helper:Awaited<ReturnType<typeof materializeRegistrationHelper>>|undefined;
 let child:Bun.Subprocess<"pipe","pipe","pipe">|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(process.platform!=="win32"||![tempAbsolute,targetAbsolute].every(p=>typeof p==="string"&&isAbsolute(p)&&!/[\x00-\x1f\x7f]/.test(p))||
   resolve(tempAbsolute).toLowerCase()===resolve(targetAbsolute).toLowerCase()||dirname(resolve(tempAbsolute)).toLowerCase()!==dirname(resolve(targetAbsolute)).toLowerCase())throw failure();
  const input=JSON.stringify({temp:tempAbsolute,target:targetAbsolute});if(Buffer.byteLength(input)>16384)throw failure();
  helper=await materializeRegistrationHelper("windows-file-replace.ps1",helperSource);
  child=Bun.spawn(["powershell.exe","-NoProfile","-NonInteractive","-File",helper.path],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  child.stdin.write(input);child.stdin.end();
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child?.kill();reject(failure());},15000);});
  const [out,_err,code]=await Promise.race([Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),expired]);
  if(code!==0||Buffer.byteLength(out)>2048)throw failure();
  const receipt=JSON.parse(out) as {replaced?:unknown;beforeDescriptorSha256?:unknown;afterDescriptorSha256?:unknown};
  if(receipt.replaced!==true||typeof receipt.beforeDescriptorSha256!=="string"||!/^[a-f0-9]{64}$/.test(receipt.beforeDescriptorSha256)||receipt.afterDescriptorSha256!==receipt.beforeDescriptorSha256)throw failure();
 }catch{throw failure();}
 finally{if(timer)clearTimeout(timer);if(child&&child.exitCode===null){child.kill();await child.exited;}await helper?.close();}
}
