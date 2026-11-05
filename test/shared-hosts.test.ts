import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {loadSharedHosts} from "../src/shared-hosts.ts";
import {runFilesCli} from "../src/files-cli.ts";
test("private host catalog selects known endpoints but host listing never outputs tokens",async()=>{
 const root=await mkdtemp(join(tmpdir(),"shared-hosts-")),path=join(root,"hosts.json");
 try{
  const hosts={hosts:[{hostId:"windows",url:"http://127.0.0.1:12345",token:"private-host-token"},{hostId:"debian",url:"https://example.org",token:"other-private-token"}]};await writeFile(path,JSON.stringify(hosts),{mode:0o600});
  assert.equal((await loadSharedHosts(path)).length,2);const output:string[]=[],errors:string[]=[];
  const io={readInput:async()=>"{}",write:(text:string)=>output.push(text),error:(text:string)=>errors.push(text),fetch};
  assert.equal(await runFilesCli(["hosts"],{ENVINHANDS_SHARED_HOSTS:path},io),0);assert.deepEqual(JSON.parse(output[0]).hosts,[{hostId:"windows"},{hostId:"debian"}]);assert.ok(!output[0].includes("private"));
  await writeFile(path,JSON.stringify({hosts:[{...hosts.hosts[0],url:"http://remote.example"}]}));await assert.rejects(loadSharedHosts(path));
 }finally{await rm(root,{recursive:true,force:true});}
});
