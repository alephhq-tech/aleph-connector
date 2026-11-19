#Requires -Version 5.1
<#
.SYNOPSIS
    Writes a CadAI.bundle PackageContents.xml that advertises ONLY the runtime
    generations actually present in the bundle.

.DESCRIPTION
    CadAI.bundle/PackageContents.xml (this folder) is the master template: it carries all
    three ComponentEntry blocks (net48, net8.0-windows, net10.0-windows) with their
    Autodesk series ranges. A shipped bundle usually holds only some of them — the default
    client package builds net8.0-windows alone (net48 needs the non-redistributable AcMgd
    DLLs, net10.0-windows needs the .NET 10 SDK). Copying the template verbatim then
    advertises `./Bootstrap/<tfm>/...` assemblies that are not in the package, and Autodesk's
    Autoloader reacts inconsistently: at best a load error, at worst a silently dropped
    component (see docs/IMPLEMENTATION_STATUS.md's "AutoCAD 2025 Autoloader silently dropped
    the plugin bundle" entry). That is exactly the "Aleph says the plugin is installed but
    AutoCAD never loads it" failure mode.

    This function is the single source of truth shared by scripts/package-client.ps1 (the
    staged client package, including what the release installer ships) and
    build-bundle.ps1 (the manual/dev install path), so neither re-derives the manifest.

    The comment block ahead of the first ComponentEntry is deliberately dropped rather than
    shifted onto a surviving entry — a dev-only note that names generations this particular
    bundle does not contain would read as a false claim about this package.

.PARAMETER TemplatePath
    Path to the master CadAI.bundle/PackageContents.xml template.

.PARAMETER OutPath
    Destination file for the generated manifest.

.PARAMETER Generations
    Runtime folder names actually present in the bundle, e.g. 'net8.0-windows', 'net48'.
    Every ComponentEntry whose ModuleName references a Bootstrap/<tfm> folder not in this
    list is removed; the result must retain at least one entry.
#>
function Write-BundleManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$TemplatePath,
        [Parameter(Mandatory = $true)] [string]$OutPath,
        [Parameter(Mandatory = $true)] [string[]]$Generations
    )

    if (-not (Test-Path $TemplatePath)) {
        throw "PackageContents.xml template not found at '$TemplatePath'."
    }

    # `[IO.File]::ReadAllText`, not `Get-Content -Raw`: Windows PowerShell 5.1 decodes a BOM-less
    # file as the machine ANSI codepage, which would mojibake this template's em-dashes.
    $template = [IO.File]::ReadAllText($TemplatePath)
    # Each block runs from its own leading indentation to the blank line after
    # </ComponentEntry>, so removing one leaves no orphan whitespace.
    $blockPattern = "(?m)^[ \t]*<ComponentEntry\b[\s\S]*?</ComponentEntry>[ \t]*\r?\n(?:[ \t]*\r?\n)*"
    $blocks = @([regex]::Matches($template, $blockPattern))
    if ($blocks.Count -eq 0) {
        throw "No <ComponentEntry> block found in '$TemplatePath' - refusing to write a manifest AutoCAD cannot load."
    }

    $kept = @(foreach ($block in $blocks) {
        $match = [regex]::Match($block.Value, 'Bootstrap/([^/"\s]+)/')
        if ($match.Success -and $Generations -contains $match.Groups[1].Value) { $block }
    })
    if ($kept.Count -eq 0) {
        throw "None of the template's ComponentEntry blocks match the built generations ($($Generations -join ', ')) - the bundle would advertise no plugin at all."
    }

    # Drop the comment before the first entry (see .DESCRIPTION), then splice the kept
    # blocks in place of every block the template had.
    $head = $template.Substring(0, $blocks[0].Index) -replace '(?s)\s*<!--.*?-->', ''
    $tail = $template.Substring($blocks[-1].Index + $blocks[-1].Length)
    $body = @(foreach ($block in $kept) { $block.Value }) -join ''
    $xml = $head + "`r`n" + $body.TrimEnd() + "`r`n" + $tail

    # UTF-8 without BOM: an attached `encoding="utf-8"` document with a BOM is a spec error,
    # and Autodesk's parser has been observed rejecting it.
    [IO.File]::WriteAllText($OutPath, $xml, (New-Object Text.UTF8Encoding $false))
}
