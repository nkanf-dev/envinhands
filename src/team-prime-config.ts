/** Private team mesh settings. This module never configures or creates a Prime agent profile. */
import { hostname, homedir } from "node:os";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface TeamPrimeConfig { url: string; token: string; machineId: string }
export interface TeamPrimeInput { url: string; token: string; machineId?: string }
export interface TeamPrimeOptions { home?: string; replace?: boolean; detectedHostname?: string; platform?: NodeJS.Platform; windowsRunner?: WindowsRunner; testHooks?: { beforeTempWrite?: () => void | Promise<void> } }
export type WindowsRunner = (operation: "read" | "write", home: string, config?: TeamPrimeConfig, replace?: boolean) => string;
export interface TeamPrimeResult { status: "created" | "unchanged" | "replaced"; path: string; diagnostics: TeamPrimeDiagnostics }
export interface TeamPrimeDiagnostics { connectivity: "not-tested"; tunnel: "possibly-required" | "not-inferred"; ssh: "available" | "missing-or-unusable" | "not-checked"; message: string }

export class TeamPrimeConfigError extends Error { constructor(message: string) { super(message); this.name = "TeamPrimeConfigError"; } }
const failure = () => new TeamPrimeConfigError("Cannot securely access team configuration; check permissions, symlinks and available disk space.");
const existing = () => new TeamPrimeConfigError("Team configuration already exists and differs; use explicit replace to change it.");
const invalid = (name: string) => new TeamPrimeConfigError(`Invalid ${name}`);

export function validateTeamPrimeConfig(input: TeamPrimeInput, detectedHostname = hostname()): TeamPrimeConfig {
  if (!input || typeof input !== "object") throw invalid("configuration");
  let url: URL;
  try { url = new URL(input.url); } catch { throw invalid("url"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw invalid("url");
  if (typeof input.token !== "string" || input.token.length > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(input.token)) throw invalid("token");
  const machineId = input.machineId ?? detectedHostname;
  if (typeof machineId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(machineId)) throw invalid("machineId; supply the registered node ID explicitly");
  return { url: url.origin, token: input.token, machineId };
}
export function teamPrimeDiagnostics(url: string, checkSsh: () => boolean = () => {
  const p = spawnSync("ssh", ["-V"], { shell: false, timeout: 3000, stdio: "ignore", windowsHide: true });
  return !p.error && p.status === 0;
}): TeamPrimeDiagnostics {
  const host = new URL(url).hostname;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(host);
  let ssh: TeamPrimeDiagnostics["ssh"] = "not-checked";
  if (local) { try { ssh = checkSsh() ? "available" : "missing-or-unusable"; } catch { ssh = "missing-or-unusable"; } }
  return { connectivity: "not-tested", tunnel: local ? "possibly-required" : "not-inferred", ssh,
    message: local ? "Local endpoint may require a separately configured and running SSH tunnel. SSH installation does not prove the tunnel or service is reachable." : "Service connectivity was not tested." };
}
function homePath(options: TeamPrimeOptions): string {
  const home = options.home ?? homedir();
  if (!isAbsolute(home) || /[\x00-\x1f\x7f]/.test(home)) throw invalid("home");
  return resolve(home);
}
export function teamPrimeConfigPath(home = homedir()): string { return join(homePath({ home }), ".prime-team", "envinhands-mesh.json"); }
async function noSymlinkAncestors(path: string): Promise<void> {
  const root = parse(path).root; let part = root;
  for (const component of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    part = join(part, component); const st = await fs.lstat(part);
    if (st.isSymbolicLink() || !st.isDirectory()) throw failure();
  }
}
async function checkDirectory(home: string, create: boolean): Promise<string> {
  await noSymlinkAncestors(home);
  const dir = join(home, ".prime-team");
  if (create) { try { await fs.mkdir(dir, { mode: 0o700 }); const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.chmod(0o700); } finally { await handle.close(); } } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || (process.getuid && st.uid !== process.getuid())) throw failure();
  return dir;
}
async function readPosix(path: string): Promise<TeamPrimeConfig | null> {
  let file: fs.FileHandle;
  try { file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || (process.getuid && st.uid !== process.getuid()) || st.size > 16384) throw failure();
    const raw = await file.readFile("utf8");
    const obj = JSON.parse(raw) as TeamPrimeInput;
    return validateTeamPrimeConfig(obj, "");
  } finally { await file.close(); }
}
function equal(a: TeamPrimeConfig | null, b: TeamPrimeConfig): boolean { return !!a && a.url === b.url && a.token === b.token && a.machineId === b.machineId; }

/** Windows runner: Windows PowerShell 5.1/.NET Framework; script is static, secret travels only over stdin. */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
 $i=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $home=[System.IO.Path]::GetFullPath([string]$i.home); $dir=[System.IO.Path]::Combine($home,'.prime-team'); $target=[System.IO.Path]::Combine($dir,'envinhands-mesh.json')
 $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
 $allowed=@($me.Value,'S-1-5-18','S-1-5-32-544')
 function CheckPath($p) { while ($p) { $item=Get-Item -LiteralPath $p -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }; $p=[IO.Path]::GetDirectoryName($p.TrimEnd('\')); if ($p -and $p.Length -eq 2 -and $p[1] -eq ':') { $p += '\' } } }
 function Security($directory) {
  if($directory) { $a=New-Object System.Security.AccessControl.DirectorySecurity; $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { $a=New-Object System.Security.AccessControl.FileSecurity; $inherit=[System.Security.AccessControl.InheritanceFlags]::None }
  $a.SetOwner($me); $a.SetAccessRuleProtection($true,$false)
  $r=New-Object System.Security.AccessControl.FileSystemAccessRule($me,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
  $a.AddAccessRule($r); return $a
 }
 function CheckAcl($p) {
  $a=Get-Acl -LiteralPath $p; $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if($owner -ne $me.Value -or -not $a.AreAccessRulesProtected) { throw 'owner or inheritance' }
  foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if($r.AccessControlType -eq 'Allow' -and $allowed -notcontains $r.IdentityReference.Value) { throw 'acl' } }
 }
 CheckPath $home
 if(-not [IO.Directory]::Exists($dir)) { if($i.operation -ne 'write') { [Console]::Out.Write('missing'); exit 0 }; [IO.Directory]::CreateDirectory($dir,(Security $true)) | Out-Null }
 CheckPath $dir; CheckAcl $dir
 if([IO.File]::Exists($target)) {
  CheckPath $target; CheckAcl $target
  $f=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try { if($f.Length -gt 16384) { throw 'size' }; $reader=New-Object IO.StreamReader($f,[Text.Encoding]::UTF8); $old=$reader.ReadToEnd() | ConvertFrom-Json } finally { $f.Dispose() }
  if($i.operation -eq 'read') { [Console]::Out.Write(($old | ConvertTo-Json -Compress)); exit 0 }
  if($old.url -ceq $i.config.url -and $old.token -ceq $i.config.token -and $old.machineId -ceq $i.config.machineId) { [Console]::Out.Write('unchanged'); exit 0 }
  if(-not $i.replace) { [Console]::Out.Write('exists'); exit 0 }; $existed=$true
 } else { if($i.operation -eq 'read') { [Console]::Out.Write('missing'); exit 0 }; $existed=$false }
 $tmp=[IO.Path]::Combine($dir,'.envinhands-'+[Guid]::NewGuid().ToString('N')+'.tmp')
 try {
  $s=New-Object IO.FileStream($tmp,[IO.FileMode]::CreateNew,[System.Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(Security $false))
  try { $b=[Text.Encoding]::UTF8.GetBytes(($i.config | ConvertTo-Json -Compress)); $s.Write($b,0,$b.Length); $s.Flush($true) } finally { $s.Dispose() }
  if($existed) { [IO.File]::Replace($tmp,$target,$null); [Console]::Out.Write('replaced') } else { [IO.File]::Move($tmp,$target); [Console]::Out.Write('created') }
 } finally { if([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
} catch { [Console]::Out.Write('error'); exit 1 }
`;
function defaultWindowsRunner(operation: "read" | "write", home: string, config?: TeamPrimeConfig, replace?: boolean): string {
  const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
  const child = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    shell: false, input: JSON.stringify({ operation, home, config, replace }), encoding: "utf8", timeout: 15000, maxBuffer: 32768, windowsHide: true,
  });
  if (child.error || child.status !== 0) throw failure();
  return child.stdout;
}
export async function readTeamPrimeConfig(options: TeamPrimeOptions = {}): Promise<TeamPrimeConfig | null> {
  const home = homePath(options); const target = teamPrimeConfigPath(home);
  try {
    if ((options.platform ?? process.platform) === "win32") {
      const result = (options.windowsRunner ?? defaultWindowsRunner)("read", home);
      if (result === "missing") return null;
      return validateTeamPrimeConfig(JSON.parse(result), "");
    }
    try { await checkDirectory(home, false); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    return await readPosix(target);
  } catch { throw failure(); }
}
/** Atomic no-clobber creation; replacement requires explicit replace=true. Does not log inputs. */
export async function writeTeamPrimeConfig(input: TeamPrimeInput, options: TeamPrimeOptions = {}): Promise<TeamPrimeResult> {
  const config = validateTeamPrimeConfig(input, options.detectedHostname ?? hostname());
  const home = homePath(options); const target = teamPrimeConfigPath(home);
  let status: TeamPrimeResult["status"];
  if ((options.platform ?? process.platform) === "win32") {
    let result: string;
    try { result = (options.windowsRunner ?? defaultWindowsRunner)("write", home, config, options.replace === true); } catch { throw failure(); }
    if (result === "exists") throw existing();
    if (result !== "created" && result !== "replaced" && result !== "unchanged") throw failure();
    status = result;
  } else {
    let temp: string | undefined;
    try {
      const dir = await checkDirectory(home, true); const old = await readPosix(target);
      if (equal(old, config)) status = "unchanged";
      else {
        if (old && options.replace !== true) throw existing();
        temp = join(dir, `.envinhands-${randomBytes(16).toString("hex")}.tmp`);
        const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.chmod(0o600); await options.testHooks?.beforeTempWrite?.(); await handle.writeFile(JSON.stringify(config) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
        if (old && options.replace === true) { await fs.rename(temp, target); status = "replaced"; }
        else { await fs.link(temp, target); status = "created"; }
      }
    } catch (e) {
      if (e instanceof TeamPrimeConfigError && e.message.includes("already exists")) throw e;
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw existing();
      throw failure();
    } finally { if (temp) { try { await fs.unlink(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw failure(); } } }
  }
  return { status, path: target, diagnostics: teamPrimeDiagnostics(config.url) };
}
