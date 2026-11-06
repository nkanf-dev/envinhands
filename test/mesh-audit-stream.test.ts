import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutationAudit } from "../src/mutation-audit.ts";
import { createNativeMeshApi } from "../src/integrations/native-mesh.ts";

const token = "stream-fixture-token";
const path = "http://localhost/v1/native-mesh/agents";
const declaration = {hostId:"host", agentId:"mesh", parentId:null, name:"stream-private-name", state:"active"};
const bytes = new TextEncoder().encode(JSON.stringify(declaration));
const headers = (actor: string, extra: Record<string,string> = {}) => ({
  authorization: `Bearer ${token}`, "content-type":"application/json",
  "x-envinhands-registration": Buffer.from(JSON.stringify({registrationId:actor, agentId:actor, sessionId:actor, machineId:"client", signature:"test"})).toString("base64url"),
  "x-envinhands-operation-id":"stream-operation", ...extra,
});
function stream(parts: Uint8Array[], fail = false): ReadableStream<Uint8Array> {
  return new ReadableStream({start(controller) {
    for (const part of parts) controller.enqueue(part);
    if (fail) controller.error(new Error("fixture stream aborted"));
    else controller.close();
  }});
}
function request(body: ReadableStream<Uint8Array>, actor = "actor-a", extra: Record<string,string> = {}) {
  return new Request(path, {method:"POST", headers:headers(actor, extra), body});
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mesh-stream-")), dbPath = join(dir, "db.sqlite");
  const mesh = createNativeMeshApi({dbPath, token});
  const audit = createMutationAudit({dbPath, token, machineId:"control", requireSignedMutations:true});
  const db = new Database(dbPath);
  const send = (req: Request) => audit.dispatch(req, r => mesh.fetch(r), mesh);
  const records = () => db.query("SELECT payload FROM change_records ORDER BY rowid").all().map(row => JSON.parse((row as {payload:string}).payload) as {outcome:string; evidenceRef:string|null});
  const revision = () => (db.query("SELECT revision AS n FROM native_mesh_revision_v2").get() as {n:number}).n;
  return {mesh, audit, db, send, records, revision, close() {audit.close(); mesh.close(); db.close(); rmSync(dir, {recursive:true, force:true});}};
}

test("streamed heartbeat byte limit accepts exactly 16 KiB and rejects one extra byte", async () => {
  const f = fixture();
  try {
    const exact = new Uint8Array(16 * 1024); exact.fill(32); exact.set(bytes);
    expect((await f.send(request(stream([exact.subarray(0, 11), exact.subarray(11, 8000), exact.subarray(8000)])))).status).toBe(200);
    expect(f.records().map(r => r.outcome)).toEqual(["unknown", "success"]);
    const rev = f.revision();
    expect((await f.send(request(stream([exact, new Uint8Array([32])]), "actor-b"))).status).toBe(413);
    expect(f.revision()).toBe(rev);
    expect(f.records().map(r => r.outcome)).toEqual(["unknown", "success", "unknown", "failed"]);
    // An invalid request by another actor must not create an audit binding.
    expect((await f.send(request(stream([bytes]), "actor-b"))).status).toBe(200);
    expect(f.records()).toHaveLength(6);
    expect((await f.send(request(stream([bytes]), "actor-b"))).status).toBe(200);
    expect(f.records()).toHaveLength(6);
    expect(JSON.stringify(f.records())).not.toContain(declaration.name);
    expect(JSON.stringify(f.records())).not.toContain(token);
  } finally { f.close(); }
});

test("malformed, truncated, and aborted heartbeat streams are audited failures, never deduplicated", async () => {
  const f = fixture();
  try {
    expect((await f.send(request(stream([bytes])))).status).toBe(200);
    const initialRevision = f.revision();
    const cases: Array<{body: () => ReadableStream<Uint8Array>; headers?: Record<string,string>; status:number; outcome:string}> = [
      {body:() => stream([bytes.subarray(0, bytes.length - 1)]), status:400, outcome:"failed"},
      {body:() => stream([new Uint8Array([0xff])]), status:400, outcome:"failed"},
      {body:() => stream([bytes]), headers:{"content-length":"invalid"}, status:400, outcome:"failed"},
      {body:() => stream([bytes]), headers:{"content-length":"16385"}, status:413, outcome:"failed"},
      {body:() => stream([bytes.subarray(0, 10)], true), status:500, outcome:"unknown"},
    ];
    for (const item of cases) {
      const before = f.records().length;
      expect((await f.send(request(item.body(), "actor-b", item.headers))).status).toBe(item.status);
      const added = f.records().slice(before);
      expect(added.map(r => r.outcome)).toEqual(["unknown", item.outcome]);
      expect(f.revision()).toBe(initialRevision);
    }
    const before = f.records().length;
    expect((await f.send(request(stream([bytes]), "actor-b"))).status).toBe(200);
    expect(f.records()).toHaveLength(before + 2);
    expect((await f.send(request(stream([bytes]), "actor-b"))).status).toBe(200);
    expect(f.records()).toHaveLength(before + 2);
  } finally { f.close(); }
});
