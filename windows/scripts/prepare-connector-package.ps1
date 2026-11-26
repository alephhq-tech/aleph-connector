#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AutoCadNetFxRefDir = $env:AUTOCAD_NETFX_REF_DIR,
    [switch]$RequireAllGenerations
)
$ErrorActionPreference = 'Stop'
$windowsRoot = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $windowsRoot
$resources = Join-Path $windowsRoot 'connector-app/src-tauri/binaries'
$client = Join-Path $resources 'client'
$pack = Join-Path $resources 'agent-pack'
Push-Location $root
try {
    & bun run build:runtime
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile local runtime.' }
    & bun run build:stdio
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile stdio proxy.' }
    $args = @{ OutputDir = $client; SkipConnectorBuild = $true }
    if ($AutoCadNetFxRefDir) { $args.AutoCadNetFxRefDir = $AutoCadNetFxRefDir }
    if ($RequireAllGenerations) { $args.RequireAllGenerations = $true }
    & (Join-Path $PSScriptRoot 'package-client.ps1') @args
    $nestedPack = Join-Path $client 'agent-pack'
    if (Test-Path $nestedPack) { Remove-Item -LiteralPath $nestedPack -Recurse -Force }
    $packSource = Join-Path $root 'packages/agent-pack'
    if (-not (Test-Path (Join-Path $packSource 'plugin.json') -PathType Leaf)) { throw 'Agent pack is missing.' }
    if (Test-Path $pack) { Remove-Item -LiteralPath $pack -Recurse -Force }
    Copy-Item -LiteralPath $packSource -Destination $pack -Recurse -Force
    foreach ($runtimeFile in @('hostfxr.dll', 'hostpolicy.dll', 'coreclr.dll', 'System.Windows.Forms.dll')) {
        if (-not (Test-Path (Join-Path $client "bridge/$runtimeFile") -PathType Leaf)) { throw "Bridge is not self-contained: missing $runtimeFile" }
    }
    foreach ($path in @('aleph-mcp.exe', 'aleph-mcp-stdio.exe', 'skills/autocad-drafting/SKILL.md', 'client/install.ps1', 'client/bridge/CadAI.Bridge.exe', 'client/CadAI.bundle/PackageContents.xml', 'agent-pack/plugin.json')) {
        if (-not (Test-Path (Join-Path $resources $path) -PathType Leaf)) { throw "Missing release resource: $path" }
    }
    Write-Host "Prepared Tauri resources in $resources"
} finally {
    Pop-Location
}
