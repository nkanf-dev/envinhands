import { test } from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { startAgentBusServer } from "../src/server.ts";
import { runDeviceCli } from "../src/device-cli.ts";

test("device CLI registers native metadata on control service and lists pending inventory", async () => {
  const root=await mkdtemp(join(tmpdir(),"device-cli-"));
  const server=startAgentBusServer({dbPath:join(root,"bus.sqlite"),token:"device-cli-fixture",hostname:"127.0.0.1",port:0});
  const output:string[]=[],errors:string[]=[];
  const io={readInput:async()=>JSON.stringify({id:"local-native",host:"host.example",sshUser:"agent"}),write:(s:string)=>output.push(s),error:(s:string)=>errors.push(s),fetch};
  const env={ENVINHANDS_URL:server.url,ENVINHANDS_TOKEN:"device-cli-fixture",ENVINHANDS_AGENT_ID:"device-test",ENVINHANDS_MACHINE_ID:"client",ENVINHANDS_SESSION_ID:"test-session",ENVINHANDS_AUDIT_SIGNATURE:"Device test"};
  try {
    assert.equal(await runDeviceCli(["register"],env,io),0);
    const receipt=JSON.parse(output[0]).receipt;
    assert.equal(receipt.machine.status,"pending");assert.equal(receipt.verificationRequested,false);
    assert.equal(await runDeviceCli(["inventory"],env,io),0);
    assert.equal(JSON.parse(output[1]).inventory.machines[0].id,"local-native");
    assert.equal(await runDeviceCli(["register"],env,io),1);
    assert.match(errors[0],/already registered/);
  }finally{await server.stop();await rm(root,{recursive:true,force:true});}
});
