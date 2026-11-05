/** Export source-layout validation fixture; not an EnvInHands runtime dependency or a Prime build. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const source = process.env.PRIME_AGENT_CHECKOUT;
const destination = process.argv[2];
if (!source || !destination) throw new Error("Set PRIME_AGENT_CHECKOUT and supply a new output directory.");
const root = resolve(source), out = resolve(destination), relOut = relative(root, out);
if (relOut === "" || (!relOut.startsWith(`..${sep}`) && relOut !== ".." && !isAbsolute(relOut))) throw new Error("Output must be outside the source checkout.");
if (existsSync(out)) throw new Error("Output directory already exists; refusing to overwrite prior evidence.");
const identity = { agentId: process.env.PRIME_EXPORT_AGENT_ID, sessionId: process.env.PRIME_EXPORT_SESSION_ID,
  machineId: process.env.PRIME_EXPORT_MACHINE_ID, signature: process.env.PRIME_EXPORT_SIGNATURE };
if (Object.values(identity).some(value => typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)))
  throw new Error("Explicit non-sensitive PRIME_EXPORT_AGENT_ID/SESSION_ID/MACHINE_ID/SIGNATURE are required.");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {name:string;version:string;workspaces:string[];scripts?:Record<string,string>};
const lockBytes = readFileSync(join(root,"package-lock.json"));
const lock = JSON.parse(lockBytes.toString("utf8")) as {lockfileVersion:number;packages:Record<string,{version?:string;link?:boolean;resolved?:string;scripts?:Record<string,string>}>};
if (!Array.isArray(rootManifest.workspaces) || lock.lockfileVersion !== 3) throw new Error("Unsupported workspace/lock shape; do not rewrite the lock.");
const files = new Map<string, Uint8Array>();
const excluded = new Set([".git","node_modules","dist","test","tests","__tests__","docs","secrets","Secrets"]);
function add(path:string) {
  const rel=relative(root,path).split(sep).join("/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel) || rel.split("/").some(part=>excluded.has(part)) || basename(rel).startsWith(".env"))
    throw new Error("Unsafe or excluded export path.");
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Only regular source files may be exported.");
  files.set(rel,readFileSync(path));
}
function walk(directory:string) {
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(excluded.has(entry.name)||entry.name.startsWith(".env")||/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))continue;
    const path=join(directory,entry.name);if(entry.isSymbolicLink())throw new Error("Symlink inside source tree is not exported.");
    if(entry.isDirectory())walk(path);else if(entry.isFile())add(path);
  }
}
for(const name of ["package.json","package-lock.json",".npmrc"])add(join(root,name));
for(const entry of readdirSync(root))if(/^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/.test(entry))add(join(root,entry));
for(const name of ["LICENSE","LICENSE.md","LICENSE.txt"])if(existsSync(join(root,name)))add(join(root,name));
const workspacePaths=Object.keys(lock.packages).filter(path=>path&&!path.startsWith("node_modules/")&&!path.includes("/node_modules/"));
const expectedWorkspacePaths=new Set<string>();
for(const pattern of rootManifest.workspaces){
  if(pattern==="packages/*"){
    for(const entry of readdirSync(join(root,"packages"),{withFileTypes:true}))if(entry.isDirectory()&&existsSync(join(root,"packages",entry.name,"package.json")))expectedWorkspacePaths.add(`packages/${entry.name}`);
  }else if(!pattern.includes("*"))expectedWorkspacePaths.add(pattern);
  else throw new Error("New workspace glob needs an explicit export review.");
}
if(JSON.stringify([...expectedWorkspacePaths].sort())!==JSON.stringify([...workspacePaths].sort()))throw new Error("Workspace manifests differ from the original lock; refusing implicit lock resolution.");
const workspaceManifests: Array<{path:string;name:string;version:string;scripts:Record<string,string>}> = [];
for(const path of workspacePaths.sort()){
  add(join(root,path,"package.json"));
  const manifest=JSON.parse(readFileSync(join(root,path,"package.json"),"utf8")) as {name:string;version:string;scripts?:Record<string,string>};
  workspaceManifests.push({path,name:manifest.name,version:manifest.version,scripts:manifest.scripts??{}});
}
for(const path of workspacePaths){
  if(/^packages\/[^/]+$/.test(path)&&existsSync(join(root,path,"src")))walk(join(root,path,"src"));
}
for(const name of ["heartbeat","messages","resources"])add(join(root,"packages/coding-agent/examples/extensions",`envinhands-${name}.ts`));
const manifest={formatVersion:1,kind:"validation-only-source-layout",createdAt:new Date().toISOString(),identity,
  primeVersion:rootManifest.version,lockfileVersion:lock.lockfileVersion,originalLockSha256:hash(lockBytes),originalLockUnchanged:true,
  rootManifestSha256:hash(files.get("package.json")!),workspaceManifests,
  files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,bytes])=>({path,bytes:bytes.byteLength,sha256:hash(bytes)})),
  install:{command:"npm ci --ignore-scripts",node:"24.14.1 or compatible >=24",npm:">=11.10; coordinator prepared 11.11.0",lifecycleScriptsDisabled:true,
    rootPrepare:rootManifest.scripts?.prepare??null,workspaceLifecycleScripts:workspaceManifests.filter(item=>item.scripts.postinstall||item.scripts.prepare||item.scripts.preinstall||item.scripts.install)
      .map(item=>({path:item.path,preinstall:item.scripts.preinstall??null,install:item.scripts.install??null,postinstall:item.scripts.postinstall??null,prepare:item.scripts.prepare??null})),
    notes:"Original workspace manifests/lock/.npmrc preserved. No build/dev/npm test. Never copy Windows native dependencies to Linux. Check lock SHA before/after install."},
  limits:["No node_modules, git history, tests/docs, actual settings, .env, secrets or dist included.","All four first-party source trees preserve alias/import.meta and JSON/theme/assets layout; this is a compatibility fixture, not an EnvInHands business dependency.","Archive integrity and local extraction are checked; actual Linux npm/native dependency/loader acceptance is a separate gate.","Shared declared Agent signature is not cryptographic authentication or automatic mutation coverage."]};
// Reject concurrent source changes rather than producing a mixed-timepoint fixture.
for(const entry of manifest.files)if(hash(readFileSync(join(root,entry.path)))!==entry.sha256)throw new Error("Source changed during export; use a newly frozen timepoint.");
if(hash(readFileSync(join(root,"package-lock.json")))!==manifest.originalLockSha256)throw new Error("Original lock changed during export.");
mkdirSync(out,{recursive:false});
const auditPath=join(out,"export-changes.jsonl");
const audit=(action:string,resourceId:string,outcome:string,summary:string)=>appendRecord({ ...identity,recordedAt:new Date().toISOString(),action,resourceId,targetMachineId:identity.machineId,outcome,summary,
  authority:"Main coordinator's explicit validation-export narrow lease; no install/deployment/privilege change.",registrationRef:join(out,"export-registration.json") });
function appendRecord(record:unknown){const previous=existsSync(auditPath)?readFileSync(auditPath,"utf8"):"";writeFileSync(auditPath,previous+JSON.stringify(record)+"\n");}
writeFileSync(join(out,"export-registration.json"),JSON.stringify({...identity,registeredAt:new Date().toISOString(),scope:"Local declared export process"},null,2)+"\n");
const archivePath=join(out,"prime-validation.tar.gz"),manifestPath=join(out,"prime-validation.manifest.json");
let extraction:string|undefined;
try{
  await Bun.Archive.write(archivePath,Object.fromEntries(files),{compress:"gzip"});
  extraction=mkdtempSync(join(tmpdir(),"prime-export-verify-"));
  await new Bun.Archive(readFileSync(archivePath)).extract(extraction);
  for(const entry of manifest.files)if(hash(readFileSync(join(extraction,entry.path)))!==entry.sha256)throw new Error("Extracted file hash mismatch.");
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n");
  const receipt={archive:"prime-validation.tar.gz",archiveSha256:hash(readFileSync(archivePath)),archiveBytes:readFileSync(archivePath).byteLength,
    manifest:"prime-validation.manifest.json",manifestSha256:hash(readFileSync(manifestPath)),fileCount:files.size,
    uncompressedBytes:[...files.values()].reduce((n,v)=>n+v.byteLength,0),lockUnchanged:hash(readFileSync(join(root,"package-lock.json")))===manifest.originalLockSha256,
    extractionHashVerified:true,version:rootManifest.version,identity};
  if(!receipt.lockUnchanged)throw new Error("Original lock changed before export completion.");
  writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
  audit("create-validation-export",archivePath,"success",`${files.size} source-layout files; archive and extracted hashes verified; original lock unchanged.`);
  console.log(JSON.stringify({...receipt,outputDirectory:out}));
}catch(error){audit("create-validation-export",archivePath,"failed","Export or integrity check failed; incomplete artifacts are not accepted.");throw error;}
finally{if(extraction){rmSync(extraction,{recursive:true,force:true});audit("cleanup-export-verification",extraction,"success","Removed own temporary extraction after hash verification.");}}
