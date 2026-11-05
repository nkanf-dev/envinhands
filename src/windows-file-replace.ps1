# Replace an existing owned file without changing its access policy. No privilege or ACL grant.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Regular-Path([string]$Path) {
 if (-not [IO.Path]::IsPathRooted($Path)) {throw 'Absolute path required'}
 $full=[IO.Path]::GetFullPath($Path)
 $root=[IO.Path]::GetPathRoot($full);$cursor=$root
 foreach($part in $full.Substring($root.Length).Split([char[]]'\/',[StringSplitOptions]::RemoveEmptyEntries)) {
  $cursor=Join-Path $cursor $part
  $item=Get-Item -LiteralPath $cursor -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Reparse path rejected'}
 }
 if ($item.PSIsContainer) {throw 'Regular file required'}
 return $full
}
function Descriptor-Hash([string]$Path) {
 $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
 $acl=[IO.File]::GetAccessControl($Path,$sections)
 $descriptor=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorSddlForm($sections))
 $dacl=$descriptor.DiscretionaryAcl
 $daclBytes=if($null -eq $dacl){$null}else{New-Object byte[] $dacl.BinaryLength}
 if($null -ne $dacl){$dacl.GetBinaryForm($daclBytes,0)}
 # ReplaceFile may set SE_DACL_AUTO_INHERITED without changing any ACE or protection.
 # Ignore only that bookkeeping flag; keep owner/group, DACL bytes/order and all other flags.
 $flags=[int]$descriptor.ControlFlags -band (-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)
 $policy=[ordered]@{owner=$descriptor.Owner.Value;group=$descriptor.Group.Value;flags=$flags;dacl=if($null -eq $daclBytes){$null}else{[Convert]::ToBase64String($daclBytes)}} | ConvertTo-Json -Compress
 $hash=[Security.Cryptography.SHA256]::Create()
 try {return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($policy)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
try {
 $buffer=New-Object char[] 16385;$size=0
 while($size -lt $buffer.Length){$n=[Console]::In.Read($buffer,$size,$buffer.Length-$size);if($n -eq 0){break};$size+=$n}
 if($size -gt 16384){throw 'Input too large'}
 $value=(-join $buffer[0..($size-1)])|ConvertFrom-Json
 if(@($value.PSObject.Properties).Count -ne 2 -or -not $value.PSObject.Properties['temp'] -or -not $value.PSObject.Properties['target']){throw 'Invalid input'}
 $temp=Regular-Path $value.temp;$target=Regular-Path $value.target
 if([string]::Equals($temp,$target,[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals([IO.Path]::GetDirectoryName($temp),[IO.Path]::GetDirectoryName($target),[StringComparison]::OrdinalIgnoreCase)){throw 'Distinct same-directory files required'}
 $before=Descriptor-Hash $target
 # Three-argument ReplaceFile uses no IGNORE_ACL_ERRORS fallback. NullString prevents PowerShell converting null to an empty filename.
 [IO.File]::Replace($temp,$target,[NullString]::Value)
 $after=Descriptor-Hash $target
 if($after -ne $before){throw 'Security descriptor changed after replacement'}
 [Console]::Out.WriteLine((@{replaced=$true;beforeDescriptorSha256=$before;afterDescriptorSha256=$after}|ConvertTo-Json -Compress))
 exit 0
}catch{
 [Console]::Error.WriteLine('Windows file replacement failed or effects are unknown; inspect the target before retry.')
 exit 1
}
