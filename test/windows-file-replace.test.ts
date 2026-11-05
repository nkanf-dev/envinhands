import {test,expect} from "bun:test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {replaceWindowsFile} from "../src/windows-file-replace.ts";

async function inspect(path:string,prepare=false){
 const source=`$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();if(PREPARE){$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$parent=Split-Path -Parent $p;$d=New-Object Security.AccessControl.DirectorySecurity;$d.SetAccessRuleProtection($true,$false);$d.SetOwner($sid);$d.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $parent -AclObject $d;$a=New-Object Security.AccessControl.FileSecurity;$a.SetAccessRuleProtection($true,$false);$a.SetOwner($sid);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));$sy=New-Object Security.Principal.SecurityIdentifier('S-1-5-18');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sy,'ReadAndExecute','Allow')));Set-Acl -LiteralPath $p -AclObject $a};$acl=Get-Acl -LiteralPath $p;[Console]::Out.WriteLine((@{sddl=$acl.Sddl;protected=$acl.AreAccessRulesProtected;owner=$acl.Owner;group=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[string]$_.AccessControlType;inheritance=[string]$_.InheritanceFlags;propagation=[string]$_.PropagationFlags;inherited=$_.IsInherited}});systemRead=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq 'S-1-5-18'}).Count}|ConvertTo-Json -Depth 6 -Compress))`.replace("PREPARE",prepare?"$true":"$false");
 const child=Bun.spawn(["powershell.exe","-NoProfile","-NonInteractive","-Command",source],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});child.stdin.write(path);child.stdin.end();
 const [out,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(exit).toBe(0);expect(error).toBe("");return JSON.parse(out) as {sddl:string;protected:boolean;owner:string;systemRead:number;group:string;rules:unknown[]};
}

test("Windows native replacement preserves protected custom DACL and owner while replacing bytes",async()=>{
 if(process.platform!=="win32"){await expect(replaceWindowsFile("/tmp/replacement","/tmp/target")).rejects.toThrow("effects are unknown");return;}
 const root=await mkdtemp(join(tmpdir(),"env-native-replace-")),target=join(root,"custom.txt"),temp=join(root,"replacement.tmp");
 try{
  await writeFile(target,"original fixture\n");const before=await inspect(target,true);expect(before.protected).toBe(true);expect(before.systemRead).toBe(1);
  await writeFile(temp,"updated fixture\n");await replaceWindowsFile(temp,target);
  const after=await inspect(target);expect(after).toEqual(before);expect(await readFile(target,"utf8")).toBe("updated fixture\n");expect(await Bun.file(temp).exists()).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("Windows ordinary inherited ACL replacement retains owner, group, protection and exact ACE permissions",async()=>{
 if(process.platform!=="win32"){await expect(replaceWindowsFile("/tmp/ordinary-replacement","/tmp/ordinary-target")).rejects.toThrow("effects are unknown");return;}
 const root=await mkdtemp(join(tmpdir(),"env-inherited-replace-")),target=join(root,"ordinary.txt"),temp=join(root,"replacement.tmp");
 try{
  await writeFile(target,"original ordinary fixture\n");const before=await inspect(target);expect(before.protected).toBe(false);expect(before.rules.length).toBeGreaterThan(0);
  await writeFile(temp,"updated ordinary fixture\n");await replaceWindowsFile(temp,target);
  const after=await inspect(target);const {sddl:beforeSddl,...beforePolicy}=before,{sddl:afterSddl,...afterPolicy}=after;
  // Only SE_DACL_AUTO_INHERITED may be normalized by Windows; ACEs, group, owner and protection are exact.
  expect(afterPolicy).toEqual(beforePolicy);expect(afterSddl.replace("D:AI(","D:(")).toBe(beforeSddl.replace("D:AI(","D:("));
  expect(await readFile(target,"utf8")).toBe("updated ordinary fixture\n");expect(await Bun.file(temp).exists()).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
