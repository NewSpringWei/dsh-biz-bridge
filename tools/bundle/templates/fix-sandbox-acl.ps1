# fix-sandbox-acl.ps1 -- repair the Windows ACL precondition that stops the DSH
# sandbox from provisioning a session workspace.
#
# Symptom it fixes: an agent tool call fails with
#     Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)
# The DSH sandbox must set BOTH the owner and the DACL of a workspace, while a
# directory created under a volume root normally grants a non-elevated user only
# "Modify" -- which does not include WRITE_OWNER. This script grants the current
# user FullControl (which does include it), inheritable by new children.
#
# It changes no owner, removes nothing, and prints the exact rollback command.
# Output is ASCII only: the console code page may be GBK, and Windows PowerShell
# 5.1 mis-decodes a non-ASCII script body saved without a BOM.
#
# Usage (normally via fix-sandbox-acl.cmd, which passes arguments through):
#     fix-sandbox-acl.cmd            check only, change nothing
#     fix-sandbox-acl.cmd --fix      apply the grant
#
# Exit codes: 0 = nothing to do / all fixed, 1 = check found work to do,
#             2 = bundle layout not recognised.

[CmdletBinding()]
param(
  [switch]$Fix,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

# Default: the bundle root (this script ships beside the launchers). -Root exists
# for advanced use and for self-testing the script against another tree.
if ([string]::IsNullOrWhiteSpace($Root)) {
  $root = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
  $root = (Resolve-Path -LiteralPath $Root).Path
}
$me = "$env:USERDOMAIN\$env:USERNAME"
$full = [System.Security.AccessControl.FileSystemRights]::FullControl

$targets = @(
  @(
    $root,
    (Join-Path $root 'runtime'),
    (Join-Path $root 'runtime\workspace')
  ) | Where-Object { Test-Path -LiteralPath $_ }
)

if ($targets.Count -eq 0) {
  Write-Host "ERROR: cannot find the bundle layout under $root" -ForegroundColor Red
  exit 2
}

Write-Host "bundle : $root"
Write-Host "user   : $me"
if ($Fix) { Write-Host "mode   : FIX" } else { Write-Host "mode   : CHECK (no changes)" }
Write-Host ""

function Test-MyFullControl([string]$path) {
  $acl = Get-Acl -LiteralPath $path
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne 'Allow') { continue }
    try { $id = $ace.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value }
    catch { $id = $ace.IdentityReference.Value }
    if ($id -ne $me) { continue }
    if (($ace.FileSystemRights -band $full) -eq $full) { return $true }
  }
  return $false
}

$needsFix = @()
foreach ($path in $targets) {
  if (Test-MyFullControl $path) {
    Write-Host "[ok]    $path"
  } else {
    Write-Host "[need]  $path"
    $needsFix += $path
  }
}

if ($needsFix.Count -eq 0) {
  Write-Host ""
  Write-Host "Nothing to do: the sandbox precondition is already satisfied."
  exit 0
}

if (-not $Fix) {
  Write-Host ""
  Write-Host "$($needsFix.Count) path(s) need the grant. Re-run with --fix to apply it."
  exit 1
}

Write-Host ""
$failed = @()
foreach ($path in $needsFix) {
  try {
    $acl = Get-Acl -LiteralPath $path
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $me, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
    if (Test-MyFullControl $path) {
      Write-Host "[fixed] $path"
    } else {
      Write-Host "[FAIL]  $path  (grant did not verify)"
      $failed += $path
    }
  } catch {
    Write-Host "[FAIL]  $path"
    Write-Host "        $($_.Exception.Message)"
    Write-Host "        If access was denied, run this script from an elevated prompt."
    $failed += $path
  }
}

Write-Host ""
Write-Host "Rollback (removes only the grant this script added):"
foreach ($path in $needsFix) {
  Write-Host "  icacls `"$path`" /remove:g `"$me`""
}

if ($failed.Count -gt 0) {
  Write-Host ""
  Write-Host "$($failed.Count) path(s) still failing -- see the messages above."
  exit 1
}

Write-Host ""
Write-Host "Done. Restart dsh-biz-bridge.cmd so the sandbox can provision workspaces."
exit 0
