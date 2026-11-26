#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutputDir
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be a three-part stable version.' }
if ([string]::IsNullOrWhiteSpace($env:AUTOCAD_NETFX_REF_DIR)) { throw 'AUTOCAD_NETFX_REF_DIR is required for release packaging.' }
if ([string]::IsNullOrWhiteSpace($env:UPDATE_SIGNING_PRIVATE_KEY)) { throw 'UPDATE_SIGNING_PRIVATE_KEY is required for release signing.' }
$privateMaterial = $env:UPDATE_SIGNING_PRIVATE_KEY
Remove-Item Env:UPDATE_SIGNING_PRIVATE_KEY
$windowsRoot = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $windowsRoot
$tauri = Join-Path $windowsRoot 'connector-app/src-tauri'
$config = Get-Content (Join-Path $tauri 'tauri.conf.json') -Raw | ConvertFrom-Json
$npm = Get-Content (Join-Path $windowsRoot 'connector-app/package.json') -Raw | ConvertFrom-Json
$plugin = Get-Content (Join-Path $windowsRoot 'installer/autocad-bundle/CadAI.bundle/current.json') -Raw | ConvertFrom-Json
$cargo = [IO.File]::ReadAllText((Join-Path $tauri 'Cargo.toml'))
$bridge = [IO.File]::ReadAllText((Join-Path $windowsRoot 'connector/BridgeConfig.cs'))
$pluginState = [IO.File]::ReadAllText((Join-Path $windowsRoot 'autocad-plugin/PluginState.cs'))
if ($config.version -ne $Version -or $npm.version -ne $Version -or $plugin.current -ne $Version -or
    $cargo -notmatch ('(?m)^version\s*=\s*"' + [regex]::Escape($Version) + '"') -or
    $bridge -notmatch ('BridgeVersion\s*=\s*"' + [regex]::Escape($Version) + '"') -or
    $pluginState -notmatch ('PluginVersion\s*=\s*"' + [regex]::Escape($Version) + '"')) {
    throw 'Tauri, Cargo, frontend, Bridge, AutoCAD bundle, and AutoCAD plugin release versions must match.'
}
if (Test-Path $OutputDir) { throw 'OutputDir must not already exist; refusing to overwrite existing files.' }
New-Item -ItemType Directory -Path $OutputDir | Out-Null
$output = (Resolve-Path $OutputDir).Path
Push-Location $repo
try {
    & bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Root dependency installation failed.' }
    Push-Location (Join-Path $windowsRoot 'connector-app')
    try {
        & bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Connector dependency installation failed.' }
    } finally { Pop-Location }
    & (Join-Path $PSScriptRoot 'prepare-connector-package.ps1') -RequireAllGenerations -AutoCadNetFxRefDir $env:AUTOCAD_NETFX_REF_DIR
    Push-Location (Join-Path $windowsRoot 'connector-app')
    try {
        & bun run tauri:build
        if ($LASTEXITCODE -ne 0) { throw 'Tauri release build failed.' }
    } finally { Pop-Location }
    $nsis = @(Get-ChildItem (Join-Path $tauri ("target/release/bundle/nsis/Aleph Connector_${Version}_x64-setup.exe")) -File)
    $msi = @(Get-ChildItem (Join-Path $tauri ("target/release/bundle/msi/Aleph Connector_${Version}_x64_en-US.msi")) -File)
    if ($nsis.Count -ne 1 -or $msi.Count -ne 1) { throw 'Expected exactly one NSIS EXE and one MSI; clear stale bundle outputs first.' }
    Copy-Item -LiteralPath $nsis[0].FullName -Destination (Join-Path $output 'AlephConnector-setup.exe')
    Copy-Item -LiteralPath $msi[0].FullName -Destination (Join-Path $output 'AlephConnector.msi')
    $zipPath = Join-Path $output 'connector-update.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $marker = $zip.CreateEntry('version.txt')
        $writer = New-Object IO.StreamWriter($marker.Open(), (New-Object Text.UTF8Encoding $false))
        try { $writer.Write($Version) } finally { $writer.Dispose() }
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $nsis[0].FullName, 'installer.exe')
    } finally { $zip.Dispose() }
    if ((Get-Item -LiteralPath $zipPath).Length -gt 1GB -or $nsis[0].Length -gt 1GB) {
        throw 'Release exceeds the desktop updater size limit (1 GiB).'
    }
    $derivedPath = Join-Path $output 'derived-public.pem'
    $privatePath = Join-Path ([IO.Path]::GetTempPath()) ('aleph-signing-' + [Guid]::NewGuid().ToString('N') + '.pem')
    try {
        [IO.File]::WriteAllText($privatePath, $privateMaterial, (New-Object Text.UTF8Encoding $false))
        & dotnet run --project (Join-Path $windowsRoot 'updater/Cli') -c Release -- pubkey $privatePath $derivedPath
        if ($LASTEXITCODE -ne 0) { throw 'Cannot derive release public key.' }
        $expected = (Get-Content (Join-Path $windowsRoot 'updater/prodkeys/public.pem') -Raw).Trim()
        $derived = (Get-Content $derivedPath -Raw).Trim()
        if ($expected -ne $derived) { throw 'Release signing key does not match the pinned public key.' }
        $pinned = Join-Path $tauri 'src/update-public-key.der'
        $derivedRsa = Join-Path $output 'derived-public-rsa.der'
        & openssl rsa -pubin -in $derivedPath -RSAPublicKey_out -outform DER -out $derivedRsa
        if ($LASTEXITCODE -ne 0 -or (Get-FileHash $pinned).Hash -ne (Get-FileHash $derivedRsa).Hash) {
            throw 'Release signing key does not match the embedded desktop updater key.'
        }
        Remove-Item -LiteralPath $derivedRsa -Force
        $url = "https://github.com/alephhq-tech/aleph-connector/releases/download/v$Version/connector-update.zip"
        & dotnet run --project (Join-Path $windowsRoot 'updater/Cli') -c Release -- manifest $zipPath $privatePath $Version $Version $url (Join-Path $output 'manifest.json')
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create signed release manifest.' }
    } finally {
        Remove-Item -LiteralPath $privatePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $derivedPath -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Prepared signed release assets in $output"
} finally { Pop-Location }
