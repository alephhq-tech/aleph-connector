<#
.SYNOPSIS
  Dev-only refresh of the INSTALLED AutoCAD client (Bridge + Plugin/Bootstrap) from the current
  working tree, without running the full package-client/installer flow.

.DESCRIPTION
  Development must run against the same installed Bridge Scheduled Task as production (see
  docs/RUN_DEV.md) - so after editing Bridge/Plugin C# you rebuild and push it into the installed
  locations:
    bridge   -> %ProgramData%\CadAI\Bridge\          (task files + component-version.json stamp)
    plugin   -> %APPDATA%\Autodesk\ApplicationPlugins\CadAI.bundle\Versions\<train>\<tfm>\ (+ Bootstrap)
  and flip the bundle's current.json to <train>. <train> is read from the two version constants
  (BridgeConfig.BridgeVersion and PluginState.PluginVersion), which package-client.ps1 keeps equal
  across the release; a mismatch here aborts instead of shipping a half-bumped pair.

  The script stops the 'CadAI Bridge' task before touching its files (the exe is locked while
  running) and restarts it afterwards; the task-started Bridge keeps reading the Desktop-
  provisioned credential from %LOCALAPPDATA%\CadAI\bridge\identity.json. Plugin DLLs are locked
  while AutoCAD is open: net48 (AutoCAD 2021-2024) cannot hot-swap at all, net8.0-windows /
  net10.0-windows take the new build after CADAIRELOAD. The script checks and reports exactly
  what still needs a manual step - it never pretends AutoCAD picked up the change.

.EXAMPLE
  .\scripts\refresh-dev-client.ps1
#>
$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$autocadRoot = Resolve-Path (Join-Path $scriptRoot '..')
$taskName = 'CadAI Bridge'

function Read-Const($path, $name) {
  $m = Select-String -Path $path -Pattern ('{0}\s*=\s*"([^"]+)"' -f $name) | Select-Object -First 1
  if (-not $m) { throw "Could not read $name from $path" }
  $m.Matches[0].Groups[1].Value
}

$bridgeVersion = Read-Const (Join-Path $autocadRoot 'bridge\BridgeConfig.cs') 'BridgeVersion'
$pluginVersion = Read-Const (Join-Path $autocadRoot 'plugin\PluginState.cs') 'PluginVersion'
if ($bridgeVersion -ne $pluginVersion) {
  throw "Version train mismatch: BridgeConfig.BridgeVersion=$bridgeVersion vs PluginState.PluginVersion=$pluginVersion - bump both together (package-client.ps1 refuses the pair otherwise)."
}
$train = $bridgeVersion
Write-Host "==> Refreshing installed client to version $train" -ForegroundColor Cyan

$bridgeDir = Join-Path $env:ProgramData 'CadAI\Bridge'
$bundleDir = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\CadAI.bundle'
# The Bridge repairs the per-user bundle by copying THIS packaged copy (bridge/Program.cs:
# sourceBundle = <BaseDirectory>/CadAI.bundle). If a dev refresh only moves the APPDATA bundle,
# PluginRecoveryService.BundlesMatch sees the two manifests differ on the next plugin-IPC failure and
# copies the stale train back over it — the deployed build silently reverts to the previous train.
$sourceBundleDir = Join-Path $bridgeDir 'CadAI.bundle'
if (-not (Test-Path $bridgeDir)) { throw "No installed Bridge at $bridgeDir - run scripts\package-client.ps1 + install.ps1 (or Desktop's AutoCAD integration install) once first." }
if (-not (Test-Path $bundleDir)) { throw "No installed plugin bundle at $bundleDir - install the client once first."
}

# --- Bridge -----------------------------------------------------------------
$bridgeProj = Join-Path $autocadRoot 'bridge\CadAI.Bridge.csproj'
$bridgeStage = Join-Path $autocadRoot 'bridge\bin\dev-refresh\bridge'
Write-Host '==> dotnet publish bridge (Release) ...' -ForegroundColor Cyan
& dotnet publish $bridgeProj -c Release -o $bridgeStage --nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Bridge publish failed.' }
[IO.File]::WriteAllText((Join-Path $bridgeStage 'component-version.json'), (@{ version = $train } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))

Write-Host "==> Stopping the '$taskName' task ..." -ForegroundColor Cyan
schtasks /End /TN $taskName 2>&1 | Out-Null
Get-Process 'CadAI.Bridge' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
# Overwrite, don't wipe: the folder also holds updater keys and whatever else the installer staged.
Copy-Item -Path (Join-Path $bridgeStage '*') -Destination $bridgeDir -Recurse -Force
Write-Host "    Bridge -> $bridgeDir (stamp $train)" -ForegroundColor Green

# --- Plugin + Bootstrap ------------------------------------------------------
$acadRunning = [bool](Get-Process acad -ErrorAction SilentlyContinue)

$tfms = @('net8.0-windows')
$netFx = Get-ChildItem 'C:\Program Files\Autodesk' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'AutoCAD 202[1-4]' } |
  Where-Object { (Test-Path (Join-Path $_.FullName 'AcMgd.dll')) -and (Test-Path (Join-Path $_.FullName 'AcDbMgd.dll')) } |
  Select-Object -First 1
if ($netFx) {
  $env:AutoCadNetFxRefDir = $netFx.FullName
  $tfms = @('net48') + $tfms
  Write-Host "  net48 ref dir: $($netFx.FullName)" -ForegroundColor DarkGray
}

foreach ($tfm in $tfms) {
  Write-Host "==> Building plugin + Bootstrap ($tfm) ..." -ForegroundColor Cyan
  # Same single-TFM override watch-plugin.ps1 uses against the multi-target csproj.
  & dotnet build (Join-Path $autocadRoot 'plugin\Bootstrap\CadAI.AutoCAD.Bootstrap.csproj') -p:TargetFrameworks=$tfm --nologo -v q
  if ($LASTEXITCODE -ne 0) { Write-Warning "Bootstrap $tfm build FAILED - skipping $tfm."; continue }
  & dotnet build (Join-Path $autocadRoot 'plugin\CadAI.AutoCAD.csproj') -p:TargetFrameworks=$tfm --nologo -v q
  if ($LASTEXITCODE -ne 0) { Write-Warning "Plugin $tfm build FAILED - skipping $tfm."; continue }

  $bootSrc = Join-Path $autocadRoot "plugin\Bootstrap\bin\Debug\$tfm"
  $plugSrc = Join-Path $autocadRoot "plugin\bin\Debug\$tfm"
  $dest = Join-Path $bundleDir "Versions\$train\$tfm"

  # First refresh to a new train: create the version folder from the previously active one so the
  # dependency set (MessagePack, VS threading, ...) matches what the installer would have staged.
  if (-not (Test-Path $dest)) {
    $current = (Get-Content (Join-Path $bundleDir 'current.json') -Raw | ConvertFrom-Json).current
    $template = Join-Path $bundleDir "Versions\$current\$tfm"
    if (-not (Test-Path $template)) { Write-Warning "No existing $tfm folder to clone (current=$current) - run scripts\package-client.ps1 + install once for this generation."; continue }
    Copy-Item -Path (Join-Path $bundleDir "Versions\$current") $dest -Recurse
    Write-Host "    Created $dest from Versions\$current" -ForegroundColor Green
  }

  try {
    Copy-Item -Path (Join-Path $bootSrc '*') -Destination $dest -Recurse -Force -ErrorAction Stop
    Copy-Item -Path (Join-Path $plugSrc '*') -Destination $dest -Recurse -Force -ErrorAction Stop
    Write-Host "    Deployed $tfm -> $dest" -ForegroundColor Green
  } catch {
    if ($acadRunning) {
      Write-Warning "$tfm DLLs are locked by the running AutoCAD - built but NOT deployed. Close AutoCAD and rerun this script."
    } else {
      Write-Warning "$tfm copy failed: $($_.Exception.Message)"
    }
    continue
  }

  # Bootstrap lives directly under the bundle root per PackageContents.xml; refresh it too.
  try {
    Copy-Item -Path (Join-Path $bootSrc '*') -Destination (Join-Path $bundleDir "Bootstrap\$tfm") -Recurse -Force -ErrorAction Stop
  } catch { Write-Warning "Bootstrap\$tfm refresh failed (AutoCAD holds it): $($_.Exception.Message)" }

  # Mirror the same generation into the packaged source bundle, or recovery reverts the copy above.
  if (Test-Path $sourceBundleDir) {
    $srcDest = Join-Path $sourceBundleDir "Versions\$train\$tfm"
    if (-not (Test-Path $srcDest)) {
      $srcCurrent = (Get-Content (Join-Path $sourceBundleDir 'current.json') -Raw | ConvertFrom-Json).current
      $srcTemplate = Join-Path $sourceBundleDir "Versions\$srcCurrent\$tfm"
      if (-not (Test-Path $srcTemplate)) {
        Write-Warning "No $tfm folder in $sourceBundleDir to clone (current=$srcCurrent) - the repair source stays at its old train."
      } else {
        Copy-Item -Path (Join-Path $sourceBundleDir "Versions\$srcCurrent") $srcDest -Recurse
      }
    }
    if (Test-Path $srcDest) {
      try {
        Copy-Item -Path (Join-Path $bootSrc '*') -Destination $srcDest -Recurse -Force -ErrorAction Stop
        Copy-Item -Path (Join-Path $plugSrc '*') -Destination $srcDest -Recurse -Force -ErrorAction Stop
        Copy-Item -Path (Join-Path $bootSrc '*') -Destination (Join-Path $sourceBundleDir "Bootstrap\$tfm") -Recurse -Force -ErrorAction Stop
        Write-Host "    Deployed $tfm -> $srcDest (repair source)" -ForegroundColor Green
      } catch { Write-Warning "Repair-source $tfm copy failed: $($_.Exception.Message)" }
    }
  }
}

# Flip the bundle pointer only after at least one generation actually deployed. Both bundles must
# agree: PluginRecoveryService byte-compares current.json (and PackageContents.xml) between them and
# copies the source over the installed bundle when they differ.
$trainDir = Join-Path $bundleDir "Versions\$train"
if (Test-Path $trainDir) {
  $pointer = (@{ current = $train } | ConvertTo-Json -Compress)
  [IO.File]::WriteAllText((Join-Path $bundleDir 'current.json'), $pointer, (New-Object Text.UTF8Encoding $false))
  Write-Host "    bundle current.json -> $train" -ForegroundColor Green
  if (Test-Path (Join-Path $sourceBundleDir "Versions\$train")) {
    [IO.File]::WriteAllText((Join-Path $sourceBundleDir 'current.json'), $pointer, (New-Object Text.UTF8Encoding $false))
    Write-Host "    repair-source current.json -> $train" -ForegroundColor Green
  }
  foreach ($f in 'current.json','PackageContents.xml') {
    $a = Join-Path $bundleDir $f
    $s = Join-Path $sourceBundleDir $f
    if ((Test-Path $a) -and (Test-Path $s) -and -not ((Get-FileHash $a).Hash -eq (Get-FileHash $s).Hash)) {
      Write-Warning "$f differs between $bundleDir and $sourceBundleDir - recovery will copy the source over the installed bundle on the next plugin-IPC failure."
    }
  }
}

# --- Restart the installed Bridge --------------------------------------------
schtasks /Run /TN $taskName 2>&1 | Out-Null
Write-Host "==> '$taskName' restarted." -ForegroundColor Green

# --- What still needs a manual step ------------------------------------------
Write-Host ''
Write-Host 'Next actions:' -ForegroundColor Cyan
if ($acadRunning) {
  Write-Host '  - AutoCAD is OPEN: net8.0-windows/net10.0-windows picked up nothing yet. Type CADAIRELOAD in AutoCAD (only if its deploy above succeeded), or close+reopen AutoCAD to load everything (required for net48).' -ForegroundColor Yellow
} else {
  Write-Host '  - Start AutoCAD; it loads the bundle current.json version ('$train') on startup.' -ForegroundColor Yellow
}
Write-Host '  - Verify: Get-Content $env:ProgramData\CadAI\Bridge\health.json | ConvertFrom-Json | Select pluginLoaded,ipcConnected,bridgeOnline,bridgeVersion' -ForegroundColor Yellow
