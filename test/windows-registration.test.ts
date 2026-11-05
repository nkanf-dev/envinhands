import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { runWindowsRegistration } from "../src/registration/windows.ts";
const key=()=>"ssh-ed25519 "+Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from("ssh-ed25519"),Buffer.from([0,0,0,32]),randomBytes(32)]).toString("base64");

async function privateRoot(path:string){
 if(process.platform!=="win32")return;
 const ps=`$p=[Console]::In.ReadToEnd();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$a.SetOwner($sid);$r=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $p -AclObject $a`;
 const child=Bun.spawn(["powershell.exe","-NoProfile","-NonInteractive","-Command",ps],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});child.stdin.write(path);child.stdin.end();
 const [exit,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect(exit).toBe(0);expect(error).toBe("");
}

test("Windows fixture writes real keys with private ACL receipt and owned revoke preserves pre-existing bytes",async()=>{
 const root=await mkdtemp(join(tmpdir(),"env-windows-reg-"));
 const request={action:"apply" as const,operationId:"key-grant",user:"fixture-user",publicKey:key(),confirm:true as const};
 try{
  await privateRoot(root);
  const options={fixtureRoot:root,fixtureIdentity:{accountName:request.user,administrator:false}};
  if(process.platform!=="win32"){expect((await runWindowsRegistration(request,options)).status).toBe("failed");return;}
  const ssh=join(root,"profile",".ssh");await mkdir(ssh,{recursive:true});const path=join(ssh,"authorized_keys");
  const original=key()+" prior-key\r\n";await writeFile(path,original);
  const applied=await runWindowsRegistration(request,options);expect(applied.status).toBe("applied");expect(applied.ready).toBe(false);expect(applied.fixture).toBe(true);
  expect(applied.receipt?.keyAdded).toBe(true);expect(typeof applied.receipt?.afterAcl).toBe("string");
  expect(applied.receipt?.beforeAcl).toBe(applied.receipt?.afterAcl);expect(await readFile(path,"utf8")).toStartWith(original);
  expect((await runWindowsRegistration({action:"revoke",operationId:request.operationId,confirm:true},options)).status).toBe("revoked");
  expect(await readFile(path,"utf8")).toBe(original);
  const reused=await runWindowsRegistration({...request,operationId:"existing-key",publicKey:original.split(" prior-key")[0]!},options);
  expect(reused.status).toBe("applied");expect(reused.receipt?.keyAdded).toBe(false);
  expect((await runWindowsRegistration({action:"revoke",operationId:"existing-key",confirm:true},options)).status).toBe("revoked");expect(await readFile(path,"utf8")).toBe(original);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("Windows fixture admin-path grant is explicit, changed keys and ambiguous group ownership remain partial",async()=>{
 const root=await mkdtemp(join(tmpdir(),"env-windows-admin-reg-"));
 const request={action:"apply" as const,operationId:"admin-grant",user:"fixture-user",publicKey:key(),confirm:true as const,grantAdministrator:true};
 try{
  await privateRoot(root);
  const options={fixtureRoot:root,fixtureIdentity:{accountName:request.user,administrator:false}};
  if(process.platform!=="win32"){expect((await runWindowsRegistration(request,options)).status).toBe("failed");return;}
  expect((await runWindowsRegistration({...request,confirm:false} as unknown as typeof request,options)).status).toBe("failed");
  const applied=await runWindowsRegistration(request,options);expect(applied.status).toBe("applied");expect(applied.receipt?.administratorPath).toBe(true);
  expect(applied.receipt?.groupAdded).toBe(true);expect(applied.fixture).toBe(true);
  const path=join(root,"programdata-ssh","administrators_authorized_keys");await appendFile(path,key()+" later-owner-entry\r\n");const modified=await readFile(path,"utf8");
  const revoked=await runWindowsRegistration({action:"revoke",operationId:request.operationId,confirm:true},options);
  expect(revoked.status).toBe("partial");expect(await readFile(path,"utf8")).toBe(modified);
  const explicit=await runWindowsRegistration({action:"revoke",operationId:request.operationId,confirm:true,revokeAdministrator:true},options);
  expect(explicit.status).toBe("partial");expect(explicit.receipt?.groupRevoked).toBe(true);expect(await readFile(path,"utf8")).toBe(modified);
 }finally{await rm(root,{recursive:true,force:true});}
});
