import {loadSharedHosts} from "./shared-hosts.ts";
import {SharedFilesClient} from "./shared-files-client.ts";
import {cliRegistration} from "./cli-registration.ts";
import {writeSharedOperation,inspectSharedOperation} from "./shared-write-operation.ts";
import type {ChangeCliIO} from "./change-cli.ts";
/** Portable resource work; compare-and-write prevents accidental blind overwrite. */
export async function runFilesCli(args:string[],env:NodeJS.ProcessEnv,io:ChangeCliIO):Promise<number>{
 try{
  if(args.length<1||args.length>2||!["hosts","resources","list","read","write","inspect"].includes(args[0]))throw new Error();
  let selectedEnv=env;
  if(args[0]==="hosts"){
   if(args.length!==1||!env.ENVINHANDS_SHARED_HOSTS)throw new Error();
   const hosts=await loadSharedHosts(env.ENVINHANDS_SHARED_HOSTS);io.write(JSON.stringify({untrusted:false,hosts:hosts.map(host=>({hostId:host.hostId}))})+"\n");return 0;
  }
  if(args[1]){
   if(!env.ENVINHANDS_SHARED_HOSTS)throw new Error();const hosts=await loadSharedHosts(env.ENVINHANDS_SHARED_HOSTS),selected=hosts.find(host=>host.hostId===args[1]);if(!selected)throw new Error();
   selectedEnv={...env,ENVINHANDS_URL:selected.url,ENVINHANDS_TOKEN:selected.token};
  }
  const baseUrl=selectedEnv.ENVINHANDS_URL,token=selectedEnv.ENVINHANDS_TOKEN;if(!baseUrl||!token)throw new Error();
  const url=new URL(baseUrl);if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))throw new Error();
  const host={hostId:args[1]??"configured-service",baseUrl,token,fetch:io.fetch};
  if(args[0]==="inspect"){const raw=await io.readInput();if(Buffer.byteLength(raw)>16384||raw.includes(token))throw new Error();const input=JSON.parse(raw);if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["operationId","after"].includes(key)))throw new Error();
   const receipt=await inspectSharedOperation(host,input.operationId,input.after??0);const output=JSON.stringify({untrusted:true,receipt});if(output.includes(token))throw new Error();io.write(output+"\n");return 0;}
  const raw=args[0]==="resources"?"{}":await io.readInput();if(Buffer.byteLength(raw)>68*1024||raw.includes(token))throw new Error();const value=JSON.parse(raw);
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!(args[0]==="resources"?[]:args[0]==="write"?["resourceId","path","text","expectedSha256"]:["resourceId","path"]).includes(k)))throw new Error();
  const client=new SharedFilesClient({baseUrl,token,fetch:io.fetch});
  const receipt=args[0]==="resources"?await client.listResources():args[0]==="list"?await client.list(value.resourceId,value.path??""):args[0]==="read"?await client.read(value.resourceId,value.path):await writeSharedOperation(host,cliRegistration(selectedEnv),value);
  const text=JSON.stringify({untrusted:true,receipt});if(text.includes(token))throw new Error();io.write(text+"\n");return "status" in receipt&&receipt.status!=="success"?1:0;
 }catch{io.error("Shared file request failed. A conflicting hash must be read and reconciled; uncertain writes must not be blindly repeated.\n");return 1;}
}
