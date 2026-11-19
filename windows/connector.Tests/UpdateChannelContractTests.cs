using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// Pins the standalone CAD emergency update channel (#329) to its one contract file,
/// <c>contracts/update-channel.json</c>. The packager derives its manifest URL and verification key
/// path from that contract so a release cannot silently configure a different channel.
/// </summary>
public sealed class UpdateChannelContractTests
{
    private static string FindIntegrationRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "contracts", "update-channel.json"))) return dir.FullName;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not walk up from the test assembly to a directory containing contracts/update-channel.json — " +
            "the update-channel contract moved without this test being updated.");
    }
    private static string Read(string relative) =>
        File.ReadAllText(Path.Combine(FindIntegrationRoot(), relative));


    private static JsonElement Contract() => JsonDocument.Parse(Read(Path.Combine("contracts", "update-channel.json"))).RootElement;

    private static string Field(string name) =>
        Contract().GetProperty(name).GetString()
        ?? throw new InvalidOperationException($"update-channel.json field '{name}' is null.");

    /// <summary>Every field the packager and workflow depend on is present and non-blank, so neither
    /// throws only at packaging/publish time.</summary>
    [Theory]
    [InlineData("bucket")]
    [InlineData("prefix")]
    [InlineData("releaseHost")]
    [InlineData("manifestName")]
    [InlineData("publicKeyRepoPath")]
    [InlineData("publicKeyPackageDir")]
    [InlineData("publicKeyInstallSubdir")]
    public void RequiredContractFieldsArePresent(string field)
    {
        Assert.False(string.IsNullOrWhiteSpace(Field(field)), $"update-channel.json field '{field}' is blank.");
    }

    [Fact]
    public void ReleaseHostIsHttpsAndPathsAreClean()
    {
        var host = Field("releaseHost");
        Assert.StartsWith("https://", host);
        // The host value carries no path: prefix/manifestName supply the path separately.
        Assert.DoesNotContain("/", host.Substring("https://".Length));
        foreach (var segment in new[] { "prefix", "manifestName", "publicKeyPackageDir", "publicKeyInstallSubdir" })
        {
            var value = Field(segment);
            Assert.DoesNotContain("://", value);
            Assert.DoesNotContain(" ", value);
        }
    }


    /// <summary>The verification key must be committed at the path the contract names; the packager
    /// refuses to package without it and the workflow ships that same file to every client.</summary>
    [Fact]
    public void CommittedPublicKeyExistsAtContractPath()
    {
        var keyPath = Path.Combine(FindIntegrationRoot(), Field("publicKeyRepoPath"));
        Assert.True(File.Exists(keyPath), $"publicKeyRepoPath '{Field("publicKeyRepoPath")}' is not a file in the repo.");
        Assert.StartsWith("-----BEGIN PUBLIC KEY-----", File.ReadAllText(keyPath).TrimStart());
    }

    /// <summary>The packager must derive the manifest URL from the contract, not hardcode a host: the
    /// whole point of one contract file is that publish and install can never disagree on the path.</summary>
    [Fact]
    public void PackagerReadsTheContractForTheManifestUrl()
    {
        var packager = Read(Path.Combine("scripts", "package-client.ps1"));
        Assert.Contains("contracts/update-channel.json", packager);
        Assert.Contains("$manifestUrl = $hostBase + $prefixPath", packager);
        // No literal release URL may be hardcoded in the packager; it must come from the contract.
        Assert.DoesNotContain("updates.alephhq.tech", packager);
    }

    /// <summary>install.ps1/uninstall.ps1 are single-quoted here-strings, so the contract values ride in
    /// as {{…}} markers that Expand-UpdateChannel substitutes at write time. Every channel marker that
    /// appears must be substituted, or a client is configured against a literal placeholder. (The packager
    /// has other placeholders, e.g. README.txt's {{VERSION}}, owned by different replacers — this test
    /// covers only the channel's own markers and its own function.)</summary>
    [Fact]
    public void GeneratedScriptPlaceholdersAreAllSubstituted()
    {
        var packager = Read(Path.Combine("scripts", "package-client.ps1"));
        // Markers used inside the generated client scripts (the here-string bodies), by definition the
        // channel's: {{VERSION}} is README-only and handled separately.
        var markers = new[] { "MANIFEST_URL", "KEY_INSTALL_SUBDIR" };
        foreach (var marker in markers)
            Assert.Contains($"{{{{{marker}}}}}", packager); // referenced in a here-string
        var replacer = Regex.Match(packager, @"function Expand-UpdateChannel.*?\n\}", RegexOptions.Singleline).Value;
        Assert.False(string.IsNullOrEmpty(replacer), "Expand-UpdateChannel was renamed or removed.");
        foreach (var marker in markers)
            Assert.Contains(marker, replacer, StringComparison.Ordinal); // and it substitutes each
    }

    /// <summary>The generated installer sets both channel env vars and restores the previous value on
    /// rollback; the uninstaller clears both. A half-configured updater (URL set, key unset) is exactly
    /// what UpdateCoordinatorService disables the channel for, so every role must be present.</summary>
    [Fact]
    public void InstallerAndUninstallerConfigureBothChannelEnvVars()
    {
        var packager = Read(Path.Combine("scripts", "package-client.ps1"));
        foreach (var name in new[] { "CADAI_UPDATE_MANIFEST_URL", "CADAI_UPDATER_PUBLIC_KEY_PATH" })
        {
            // set at apply time (double-quoted inside SetEnvironmentVariable)
            Assert.Contains($"SetEnvironmentVariable(\"{name}\"", packager);
            // captured for rollback (GetEnvironmentVariable into $old…)
            Assert.Contains($"GetEnvironmentVariable(\"{name}\"", packager);
            // cleared on uninstall (single-quoted name in the foreach list)
            Assert.Contains($"'{name}'", packager);
        }
    }
}
