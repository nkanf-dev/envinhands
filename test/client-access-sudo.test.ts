import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {UNIX_ROOT_SHELL_CHECK} from "../src/client-access.ts";

// Real sudo and sudoers, but only inside a disposable user+mount namespace.
// Its bind mounts and PAM policy never change the host's files or privileges.
test("real sudo fixture: true-only policy fails fixed root shell, shell policy succeeds",t=>{
 if(process.platform!=="linux" || !["/usr/bin/unshare","/usr/bin/python3","/usr/bin/sudo","/usr/bin/setpriv","/usr/bin/mount","/etc/sudoers","/etc/pam.d/sudo","/usr/bin/true"].every(existsSync))return t.skip("sudo namespace fixture prerequisites unavailable");
 const pre=spawnSync("/usr/bin/unshare",["-Ur","--map-auto","/usr/bin/true"],{stdio:"ignore",timeout:5000});
 if(pre.status!==0)return t.skip("mapped user namespaces unavailable");
 const base=mkdtempSync(join(tmpdir(),"eih-sudo-check-"));
 const program=String.raw`
import os, pwd, shutil, subprocess, sys, json
base=sys.argv[1]
os.chmod(base,0o755)
shutil.copy2('/usr/bin/sudo',base+'/sudo')
os.chown(base+'/sudo',0,0);os.chmod(base+'/sudo',0o4755)
user=pwd.getpwuid(1).pw_name
policy=base+'/sudoers'
def setpolicy(command):
 with open(policy,'w') as f:f.write('Defaults !lecture\nroot ALL=(ALL:ALL) ALL\n'+user+' ALL=(ALL:ALL) NOPASSWD: '+command+'\n')
 os.chown(policy,0,0);os.chmod(policy,0o440)
setpolicy('/usr/bin/true')
open(base+'/pam','w').write('auth sufficient pam_permit.so\naccount sufficient pam_permit.so\nsession sufficient pam_permit.so\n')
subprocess.run(['/usr/bin/mount','--bind',policy,'/etc/sudoers'],check=True)
subprocess.run(['/usr/bin/mount','--bind',base+'/pam','/etc/pam.d/sudo'],check=True)
def run(command):
 return subprocess.run(['/usr/bin/setpriv','--reuid=1','--regid=1','--clear-groups','/bin/sh','-c',command],env=dict(os.environ,PATH=base+':/usr/bin:/bin'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode
true=run('sudo -n -- /usr/bin/true')
restricted=run(os.environ['EIH_CHECK'])
setpolicy('/bin/sh')
allowed=run(os.environ['EIH_CHECK'])
print(json.dumps({'true':true,'restricted':restricted,'allowed':allowed}))
`;
 try{
  const r=spawnSync("/usr/bin/unshare",["-Ur","-m","--map-auto","/usr/bin/python3","-c",program,base],{env:{...process.env,EIH_CHECK:UNIX_ROOT_SHELL_CHECK},encoding:"utf8",timeout:10000});
  assert.equal(r.status,0,`isolated sudo fixture failed: ${r.stderr}`);
  const result=JSON.parse(r.stdout);assert.equal(result.true,0);assert.notEqual(result.restricted,0);assert.equal(result.allowed,0);
 }finally{rmSync(base,{recursive:true,force:true});}
});
