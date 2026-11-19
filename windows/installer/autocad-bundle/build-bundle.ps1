#Requires -Version 5.1
<#
.SYNOPSIS
    Packages the AutoCAD plugin's Bootstrap and versioned-plugin build
    output into the CadAI.bundle layout, and installs it into
    %APPDATA%\Autodesk\ApplicationPlugins\CadAI.bundle for per-user autoload.

.DESCRIPTION
    plugin/CadAI.AutoCAD.csproj and plugin/Bootstrap/CadAI.AutoCAD.Bootstrap.csproj both
    multi-target net48 (AutoCAD 2021-2024), net8.0-windows (AutoCAD 2025-2026), and
    net10.0-windows (AutoCAD 2027+) — see that project's header comment for the full
    AutoCAD-series mapping. This script takes each generation's build *output* directory as
    an optional parameter rather than invoking `dotnet build` itself, and only lays out the
    generations you actually pass (e.g. pass only the *Net8 pair if that's all you built).
    Build at least one generation first, e.g.:

        dotnet build plugin/Bootstrap/CadAI.AutoCAD.Bootstrap.csproj -f net8.0-windows
        dotnet build plugin/CadAI.AutoCAD.csproj -f net8.0-windows

    net48 additionally needs -p:AutoCadNetFxRefDir="<...>" — see SETUP.md, "Building the
    net48 (AutoCAD 2021-2024) target".

    Installing into %APPDATA%\Autodesk\ApplicationPlugins\ is Autodesk's
    documented per-user bundle discovery path — AutoCAD scans it at startup
    and loads any *.bundle\PackageContents.xml it finds with no manual
    APPLOAD/NETLOAD step, and no admin rights needed (unlike the
    all-users path under %ProgramData%\Autodesk\ApplicationPlugins\, which
    this script deliberately does not use).

.PARAMETER BootstrapOutputDirNet48
    Path to the Bootstrap project's net48 build output directory (must contain
    CadAI.AutoCAD.Bootstrap.dll). Omit if you're not shipping AutoCAD 2021-2024 support.

.PARAMETER PluginOutputDirNet48
    Path to the versioned plugin project's net48 build output directory. Required
    whenever -BootstrapOutputDirNet48 is given, and vice versa.

.PARAMETER BootstrapOutputDirNet8
    Path to the Bootstrap project's net8.0-windows build output directory. Omit if
    you're not shipping AutoCAD 2025-2026 support.

.PARAMETER PluginOutputDirNet8
    Path to the versioned plugin project's net8.0-windows build output directory.
    Required whenever -BootstrapOutputDirNet8 is given, and vice versa.

.PARAMETER BootstrapOutputDirNet10
    Path to the Bootstrap project's net10.0-windows build output directory. Omit if
    you're not shipping AutoCAD 2027+ support.

.PARAMETER PluginOutputDirNet10
    Path to the versioned plugin project's net10.0-windows build output directory.
    Required whenever -BootstrapOutputDirNet10 is given, and vice versa.

.PARAMETER Version
    The version being installed, e.g. "0.3.0". Becomes both the
    Versions/{version}/ folder name and the new current.json value.
    Defaults to the version this script's bundled PackageContents.xml template
    carries (AppVersion), so the installed bundle's current.json and its manifest
    can never name different versions.

.PARAMETER InstallTarget
    Where the bundle is installed. Defaults to the standard per-user
    Autodesk ApplicationPlugins path.

.EXAMPLE
    .\build-bundle.ps1 -BootstrapOutputDirNet8 C:\build\bootstrap\bin\Release\net8.0-windows `
                        -PluginOutputDirNet8 C:\build\plugin\bin\Release\net8.0-windows
#>
[CmdletBinding()]
param(
    [string]$BootstrapOutputDirNet48,
    [string]$PluginOutputDirNet48,

    [string]$BootstrapOutputDirNet8,
    [string]$PluginOutputDirNet8,

    [string]$BootstrapOutputDirNet10,
    [string]$PluginOutputDirNet10,

    [string]$Version = '',

    [string]$InstallTarget = (Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\CadAI.bundle')
)

$ErrorActionPreference = 'Stop'

# (RuntimeFolderName, BootstrapOutputDir, PluginOutputDir) for every generation actually passed.
$generations = @(
    @{ Name = 'net48'; Bootstrap = $BootstrapOutputDirNet48; Plugin = $PluginOutputDirNet48 }
    @{ Name = 'net8.0-windows'; Bootstrap = $BootstrapOutputDirNet8; Plugin = $PluginOutputDirNet8 }
    @{ Name = 'net10.0-windows'; Bootstrap = $BootstrapOutputDirNet10; Plugin = $PluginOutputDirNet10 }
) | Where-Object { $_.Bootstrap -or $_.Plugin }

if ($generations.Count -eq 0) {
    throw "No generation's output directories were given - pass at least one of -BootstrapOutputDirNet48/-PluginOutputDirNet48, -BootstrapOutputDirNet8/-PluginOutputDirNet8, or -BootstrapOutputDirNet10/-PluginOutputDirNet10 (see this script's header comment)."
}

foreach ($gen in $generations) {
    if (-not $gen.Bootstrap -or -not $gen.Plugin) {
        throw "$($gen.Name): both -BootstrapOutputDir* and -PluginOutputDir* must be given together (one was omitted)."
    }
    $bootstrapDll = Join-Path $gen.Bootstrap 'CadAI.AutoCAD.Bootstrap.dll'
    if (-not (Test-Path $bootstrapDll)) {
        throw "`"$bootstrapDll`" not found. Build plugin/Bootstrap for $($gen.Name) first (see this script's header comment)."
    }
    $pluginDll = Join-Path $gen.Plugin 'CadAI.AutoCAD.dll'
    if (-not (Test-Path $pluginDll)) {
        throw "`"$pluginDll`" not found. Build plugin for $($gen.Name) first (see this script's header comment)."
    }
}

$sourceBundleDir = Join-Path $PSScriptRoot 'CadAI.bundle'
. (Join-Path $PSScriptRoot 'write-bundle-manifest.ps1')

# Same single-source-of-truth rule as scripts/package-client.ps1: the bundle template carries the
# release version. A hardcoded default here drifted once (#327) and could install a current.json
# disagreeing with the AppVersion this script copies from that same template.
if ([string]::IsNullOrWhiteSpace($Version)) {
    [xml]$templateDoc = [IO.File]::ReadAllText((Join-Path $sourceBundleDir 'PackageContents.xml'))
    $Version = $templateDoc.ApplicationPackage.AppVersion
    if ([string]::IsNullOrWhiteSpace($Version)) {
        throw "Could not read AppVersion from the bundle template at $sourceBundleDir\PackageContents.xml."
    }
}

Write-Host "Installing CadAI.bundle to $InstallTarget (version $Version, generations: $(($generations | ForEach-Object { $_.Name }) -join ', ')) ..."

New-Item -ItemType Directory -Force -Path $InstallTarget | Out-Null

# Only the generations passed in get an advertised ComponentEntry — a manifest naming a
# Bootstrap folder this install doesn't contain can make AutoCAD's Autoloader drop the
# component entirely (write-bundle-manifest.ps1).
Write-Host 'Writing PackageContents.xml for the installed generations ...'
Write-BundleManifest -TemplatePath (Join-Path $sourceBundleDir 'PackageContents.xml') `
    -OutPath (Join-Path $InstallTarget 'PackageContents.xml') `
    -Generations @($generations | ForEach-Object { $_.Name })

foreach ($gen in $generations) {
    $bootstrapTarget = Join-Path $InstallTarget "Bootstrap\$($gen.Name)"
    $versionTarget = Join-Path $InstallTarget "Versions\$Version\$($gen.Name)"
    New-Item -ItemType Directory -Force -Path $bootstrapTarget | Out-Null
    New-Item -ItemType Directory -Force -Path $versionTarget | Out-Null

    Write-Host "Copying $($gen.Name) Bootstrap build output from $($gen.Bootstrap) ..."
    try {
        Copy-Item -Path (Join-Path $gen.Bootstrap '*') -Destination $bootstrapTarget -Recurse -Force -ErrorAction Stop
    } catch {
        Write-Warning "Could not overwrite Bootstrap in $bootstrapTarget (likely locked by running AutoCAD); skipping Bootstrap copy: $_"
    }
    Write-Host "Copying $($gen.Name) plugin build output from $($gen.Plugin) into Versions\$Version\$($gen.Name) ..."
    Copy-Item -Path (Join-Path $gen.Plugin '*') -Destination $versionTarget -Recurse -Force
}

Write-Host 'Activating (writing current.json) ...'
$currentJson = @{ current = $Version } | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $InstallTarget 'current.json') -Value $currentJson -NoNewline

Write-Host ''
Write-Host "Done. $InstallTarget now activates version $Version."
Write-Host '(Re)start AutoCAD to load it - no manual APPLOAD/NETLOAD needed; AutoCAD'
Write-Host 'discovers *.bundle folders under %APPDATA%\Autodesk\ApplicationPlugins\ automatically.'
