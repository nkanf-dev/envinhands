import {test, expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createNativeMeshApi, qualifiedAgentId} from "../src/integrations/native-mesh.ts";

// Opt in with the Prime candidate's absolute transport.ts path. This deliberately
// tests the actual cross-repository client against this candidate HTTP server.
const transportPath = process.env.ENVINHANDS_TEAM_TRANSPORT;
for (const maxLimit of [4000, 1000, 100]) {
  (transportPath ? test : test.skip)(`Prime Team transport + EnvInHands HTTP, max limit ${maxLimit}`, async () => {
    const {NativeMeshTransport} = await import(transportPath!);
    const dir = mkdtempSync(join(tmpdir(), "mesh-cross-repo-"));
    const dbPath = join(dir, "mesh.sqlite");
    const api = createNativeMeshApi({dbPath, token:"fixture"});
    const db = new Database(dbPath);
    const insert = db.query("INSERT INTO native_mesh_agents_v1 VALUES (?,?,?,?,?,?,?)");
    const expected = new Set<string>();
    db.transaction(() => { for (let i=0; i<6296; i++) {
      const agentId = String(i), id = qualifiedAgentId("host", agentId);
      expected.add(id);
      insert.run(id,"host",agentId,null,"Unicode 界 \\\" agent".repeat(6),"active","2025-01-01T00:00:00.000Z");
    }})();
    const requests: {limit:number; continuation:boolean; status:number}[] = [];
    const server = Bun.serve({hostname:"127.0.0.1", port:0, async fetch(req) {
      const params = new URL(req.url).searchParams;
      const limit = Number(params.get("limit"));
      if (limit > maxLimit) {
        requests.push({limit,continuation:params.has("after"),status:400});
        return Response.json({error:"Invalid pagination"},{status:400});
      }
      const res = await api.fetch(req);
      requests.push({limit,continuation:params.has("after"),status:res.status});
      return res;
    }});
    try {
      const client = new NativeMeshTransport({url:`http://127.0.0.1:${server.port}`,token:"fixture",timeoutMs:20000});
      const agents = await client.discover();
      expect(agents.length).toBe(expected.size);
      expect(new Set(agents.map((agent:{id:string}) => agent.id))).toEqual(expected);
      const limitSequence = maxLimit === 4000 ? [4000] : maxLimit === 1000 ? [4000,1000] : [4000,1000,100];
      expect(requests.filter(r=>!r.continuation).map(r=>r.limit)).toEqual(limitSequence);
      const pages = requests.filter(r=>r.status===200);
      expect(pages.length).toBe(Math.ceil(expected.size/maxLimit));
      expect(pages.every(r=>r.limit===maxLimit)).toBe(true);
      expect(pages.slice(1).every(r=>r.continuation)).toBe(true);
    } finally {server.stop(true); db.close(); api.close(); rmSync(dir,{recursive:true,force:true});}
  });
}
