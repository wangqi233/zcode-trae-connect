# Start local trae2api gateway instance(s).
# Defaults target the repo layout: the main gateway runs from this repo root;
# an optional second instance (e.g. Trae CN) runs from a separate directory.
# Existing listeners on the target ports are left alone.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/start-instances.ps1
#   # different ports / dirs:
#   powershell -ExecutionPolicy Bypass -File scripts\start-instances.ps1 `-SoloPort 19960 `-CnPort 19961
#   # point both instances at real sibling dirs (e.g. junction-based layout):
#   powershell -ExecutionPolicy Bypass -File scripts\start-instances.ps1 `-SoloDir D:\trae-solo `-CnDir D:\trae-cn
#   # single-instance deployment (skip the second instance):
#   powershell -ExecutionPolicy Bypass -File scripts\start-instances.ps1 `-CnDir $null

param(
    [int]$SoloPort = 19960,
    [int]$CnPort   = 19961,
    [string]$SoloDir = (Split-Path -Parent $PSScriptRoot),
    [string]$CnDir   = $null
)

$ErrorActionPreference = 'Continue'

function Get-ListenerPid([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { return ($conn | Select-Object -First 1).OwningProcess }
    return $null
}

function Start-Instance([string]$Name, [string]$Dir, [int]$Port) {
    $existing = Get-ListenerPid $Port
    if ($existing) {
        Write-Output "[$Name] already listening on $Port (pid $existing) - left alone"
        return
    }
    $server = Join-Path $Dir 'src\server.js'
    if (-not (Test-Path $server)) {
        Write-Output "[$Name] server.js not found at $server"
        return
    }
    $log = Join-Path $Dir 'service.log'
    # Quote the script path: it may contain spaces, and -ArgumentList joins its
    # elements with spaces before the shell sees them.
    $proc = Start-Process -FilePath 'node' -ArgumentList "`"$server`"" `
        -WorkingDirectory $Dir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Dir 'service.err.log')
    Start-Sleep -Seconds 4
    $nowListening = Get-ListenerPid $Port
    if ($nowListening) {
        Write-Output "[$Name] started on $Port (pid $nowListening)"
    } else {
        Write-Output "[$Name] FAILED to listen on $Port - see $log"
    }
}

Start-Instance -Name 'SOLO-CN' -Dir $SoloDir -Port $SoloPort
if ($CnDir) {
    Start-Instance -Name 'TRAE-CN' -Dir $CnDir -Port $CnPort
}

Write-Output ''
Write-Output 'Current state:'
$ports = @($SoloPort)
if ($CnDir) { $ports += $CnPort }
foreach ($p in $ports) {
    $owner = Get-ListenerPid $p
    if ($owner) { Write-Output ("  port {0}: pid {1}" -f $p, $owner) }
    else { Write-Output ("  port {0}: (not listening)" -f $p) }
}