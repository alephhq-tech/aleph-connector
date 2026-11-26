#Requires -Version 5.1
<#
.SYNOPSIS
    Packages all client deliverables into a single clean folder: ./dist/client/
    Ready to zip and send to end-users (never pushed to git, ignored by .gitignore).

.DESCRIPTION
    Builds the Bridge daemon, builds the AutoCAD plugin (Bootstrap + versioned assembly),
    assembles the CadAI.bundle, and bundles one-click install/uninstall scripts plus
    a client manual-install guide into:
        ./dist/client/
        ├── bridge/               <- CadAI.Bridge.exe + runtime files
        ├── CadAI.bundle/         <- Complete AutoCAD bundle ready to autoload
        ├── install.ps1           <- Automated one-click installer for client
        ├── uninstall.ps1         <- Clean uninstaller
        └── README.txt            <- Instructions for client (both 1-click and manual NETLOAD)

.PARAMETER AutoCADInstallDir
    Ignored; kept so existing invocations keep working. The net8.0-windows/net10.0-windows
    generations compile from the AutoCAD.NET NuGet packages, so no local AutoCAD install is
    read at build time for those.

.PARAMETER AutoCadNetFxRefDir
    Path to a local AutoCAD 2021-2024 install or extracted ObjectARX SDK (must contain
    AcMgd.dll/AcDbMgd.dll/AcCoreMgd.dll) — see SETUP.md, "Building the net48 (AutoCAD
    2021-2024) target". Required when RequireAllGenerations is set.

.PARAMETER IncludeNet10
    Also build/package the net10.0-windows generation. Requires the .NET 10 SDK.

.PARAMETER RequireAllGenerations
    Fail unless net48, net8.0-windows, and net10.0-windows are all built and packaged. Release
    pipelines use this so a published installer can never silently omit an advertised AutoCAD
    generation.

.PARAMETER Version
    Plugin/release version string. Defaults to the version the installer bundle template is
    pinned to (installer/autocad-bundle/CadAI.bundle/current.json), which plugin.Tests'
    PluginVersionTests and bridge.Tests' BridgeVersionTests both hold equal to the plugin's and
    the Bridge's own version constants.

.PARAMETER OutputDir
    Destination folder. Defaults to "./dist/client" at repository root.

.EXAMPLE
    .\scripts\package-client.ps1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$AutoCADInstallDir = "C:\Program Files\Autodesk\AutoCAD 2024",

    [Parameter(Mandatory = $false)]
    [string]$AutoCadNetFxRefDir = "",

    [Parameter(Mandatory = $false)]
    [switch]$IncludeNet10,

    [Parameter(Mandatory = $false)]
    [switch]$RequireAllGenerations,

    [Parameter(Mandatory = $false)]
    [string]$Version = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "",

    [Parameter(Mandatory = $false)]
    [switch]$SkipConnectorBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

# Cross-staging on Linux (release-desktop-app.yml runs this under pwsh): the Bridge needs the
# win-x64 RID or publish emits an ELF apphost, Windows TFMs need EnableWindowsTargeting, and
# Join-Path components below use forward slashes (a backslash is a literal char on Linux).
$onWindows = [Environment]::OSVersion.Platform -eq 'Win32NT'
$crossWindowsArgs = @()
if (-not $onWindows) {
    $crossWindowsArgs = @('-p:EnableWindowsTargeting=true')
}
# Bundle .NET Desktop so the Bridge works without a separate runtime installation.
$bridgePublishArgs = @('-r', 'win-x64', '--self-contained', 'true') + $crossWindowsArgs

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $repoRoot 'dist/client'
}

# A hardcoded default here drifted once already (#327): it disagreed with the template the shipped
# PackageContents.xml is copied from, so current.json and AppVersion could name different versions.
# The template is the single source of truth; BridgeVersionTests/PluginVersionTests pin the constants.
if ([string]::IsNullOrWhiteSpace($Version)) {
    $templateCurrent = Join-Path $repoRoot 'installer/autocad-bundle/CadAI.bundle/current.json'
    $Version = ([IO.File]::ReadAllText($templateCurrent) | ConvertFrom-Json).current
    if ([string]::IsNullOrWhiteSpace($Version)) {
        throw "Could not read the release version from the bundle template at $templateCurrent."
    }
    Write-Host "Release version: $Version (from the installer bundle template)"
}
# The bundle pointer, bridge protocol version and plugin version are a single CAD release train.
# Refuse an override that would advertise different files as one release.
$bridgeConfigSource = [IO.File]::ReadAllText((Join-Path $repoRoot 'connector/BridgeConfig.cs'))
$bridgeVersionMatch = [regex]::Match($bridgeConfigSource, 'BridgeVersion\s*=\s*"([0-9.]+)"')
if (-not $bridgeVersionMatch.Success -or $bridgeVersionMatch.Groups[1].Value -ne $Version) {
    throw "BridgeConfig.BridgeVersion must match packaged release version $Version."
}

# Single source of truth for the Aleph Connector update channel: consumed here, by
# .github/workflows/release-connector.yml, and pinned by connector.Tests/UpdateChannelContractTests.cs
# so the published manifest URL and the URL baked into every install.ps1 can never drift apart.
$updateChannelPath = Join-Path $repoRoot 'contracts/update-channel.json'
if (-not (Test-Path $updateChannelPath -PathType Leaf)) {
    throw "update-channel contract is missing: $updateChannelPath"
}
$updateChannel = [IO.File]::ReadAllText($updateChannelPath) | ConvertFrom-Json
foreach ($field in 'releaseHost', 'prefix', 'manifestName', 'publicKeyRepoPath', 'publicKeyPackageDir', 'publicKeyInstallSubdir') {
    if ([string]::IsNullOrWhiteSpace([string]$updateChannel.$field)) {
        throw "update-channel contract field '$field' is missing or blank in $updateChannelPath."
    }
}
$hostBase = $updateChannel.releaseHost.TrimEnd('/')
$prefixPath = '/' + $updateChannel.prefix.Trim('/')
$manifestUrl = $hostBase + $prefixPath + '/' + $updateChannel.manifestName.TrimStart('/')
$keyInstallSubdir = $updateChannel.publicKeyInstallSubdir.Trim('\')
$publicKeySource = Join-Path $repoRoot $updateChannel.publicKeyRepoPath
if (-not (Test-Path $publicKeySource -PathType Leaf)) {
    throw "Standalone update public key is missing: $publicKeySource (contract publicKeyRepoPath)."
}

Write-Host "=========================================================="
Write-Host " Packaging CadAI Client Distribution -> $OutputDir"
Write-Host "=========================================================="

# connector/ and CadAI.bundle/ are both fully regenerated below. Leaving a previous run's bundle
# behind is not cosmetic: PackageContents.xml advertises only the generations this run built, so a
# stale Bootstrap/<generation> from an earlier -RequireAllGenerations run makes a net8-only run
# stage a package that fails its own validator - and would have shipped a plugin build nobody
# compiled this time.
if (Test-Path $OutputDir) {
    Write-Host "Cleaning existing output directory..."
    foreach ($stale in 'bridge', 'CadAI.bundle', 'keys', 'AlephConnector.exe', 'agent-pack') {
        Remove-Item -Path (Join-Path $OutputDir $stale) -Recurse -Force -ErrorAction SilentlyContinue
    }
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# 1. Publish Bridge daemon
$bridgeTargetDir = Join-Path $OutputDir 'bridge'
Write-Host "`n[1/4] Publishing CadAI.Bridge.exe (Release) to bridge/ ..."
$bridgeProj = Join-Path $repoRoot 'connector/CadAI.Bridge.csproj'
& dotnet publish $bridgeProj -c Release -o $bridgeTargetDir --nologo -v q @bridgePublishArgs
if ($LASTEXITCODE -ne 0) {
    throw "Failed to publish CadAI.Bridge.csproj."
}
# A standalone Bridge does not carry a useful auto-generated assembly file version. Stamp
# the package so Desktop can compare the installed executable independently from current.json.
# The signed Tauri installer authenticates this marker together with the Bridge binary.
[IO.File]::WriteAllText(
    (Join-Path $bridgeTargetDir 'component-version.json'),
    (@{ version = $Version } | ConvertTo-Json -Compress),
    (New-Object Text.UTF8Encoding $false)
)

# The standalone update public key ships inside the signed package, next to the binaries it
# authenticates, so an install can never end up with an updater configured against a key that is
# not present on disk. Tauri bundles resources/autocad/ wholesale, so this rides along in the
# Desktop installer without any further wiring.
$publicKeyDir = Join-Path $OutputDir $updateChannel.publicKeyPackageDir
New-Item -ItemType Directory -Force -Path $publicKeyDir | Out-Null
Copy-Item -Path $publicKeySource -Destination (Join-Path $publicKeyDir 'public.pem') -Force

# The package carries no config.json. Aleph Connector onboarding provisions the gateway URL and device
# credential after owner-confirmed pairing.
# 2. Build AutoCAD plugin (Bootstrap + Versioned Plugin), per generation
$bootstrapProj = Join-Path $repoRoot 'autocad-plugin/Bootstrap/CadAI.AutoCAD.Bootstrap.csproj'
$pluginProj = Join-Path $repoRoot 'autocad-plugin/CadAI.AutoCAD.csproj'

# Auto-detect local AutoCAD 2021-2024 managed references on Windows when AutoCadNetFxRefDir was not passed explicitly
if ([string]::IsNullOrWhiteSpace($AutoCadNetFxRefDir) -and $onWindows) {
    $candidateDirs = @(
        'C:\Program Files\Autodesk\AutoCAD 2024',
        'C:\Program Files\Autodesk\AutoCAD 2023',
        'C:\Program Files\Autodesk\AutoCAD 2022',
        'C:\Program Files\Autodesk\AutoCAD 2021'
    )
    foreach ($regPath in @('HKLM:\SOFTWARE\Autodesk\AutoCAD', 'HKLM:\SOFTWARE\WOW6432Node\Autodesk\AutoCAD')) {
        if (Test-Path $regPath) {
            foreach ($sub in Get-ChildItem $regPath -ErrorAction SilentlyContinue) {
                foreach ($prod in Get-ChildItem $sub.PSPath -ErrorAction SilentlyContinue) {
                    $installDir = (Get-ItemProperty $prod.PSPath -ErrorAction SilentlyContinue).AcadLocation
                    if ($installDir -and (Test-Path $installDir)) {
                        $candidateDirs += $installDir
                    }
                }
            }
        }
    }
    foreach ($dir in ($candidateDirs | Select-Object -Unique)) {
        if ((Test-Path (Join-Path $dir 'AcMgd.dll')) -and (Test-Path (Join-Path $dir 'AcDbMgd.dll'))) {
            $AutoCadNetFxRefDir = $dir
            Write-Host "Auto-detected AutoCAD managed references for net48 at: $AutoCadNetFxRefDir"
            break
        }
    }
}
# net8.0-windows is the baseline. net48 needs Autodesk reference assemblies and net10.0-windows
# needs the .NET 10 SDK. RequireAllGenerations turns both from opt-in into release gates.
if ($RequireAllGenerations -and [string]::IsNullOrWhiteSpace($AutoCadNetFxRefDir)) {
    throw "RequireAllGenerations needs -AutoCadNetFxRefDir pointing at AutoCAD 2021-2024 or ObjectARX managed references."
}
$generations = @('net8.0-windows')
if (-not [string]::IsNullOrWhiteSpace($AutoCadNetFxRefDir)) { $generations += 'net48' }
if ($IncludeNet10 -or $RequireAllGenerations) { $generations += 'net10.0-windows' }

Write-Host "`n[2/4] Building AutoCAD Plugin DLLs for: $($generations -join ', ') ..."

$tempRoot = Join-Path $repoRoot 'dist/.temp-plugin-build'
if (Test-Path $tempRoot) { Remove-Item -Path $tempRoot -Recurse -Force }
$builtGenerations = @()

foreach ($tfm in $generations) {
    $tempBootstrap = Join-Path $tempRoot "$tfm/bootstrap"
    $tempPlugin = Join-Path $tempRoot "$tfm/plugin"
    $extraArgs = @($crossWindowsArgs)
    if ($tfm -eq 'net48') { $extraArgs += "-p:AutoCadNetFxRefDir=$AutoCadNetFxRefDir" }

    # -p:TargetFrameworks=$tfm, not -f $tfm: the SDK validates every entry in the project's
    # full TargetFrameworks list before -f narrows which one builds, so -f alone fails with
    # NETSDK1045 on a machine without the .NET 10 SDK even when building net48/net8.0-windows.
    & dotnet build $bootstrapProj -c Release -p:TargetFrameworks=$tfm -o $tempBootstrap --nologo -v q @extraArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to build Bootstrap plugin for $tfm." }

    & dotnet build $pluginProj -c Release -p:TargetFrameworks=$tfm -o $tempPlugin --nologo -v q @extraArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to build versioned plugin for $tfm." }

    $builtGenerations += @{ Name = $tfm; Bootstrap = $tempBootstrap; Plugin = $tempPlugin }
}

if (-not $RequireAllGenerations -and $generations.Count -lt 3) {
    $missing = @('net48', 'net8.0-windows', 'net10.0-windows') | Where-Object { $generations -notcontains $_ }
    Write-Host "  NOTE: this development package covers only $($generations -join ', ')."
    Write-Host "        Not built (plugin will NOT load on those AutoCAD series): $($missing -join ', ')."
    Write-Host "        Production releases must use -RequireAllGenerations."
}

# 3. Assemble CadAI.bundle
$bundleTargetDir = Join-Path $OutputDir 'CadAI.bundle'
Write-Host "`n[3/4] Assembling CadAI.bundle structure ..."

# The shipped bundle advertises only the generations this run actually built (see
# installer/autocad-bundle/write-bundle-manifest.ps1) — the master template's other
# ComponentEntry blocks point at Bootstrap folders that aren't in this package, which
# AutoCAD's Autoloader reacts to by dropping the component.
$templateManifest = Join-Path $repoRoot 'installer/autocad-bundle/CadAI.bundle/PackageContents.xml'
. (Join-Path $repoRoot 'installer/autocad-bundle/write-bundle-manifest.ps1')
$packageContentsXml = Join-Path $bundleTargetDir 'PackageContents.xml'
New-Item -ItemType Directory -Force -Path $bundleTargetDir | Out-Null
Write-BundleManifest -TemplatePath $templateManifest -OutPath $packageContentsXml `
    -Generations @($builtGenerations | ForEach-Object { $_.Name })
$currentJson = @{ current = $Version } | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $bundleTargetDir 'current.json') -Value $currentJson -NoNewline

foreach ($gen in $builtGenerations) {
    $bootstrapTarget = Join-Path $bundleTargetDir "Bootstrap/$($gen.Name)"
    $versionTarget = Join-Path $bundleTargetDir "Versions/$Version/$($gen.Name)"
    New-Item -ItemType Directory -Force -Path $bootstrapTarget | Out-Null
    New-Item -ItemType Directory -Force -Path $versionTarget | Out-Null
    Copy-Item -Path (Join-Path $gen.Bootstrap '*') -Destination $bootstrapTarget -Recurse -Force
    Copy-Item -Path (Join-Path $gen.Plugin '*') -Destination $versionTarget -Recurse -Force
}

if (Test-Path $tempRoot) { Remove-Item -Path $tempRoot -Recurse -Force }

# 4. Copy Installers & Client README
Write-Host "`n[4/4] Creating client installer scripts and instructions ..."

# Client install script (runs locally inside the client package folder)
$clientInstallScript = @'
#Requires -Version 5.1
param(
    # Aleph Connector onboarding passes the gateway URL and the device credential issued after pairing.
    # The credential goes into identity.json, not a User-scope environment variable, so it can be
    # rotated without an environment override pinning an expired token.
    [string]$GatewayUrl = "",
    [string]$DeviceId = "",
    [string]$DeviceToken = "",
    [long]$TokenExpiresAt = 0
)
$ErrorActionPreference = 'Stop'
# $PSScriptRoot có thể rỗng khi script bị gọi qua -File với đường dẫn verbatim \\?\ (bug thật
# của Windows PowerShell 5.1) — fallback sang $MyInvocation, rồi fail rõ ràng thay vì để
# Join-Path crash mù mờ với "value of argument drive is null" ở bước sau.
$pkgDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($pkgDir)) { $pkgDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($pkgDir)) { throw "Không xác định được thư mục chứa install.ps1 (both `$PSScriptRoot` and `$MyInvocation.MyCommand.Path` empty)." }
# Reject unsafe in-place upgrades before touching identity.json, environment settings or the Bridge.
# The native Desktop defers this installation too, but direct/manual script callers need the
# same fail-closed safety gate. acadcore is also used by headless AutoCAD sessions.
$activeCad = @(Get-Process -Name 'acad', 'acadcore', 'accoreconsole' -ErrorAction SilentlyContinue)
if ($activeCad.Count -gt 0) {
    throw 'Close every AutoCAD instance before updating CadAI Bridge and Plugin. No files were changed.'
}
$adminBundle = Join-Path $env:ProgramFiles 'Autodesk\ApplicationPlugins\CadAI.bundle'
if (Test-Path (Join-Path $adminBundle 'PackageContents.xml')) {
    throw "An administrator-managed CadAI.bundle exists at $adminBundle. It takes precedence over the per-user bundle. Ask your administrator to update it."
}
$packagedBridgeVersion = (Get-Content (Join-Path $pkgDir 'bridge/component-version.json') -Raw | ConvertFrom-Json).version
$packagedPluginVersion = (Get-Content (Join-Path $pkgDir 'CadAI.bundle/current.json') -Raw | ConvertFrom-Json).current
if (-not $packagedBridgeVersion -or $packagedBridgeVersion -ne $packagedPluginVersion) {
    throw "Packaged Bridge and plugin versions do not match ($packagedBridgeVersion / $packagedPluginVersion)."
}
# The safety policy applies to direct/manual installs as well as Desktop's background sync.
# Never overwrite a newer installed component with an older packaged version.
function Assert-NoDowngrade([string]$label, [string]$installed, [string]$packaged) {
    if ([string]::IsNullOrWhiteSpace($installed)) { return }
    try {
        $installedVersion = [Version]::Parse($installed)
        $packagedVersion = [Version]::Parse($packaged)
    } catch {
        throw "Cannot safely compare $label versions (installed=$installed, packaged=$packaged)."
    }
    if ($installedVersion -gt $packagedVersion) {
        throw "Refusing to downgrade $label from $installed to $packaged."
    }
}
$existingBridgeStamp = Join-Path $env:ProgramData 'CadAI\Bridge\component-version.json'
$existingPluginPointer = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\CadAI.bundle\current.json'
if (Test-Path $existingBridgeStamp) {
    $existingBridge = (Get-Content $existingBridgeStamp -Raw | ConvertFrom-Json).version
    Assert-NoDowngrade 'Bridge' $existingBridge $packagedBridgeVersion
}
if (Test-Path $existingPluginPointer) {
    $existingPlugin = (Get-Content $existingPluginPointer -Raw | ConvertFrom-Json).current
    Assert-NoDowngrade 'Plugin' $existingPlugin $packagedPluginVersion
}

Write-Host "========================================="
Write-Host " Installing CadAI Client Integration"
Write-Host "========================================="

# 1. Validate prerequisites and back up existing credential/env before any mutations.
# These will be restored if update fails during staging, activation, or startup verification.
if (-not $DeviceToken) {
    throw "No Bridge device credential. Start the local Connector runtime and run Install from Connector."
}
$identityDir = Join-Path $env:LOCALAPPDATA 'CadAI\bridge'
$identityPath = Join-Path $identityDir 'identity.json'
$identityBackup = $null
if (Test-Path $identityPath) {
    try {
        $identityBackup = [IO.File]::ReadAllText($identityPath)
    } catch {
        $identityBackup = $null
    }
}
$oldGatewayUrl = [Environment]::GetEnvironmentVariable("CADAI_GATEWAY_URL", "User")
$oldDeviceId = [Environment]::GetEnvironmentVariable("CADAI_DEVICE_ID", "User")
$oldDeviceToken = [Environment]::GetEnvironmentVariable("CADAI_DEVICE_TOKEN", "User")
$oldUpdateManifestUrl = [Environment]::GetEnvironmentVariable("CADAI_UPDATE_MANIFEST_URL", "User")
$oldUpdatePublicKeyPath = [Environment]::GetEnvironmentVariable("CADAI_UPDATER_PUBLIC_KEY_PATH", "User")
$credentialMutated = $false
$updateChannelMutated = $false


# 3. Prepare both replacement folders before stopping a running Bridge. The two complete
# source trees come from the same Tauri-signed desktop installer, never separate downloads.
$bridgeSource = Join-Path $pkgDir 'bridge'
$bundleSource = Join-Path $pkgDir 'CadAI.bundle'
$bridgeParent = Join-Path $env:ProgramData 'CadAI'
$bundleParent = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins'
$bridgeTarget = Join-Path $bridgeParent 'Bridge'
$bundleTarget = Join-Path $bundleParent 'CadAI.bundle'
$id = [Guid]::NewGuid().ToString('N')
$bridgeStage = Join-Path $bridgeParent "Bridge.stage.$id"
$bundleStage = Join-Path $bundleParent "CadAI.bundle.stage.$id"
$bridgePrevious = Join-Path $bridgeParent "Bridge.previous.$id"
$bundlePrevious = Join-Path $bundleParent "CadAI.bundle.previous.$id"
$taskName = 'CadAI Bridge'
$oldTaskXml = $null
$wasBridgeRunning = $null -ne (Get-Process -Name 'CadAI.Bridge' -ErrorAction SilentlyContinue)
$bridgeStopped = $false
$committed = $false
$hadBridge = Test-Path $bridgeTarget
$hadBundle = Test-Path $bundleTarget
$journalPath = $null

try {
    New-Item -ItemType Directory -Path $bridgeParent -Force | Out-Null
    # This file lives OUTSIDE the Bridge directory; the updater renames that directory
    # during activation. FileShare.None serializes with the C# standalone updater.
    $updateLockPath = Join-Path $bridgeParent 'client-update.lock'
    $lockDeadline = (Get-Date).AddMinutes(2)
    while ($null -eq $updateLock -and (Get-Date) -lt $lockDeadline) {
        try {
            $updateLock = [IO.File]::Open($updateLockPath, [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [System.IO.IOException] {
            Start-Sleep -Milliseconds 200
        }
    }
    if ($null -eq $updateLock) {
        throw 'Another Bridge/Plugin update holds the native update lock; refusing concurrent installation.'
    }
    New-Item -ItemType Directory -Path $bundleParent -Force | Out-Null
    New-Item -ItemType Directory -Path $bridgeStage -Force | Out-Null
    New-Item -ItemType Directory -Path $bundleStage -Force | Out-Null
    Copy-Item -Path (Join-Path $bridgeSource '*') -Destination $bridgeStage -Recurse -Force -ErrorAction Stop
    Copy-Item -Path (Join-Path $bundleSource '*') -Destination $bundleStage -Recurse -Force -ErrorAction Stop
    $bridgeBundleStage = Join-Path $bridgeStage 'CadAI.bundle'
    New-Item -ItemType Directory -Path $bridgeBundleStage -Force | Out-Null
    Copy-Item -Path (Join-Path $bundleStage '*') -Destination $bridgeBundleStage -Recurse -Force -ErrorAction Stop

    # Both staged folders must be complete before any running process or installed bundle is touched.
    $stagedBridgeVersion = (Get-Content (Join-Path $bridgeStage 'component-version.json') -Raw | ConvertFrom-Json).version
    $stagedPluginVersion = (Get-Content (Join-Path $bundleStage 'current.json') -Raw | ConvertFrom-Json).current
    if ($stagedBridgeVersion -ne $packagedBridgeVersion -or $stagedPluginVersion -ne $packagedPluginVersion) {
        throw 'Staged version markers do not match the signed package.'
    }
    if (-not (Test-Path (Join-Path $bridgeStage 'CadAI.Bridge.exe') -PathType Leaf) -or
        -not (Test-Path (Join-Path $bundleStage 'PackageContents.xml') -PathType Leaf)) {
        throw 'A staged Bridge executable or AutoCAD bundle manifest is missing.'
    }
    foreach ($generation in @(Get-ChildItem (Join-Path $bundleStage 'Bootstrap') -Directory)) {
        $versionedPlugin = Join-Path $bundleStage "Versions/$stagedPluginVersion/$($generation.Name)/CadAI.AutoCAD.dll"
        if (-not (Test-Path $versionedPlugin -PathType Leaf)) {
            throw "Staged bundle is incomplete: $versionedPlugin"
        }
    }

    # Second preflight closes the race between initial checks and staging. Never force-terminate
    # an agent's drawing session to satisfy a software update.
    if (@(Get-Process -Name 'acad', 'acadcore', 'accoreconsole' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'AutoCAD opened while staging the update; installed files were left untouched.'
    }
    $previousTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $previousTask) { $oldTaskXml = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop }

    # Terminate the old daemon only after staging succeeded and AutoCAD has closed.
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Stop-Process -Name 'CadAI.Bridge' -Force -ErrorAction SilentlyContinue
    $bridgeStopped = $true
    $deadline = (Get-Date).AddSeconds(10)
    while ($null -ne (Get-Process -Name 'CadAI.Bridge' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if ($null -ne (Get-Process -Name 'CadAI.Bridge' -ErrorAction SilentlyContinue)) {
        throw 'The running Bridge could not be stopped; no installed folders were replaced.'
    }
    if (@(Get-Process -Name 'acad', 'acadcore', 'accoreconsole' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'AutoCAD started before activation; leaving the installed bundle unchanged.'
    }

    # Apply credential and gateway configuration inside the active update lock after
    # staging and preflight checks have passed.
    if ($GatewayUrl) {
        [Environment]::SetEnvironmentVariable("CADAI_GATEWAY_URL", $GatewayUrl, "User")
        # Avoid "$var (User ...)" inside double quotes - PS 5.1 can parse (User) as a command
        # when the script file encoding mis-reads Unicode dashes earlier in the file.
        Write-Host ("CADAI_GATEWAY_URL set to {0} (User scope)" -f $GatewayUrl)
    }
    if (-not $DeviceId) {
        # Prefer an existing paired identity; otherwise mint a stable local deviceId for portal pairing.
        if ($identityBackup) {
            try { $DeviceId = ((ConvertFrom-Json $identityBackup).deviceId) } catch { $DeviceId = '' }
        }
        if (-not $DeviceId) { $DeviceId = 'device_' + ([Guid]::NewGuid().ToString('N')) }
    }
    if ($DeviceId) { [Environment]::SetEnvironmentVariable("CADAI_DEVICE_ID", $null, "User") }
    [Environment]::SetEnvironmentVariable("CADAI_DEVICE_TOKEN", $null, "User")
    New-Item -ItemType Directory -Force -Path $identityDir | Out-Null
    $identityJson = [ordered]@{ deviceId = $DeviceId; token = $DeviceToken }
    if ($TokenExpiresAt -gt 0) { $identityJson.tokenExpiresAt = $TokenExpiresAt }
    # Write BOM-less UTF-8 for strict JSON readers.
    [IO.File]::WriteAllText($identityPath, ($identityJson | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    $credentialMutated = $true
    Write-Host "Bridge credential written to $identityPath"

    # Standalone signed update channel. The manifest URL and verification key come from the
    # update-channel contract at packaging time; the key ships in this package.
    $publicKeySourcePath = Join-Path $pkgDir 'keys/public.pem'
    if (-not (Test-Path $publicKeySourcePath -PathType Leaf)) {
        throw "Standalone update public key is missing from this package: $publicKeySourcePath"
    }
    $keyInstallDir = Join-Path $env:ProgramData '{{KEY_INSTALL_SUBDIR}}'
    New-Item -ItemType Directory -Force -Path $keyInstallDir | Out-Null
    Copy-Item -Path $publicKeySourcePath -Destination (Join-Path $keyInstallDir 'public.pem') -Force
    $publicKeyInstallPath = Join-Path $keyInstallDir 'public.pem'
    [Environment]::SetEnvironmentVariable("CADAI_UPDATE_MANIFEST_URL", '{{MANIFEST_URL}}', "User")
    [Environment]::SetEnvironmentVariable("CADAI_UPDATER_PUBLIC_KEY_PATH", $publicKeyInstallPath, "User")
    $updateChannelMutated = $true
    Write-Host "Standalone CAD update channel enabled (manifest {{MANIFEST_URL}})"

    # 3b. Crash-safe transaction journal. Written BEFORE the first directory rename so a power
    # loss / process kill mid-activation leaves a durable record the next Desktop launch replays
    # (aleph_host::autocad_journal::reconciliation_actions restores .previous backups and discards
    # stray staged trees). Deleted on the verified-commit path and in the finally block once any
    # rollback has completed.
    $journalPath = Join-Path $bridgeParent 'client-activation.json'
    $journal = [ordered]@{
        id            = $id
        bridge        = [ordered]@{ target = $bridgeTarget; stage = $bridgeStage; previous = $bridgePrevious }
        bundle        = [ordered]@{ target = $bundleTarget; stage = $bundleStage; previous = $bundlePrevious }
        bridgeVersion = $packagedBridgeVersion
        pluginVersion = $packagedPluginVersion
    }
    [IO.File]::WriteAllText($journalPath, ($journal | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

    # Renames within the same volume are atomic at the directory-entry level. The old
    # directories remain available for rollback until Bridge startup is verified.
    if (Test-Path $bridgeTarget) { Rename-Item -LiteralPath $bridgeTarget -NewName "Bridge.previous.$id" -ErrorAction Stop }
    Rename-Item -LiteralPath $bridgeStage -NewName 'Bridge' -ErrorAction Stop
    if (Test-Path $bundleTarget) { Rename-Item -LiteralPath $bundleTarget -NewName "CadAI.bundle.previous.$id" -ErrorAction Stop }
    Rename-Item -LiteralPath $bundleStage -NewName 'CadAI.bundle' -ErrorAction Stop

    $exePath = Join-Path $bridgeTarget 'CadAI.Bridge.exe'
    $action = New-ScheduledTaskAction -Execute $exePath -WorkingDirectory $bridgeTarget
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

    if ($null -ne $previousTask) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop | Out-Null
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'CadAI Bridge daemon' -ErrorAction Stop | Out-Null
    $startTimeUtc = (Get-Date).ToUniversalTime()
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

    $deadline = (Get-Date).AddSeconds(12)
    while ($null -eq (Get-Process -Name 'CadAI.Bridge' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
    }
    if ($null -eq (Get-Process -Name 'CadAI.Bridge' -ErrorAction SilentlyContinue)) {
        throw 'The new Bridge did not start; restoring the previous installation.'
    }

    # A process can exist but die before loading the gateway and health reporter. Verify a
    # FRESH snapshot written by the new Bridge version, not merely an executable on disk.
    $healthPath = Join-Path $bridgeParent 'bridge/health.json'
    $healthVerified = $false
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if ($null -eq (Get-Process -Name 'CadAI.Bridge' -ErrorAction SilentlyContinue)) {
            throw 'The new Bridge exited before publishing health; rolling back.'
        }
        try {
            if (Test-Path $healthPath) {
                $report = Get-Content $healthPath -Raw | ConvertFrom-Json
                $modifiedUtc = (Get-Item $healthPath).LastWriteTimeUtc
                if ($report.bridgeVersion -eq $packagedBridgeVersion -and $modifiedUtc -ge $startTimeUtc) {
                    $healthVerified = $true
                    break
                }
            }
        } catch {
            # The Bridge writes a temporary file and atomically replaces the health report.
            # A transient read error while the file is being swapped is safe to retry.
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthVerified) {
        throw "Bridge did not publish a current health snapshot for version $packagedBridgeVersion; restoring previous installation."
    }
    if ((Get-Content (Join-Path $bridgeTarget 'component-version.json') -Raw | ConvertFrom-Json).version -ne $packagedBridgeVersion -or
        (Get-Content (Join-Path $bundleTarget 'current.json') -Raw | ConvertFrom-Json).current -ne $packagedPluginVersion) {
        throw 'Installed version markers differ from the signed package; restoring previous installation.'
    }

    $committed = $true
    Write-Host "Bridge and Plugin $packagedPluginVersion installed and Bridge process verified."
}
catch {
    $originalError = $_.Exception.Message
    $rollbackErrors = @()
    if ($bridgeStopped) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Stop-Process -Name 'CadAI.Bridge' -Force -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds(10)
        while ($null -ne (Get-Process -Name 'CadAI.Bridge' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 250
        }
    }

    # Only swap-back directories when a previous directory really exists. A failed staging
    # step, before any rename, must never delete the still-working installation.
    try {
        if (Test-Path $bundlePrevious) {
            if (Test-Path $bundleTarget) { Remove-Item -LiteralPath $bundleTarget -Recurse -Force -ErrorAction Stop }
            Rename-Item -LiteralPath $bundlePrevious -NewName 'CadAI.bundle' -ErrorAction Stop
        } elseif (-not $hadBundle -and (Test-Path $bundleTarget)) {
            Remove-Item -LiteralPath $bundleTarget -Recurse -Force -ErrorAction Stop
        }
    } catch { $rollbackErrors += "Plugin: $($_.Exception.Message)" }
    try {
        if (Test-Path $bridgePrevious) {
            if (Test-Path $bridgeTarget) { Remove-Item -LiteralPath $bridgeTarget -Recurse -Force -ErrorAction Stop }
            Rename-Item -LiteralPath $bridgePrevious -NewName 'Bridge' -ErrorAction Stop
        } elseif (-not $hadBridge -and (Test-Path $bridgeTarget)) {
            Remove-Item -LiteralPath $bridgeTarget -Recurse -Force -ErrorAction Stop
        }
    } catch { $rollbackErrors += "Bridge: $($_.Exception.Message)" }

    if ($bridgeStopped) {
        try {
            if ($null -ne $oldTaskXml) {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
                Register-ScheduledTask -TaskName $taskName -Xml $oldTaskXml -ErrorAction Stop | Out-Null
                if ($wasBridgeRunning) { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop }
            } else {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
            }
        } catch { $rollbackErrors += "Scheduled Task: $($_.Exception.Message)" }
    }
    if ($credentialMutated) {
        try {
            if ($null -ne $identityBackup) {
                [IO.File]::WriteAllText($identityPath, $identityBackup, (New-Object Text.UTF8Encoding $false))
            } elseif (Test-Path $identityPath) {
                Remove-Item -LiteralPath $identityPath -Force -ErrorAction SilentlyContinue
            }
            [Environment]::SetEnvironmentVariable("CADAI_GATEWAY_URL", $oldGatewayUrl, "User")
            if ($null -ne $oldDeviceId) {
                [Environment]::SetEnvironmentVariable("CADAI_DEVICE_ID", $oldDeviceId, "User")
            }
            if ($null -ne $oldDeviceToken) {
                [Environment]::SetEnvironmentVariable("CADAI_DEVICE_TOKEN", $oldDeviceToken, "User")
            }
        } catch { $rollbackErrors += "Credential: $($_.Exception.Message)" }
    }

    # The public key file stays where it was: it is the same committed key for every package, and
    # an unreferenced file is inert — the Bridge only reads it through the env var restored here.
    if ($updateChannelMutated) {
        try {
            [Environment]::SetEnvironmentVariable("CADAI_UPDATE_MANIFEST_URL", $oldUpdateManifestUrl, "User")
            [Environment]::SetEnvironmentVariable("CADAI_UPDATER_PUBLIC_KEY_PATH", $oldUpdatePublicKeyPath, "User")
        } catch { $rollbackErrors += "Update channel: $($_.Exception.Message)" }
    }


    $rollbackDetail = if ($rollbackErrors.Count -gt 0) { "Rollback warnings: $($rollbackErrors -join '; ')" } else { 'Old installation restored where available.' }

    # Journal lifecycle: on rollback, delete the journal only when rollback was clean. If any
    # rollback step errored, the journal is kept so the next Desktop launch's reconciliation
    # replays the same restore deterministically instead of guessing from directory names.
    if ($null -ne $journalPath -and $rollbackErrors.Count -eq 0) {
        Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue
    }
    throw "CadAI update failed: $originalError. $rollbackDetail"
}
finally {
    # Keep .previous folders if rollback itself failed; otherwise remove staging and old
    # backups only after a verified commit (no stale directories accumulating every release).
    foreach ($temp in @($bridgeStage, $bundleStage)) {
        if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if ($committed) {
        foreach ($old in @($bridgePrevious, $bundlePrevious)) {
            if (Test-Path $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if ($null -ne $journalPath -and (Test-Path $journalPath)) {
            Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $updateLock) { $updateLock.Dispose() }
}

Write-Host "`n========================================="
Write-Host " Installation Complete!"
Write-Host " Open AutoCAD to use the integration."
Write-Host "========================================="
'@

# Literal here-strings cannot carry the contract values (they would be evaluated at packager-parse
# time), so install.ps1/uninstall.ps1 keep {{…}} markers replaced here — the same mechanism the
# README's {{VERSION}} uses — with the manifest URL and key path read from update-channel.json.
function Expand-UpdateChannel([string]$scriptText) {
    $scriptText -replace '\{\{MANIFEST_URL\}\}', $manifestUrl -replace '\{\{KEY_INSTALL_SUBDIR\}\}', $keyInstallSubdir
}
# UTF-8 with BOM so Windows PowerShell 5.1 -File does not misread Unicode as ANSI
# (UTF-8 em-dash bytes otherwise become a stray quote and break later strings).
$installPs1Path = Join-Path $OutputDir 'install.ps1'
[System.IO.File]::WriteAllText(
    $installPs1Path,
    (Expand-UpdateChannel $clientInstallScript),
    (New-Object System.Text.UTF8Encoding $true)
)

# Client uninstall script
$clientUninstallScript = @'
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
Write-Host "Uninstalling CadAI Client Integration..."
$acad = Get-Process -Name "acad" -ErrorAction SilentlyContinue
if ($acad) {
    Write-Warning "AutoCAD is running - please close AutoCAD to allow deleting plugin DLLs."
}
Unregister-ScheduledTask -TaskName "CadAI Bridge" -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Stop-Process -Name "CadAI.Bridge" -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:ProgramData 'CadAI\Bridge') -Recurse -Force -ErrorAction SilentlyContinue
# The Bridge credential lives in the user's LOCALAPPDATA, so removing only ProgramData would leave
# a live 14-day token (and the gateway URL) behind after an uninstall.
Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'CadAI\bridge') -Recurse -Force -ErrorAction SilentlyContinue
foreach ($name in 'CADAI_GATEWAY_URL', 'CADAI_DEVICE_ID', 'CADAI_DEVICE_TOKEN', 'CADAI_UPDATE_MANIFEST_URL', 'CADAI_UPDATER_PUBLIC_KEY_PATH') {
    [Environment]::SetEnvironmentVariable($name, $null, "User")
}
# install.ps1 copies the standalone-update public key under %ProgramData%; a leftover key beside a
# removed Bridge would let a stale env var (or a manual run) verify packages against an orphan file.
Remove-Item -Path (Join-Path $env:ProgramData '{{KEY_INSTALL_SUBDIR}}') -Recurse -Force -ErrorAction SilentlyContinue
$bundleDir = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\CadAI.bundle'
if (Test-Path $bundleDir) {
    Remove-Item -Path $bundleDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $bundleDir) {
        Write-Warning "Could not delete CadAI.bundle completely because files are locked."
    }
}

# install.ps1 leaves this folder in AutoCAD's per-profile TRUSTEDPATHS (the Bridge maintains that
# entry at runtime). Remove only our own entry - never another path the user or an administrator
# listed - so uninstall does not leave a trusted location pointing at a folder that no longer exists.
$entry = $bundleDir + '\...'
$variablesKeys = @()
foreach ($release in (Get-ChildItem 'HKCU:\Software\Autodesk\AutoCAD' -ErrorAction SilentlyContinue)) {
    # Profiles sits directly under the release key on some installs (R24.1\Profiles) and one level
    # deeper under a product key on others (R24.1\ACAD-5101:409\Profiles) - scan both, matching
    # bridge/Device/AutoCadTrustedPaths.cs.
    $profilesPaths = @((Join-Path $release.PSPath 'Profiles'))
    foreach ($child in (Get-ChildItem $release.PSPath -ErrorAction SilentlyContinue)) {
        $profilesPaths += (Join-Path $child.PSPath 'Profiles')
    }
    foreach ($profilesPath in $profilesPaths) {
        foreach ($profile in (Get-ChildItem $profilesPath -ErrorAction SilentlyContinue)) {
            $variablesKey = Join-Path $profile.PSPath 'Variables'
            if (Test-Path $variablesKey) { $variablesKeys += $variablesKey }
        }
    }
}
foreach ($key in $variablesKeys) {
    $existing = (Get-ItemProperty $key -ErrorAction SilentlyContinue).TRUSTEDPATHS
    if (-not $existing) { continue }
    $original = @($existing -split ';')
    $kept = @($original | Where-Object { $_.Trim().Trim('"') -ne $entry -and $_.Trim().Trim('"') -ne $bundleDir })
    if ($kept.Count -lt $original.Count) {
        Set-ItemProperty -Path $key -Name TRUSTEDPATHS -Value ($kept -join ';') -Type String
    }
}
Write-Host "Uninstalled successfully."
'@
$uninstallPs1Path = Join-Path $OutputDir 'uninstall.ps1'
[System.IO.File]::WriteAllText(
    $uninstallPs1Path,
    (Expand-UpdateChannel $clientUninstallScript),
    (New-Object System.Text.UTF8Encoding $true)
)

# Client README text file (simple, plain text for any user)
$clientReadmeText = @'
================================================================================
CadAI AutoCAD Integration - Client Package
================================================================================

This package contains:
1. AlephConnector.exe - Aleph Connector (Tauri) — sign in, install MCP + AutoCAD
2. bridge/          - CadAI.Bridge.exe (headless daemon to the Device Gateway)
3. CadAI.bundle/    - AutoCAD ApplicationPlugins bundle (autoloads in AutoCAD)
4. install.ps1      - Automated installation script (also invoked by Aleph Connector)
5. uninstall.ps1    - Clean removal script

--------------------------------------------------------------------------------
OPTION 1: SETUP WIZARD (Recommended)
--------------------------------------------------------------------------------
Double-click `AlephConnector.exe`:
- Install Bridge + AutoCAD plugin
- Detect Cursor / Claude Desktop / Claude Code / VS Code / Codex
- Write Aleph MCP (OAuth) into the agents you select
Then open Aleph Connector, sign in, and pair the device (writes identity.json automatically).

--------------------------------------------------------------------------------
OPTION 2: POWERShell INSTALL (No Admin Required)
--------------------------------------------------------------------------------
Right-click PowerShell -> "Run with PowerShell" on `install.ps1`:
Or open PowerShell in this folder and run:

    .\install.ps1 -GatewayUrl "wss://gateway.example.com/device" -DeviceToken "tok_xxx"

This will:
- Copy the Bridge to %ProgramData%\CadAI\Bridge and start it at Windows logon.
- Store the device credential in %LOCALAPPDATA%\CadAI\bridge\identity.json (Aleph Connector onboarding rotates it).
- Copy CadAI.bundle to %APPDATA%\Autodesk\ApplicationPlugins\CadAI.bundle.
- AutoCAD will automatically load the plugin every time it starts.

--------------------------------------------------------------------------------
OPTION 2: MANUAL INSTALL (Via AutoCAD / File Explorer)
--------------------------------------------------------------------------------

Method A: Copy the Bundle folder (Autoload in AutoCAD)
1. Press Windows + R, type:
   %APPDATA%\Autodesk\ApplicationPlugins
   and press Enter.
2. Copy the entire `CadAI.bundle` folder from this package into that directory.
3. Start `bridge\CadAI.Bridge.exe` to run the background service.
4. Open AutoCAD. The plugin will be loaded automatically!

Method B: Manual load via AutoCAD Command Line (NETLOAD / APPLOAD)
1. Open AutoCAD.
2. In AutoCAD command line, type:
   NETLOAD
   and press Enter.
3. Browse to this package:
   CadAI.bundle\Bootstrap\CadAI.AutoCAD.Bootstrap.dll
   and click Open.
4. To make AutoCAD load it automatically every time:
   - Type: APPLOAD
   - Under "Startup Suite" (briefcase icon), click "Contents..."
   - Click "Add..." and choose `CadAI.bundle\Bootstrap\CadAI.AutoCAD.Bootstrap.dll`
   - Click Close.
5. In AutoCAD command line, type:
   CADAISTATUS
   to confirm the plugin is active and view uptime.
6. Double-click `bridge\CadAI.Bridge.exe` to start the bridge communication daemon.

--------------------------------------------------------------------------------
VERIFICATION
--------------------------------------------------------------------------------
When AutoCAD launches, the command line prints:
  [cadai] CadAI AutoCAD plugin v{{VERSION}} listening on pipe "cadai-autocad-<PID>"

Type `CADAISTATUS` in AutoCAD to confirm anytime.
'@
Set-Content -Path (Join-Path $OutputDir 'README.txt') -Value ($clientReadmeText -replace '\{\{VERSION\}\}', $Version)

# Aleph Connector (Tauri v2 + Bun frontend)
$connectorApp = Join-Path $repoRoot 'connector-app'
if ($SkipConnectorBuild) {
    Write-Host "`n--- Skipping Aleph Connector build (-SkipConnectorBuild) ---"
    Write-Host "  Use tauri:dev / an existing AlephConnector.exe; package still has install.ps1 + Bridge."
} else {
    Write-Host "`n--- Building Aleph Connector (Tauri) ---"
    Push-Location $connectorApp
    try {
        & bun install
        if ($LASTEXITCODE -ne 0) { throw "bun install failed in connector-app." }
        & bun run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "bun run tauri:build failed." }
    } finally {
        Pop-Location
    }
    $tauriExe = Join-Path $connectorApp 'src-tauri/target/release/aleph-connector.exe'
    if (-not (Test-Path $tauriExe)) {
        throw "Tauri release binary not found at $tauriExe"
    }
    Copy-Item -Force $tauriExe (Join-Path $OutputDir 'AlephConnector.exe')
    Write-Host "  AlephConnector.exe -> $OutputDir"
}

# Agent pack (AGENTS.md + drafting/PCCC skills) next to AlephConnector.exe for Install Plugin.
# Skills are committed under packages/agent-pack/skills — no sync step at package time.
$monorepoRoot = Resolve-Path (Join-Path $repoRoot '..')
$agentPackSrc = Join-Path $monorepoRoot 'packages/agent-pack'
if ((Test-Path (Join-Path $agentPackSrc 'plugin.json')) -and (Test-Path (Join-Path $agentPackSrc 'skills'))) {
    Write-Host "`n--- Packaging agent-pack ---"
    $agentPackDest = Join-Path $OutputDir 'agent-pack'
    if (Test-Path $agentPackDest) { Remove-Item -Recurse -Force $agentPackDest }
    New-Item -ItemType Directory -Path $agentPackDest | Out-Null
    Copy-Item -Force (Join-Path $agentPackSrc 'plugin.json') $agentPackDest
    Copy-Item -Force (Join-Path $agentPackSrc 'AGENTS.md') $agentPackDest
    Copy-Item -Force (Join-Path $agentPackSrc 'README.md') $agentPackDest
    Copy-Item -Recurse -Force (Join-Path $agentPackSrc 'skills') (Join-Path $agentPackDest 'skills')
    Write-Host "  agent-pack -> $agentPackDest"
} else {
    Write-Host "`n--- WARNING: packages/agent-pack missing; Install Plugin will need ALEPH_AGENT_PACK_DIR ---"
}

$validator = Join-Path $repoRoot 'scripts/Test-PackagedBundle.ps1'
$requiredGenerations = if ($RequireAllGenerations) { @('net48', 'net8.0-windows', 'net10.0-windows') } else { @() }
$validatorArgs = @{
    PackageDir = $OutputDir
    RequiredGenerations = $requiredGenerations
}
if ($SkipConnectorBuild) { $validatorArgs.AllowMissingConnector = $true }
& $validator @validatorArgs
if ($LASTEXITCODE -ne 0) {
    throw "Packaged AutoCAD client validation failed."
}

Write-Host "`n=========================================================="
Write-Host " Packaging Complete!"
Write-Host " Location: $OutputDir"
Write-Host " You can now zip this folder and send it to clients."
Write-Host " (This folder is in .gitignore and will not be pushed to git)"
Write-Host "=========================================================="
