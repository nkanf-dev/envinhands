// Test-only isolated subprocess. IPC gates an audited handler after its DB commit.
import { createNativeMeshApi } from "../../src/integrations/native-mesh.ts";
import { createMutationAudit } from "../../src/mutation-audit.ts";
const [dbPath, machineId] = process.argv.slice(2) as [string,string];
const token = "fixture-token";
const mesh = createNativeMeshApi({dbPath,token});
const audit = createMutationAudit({dbPath,token,machineId,requireSignedMutations:true});
let release: (() => void) | undefined;
process.on("message", message => { if (message === "release") { release?.(); release=undefined; } });
async function gate(label: string) {
  await new Promise<void>(resolve=>{release=resolve; process.send?.(label);});
}
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>audit.dispatch(req,async r=>{
  if (["after-intent", "commit-lock"].includes(r.headers.get("x-fixture-gate") ?? "")) await gate("intent");
  const result=await mesh.fetch(r);
  if (r.headers.get("x-fixture-gate") === "commit-lock") await gate("mesh-finished");
  if (r.headers.get("x-fixture-gate") === "after-write") await gate("committed");
  return result;
},{
  async tryAuditedHeartbeat(r,actor) {
    if (r.headers.get("x-fixture-gate") === "candidate-lock") {
      await gate("before-candidate");
      const result = await mesh.tryAuditedHeartbeat(r,actor);
      await gate("after-candidate");
      return result;
    }
    return mesh.tryAuditedHeartbeat(r,actor);
  },
  async rememberAuditedHeartbeat(r,actor) {
    if (r.headers.get("x-fixture-gate") === "after-completion") await gate("completion");
    await mesh.rememberAuditedHeartbeat(r,actor);
  }
})});
process.send?.({ready:server.url.toString()});
