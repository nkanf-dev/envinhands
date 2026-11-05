import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { runUnixRegistration } from "../src/registration/apply.ts";
const key = () => "ssh-ed25519 " + Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from("ssh-ed25519"),Buffer.from([0,0,0,32]),randomBytes(32)]).toString("base64");

test("Unix helper applies real isolated files and owned revoke preserves prior authorized keys", async () => {
 const dir=await mkdtemp(join(tmpdir(),"env-unix-apply-"));
 try {
  const request={action:"apply" as const,operationId:"fixture-grant",user:userInfo().username,publicKey:key(),confirm:true as const};
  if(process.platform==="win32") { expect((await runUnixRegistration(request,{fixtureRoot:dir})).status).toBe("failed");return; }
  const ssh=join(dir,"home",".ssh");await mkdir(ssh,{recursive:true,mode:0o700});await chmod(join(dir,"home"),0o700);await chmod(ssh,0o700);
  const original=key()+" prior-key\n";const keys=join(ssh,"authorized_keys");await writeFile(keys,original,{mode:0o600});
  const applied=await runUnixRegistration(request,{fixtureRoot:dir});
  expect(applied.status).toBe("applied");expect(applied.fixture).toBe(true);expect(applied.ready).toBe(false);
  expect(await readFile(keys,"utf8")).toStartWith(original);expect(applied.receipt?.keyAdded).toBe(true);
  const policy=join(dir,"sudoers.d",String(applied.receipt?.sudoersName));expect(await readFile(policy,"utf8")).toBe(request.user+" ALL=(ALL:ALL) NOPASSWD: ALL\n");
  expect((await runUnixRegistration({action:"revoke",operationId:request.operationId,confirm:true},{fixtureRoot:dir})).status).toBe("revoked");
  expect(await readFile(keys,"utf8")).toBe(original);expect(await Bun.file(policy).exists()).toBe(false);
  const existing={...request,operationId:"already-authorized",publicKey:original.split(" prior-key")[0]!};
  const reused=await runUnixRegistration(existing,{fixtureRoot:dir});expect(reused.status).toBe("applied");expect(reused.receipt?.keyAdded).toBe(false);
  expect((await runUnixRegistration({action:"revoke",operationId:existing.operationId,confirm:true},{fixtureRoot:dir})).status).toBe("revoked");
  expect(await readFile(keys,"utf8")).toBe(original);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("Unix revoke retains changed owned files as partial; missing confirmation never starts grants",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"env-unix-changed-"));
 try{
  const request={action:"apply" as const,operationId:"changed-grant",user:userInfo().username,publicKey:key(),confirm:true as const};
  if(process.platform==="win32"){expect((await runUnixRegistration(request,{fixtureRoot:dir})).status).toBe("failed");return;}
  const invalid=await runUnixRegistration({...request,confirm:false} as unknown as typeof request,{fixtureRoot:dir});expect(invalid.status).toBe("failed");
  const applied=await runUnixRegistration(request,{fixtureRoot:dir});expect(applied.status).toBe("applied");
  const keys=join(dir,"home",".ssh","authorized_keys"),policy=join(dir,"sudoers.d",String(applied.receipt?.sudoersName));
  await appendFile(keys,key()+" later-user-change\n");await chmod(policy,0o640);await appendFile(policy,"# later-owner-change\n");
  const keysBefore=await readFile(keys,"utf8"),policyBefore=await readFile(policy,"utf8");
  const revoked=await runUnixRegistration({action:"revoke",operationId:request.operationId,confirm:true},{fixtureRoot:dir});
  expect(revoked.status).toBe("partial");expect(await readFile(keys,"utf8")).toBe(keysBefore);expect(await readFile(policy,"utf8")).toBe(policyBefore);
 }finally{await rm(dir,{recursive:true,force:true});}
});
