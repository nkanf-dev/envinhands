import { startRemoteAccess, type RemoteAccessOptions } from "./remote-access.ts";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SignalSource } from "./cli.ts";

/** Long-lived loopback access via a local connection-profile file, no secret arguments. */
export async function runRemoteAccessCli(args: string[], io: {write(text:string):void;error(text:string):void}, signals: SignalSource = process): Promise<number> {
  if (args.length!==1 || !isAbsolute(args[0])) {io.error("Use access with one absolute SSH connection-profile JSON path.\n");return 1;}
  let connection: Awaited<ReturnType<typeof startRemoteAccess>> | undefined;
  let stop!:()=>void;
  try {
    const options=JSON.parse(await readFile(args[0],"utf8")) as RemoteAccessOptions;
    connection=await startRemoteAccess(options);
    io.write(JSON.stringify({url:connection.url,encryptedSSH:true,backendVerified:false})+"\n");
    await new Promise<void>(resolve=>{stop=resolve;signals.on("SIGINT",stop);signals.on("SIGTERM",stop);});
    return 0;
  }catch{io.error("Remote access failed. Check the authorized SSH route and service; host-key checks were not relaxed.\n");return 1;}
  finally{if(stop){signals.removeListener("SIGINT",stop);signals.removeListener("SIGTERM",stop);}await connection?.close();}
}
