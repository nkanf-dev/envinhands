import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createNativeMeshApi,qualifiedAgentId,familyReachable} from "../src/integrations/native-mesh.ts";
import {createAgentBus} from "../src/agent-bus.ts";
const installed=process.env.ENVINHANDS_TEAM_TRANSPORT;
(installed ? test : test.skip)("installed Team transport real HTTP, atomic legacy, concurrent new sessions and pending",async()=>{
 const {NativeMeshTransport}=await import(installed!);const dir=mkdtempSync(join(tmpdir(),"emergency-http-"));const path=join(dir,"db");const api=createNativeMeshApi({dbPath:path,token:"fixture"});const bus=createAgentBus({dbPath:path,token:"fixture"});const db=new Database(path);db.exec("PRAGMA journal_mode=WAL");const stmt=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");db.transaction(()=>{for(let i=0;i<1964;i++){const a=String(i);stmt.run(qualifiedAgentId("host",a),"host",a,null,"agent","active","2025-01-01T00:00:00.000Z")}})();let gets=0;const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){if(new URL(req.url).pathname==="/v1/native-mesh/agents"){if(req.method==="GET")gets++;return api.fetch(req)}return bus.fetch(req)}});let worker:ReturnType<typeof Bun.spawn>|undefined;
 try{const file=join(dir,"writer.ts");await Bun.write(file,`import {Database} from "bun:sqlite"; import {createHash} from "node:crypto"; const db=new Database(process.argv[2]);db.exec("PRAGMA busy_timeout=5000"); const s=db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");console.log("ready");for(let n=0;n<1000;n++){const a="writer-"+n;const id="nm1-"+createHash("sha256").update(JSON.stringify(["host",a])).digest("hex");s.run(id,"host",a,null,"agent","active","2025-01-01T00:00:00.000Z");}`);worker=Bun.spawn([process.execPath,file,path],{stdout:"pipe",stderr:"pipe"});const reader=(worker.stdout as ReadableStream<Uint8Array>).getReader();expect((await reader.read()).done).toBe(false);reader.releaseLock(); const clients=Array.from({length:8},()=>new NativeMeshTransport({url:`http://127.0.0.1:${server.port}`,token:"fixture",timeoutMs:10000}));const scans=await Promise.all(clients.map(c=>c.discover()));expect(gets).toBe(8);for(const rows of scans){expect(rows.length).toBeGreaterThanOrEqual(1964);const self=rows.find((r:any)=>r.agentId==="0");const sibling=rows.find((r:any)=>r.agentId==="1");expect(self).toBeTruthy();expect(sibling).toBeTruthy();expect(familyReachable(self,sibling)).toBe(true);const ids=new Set(rows.map((r:any)=>r.id));expect(ids.size).toBe(rows.length);for(let i=0;i<1964;i++)expect(ids.has(qualifiedAgentId("host",String(i)))).toBe(true);}const from=qualifiedAgentId("host","0"),to=qualifiedAgentId("host","1");await clients[0].store({from,to,callerMessageId:"fixture",text:"fixture"});const pending=await clients[1].pending(to);expect(pending).toHaveLength(1);expect(pending[0].to).toBe(to);await clients[1].acknowledge(pending[0].requestId);expect(await clients[1].pending(to)).toHaveLength(0);
 }finally{if(worker){worker.kill();await worker.exited}server.stop(true);db.close();bus.close();api.close();rmSync(dir,{recursive:true,force:true})}
},20000);

// Opt-in: the transport belongs to the separately installed Team project.
(installed ? test : test.skip)("installed Team transport retries a real v2 topology conflict over HTTP", async () => {
  const {NativeMeshTransport} = await import(installed!);
  const dir = mkdtempSync(join(tmpdir(), "team-v2-http-")), path = join(dir, "db");
  const api = createNativeMeshApi({dbPath:path, token:"fixture"});
  const bus = createAgentBus({dbPath:path, token:"fixture"});
  const db = new Database(path);
  const insert = db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i=0; i<8000; i++) {
      const agentId = `existing-${i}`;
      insert.run(qualifiedAgentId("host",agentId),"host",agentId,null,"n".repeat(128),"active","2025-01-01T00:00:00.000Z");
    }
  })();
  let starts=0, conflicts=0, pages=0, changed=false;
  const server = Bun.serve({hostname:"127.0.0.1", port:0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/native-mesh/agents") return bus.fetch(req);
    if (req.method === "GET") {
      if (!url.searchParams.has("after")) starts++;
      else if (!changed) {
        changed=true;
        insert.run(qualifiedAgentId("host","new"),"host","new",null,"new","active","2025-01-01T00:00:00.000Z");
      }
    }
    const response=await api.fetch(req);
    if (req.method === "GET") {
      if (response.status===409) conflicts++;
      if (response.status===200) {
        const page=await response.clone().json() as {version?:number;agents:unknown[]};
        expect(page.version).toBe(2);
        expect(page.agents.length).toBeLessThanOrEqual(100);
        pages++;
      }
    }
    return response;
  }});
  try {
    const team = new NativeMeshTransport({url:`http://127.0.0.1:${server.port}`,token:"fixture",timeoutMs:20000});
    const rows=await team.discover();
    expect(starts).toBe(2); expect(conflicts).toBe(1); expect(changed).toBe(true);
    expect(pages).toBe(82); expect(rows).toHaveLength(8001);
    expect(new Set(rows.map((row:{id:string})=>row.id)).size).toBe(8001);
    expect(rows.some((row:{id:string})=>row.id===qualifiedAgentId("host","new"))).toBe(true);
  } finally {server.stop(true);db.close();bus.close();api.close();rmSync(dir,{recursive:true,force:true});}
}, 30000);
