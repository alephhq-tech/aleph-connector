using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// Pins <see cref="BridgeConfig.BridgeVersion"/> to the rest of the unified release train.
/// A real drift shipped as #327: the Bridge constant stayed 0.1.6 while the plugin constant and
/// the installer bundle templates moved to 0.1.8, so a freshly built 0.1.8 Bridge introduced
/// itself as 0.1.6 in `hello.bridgeVersion` and every `minimumBridgeVersion` comparison reasoned
/// about a version no artifact matched. The plugin side is guarded by plugin.Tests'
/// PluginVersionTests; this is the same guard for the Bridge half. The plugin constant is read
/// from source text rather than referenced as a project: the plugin assembly needs AutoCAD's
/// reference assemblies, and a test-only project reference would drag them into the Bridge's
/// CI build.
/// </summary>
public sealed class BridgeVersionTests
{
    private static string FindIntegrationRoot()
    {
        // Walk up from the test assembly's output dir to the integration root, which holds
        // windows/installer/autocad-bundle/CadAI.bundle/ and windows/autocad-plugin/.
        // Robust to bin/{config}/{tfm} depth and CI layout.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "installer", "autocad-bundle", "CadAI.bundle");
            if (File.Exists(Path.Combine(candidate, "current.json"))) return dir.FullName;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not walk up from the test assembly to a directory containing installer/autocad-bundle/CadAI.bundle — " +
            "the installer templates moved without this test being updated.");
    }

    [Fact]
    public void BridgeVersion_MatchesBundleCurrentJsonTemplate()
    {
        var bundleDir = Path.Combine(FindIntegrationRoot(), "installer", "autocad-bundle", "CadAI.bundle");
        var currentJson = File.ReadAllText(Path.Combine(bundleDir, "current.json"));
        var templateVersion = System.Text.Json.JsonDocument.Parse(currentJson)
            .RootElement.GetProperty("current").GetString();

        Assert.Equal(BridgeConfig.BridgeVersion, templateVersion);
    }

    [Fact]
    public void BridgeVersion_MatchesPackageContentsAppVersion()
    {
        var bundleDir = Path.Combine(FindIntegrationRoot(), "installer", "autocad-bundle", "CadAI.bundle");
        var doc = XDocument.Load(Path.Combine(bundleDir, "PackageContents.xml"));
        var appVersion = doc.Root?.Attribute("AppVersion")?.Value;

        Assert.Equal(BridgeConfig.BridgeVersion, appVersion);
    }

    [Fact]
    public void BridgeVersion_MatchesPluginConstant()
    {
        var pluginState = File.ReadAllText(Path.Combine(FindIntegrationRoot(), "autocad-plugin", "PluginState.cs"));
        var match = Regex.Match(pluginState, "PluginVersion\\s*=\\s*\"([0-9.]+)\"");
        Assert.True(match.Success, "Could not find PluginState.PluginVersion — the plugin constant was renamed or reformatted.");

        Assert.Equal(BridgeConfig.BridgeVersion, match.Groups[1].Value);
    }

    [Theory]
    [InlineData("24.1.51.0", "2022 (24.1.51.0)")]
    [InlineData("24.0.30.0", "2021 (24.0.30.0)")]
    [InlineData("24.2.10.0", "2023 (24.2.10.0)")]
    [InlineData("24.3.61.0", "2024 (24.3.61.0)")]
    [InlineData("25.0.189.0", "2025 (25.0.189.0)")]
    [InlineData("26.0.1.0", "2026 (26.0.1.0)")]
    [InlineData("unknown", "unknown")]
    [InlineData("custom-version", "custom-version")]
    public void FormatAutoCadVersion_MapsInternalVersionsToReleaseYears(string raw, string expected)
    {
        var formatted = CadAi.Bridge.Device.AutoCadProcessMonitor.FormatAutoCadVersion(raw);
        Assert.Equal(expected, formatted);
    }
}
