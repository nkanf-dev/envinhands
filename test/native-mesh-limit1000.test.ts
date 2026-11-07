import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeMeshApi, qualifiedAgentId } from "../src/integrations/native-mesh.ts";
const token = "synthetic-fixture";
const headers = { authorization: `Bearer ${token}` };
function get(api: ReturnType<typeof createNativeMeshApi>, query: string, auth = headers.authorization) {
  return api.fetch(new Request(`http://localhost/v1/native-mesh/agents${query}`, {headers:{authorization:auth}}));
}
type Row = {id:string};
type Page = {version:number; revision:string; nextCursor:string|null; agents:Row[]};
test("1000-page scans retain 5900 rows, 2MiB bounds, cursor stability, and legacy 100", async () => {
 const dir=mkdtempSync(join(tmpdir(),"mesh-limit1000-")), path=join(dir,"test.sqlite");
 const api=createNativeMeshApi({dbPath:path,token}), db=new Database(path);
 try {
  const add=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
  const expected=new Set<string>();
  db.transaction(()=>{for(let i=0;i<5900;i++){const a=String(i), id=qualifiedAgentId("fixture-host",a); expected.add(id); add.run(id,"fixture-host",a,null,"fixture-name","active","2025-01-01T00:00:00.000Z");}})();
  const oldRes=await get(api,"?limit=100"); expect(oldRes.status).toBe(200); const old=await oldRes.json() as {agents:Row[],version?:number}; expect(old.version).toBeUndefined(); expect(old.agents).toHaveLength(5900);
  let query="?limit=1000", revision:string|undefined, pages=0; const seen=new Set<string>();
  for (;;) {
   const res=await get(api,query); expect(res.status).toBe(200); const raw=await res.text(); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2*1024*1024);
   const page=JSON.parse(raw) as Page; expect(page.version).toBe(2); if(revision===undefined) revision=page.revision; else expect(page.revision).toBe(revision);
   expect(page.agents.length).toBeLessThanOrEqual(1000); for(const row of page.agents){expect(seen.has(row.id)).toBe(false);seen.add(row.id);} pages++;
   if(page.nextCursor===null) break;
   expect(page.nextCursor).toBe(page.agents.at(-1)?.id); query=`?${new URLSearchParams({limit:"1000",after:page.nextCursor,revision})}`;
  }
  expect(pages).toBe(6); expect(seen).toEqual(expected);
  for(const q of ["?limit=0","?limit=01","?limit=1001","?limit=1e3","?limit=1000.0","?limit=1000&limit=1"]) expect((await get(api,q)).status).toBe(400);
  for(const q of ["?limit=101","?limit=999"]) expect((await get(api,q)).status).toBe(200);
  expect((await get(api,"?limit=1000","Bearer invalid" )).status).toBe(401);
 } finally { db.close(); api.close(); rmSync(dir,{recursive:true,force:true}); }
});
test("1000-page snapshot tolerates heartbeat but rejects topology changes", async () => {
 const dir=mkdtempSync(join(tmpdir(),"mesh-limit1000-")), path=join(dir,"test.sqlite");
 const api=createNativeMeshApi({dbPath:path,token}), db=new Database(path);
 try {
  const add=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
  db.transaction(()=>{for(let i=0;i<1001;i++){const a=String(i); add.run(qualifiedAgentId("host",a),"host",a,null,"name","active","2025-01-01T00:00:00.000Z");}})();
  const first=await (await get(api,"?limit=1000")).json() as Page; expect(first.nextCursor).not.toBeNull();
  const continuation=`?${new URLSearchParams({limit:"1000",after:first.nextCursor!,revision:first.revision})}`;
  db.query("UPDATE native_mesh_agents_v1 SET last_heartbeat_at=? WHERE id=?").run("2025-01-01T00:00:01.000Z",qualifiedAgentId("host","0")); expect((await get(api,continuation)).status).toBe(200);
  db.query("UPDATE native_mesh_agents_v1 SET name=? WHERE id=?").run("changed",qualifiedAgentId("host","0")); expect((await get(api,continuation)).status).toBe(409);
 } finally { db.close(); api.close(); rmSync(dir,{recursive:true,force:true}); }
});
