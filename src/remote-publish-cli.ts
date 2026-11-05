import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { startRemotePublish, type RemotePublishOptions } from "./remote-publish.ts";
import type { SignalSource } from "./cli.ts";
/** A private profile contains SSH references, never service tokens or key contents. */
export async function runRemotePublishCli(args:string[], io:{write(text:string):void;error(text:string):void}, signals:SignalSource=process,
  dependencies:{start?:typeof startRemotePublish}={}):Promise<number> {
  if(args.length!==1 || !isAbsolute(args[0])) {io.error("Use publish with one absolute private SSH publication-profile JSON path.\n"); return 1;}
  const controller=new AbortController(); const stop=()=>controller.abort();
  signals.on("SIGINT",stop); signals.on("SIGTERM",stop);
  let connection:Awaited<ReturnType<typeof startRemotePublish>>|undefined;
  try {
    const file=await open(args[0],constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
    let options:RemotePublishOptions;
    try {
      const info=await file.stat();
      if(!info.isFile()||info.size>16384||(process.platform!=="win32"&&((info.mode&0o7777)!==0o600||info.uid!==process.getuid?.()))) throw new Error();
      const buffer=Buffer.alloc(16385);let count=0;
      while(count<buffer.length){const read=await file.read(buffer,count,buffer.length-count,null);if(!read.bytesRead)break;count+=read.bytesRead;}
      if(count>16384)throw new Error();
      options=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,count))) as RemotePublishOptions;
    } finally {await file.close();}
    connection=await (dependencies.start??startRemotePublish)(options,{signal:controller.signal});
    if(controller.signal.aborted)return 0;
    io.write(JSON.stringify({type:"ready",url:connection.url,remoteHost:connection.remoteHost,remotePort:connection.remotePort,encryptedSSH:true,backendVerified:false})+"\n");
    await connection.finished;
    return controller.signal.aborted?0:1;
  } catch {if(controller.signal.aborted)return 0;io.error("Remote publication failed. Check the authorized SSH route and port; host-key checks were not relaxed.\n");return 1;}
  finally {signals.removeListener("SIGINT",stop);signals.removeListener("SIGTERM",stop);await connection?.close();}
}
