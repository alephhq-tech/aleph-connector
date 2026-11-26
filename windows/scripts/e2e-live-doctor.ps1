#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only preflight for the live AutoCAD E2E lane: reports what this machine has and what the run
  still needs, without touching anything. ASCII only: Windows PowerShell 5.1 reads a BOM-less file in
  the ANSI codepage, so any non-ASCII byte can corrupt string quoting at parse time.

.DESCRIPTION
  The live lane needs, in order: an AutoCAD install, its net48 managed reference assemblies
  (AcMgd/AcDbMgd) for the AutoCAD 2021-2024 plugin target, the installed CadAI connector (scheduled
  task + %ProgramData%\CadAI\Bridge), an installed plugin bundle, a gateway URL pointing at the local
  server, a device identity file, and repo train == installed train. Each missing item prints the
  exact next command, and the script exits 1 when a hard prerequisite is absent so a run fails fast
  instead of half-configuring the machine.

.PARAMETER ExpectOnline
  Also require health.json to report pluginLoaded/ipcConnected/bridgeOnline true. Off by default so a
  cold-box doctor run is not reported as broken.
#>
[CmdletBinding()]
param([switch]$ExpectOnline)
$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$blocking = @()
$warnings = @()
$notes = @()

function Step($label, $ok, $detail, $fix) {
  if ($ok) {
    if ($detail) {
      Write-Host ("  [ok]   {0} - {1}" -f $label, $detail) -ForegroundColor Green
    } else {
      Write-Host ("  [ok]   {0}" -f $label) -ForegroundColor Green
    }
  } else {
    Write-Host ("  [MISS] {0}" -f $label) -ForegroundColor Red
    if ($detail) { Write-Host ("         {0}" -f $detail) -ForegroundColor DarkGray }
    if ($fix) { Write-Host ("         fix: {0}" -f $fix) -ForegroundColor Yellow }
    $script:blocking += $label
  }
}

Write-Host '=== Aleph Connector live E2E doctor ===' -ForegroundColor Cyan
Write-Host "repo: $repoRoot"

Write-Host ''
Write-Host '--- AutoCAD ---'
$acadRoots = @(Get-ChildItem 'C:\Program Files\Autodesk' -Directory | Where-Object { $_.Name -like 'AutoCAD*' })
Step 'AutoCAD installed' ($acadRoots.Count -gt 0) (($acadRoots | ForEach-Object { $_.Name }) -join ', ') `
  'install AutoCAD 2021-2026 on this machine'

Write-Host ''
Write-Host '--- net48 plugin build references (AutoCAD 2021-2024) ---'
$netFx = @($acadRoots | Where-Object { $_.Name -match 'AutoCAD 202[1-4]' } |
  Where-Object { (Test-Path (Join-Path $_.FullName 'AcMgd.dll')) -and (Test-Path (Join-Path $_.FullName 'AcDbMgd.dll')) }) |
  Select-Object -First 1
Step 'AcMgd.dll + AcDbMgd.dll resolvable' ($null -ne $netFx) $(if ($netFx) { $netFx.FullName } else { 'no AutoCAD 2021-2024 dir with managed refs' }) `
  'an AutoCAD 2021-2024 install (or extracted ObjectARX SDK) must exist for the net48 target'
$acadMajor = 0
if ($acadRoots.Count -gt 0) {
  $tail = (($acadRoots[0].Name -split '\s+')[-1])
  $acadMajor = [int]$tail
}
if ($acadMajor -ge 2025 -and $null -eq $netFx) {
  $notes += "AutoCAD $acadMajor loads the net8.0-windows plugin generation; net48 refs are not needed."
}

Write-Host ''
Write-Host '--- installed connector + plugin bundle ---'
$bridgeDir = Join-Path $env:ProgramData 'CadAI\Bridge'
$bundleDir = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\CadAI.bundle'
$repairBundle = Join-Path $bridgeDir 'CadAI.bundle'
Step 'Bridge installed' (Test-Path (Join-Path $bridgeDir 'CadAI.Bridge.exe')) $bridgeDir `
  'run windows\scripts\package-client.ps1 then its install.ps1 once'
Step 'plugin bundle installed' (Test-Path (Join-Path $bundleDir 'current.json')) $bundleDir `
  'the client installer stages the bundle; see windows\autocad-plugin\README.md'

$task = @(schtasks /query /tn 'CadAI Bridge' 2>$null | Select-String 'CadAI Bridge')
Step 'CadAI Bridge scheduled task' ($task.Count -gt 0) '' 'install.ps1 registers it'

Write-Host ''
Write-Host '--- repo train vs installed train ---'
function Read-Const($path, $name) {
  $pattern = '{0}\s*=\s*"([^"]+)"' -f $name
  $m = @(Select-String -Path $path -Pattern $pattern) | Select-Object -First 1
  if (-not $m) { return $null }
  return $m.Matches[0].Groups[1].Value
}
$repoBridge = Read-Const (Join-Path $repoRoot 'windows\connector\BridgeConfig.cs') 'BridgeVersion'
$repoPlugin = Read-Const (Join-Path $repoRoot 'windows\autocad-plugin\PluginState.cs') 'PluginVersion'
Step 'repo version constants agree' ($repoBridge -and ($repoBridge -eq $repoPlugin)) "Bridge=$repoBridge Plugin=$repoPlugin" `
  'bump windows\connector\BridgeConfig.cs and windows\autocad-plugin\PluginState.cs together'
$installedTrain = $null
if (Test-Path (Join-Path $bundleDir 'current.json')) {
  $installedTrain = (Get-Content (Join-Path $bundleDir 'current.json') -Raw | ConvertFrom-Json).current
}
Step 'installed train equals repo train' ($installedTrain -and ($installedTrain -eq $repoPlugin)) "installed=$installedTrain repo=$repoPlugin" `
  'run windows\scripts\refresh-dev-client.ps1 (AutoCAD closed for net48)'
foreach ($b in @($bundleDir, $repairBundle)) {
  $cur = Join-Path $b 'current.json'
  if (Test-Path $cur) {
    $notes += "current.json: $b -> $((Get-Content $cur -Raw).Trim())"
  }
}

Write-Host ''
Write-Host '--- gateway target + device identity ---'
$gatewayUrl = [Environment]::GetEnvironmentVariable('CADAI_GATEWAY_URL', 'User')
if (-not $gatewayUrl) { $gatewayUrl = [Environment]::GetEnvironmentVariable('CADAI_GATEWAY_URL', 'Machine') }
Step 'CADAI_GATEWAY_URL set for the connector' ([bool]$gatewayUrl) $(if ($gatewayUrl) { $gatewayUrl } else { 'unset' }) `
  '[Environment]::SetEnvironmentVariable("CADAI_GATEWAY_URL","ws://127.0.0.1:8080/device","User")'
if ($gatewayUrl -and $gatewayUrl -notmatch '127\.0\.0\.1|localhost') {
  $warnings += "CADAI_GATEWAY_URL points off-box ($gatewayUrl); the live lane expects a local server."
}
$identityPath = Join-Path $env:LOCALAPPDATA 'CadAI\bridge\identity.json'
Step 'connector identity.json exists' (Test-Path $identityPath) $identityPath `
  'the local runtime writes it at startup: bun run apps\mcp-server\src\index.ts'

Write-Host ''
Write-Host '--- process state ---'
$acadProcs = @(Get-Process acad -ErrorAction SilentlyContinue)
if ($acadProcs.Count -eq 0) {
  $notes += 'no AutoCAD running: fine, the lane opens its own scratch drawing.'
} else {
  $notes += "AutoCAD running (PID $($acadProcs.Id -join ',')): net48 plugin DLLs are locked - close it before refresh-dev-client.ps1, and never force-kill an unsaved drawing."
}
$bridgeProcs = @(Get-Process CadAI.Bridge -ErrorAction SilentlyContinue)
if ($bridgeProcs.Count -eq 0) { $notes += 'CadAI.Bridge not running: start it with schtasks /Run /tn "CadAI Bridge".' }

Write-Host ''
Write-Host '--- bridge health ---'
$healthPath = Join-Path $bridgeDir 'health.json'
if (Test-Path $healthPath) {
  $health = Get-Content $healthPath -Raw | ConvertFrom-Json
  Write-Host ("  bridgeVersion={0} pluginLoaded={1} ipcConnected={2} bridgeOnline={3} recoveryPending={4}" -f `
      $health.bridgeVersion, $health.pluginLoaded, $health.ipcConnected, $health.bridgeOnline, $health.recoveryPending)
  if ($health.credentialExpiresAt) {
    Write-Host ("  credentialExpiresAt={0}" -f ([DateTimeOffset]::FromUnixTimeSeconds($health.credentialExpiresAt).LocalDateTime))
  }
  if ($ExpectOnline -and -not ($health.pluginLoaded -and $health.ipcConnected -and $health.bridgeOnline)) {
    Step 'stack online (health.json)' $false "pluginLoaded=$($health.pluginLoaded) ipc=$($health.ipcConnected) online=$($health.bridgeOnline)" `
      'start the local runtime (bun run apps\mcp-server\src\index.ts), then restart the Bridge task'
  }
} else {
  $notes += 'health.json not readable (the Bridge has never started?).'
}

Write-Host ''
Write-Host '--- local runtime entrypoint ---'
$runtimeEntry = Join-Path $repoRoot 'apps\mcp-server\src\index.ts'
Step 'local runtime entrypoint exists' (Test-Path $runtimeEntry) $runtimeEntry `
  'the repo checkout is missing apps\mcp-server\src\index.ts'
$sidecar = Join-Path $repoRoot 'apps\mcp-server\dist\aleph-mcp.exe'
if (Test-Path $sidecar) {
  $notes += "compiled sidecar present: $sidecar (the desktop app manages this one)."
}

Write-Host ''
foreach ($n in $notes) { Write-Host "  note: $n" -ForegroundColor DarkGray }
foreach ($w in $warnings) { Write-Host "  warn: $w" -ForegroundColor Yellow }

if ($blocking.Count -gt 0) {
  Write-Host ''
  Write-Host ("BLOCKED - {0} prerequisite(s) missing: {1}" -f $blocking.Count, ($blocking -join '; ')) -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host 'READY for the live lane.' -ForegroundColor Green
exit 0
