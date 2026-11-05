import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createSharedFilesApi } from "../src/shared-files-api.ts";
import { SharedFilesClient } from "../src/shared-files-client.ts";

test("two clients read and update actual shared files with expected hashes and no blind overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-shared-files-")), root = join(dir, "shared"), token = randomBytes(32).toString("hex"); await mkdir(root);
  const api = createSharedFilesApi({ roots: { project: root }, token }); const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch });
  try {
    const options = { baseUrl: `http://127.0.0.1:${server.port}`, token, fetch }, a = new SharedFilesClient(options), b = new SharedFilesClient(options);
    const created = await a.write({ resourceId: "project", path: "notes.txt", text: "first participant", expectedSha256: null }); assert.equal(created.beforeSha256, null);
    const first = await b.read("project", "notes.txt"); assert.equal(first.text, "first participant"); assert.equal(first.sha256, created.afterSha256);
    const changed = await b.write({ resourceId: "project", path: "notes.txt", text: "second participant", expectedSha256: first.sha256 });
    assert.equal(changed.beforeSha256, first.sha256); assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "second participant");
    assert.equal((await a.read("project", "notes.txt")).sha256, changed.afterSha256);
    await assert.rejects(a.write({ resourceId: "project", path: "notes.txt", text: "stale", expectedSha256: first.sha256 }), error => (error as {status?:number}).status === 409);
    await assert.rejects(a.write({ resourceId: "project", path: "notes.txt", text: "blind", expectedSha256: null }), error => (error as {status?:number}).status === 409);
    const simultaneous = await Promise.allSettled([a.write({ resourceId: "project", path: "notes.txt", text: "A", expectedSha256: changed.afterSha256 }), b.write({ resourceId: "project", path: "notes.txt", text: "B", expectedSha256: changed.afterSha256 })]);
    assert.equal(simultaneous.filter(result => result.status === "fulfilled").length, 1);
    const large = "x".repeat(65536); await a.write({resourceId:"project",path:"limit.txt",text:large,expectedSha256:null}); assert.equal((await b.read("project","limit.txt")).text,large);
    await assert.rejects(a.write({resourceId:"project",path:"oversize",text:large+"x",expectedSha256:null}));
    await writeFile(join(root,"bom.txt"),"\uFEFFvalid text");assert.equal((await a.read("project","bom.txt")).text,"\uFEFFvalid text");
  } finally { await server.stop(true); api.close(); await rm(dir, { recursive: true, force: true }); }
});

test("shared roots reject traversal and symlink escape, with authentication and missing file outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-shared-boundary-")), root = join(dir, "shared"), outside = join(dir,"outside"), token = randomBytes(32).toString("hex"); await mkdir(root); await mkdir(outside);await writeFile(join(outside,"private.txt"),"outside");
  await symlink(outside,join(root,"escape"),process.platform==="win32"?"junction":"dir");
  const api=createSharedFilesApi({roots:{project:root},token});const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api.fetch});
  try{
    const baseUrl=`http://127.0.0.1:${server.port}`,client=new SharedFilesClient({baseUrl,token,fetch});
    await assert.rejects(client.read("project","escape/private.txt"),error=>(error as {status?:number}).status===403);
    await assert.rejects(client.write({resourceId:"project",path:"escape/new.txt",text:"no",expectedSha256:null}),error=>(error as {status?:number}).status===403);
    for(const path of["../outside/private.txt","/absolute","a/../file","a\\file","file:stream"])await assert.rejects(client.read("project",path));
    assert.equal(await readFile(join(outside,"private.txt"),"utf8"),"outside");
    await assert.rejects(client.read("project","missing.txt"),error=>(error as {status?:number}).status===404);
    const denied=await fetch(baseUrl+"/v1/shared-files?resourceId=project&path=missing.txt");assert.equal(denied.status,401);await denied.body?.cancel();
    const wrong=new SharedFilesClient({baseUrl,token:"wrong-token",fetch});await assert.rejects(wrong.read("project","missing.txt"),error=>(error as {status?:number}).status===401);
  }finally{await server.stop(true);api.close();await rm(dir,{recursive:true,force:true});}
});


test("discover configured resource IDs and one-level directory content without exposing host roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-shared-discovery-")), root = join(dir,"shared"), outside = join(dir,"outside"), token = randomBytes(32).toString("hex");
  await mkdir(root); await mkdir(outside); await mkdir(join(root,"nested")); await writeFile(join(root,"readme.txt"),"visible work"); await writeFile(join(root,"nested","child.txt"),"child");
  await symlink(outside,join(root,"escape"),process.platform==="win32"?"junction":"dir");
  const api=createSharedFilesApi({roots:{team:root},token});const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:api.fetch});
  try{
    const baseUrl=`http://127.0.0.1:${server.port}`,client=new SharedFilesClient({baseUrl,token,fetch});
    const resources=await client.listResources();assert.deepEqual(resources,{resources:[{resourceId:"team",kind:"shared-directory",capabilities:["read","comparewrite"]}]});
    assert.equal(JSON.stringify(resources).includes(root),false);
    const listing=await client.list("team");assert.equal(listing.path,"");assert.equal(listing.hasMore,false);
    const entries=new Map(listing.entries.map(entry=>[entry.name,entry]));assert.equal(entries.get("readme.txt")!.type,"file");assert.equal(entries.get("readme.txt")!.bytes,12);assert.ok(entries.get("readme.txt")!.modifiedAt);
    assert.equal(entries.get("nested")!.type,"directory");assert.equal(entries.get("escape")!.type,"unsupported");assert.equal(entries.get("escape")!.bytes,null);
    assert.equal(listing.entries.some(entry=>entry.name==="child.txt"),false);assert.equal(JSON.stringify(listing).includes(root),false);
    assert.deepEqual((await client.list("team","nested")).entries.map(entry=>entry.name),["child.txt"]);
    await assert.rejects(client.list("team","escape"),error=>(error as {status?:number}).status===403);
    await assert.rejects(client.list("team","../outside"));
    const denied=await fetch(baseUrl+"/v1/shared-resources");assert.equal(denied.status,401);await denied.body?.cancel();
    const large=join(root,"large");await mkdir(large);await Promise.all(Array.from({length:101},(_,i)=>writeFile(join(large,`item-${i}.txt`),"x")));
    const partial=await client.list("team","large");assert.equal(partial.entries.length,100);assert.equal(partial.hasMore,true);
    const created=await client.write({resourceId:"team",path:"new.txt",text:"after discovery",expectedSha256:null});assert.equal((await client.read("team","new.txt")).sha256,created.afterSha256);
  }finally{await server.stop(true);api.close();await rm(dir,{recursive:true,force:true});}
});
