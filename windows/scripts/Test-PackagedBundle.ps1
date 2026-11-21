#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackageDir,

    [Parameter(Mandatory = $false)]
    [string[]]$RequiredGenerations = @()
)

$ErrorActionPreference = 'Stop'
$package = (Resolve-Path $PackageDir).Path
$bundle = Join-Path $package 'CadAI.bundle'
$manifestPath = Join-Path $bundle 'PackageContents.xml'
$bridgePath = Join-Path $package 'bridge/CadAI.Bridge.exe'

if (-not (Test-Path $bridgePath -PathType Leaf)) {
    throw "Packaged Bridge is missing: $bridgePath"
}
if (-not (Test-Path $manifestPath -PathType Leaf)) {
    throw "Bundle manifest is missing: $manifestPath"
}

$manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
if ($manifestBytes.Length -ge 3 -and $manifestBytes[0] -eq 0xEF -and $manifestBytes[1] -eq 0xBB -and $manifestBytes[2] -eq 0xBF) {
    throw 'PackageContents.xml must be UTF-8 without a BOM.'
}

[xml]$manifest = [IO.File]::ReadAllText($manifestPath)
$entries = @($manifest.ApplicationPackage.Components.ComponentEntry)
if ($entries.Count -eq 0) {
    throw 'PackageContents.xml contains no ComponentEntry.'
}

$advertised = @()
foreach ($entry in $entries) {
    $moduleName = [string]$entry.ModuleName
    if ($moduleName -notmatch '^\./Bootstrap/([^/]+)/CadAI\.AutoCAD\.Bootstrap\.dll$') {
        throw "Unexpected ComponentEntry ModuleName: $moduleName"
    }
    if ($null -eq $entry.RuntimeRequirements) {
        throw "ComponentEntry $moduleName has no nested RuntimeRequirements."
    }

    $generation = $Matches[1]
    $advertised += $generation
    $bootstrap = Join-Path $bundle "Bootstrap/$generation/CadAI.AutoCAD.Bootstrap.dll"
    if (-not (Test-Path $bootstrap -PathType Leaf)) {
        throw "Manifest advertises $generation but Bootstrap DLL is missing: $bootstrap"
    }
}

$currentPath = Join-Path $bundle 'current.json'
if (-not (Test-Path $currentPath -PathType Leaf)) {
    throw "Bundle version pointer is missing: $currentPath"
}
$current = (Get-Content $currentPath -Raw | ConvertFrom-Json).current
$bridgeVersionPath = Join-Path $package 'bridge/component-version.json'
if (-not (Test-Path $bridgeVersionPath -PathType Leaf)) {
    throw "Bridge version marker is missing: $bridgeVersionPath"
}
$bridgeVersion = (Get-Content $bridgeVersionPath -Raw | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($bridgeVersion) -or $bridgeVersion -ne $current) {
    throw "Bridge version $bridgeVersion does not match packaged AutoCAD plugin $current"
}
if ([string]::IsNullOrWhiteSpace($current)) {
    throw 'current.json does not name an active version.'
}

foreach ($generation in $advertised) {
    $plugin = Join-Path $bundle "Versions/$current/$generation/CadAI.AutoCAD.dll"
    if (-not (Test-Path $plugin -PathType Leaf)) {
        throw "Manifest advertises $generation but versioned plugin DLL is missing: $plugin"
    }
}

$unexpected = @(Get-ChildItem (Join-Path $bundle 'Bootstrap') -Directory | Where-Object { $advertised -notcontains $_.Name })
if ($unexpected.Count -gt 0) {
    throw "Bundle contains generations not advertised by PackageContents.xml: $($unexpected.Name -join ', ')"
}

foreach ($generation in $RequiredGenerations) {
    if ($advertised -notcontains $generation) {
        throw "Release package is missing required AutoCAD generation: $generation"
    }
}

# The updater's packaging script must be syntactically valid under Windows PowerShell;
# compiling the .NET Bridge alone cannot catch a broken one-click installer.
$setupExe = Join-Path $package 'AlephConnector.Setup.exe'
if (-not (Test-Path $setupExe -PathType Leaf)) {
    throw "Packaged Aleph Connector Setup wizard is missing: $setupExe"
}

$installScript = Join-Path $package 'install.ps1'
if (-not (Test-Path $installScript -PathType Leaf)) {
    throw "Packaged client installer is missing: $installScript"
}
$tokens = $null
$syntaxErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$tokens, [ref]$syntaxErrors) | Out-Null
if ($syntaxErrors.Count -gt 0) {
    throw "Packaged PowerShell installer has syntax errors: $($syntaxErrors -join '; ')"
}

# Verify staging copy behavior: copying bundleSource into an existing bundleStage
# must place current.json and PackageContents.xml directly at the root, never nesting
# a CadAI.bundle directory inside bundleStage.
$mockRoot = Join-Path ([IO.Path]::GetTempPath()) "cadai-stage-test-$([Guid]::NewGuid().ToString('N'))"
try {
    $mockBundleSource = Join-Path $mockRoot 'CadAI.bundle'
    $mockStage = Join-Path $mockRoot 'CadAI.bundle.stage.mock'
    New-Item -ItemType Directory -Path $mockBundleSource -Force | Out-Null
    Set-Content -Path (Join-Path $mockBundleSource 'current.json') -Value '{"current":"test"}'
    Set-Content -Path (Join-Path $mockBundleSource 'PackageContents.xml') -Value '<test/>'

    # Pre-create destination directory (the condition that triggers nesting if using Copy-Item -LiteralPath)
    New-Item -ItemType Directory -Path $mockStage -Force | Out-Null
    Copy-Item -Path (Join-Path $mockBundleSource '*') -Destination $mockStage -Recurse -Force -ErrorAction Stop

    if (-not (Test-Path (Join-Path $mockStage 'current.json') -PathType Leaf) -or
        -not (Test-Path (Join-Path $mockStage 'PackageContents.xml') -PathType Leaf)) {
        throw "Staging copy failed: root markers missing from staging directory $mockStage"
    }
    if (Test-Path (Join-Path $mockStage 'CadAI.bundle')) {
        throw "Staging copy failed: created nested CadAI.bundle directory inside $mockStage"
    }
} finally {
    if (Test-Path $mockRoot) { Remove-Item -LiteralPath $mockRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

# Cross-layer contract: Desktop's crash recovery (aleph_host::autocad_journal::journal_path)
# looks for the journal under %ProgramData%\CadAI with a fixed filename. If the installer ever
# renames it, an interrupted activation would never be detected. Pin the exact name here.
$installText = Get-Content $installScript -Raw
if ($installText -notmatch "client-activation\.json") {
    throw 'install.ps1 does not write the client-activation.json crash journal that Desktop boot recovery reads.'
}
if ($installText -notmatch '\$journalPath\s*=\s*Join-Path \$bridgeParent') {
    throw 'install.ps1 journal must live next to client-update.lock in the Bridge parent (outside the renamed Bridge directory).'
}

# Standalone emergency update channel (aleph-platform#329). Every client's install.ps1 now points the
# Bridge at a signed manifest, so a package must carry the verification key and its generated scripts
# must name the contract's URL — a package that ships binaries without the key, or a generated script
# whose placeholder never got replaced, configures an updater that can never verify anything.
# Same $PSScriptRoot fallback package-client.ps1 uses: Windows PowerShell 5.1 can hand the script a
# verbatim \\?\ path where $PSScriptRoot comes back empty.
$selfDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($selfDir)) { $selfDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($selfDir)) { throw 'Cannot locate the directory of Test-PackagedBundle.ps1.' }
$integrationRoot = Split-Path -Parent $selfDir
$contractPath = Join-Path $integrationRoot 'contracts/update-channel.json'
if (-not (Test-Path $contractPath -PathType Leaf)) {
    throw "update-channel contract is missing: $contractPath"
}
$channel = [IO.File]::ReadAllText($contractPath) | ConvertFrom-Json
$channelManifestUrl = $channel.releaseHost.TrimEnd('/') + '/' + $channel.prefix.Trim('/') + '/' + $channel.manifestName.TrimStart('/')
if ($installText -notmatch [regex]::Escape($channelManifestUrl)) {
    throw "install.ps1 does not set the contract manifest URL ($channelManifestUrl)."
}
foreach ($var in 'CADAI_UPDATE_MANIFEST_URL', 'CADAI_UPDATER_PUBLIC_KEY_PATH') {
    if ($installText -notmatch [regex]::Escape($var)) {
        throw "install.ps1 must configure $var for the standalone update channel."
    }
}
if ($installText -match '\{\{(MANIFEST_URL|KEY_INSTALL_SUBDIR)\}\}') {
    throw 'install.ps1 still contains an unreplaced update-channel placeholder.'
}
$uninstallScript = Join-Path $package 'uninstall.ps1'
if (-not (Test-Path $uninstallScript -PathType Leaf)) {
    throw "Packaged client uninstaller is missing: $uninstallScript"
}
$uninstallText = Get-Content $uninstallScript -Raw
if ($uninstallText -match '\{\{(MANIFEST_URL|KEY_INSTALL_SUBDIR)\}\}') {
    throw 'uninstall.ps1 still contains an unreplaced update-channel placeholder.'
}
foreach ($var in 'CADAI_UPDATE_MANIFEST_URL', 'CADAI_UPDATER_PUBLIC_KEY_PATH') {
    if ($uninstallText -notmatch [regex]::Escape($var)) {
        throw "uninstall.ps1 must clear $var."
    }
}
$shippedKey = Join-Path $package ($channel.publicKeyPackageDir + '/public.pem')
if (-not (Test-Path $shippedKey -PathType Leaf)) {
    throw "Packaged update public key is missing: $shippedKey"
}
$repoKey = Join-Path $integrationRoot $channel.publicKeyRepoPath
if (-not (Test-Path $repoKey -PathType Leaf)) {
    throw "Contract publicKeyRepoPath does not exist in the repo: $repoKey"
}
if ((Get-FileHash $shippedKey).Hash -ne (Get-FileHash $repoKey).Hash) {
    throw "Packaged update public key differs from the repo key at $($channel.publicKeyRepoPath) - clients would verify releases against a key no release signs with."
}
if (-not ((Get-Content $shippedKey -Raw) -match '^-----BEGIN PUBLIC KEY-----')) {
    throw "Packaged update public key is not a PEM public key: $shippedKey"
}

Write-Host "Validated AutoCAD client package: $($advertised -join ', ') (version $current)"
