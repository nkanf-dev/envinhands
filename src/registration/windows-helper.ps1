# Explicit local Windows grants; no UAC, network, SSH service or privilege escalation.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$Receipt = $null
$Fixture = $false
$Lock = $null

function Hash-Bytes([byte[]]$Bytes) {
 $h = [Security.Cryptography.SHA256]::Create()
 try { return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally {$h.Dispose()}
}
function Path-WithoutReparse([string]$Path) {
 if (-not [IO.Path]::IsPathRooted($Path)) {throw 'Absolute path required'}
 $full = [IO.Path]::GetFullPath($Path)
 $root = [IO.Path]::GetPathRoot($full)
 $cursor = $root
 foreach ($part in $full.Substring($root.Length).Split([char[]]'\/', [StringSplitOptions]::RemoveEmptyEntries)) {
  $cursor = Join-Path $cursor $part
  if (Test-Path -LiteralPath $cursor) {
   if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Reparse path rejected'}
  }
 }
 return $full
}
function Private-Acl([string]$Path,[string[]]$Sids,[bool]$Directory) {
 if ($Directory) {$acl = New-Object Security.AccessControl.DirectorySecurity} else {$acl = New-Object Security.AccessControl.FileSecurity}
 $acl.SetAccessRuleProtection($true,$false)
 $owner = if ($CurrentSid.Value -in $Sids) {$CurrentSid} else {New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')}
 $acl.SetOwner($owner)
 foreach ($sid in ($Sids | Select-Object -Unique)) {
  $identity = New-Object Security.Principal.SecurityIdentifier($sid)
  if ($Directory) {
   $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  } else {$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')}
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $Path -AclObject $acl
}
function Check-Acl([string]$Path,[string[]]$Allowed) {
 $acl = Get-Acl -LiteralPath $Path
 $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if ($owner -notin $Allowed) {throw 'Unsafe owner'}
 foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $Allowed -and
      (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0 -or
       ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0 -or
       ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership) -ne 0)) {throw 'Unsafe write ACL'}
 }
 return $acl.Sddl
}
function Read-Regular([string]$Path) {
 $null = Path-WithoutReparse $Path
 if (-not (Test-Path -LiteralPath $Path)) {return $null}
 $item = Get-Item -LiteralPath $Path -Force
 if ($item.PSIsContainer -or $item.Length -gt 1048576) {throw 'Invalid file'}
 return ,([IO.File]::ReadAllBytes($Path))
}
function Durable-New([string]$Path,[byte[]]$Bytes,[string[]]$Sids) {
 $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try {$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
 Private-Acl $Path $Sids $false
}
function Replace-Owned([string]$Path,[byte[]]$Bytes,[string]$ExpectedHash,[string]$ExpectedSddl,[string[]]$Sids) {
 $temp = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.envinhands-'+[guid]::NewGuid().ToString('N')+'.tmp')
 try {
  Durable-New $temp $Bytes $Sids
  $now = Read-Regular $Path
  if ($null -eq $now -or (Hash-Bytes $now) -ne $ExpectedHash -or (Get-Acl -LiteralPath $Path).Sddl -ne $ExpectedSddl) {throw 'File changed before replace'}
  # Windows ReplaceFile preserves the replaced file security descriptor. The temporary file is already private.
  [IO.File]::Replace($temp,$Path,[NullString]::Value)
  if ((Get-Acl -LiteralPath $Path).Sddl -ne $ExpectedSddl) {throw 'Replacement ACL differs; inspect partial result'}
 } finally {if (Test-Path -LiteralPath $temp) {Remove-Item -LiteralPath $temp -Force}}
}
function Save-Receipt {
 $bytes = $Utf8.GetBytes(($Receipt | ConvertTo-Json -Depth 12 -Compress))
 if (Test-Path -LiteralPath $ReceiptPath) {
  $old = Read-Regular $ReceiptPath
  $sddl = Check-Acl $ReceiptPath $StateSids
  Replace-Owned $ReceiptPath $bytes (Hash-Bytes $old) $sddl $StateSids
 } else {Durable-New $ReceiptPath $bytes $StateSids}
}
function Result([string]$Status,[string]$Message) {
 return @{status=$Status;ready=$false;fixture=$Fixture;receipt=$Receipt;message=$Message}
}
try {
 $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
 $CurrentSid = $identity.User
 $raw = [Console]::In.ReadToEnd()
 if ($Utf8.GetByteCount($raw) -gt 16384) {throw 'Input too large'}
 $envelope = $raw | ConvertFrom-Json
 $request = $envelope.request; $options = $envelope.options
 $Fixture = -not [string]::IsNullOrEmpty($options.fixtureRoot)
 if ($request.confirm -ne $true -or $request.action -notin @('apply','revoke') -or
     $request.operationId -notmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$') {throw 'Explicit confirmed operation required'}
 if (-not $Fixture) {
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Existing effective administrator token required'}
 }
 $StateSids = if ($Fixture) {@($CurrentSid.Value)} else {@('S-1-5-18','S-1-5-32-544',$CurrentSid.Value)}
 if ($Fixture) {
  $base = Path-WithoutReparse $options.fixtureRoot
  if ($base -eq [IO.Path]::GetPathRoot($base)) {throw 'Fixture root cannot be drive root'}
  $null = Check-Acl $base @($CurrentSid.Value,'S-1-5-18','S-1-5-32-544')
  $State = Join-Path $base 'state'
 } else {$State = Join-Path $env:ProgramData 'EnvInHands\registrations'}
 $null = Path-WithoutReparse $State
 if (-not (Test-Path -LiteralPath $State)) {
  $null = [IO.Directory]::CreateDirectory($State)
  Private-Acl $State $StateSids $true
 }
 $null = Check-Acl $State $StateSids
 $lockPath = Join-Path $State '.registration.lock'
 if (-not (Test-Path -LiteralPath $lockPath)) {Durable-New $lockPath ([byte[]]@()) $StateSids}
 $null = Path-WithoutReparse $lockPath
 $null = Check-Acl $lockPath $StateSids
 $Lock = [IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $ReceiptPath = Join-Path $State ('registration-'+(Hash-Bytes $Utf8.GetBytes($request.operationId))+'.json')
 if ($request.action -eq 'apply') {
  if (Test-Path -LiteralPath $ReceiptPath) {
   $null = Check-Acl $ReceiptPath $StateSids
   $Receipt = $Utf8.GetString((Read-Regular $ReceiptPath)) | ConvertFrom-Json
   $result = Result 'partial' 'Operation already recorded; inspect it, no work replayed.'
  } else {
   if ([string]::IsNullOrWhiteSpace($request.user) -or $request.user.Length -gt 64 -or $request.user -match '[\x00-\x1f\x7f\\/:*?"<>|]') {throw 'Invalid local account'}
   if ($request.publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$') {throw 'Invalid Ed25519 public key'}
   $keyBytes = [Convert]::FromBase64String($request.publicKey.Split(' ')[1])
   if ($keyBytes.Length -ne 51 -or [Convert]::ToBase64String($keyBytes) -ne $request.publicKey.Split(' ')[1] -or
       [BitConverter]::ToString($keyBytes[0..18]) -ne '00-00-00-0B-73-73-68-2D-65-64-32-35-35-31-39-00-00-00-20') {throw 'Invalid Ed25519 wire key'}
   if ($Fixture) {
    if ($options.fixtureIdentity.accountName -ne $request.user) {throw 'Fixture identity mismatch'}
    $accountSid = $CurrentSid.Value
    $wasAdmin = $options.fixtureIdentity.administrator -eq $true
    $profile = Join-Path $base 'profile'
   } else {
    $account = Get-LocalUser -Name $request.user
    if (-not $account.Enabled) {throw 'Existing enabled local account required'}
    $accountSid = $account.SID.Value
    $group = Get-LocalGroup -SID 'S-1-5-32-544'
    $wasAdmin = @((Get-LocalGroupMember -Group $group.Name) | Where-Object {$_.SID.Value -eq $accountSid}).Count -gt 0
    $profileInfo = @(Get-CimInstance Win32_UserProfile | Where-Object {$_.SID -eq $accountSid})
    if ($profileInfo.Count -ne 1 -or -not [IO.Directory]::Exists($profileInfo[0].LocalPath)) {throw 'Existing real local profile required'}
    $profile = Path-WithoutReparse $profileInfo[0].LocalPath
   }
   $grant = $request.grantAdministrator -eq $true -and -not $wasAdmin
   $useAdminPath = $wasAdmin -or $grant
   $keyDirectory = if ($Fixture) {if ($useAdminPath) {Join-Path $base 'programdata-ssh'} else {Join-Path $profile '.ssh'}} elseif ($useAdminPath) {Join-Path $env:ProgramData 'ssh'} else {Join-Path $profile '.ssh'}
   $keysPath = Join-Path $keyDirectory $(if ($useAdminPath) {'administrators_authorized_keys'} else {'authorized_keys'})
   $null = Path-WithoutReparse $keysPath
   $KeySids = if ($Fixture) {@($CurrentSid.Value)} elseif ($useAdminPath) {@('S-1-5-18','S-1-5-32-544')} else {@('S-1-5-18','S-1-5-32-544',$accountSid)}
   $Receipt = [ordered]@{version=1;operationId=$request.operationId;fixture=$Fixture;user=$request.user;accountSid=$accountSid;keyPath=$keysPath;administratorPath=$useAdminPath;wasAdministrator=$wasAdmin;groupAddAttempted=$false;groupAdded=$false;stage='prepared';keyAdded=$false;keyWriteAttempted=$false}
   Save-Receipt
   if ($grant) {
    $Receipt.groupAddAttempted = $true; $Receipt.stage='group-add-unknown'; Save-Receipt
    if (-not $Fixture) {Add-LocalGroupMember -Group $group.Name -Member $account.SID -Confirm:$false}
    $Receipt.groupAdded = $true; $Receipt.stage='group-added'; Save-Receipt
   }
   if (-not [IO.Directory]::Exists($keyDirectory)) {$null = [IO.Directory]::CreateDirectory($keyDirectory);Private-Acl $keyDirectory $KeySids $true}
   $null = Check-Acl $keyDirectory $KeySids
   $before = Read-Regular $keysPath
   $original = if ($null -eq $before) {''} else {$Utf8.GetString($before)}
   $aclBefore = if ($null -eq $before) {$null} else {Check-Acl $keysPath $KeySids}
   $already = $false
   foreach ($line in ($original -split '\r?\n')) {
    $parts = $line.Trim().Split([char[]]' ',[StringSplitOptions]::RemoveEmptyEntries)
    if ($parts.Length -ge 2 -and ($parts[0]+' '+$parts[1]) -ceq $request.publicKey) {$already=$true}
   }
   $block = $(if ($original.Length -gt 0 -and -not $original.EndsWith("`n")) {"`r`n"} else {''})+$request.publicKey+' envinhands:'+(Hash-Bytes $Utf8.GetBytes($request.operationId))+"`r`n"
   $after = if ($already) {$original} else {$original+$block}
   $Receipt.keyAdded = -not $already
   $Receipt.keyBlockBase64 = if ($already) {$null} else {[Convert]::ToBase64String($Utf8.GetBytes($block))}
   $Receipt.keyExisted = $null -ne $before
   $Receipt.beforeSha256 = Hash-Bytes $Utf8.GetBytes($original)
   $Receipt.afterSha256 = Hash-Bytes $Utf8.GetBytes($after)
   $Receipt.beforeAcl = $aclBefore
   $Receipt.stage='key-write-unknown';$Receipt.keyWriteAttempted=-not $already;Save-Receipt
   if (-not $already) {
    if ($null -eq $before) {Durable-New $keysPath $Utf8.GetBytes($after) $KeySids}
    else {Replace-Owned $keysPath $Utf8.GetBytes($after) (Hash-Bytes $before) $aclBefore $KeySids}
   }
   $Receipt.afterAcl = Check-Acl $keysPath $KeySids
   $Receipt.stage='applied';Save-Receipt
   $result = Result 'applied' 'Owned key grant written; actual SSH and effective administrator checks remain required.'
  }
 } else {
  if (-not (Test-Path -LiteralPath $ReceiptPath)) {throw 'Owned receipt missing'}
  $null = Check-Acl $ReceiptPath $StateSids
  $Receipt = $Utf8.GetString((Read-Regular $ReceiptPath)) | ConvertFrom-Json
  if ($Receipt.operationId -ne $request.operationId -or $Receipt.fixture -ne $Fixture) {throw 'Receipt mismatch'}
  $partial = $false
  if ($Receipt.keyAdded -and $Receipt.keyWriteAttempted) {
   $bytes = Read-Regular $Receipt.keyPath
   if ($null -ne $bytes) {
    $acl = (Get-Acl -LiteralPath $Receipt.keyPath).Sddl
    if ((Hash-Bytes $bytes) -eq $Receipt.afterSha256 -and $acl -eq $Receipt.afterAcl) {
     $block = $Utf8.GetString([Convert]::FromBase64String($Receipt.keyBlockBase64))
     $text = $Utf8.GetString($bytes)
     $first = $text.IndexOf($block,[StringComparison]::Ordinal)
     if ($first -ge 0 -and $text.IndexOf($block,$first+$block.Length,[StringComparison]::Ordinal) -lt 0) {
      $replacement = $text.Remove($first,$block.Length)
      Replace-Owned $Receipt.keyPath $Utf8.GetBytes($replacement) (Hash-Bytes $bytes) $acl $StateSids
     } else {$partial=$true}
    } else {$partial=$true}
   }
  }
  # Removing membership is a fresh explicit owner decision, never inferred from current membership alone.
  if ($Receipt.groupAddAttempted -and -not $Receipt.groupRevoked) {
   if ($request.revokeAdministrator -eq $true) {
    if ($Fixture) {
     $Receipt | Add-Member -NotePropertyName groupRevoked -NotePropertyValue $true -Force
     $Receipt | Add-Member -NotePropertyName groupRevocationAuthority -NotePropertyValue 'New explicit owner decision; fixture group primitive only' -Force
    } else {
     $account = Get-LocalUser -Name $Receipt.user
     if ($account.SID.Value -ne $Receipt.accountSid) {throw 'Account identity changed'}
     $group = Get-LocalGroup -SID 'S-1-5-32-544'
     $members = @((Get-LocalGroupMember -Group $group.Name) | Where-Object {$_.SID.Value -eq $Receipt.accountSid})
     $Receipt.stage='group-revoke-unknown'
     $Receipt | Add-Member -NotePropertyName groupRevocationAuthority -NotePropertyValue 'New explicit owner decision; not inferred historical ownership' -Force
     Save-Receipt
     if ($members.Count -gt 0) {Remove-LocalGroupMember -Group $group.Name -Member $account.SID -Confirm:$false}
     if (@((Get-LocalGroupMember -Group $group.Name) | Where-Object {$_.SID.Value -eq $Receipt.accountSid}).Count -ne 0) {throw 'Membership removal unconfirmed'}
     $Receipt | Add-Member -NotePropertyName groupRevoked -NotePropertyValue $true -Force
    }
   } else {$partial=$true}
  }
  $Receipt.stage = if ($partial) {'partial-revoke'} else {'revoked'};Save-Receipt
  $result = Result $(if ($partial) {'partial'} else {'revoked'}) $(if ($partial) {'Changed entries or administrator membership retained for owner review.'} else {'Only unchanged owned key block removed; other entries retained.'})
 }
} catch {
 $result = Result $(if ($null -eq $Receipt) {'failed'} else {'partial'}) 'Windows registration rejected or incomplete; inspect owned receipt, no successful access is claimed.'
} finally {if ($null -ne $Lock) {$Lock.Dispose()}}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 15 -Compress))
if ($result.status -in @('applied','revoked')) {exit 0} else {exit 1}
