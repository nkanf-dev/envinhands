import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createMachineApi } from "../src/machine-api.ts";
import { createResourceProfileApi } from "../src/resource-profile.ts";
import { CollaborationClient } from "../src/collaboration-client.ts";

const headers = {authorization: "Bearer token", "content-type": "application/json"};
describe("resource profiles (isolated temporary SQLite + real HTTP)", () => {
  test("old clients, new annotations, replies, paging, restart and errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resource-profile-")), path = join(dir, "db.sqlite");
    // Simulate an existing pre-profile database, not a production host or NAS.
    const legacy = new Database(path); legacy.exec(`CREATE TABLE resource_messages (id TEXT PRIMARY KEY NOT NULL, resourceId TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL); INSERT INTO resource_messages VALUES ('old-note','nas1','old-agent','disk 100% old','2020-01-01T00:00:00.000Z');`); legacy.close();
    let profile = createResourceProfileApi({dbPath: path, token: "token"});
    const machine = createMachineApi({dbPath: path, token: "token"});
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname.includes("/profile-notes") ? profile.fetch(req) : machine.fetch(req)});
    const base = `http://127.0.0.1:${server.port}`;
    const url = base + "/v1/resources/nas1/profile-notes";
    const call = (path: string, method = "GET", body?: unknown, h: Record<string,string> = headers) => fetch(path, {method, headers: h, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    try {
      const client = new CollaborationClient({baseUrl: base, token: "token", fetch});
      const old = await client.readNotes("nas1"); expect(old).toHaveLength(1);
      const legacyNew = await client.addNote("nas1", "legacy-agent", "old client wrote this");
      let r = await call(url); let data: any = await r.json();
      expect(data.notes.map((x: any) => x.category)).toEqual([null, null]);
      expect(data.notes[0].verification).toBe("not-declared");
      const note = {author:"agent-a", text:"Disk replaced 100%", category:"change", topic:"disk", replyTo:"old-note", expiresAt:"2020-02-01T00:00:00.000Z", verifiedAt:"2020-01-02T00:00:00.000Z"};
      r = await call(url,"POST",note); expect(r.status).toBe(201); const made = ((await r.json()) as any).note;
      expect(made).toMatchObject({resourceId:"nas1", author:"agent-a", annotatedBy:"agent-a", replyTo:"old-note", expiry:"expired", verification:"declared"});
      expect((await client.readNotes("nas1")).map(x => x.id)).toContain(made.id);
      r = await call(url + "/old-note", "PUT", {category:"experience", topic:"disk", annotatedBy:"agent-b"});
      expect(r.status).toBe(201); expect(((await r.json()) as any).note).toMatchObject({author:"old-agent", annotatedBy:"agent-b", category:"experience"});
      expect((await call(url + "/old-note", "PUT", {category:"issue", annotatedBy:"other"})).status).toBe(409);
      r = await call(url + "?topic=disk&text=100%25&limit=1"); data = await r.json();
      expect(data.notes).toHaveLength(1); expect(data.notes[0].id).toBe("old-note"); expect(data.nextCursor).toBeTruthy();
      r = await call(url + "?topic=disk&text=100%25&limit=1&after=" + data.nextCursor); data = await r.json();
      expect(data.notes.map((x: any) => x.id)).toEqual([made.id]); expect(data.nextCursor).toBeNull();
      data = await (await call(url + "?category=unclassified")).json(); expect(data.notes.map((x: any) => x.id)).toEqual([legacyNew.id]);
      expect((await call(url,"GET",undefined,{})).status).toBe(401);
      expect((await call(url + "?limit=0")).status).toBe(400);
      expect((await call(url + "?topic=a&topic=b")).status).toBe(400);
      expect((await call(url,"POST",{...note, replyTo:"missing"})).status).toBe(400);
      expect((await call(url,"POST",{...note, expiresAt:"not-a-date"})).status).toBe(400);
      expect((await call(url,"POST",{...note, category:"fake"})).status).toBe(400);
      expect((await call(base + "/v1/resources/other/profile-notes","POST",{...note,replyTo:"old-note"})).status).toBe(400);
      expect((await call(url,"POST",{...note, verifiedAt:"2999-01-01T00:00:00.000Z"})).status).toBe(400);
      expect((await call(url + "/old-note","PUT",{category:"answer"})).status).toBe(400);
      expect((await client.readNotes("nas1"))).toHaveLength(3); // failed POST rolled back
      profile.close(); profile = createResourceProfileApi({dbPath:path, token:"token"});
      data = await (await call(url)).json(); expect(data.notes).toHaveLength(3); expect(data.notes[0].annotatedBy).toBe("agent-b");
      // A fresh OS process reopens the same SQLite file (no in-memory state).
      const script = `import { createResourceProfileApi } from ${JSON.stringify(new URL("../src/resource-profile.ts", import.meta.url).href)}; const api=createResourceProfileApi({dbPath:process.argv[1],token:"token"}); const r=await api.fetch(new Request("http://localhost/v1/resources/nas1/profile-notes",{headers:{authorization:"Bearer token"}})); console.log(JSON.stringify(await r.json())); api.close();`;
      const child = Bun.spawnSync([process.execPath, "-e", script, path]);
      expect(child.exitCode).toBe(0); expect(JSON.parse(child.stdout.toString()).notes).toHaveLength(3);
    } finally { await server.stop(true); profile.close(); machine.close(); rmSync(dir,{recursive:true,force:true}); }
  });
  test("concurrent writers persist without overwriting, and annotations race safely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resource-profile-race-")), path = join(dir,"db.sqlite");
    const a = createResourceProfileApi({dbPath:path,token:"token"}), b = createResourceProfileApi({dbPath:path,token:"token"});
    const s = Bun.serve({hostname:"127.0.0.1", port:0, fetch:req => Number(new URL(req.url).searchParams.get("shard")) ? b.fetch(new Request(req.url.replace("?shard=1", ""),req)) : a.fetch(req)});
    const url = `http://127.0.0.1:${s.port}/v1/resources/r/profile-notes`;
    const post = (u:string, body:unknown, method="POST") => fetch(u,{method,headers,body:JSON.stringify(body)});
    try {
      const responses = await Promise.all(Array.from({length:40},(_,i)=>post(url+(i%2?"?shard=1":""),{author:"agent",text:`message ${i}`,category:"question"})));
      expect(responses.map(x=>x.status)).toEqual(Array(40).fill(201));
      const listed: any = await (await fetch(url,{headers})).json(); expect(listed.notes).toHaveLength(40);
      const raw = new Database(path); raw.query("INSERT INTO resource_messages VALUES ('legacy','r','a','old',?)").run(new Date().toISOString()); raw.close();
      const attempts = await Promise.all([post(url+"/legacy",{category:"issue",annotatedBy:"a"},"PUT"),post(url+"/legacy?shard=1",{category:"change",annotatedBy:"b"},"PUT")]);
      expect(attempts.map(x=>x.status).sort()).toEqual([201,409]);
    } finally { await s.stop(true); a.close(); b.close(); rmSync(dir,{recursive:true,force:true}); }
  });
});
