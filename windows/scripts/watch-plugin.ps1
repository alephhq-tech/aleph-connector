#Requires -Version 5.1
<#
.SYNOPSIS
    Watches the AutoCAD plugin's C# source, auto-rebuilds on save, and auto-deploys the built
    DLLs into the locally-installed per-user AutoCAD bundle - removing the manual
    "dotnet build -> copy DLL -> remember CADAIRELOAD or restart AutoCAD" cycle.

.DESCRIPTION
    net8.0-windows / net10.0-windows (AutoCAD 2025+) use a collectible AssemblyLoadContext, so
    CADAIRELOAD inside AutoCAD's command line hot-swaps the new DLL without closing AutoCAD.
    net48 (AutoCAD 2021-2024) has no AssemblyLoadContext in .NET Framework - there is NO way to
    hot-swap it from any script; AutoCAD must be closed and reopened to pick up a new build. This
    script does not pretend otherwise: it auto-builds and auto-deploys for every generation it
    can, and tells you exactly which action (CADAIRELOAD vs. restart AutoCAD) each generation
    still needs after a build.

    On every detected .cs change under autocad-plugin/ (debounced 500ms so a multi-file save /
    format-on-save doesn't trigger a build per file):
      1. Rebuilds each target framework this workstation can actually produce (net8.0-windows
         always; net48 only if a local AutoCAD 2021-2024 install is detected, matching
         package-client.ps1's own auto-detection; net10.0-windows only if the .NET 10 SDK is
         installed).
      2. Copies the built DLL (+ PDB + dependent assemblies) into
         %APPDATA%\Autodesk\ApplicationPlugins\CadAI.bundle\Versions\<PluginVersion>\<tfm>\.
      3. If the copy fails because AutoCAD has that generation's DLL locked, reports that plainly
         instead of silently leaving a half-updated bundle.
      4. Prints the exact next action per generation: "type CADAIRELOAD in AutoCAD" for
         net8.0-windows/net10.0-windows, "close and reopen AutoCAD" for net48.

.EXAMPLE
    # Terminal: Aleph Connector/windows
    .\scripts\watch-plugin.ps1
#>
param()

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$autocadRoot = Resolve-Path (Join-Path $scriptRoot '..')
$pluginCsproj = Join-Path $autocadRoot 'autocad-plugin\CadAI.AutoCAD.csproj'
$bundleTarget = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\CadAI.bundle'

# PluginVersion must match autocad-plugin/PluginState.cs's constant.
$pluginStatePath = Join-Path $autocadRoot 'autocad-plugin\PluginState.cs'
$pluginVersionMatch = Select-String -Path $pluginStatePath -Pattern 'PluginVersion\s*=\s*"([^"]+)"' | Select-Object -First 1
if (-not $pluginVersionMatch) { throw "Could not read PluginVersion from $pluginStatePath" }
$pluginVersion = $pluginVersionMatch.Matches[0].Groups[1].Value
Write-Host "Plugin version: $pluginVersion (bundle target: $bundleTarget\Versions\$pluginVersion\)" -ForegroundColor Cyan

function Get-BuildableFrameworks {
    $tfms = @('net8.0-windows')
    $net48Candidates = Get-ChildItem 'C:\Program Files\Autodesk' -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'AutoCAD 202[1-4]' }
    if ($net48Candidates) {
        $ref = $net48Candidates | Select-Object -First 1
        if ((Test-Path (Join-Path $ref.FullName 'AcMgd.dll')) -and (Test-Path (Join-Path $ref.FullName 'AcDbMgd.dll'))) {
            $env:AutoCadNetFxRefDir = $ref.FullName
            $tfms = @('net48') + $tfms
            Write-Host "  net48 ref dir: $($ref.FullName)" -ForegroundColor DarkGray
        }
    }
    $net10Sdks = & dotnet --list-sdks 2>$null | Where-Object { $_ -match '^10\.' }
    if ($net10Sdks) {
        $tfms += 'net10.0-windows'
    }
    return $tfms
}

function Build-And-Deploy {
    param([string[]]$Frameworks)

    foreach ($tfm in $Frameworks) {
        Write-Host "==> Building $tfm ..." -ForegroundColor Cyan
        $buildOutput = & dotnet build $pluginCsproj -p:TargetFrameworks=$tfm --nologo -v q 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host $buildOutput -ForegroundColor Red
            Write-Warning "$tfm build FAILED - not deploying. Fix the error above and save again."
            continue
        }

        $outDir = Join-Path $autocadRoot "autocad-plugin\bin\Debug\$tfm"
        if (-not (Test-Path $outDir)) {
            Write-Warning "$tfm built but output dir not found: $outDir"
            continue
        }

        $destDir = Join-Path $bundleTarget "Versions\$pluginVersion\$tfm"
        if (-not (Test-Path $destDir)) {
            Write-Warning "$tfm has no installed bundle folder at $destDir - run scripts/package-client.ps1 once first to install this generation."
            continue
        }

        try {
            Copy-Item -Path (Join-Path $outDir '*') -Destination $destDir -Recurse -Force -ErrorAction Stop
            Write-Host "    Deployed $tfm -> $destDir" -ForegroundColor Green
            if ($tfm -eq 'net48') {
                Write-Host "    ACTION NEEDED: net48 has no hot reload - close and reopen AutoCAD to load this build." -ForegroundColor Yellow
            }
            else {
                Write-Host "    ACTION NEEDED: type CADAIRELOAD in AutoCAD's command line to load this build." -ForegroundColor Yellow
            }
        }
        catch {
            if ($tfm -eq 'net48') {
                Write-Warning "$tfm DLL is locked (AutoCAD 2021-2024 has it loaded) - built but NOT deployed. Close AutoCAD, then save again (or rerun this script) to deploy."
            }
            else {
                Write-Warning "$tfm DLL is locked - built but NOT deployed. Close AutoCAD or free the file, then save again."
            }
        }
    }
}

$frameworks = Get-BuildableFrameworks
Write-Host "Watching for changes: $($frameworks -join ', ')" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray

# Initial build+deploy so the watcher starts from a known-current state.
Build-And-Deploy -Frameworks $frameworks

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = Join-Path $autocadRoot 'autocad-plugin'
$watcher.IncludeSubdirectories = $true
$watcher.Filter = '*.cs'
$watcher.EnableRaisingEvents = $true

$lastTrigger = [DateTime]::MinValue
$debounceMs = 500

try {
    while ($true) {
        $result = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::Changed -bor [System.IO.WatcherChangeTypes]::Created, 1000)
        if ($result.TimedOut) { continue }
        if ($result.Name -match '\\bin\\|\\obj\\') { continue }

        $now = Get-Date
        if (($now - $lastTrigger).TotalMilliseconds -lt $debounceMs) { continue }
        $lastTrigger = $now

        Start-Sleep -Milliseconds $debounceMs
        Write-Host ""
        Write-Host "--- Change detected: $($result.Name) ---" -ForegroundColor Magenta
        Build-And-Deploy -Frameworks $frameworks
    }
}
finally {
    $watcher.Dispose()
}
