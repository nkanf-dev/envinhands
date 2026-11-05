import {mkdtemp,writeFile,rm,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
/** External interpreters cannot open Bun's embedded virtual files. Own a short-lived private copy. */
export async function materializeRegistrationHelper(name:"unix-helper.py"|"windows-helper.ps1",source:string):Promise<{path:string;close():Promise<void>}>{
 const directory=await mkdtemp(join(tmpdir(),"env-registration-helper-"));
 try{
  if(process.platform!=="win32")await chmod(directory,0o700);
  const path=join(directory,name);await writeFile(path,source,{mode:0o600,flag:"wx"});
  return {path,close:()=>rm(directory,{recursive:true,force:true})};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
