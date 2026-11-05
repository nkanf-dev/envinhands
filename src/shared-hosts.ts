/** Operator-selected host clients. Remote content cannot add endpoints or credentials. */
import {open} from "node:fs/promises";
import {constants} from "node:fs";
import {isAbsolute} from "node:path";
import {SharedFilesClient} from "./shared-files-client.ts";
import {createSignedFetch} from "./signed-fetch.ts";
import type {AgentRegistrationInput} from "./change-model.ts";
import type {Fetcher} from "./prime-bridge.ts";
export interface SharedHost {hostId:string;url:string;token:string}
export async function loadSharedHosts(path:string):Promise<SharedHost[]>{
 if(!isAbsolute(path))throw new Error("Shared host configuration requires an absolute path");
 const file=await open(path,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));let bytes:Buffer;
 try{
  const info=await file.stat();if(!info.isFile()||info.size>16384||(process.platform!=="win32"&&((info.mode&0o7777)!==0o600||info.uid!==process.getuid?.())))throw new Error("Shared host configuration must be private");
  const buffer=Buffer.alloc(16385);let count=0;while(count<buffer.length){const part=await file.read(buffer,count,buffer.length-count,null);if(!part.bytesRead)break;count+=part.bytesRead;}if(count>16384)throw new Error("Shared host configuration too large");bytes=buffer.subarray(0,count);
 }finally{await file.close();}
 const value=JSON.parse(bytes.toString("utf8")) as {hosts?:unknown};
 if(!value||!Array.isArray(value.hosts)||value.hosts.length>20)throw new Error("Invalid shared host configuration");
 const result:SharedHost[]=[],ids=new Set<string>();
 for(const item of value.hosts){
  if(!item||typeof item!=="object"||Object.keys(item).length!==3||!["hostId","url","token"].every(k=>Object.hasOwn(item,k)))throw new Error("Invalid shared host entry");
  const host=item as SharedHost,url=new URL(host.url);
  if(!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(host.hostId)||ids.has(host.hostId)||url.username||url.password||url.pathname!=="/"||url.search||url.hash||
   (url.protocol!=="https:"&&!(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))||typeof host.token!=="string"||!/^[A-Za-z0-9._~+\/-]+=*$/.test(host.token))throw new Error("Invalid shared host endpoint");
  ids.add(host.hostId);result.push({hostId:host.hostId,url:url.origin,token:host.token});
 }
 return result;
}
export function sharedHostClient(host:SharedHost,fetcher:Fetcher,registration?:()=>AgentRegistrationInput):SharedFilesClient{
 return new SharedFilesClient({baseUrl:host.url,token:host.token,fetch:registration?createSignedFetch({baseUrl:host.url,registration,fetch:fetcher}):fetcher});
}
