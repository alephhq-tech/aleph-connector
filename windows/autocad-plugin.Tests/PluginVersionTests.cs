using System;
using System.IO;
using System.Xml.Linq;
using CadAI.AutoCAD;
using Xunit;

namespace CadAI.AutoCAD.Tests;

/// <summary>
/// Pins <see cref="PluginState.PluginVersion"/> to the version the installer bundle templates
/// ship (<c>installer/autocad-bundle/CadAI.bundle/current.json</c> + <c>PackageContents.xml</c>'s
/// <c>AppVersion</c>). A real drift shipped once: the constant stayed 0.1.0 while the bundle was
/// installed under Versions/0.1.1, so CADAISTATUS and system.status reported a version no folder
/// matched. The constant is what the running plugin reports; the templates are what
/// build-bundle.ps1 installs by default — they must agree.
/// </summary>
public class PluginVersionTests
{
    private static string FindBundleTemplateDir()
    {
        // Walk up from the test assembly's output dir to the integration root, which holds
        // installer/autocad-bundle/CadAI.bundle/ — robust to bin/Debug/{tfm} depth and CI layout.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "installer", "autocad-bundle", "CadAI.bundle");
            if (File.Exists(Path.Combine(candidate, "current.json"))) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not walk up from the test assembly to a directory containing installer/autocad-bundle/CadAI.bundle — " +
            "the installer templates moved without this test being updated.");
    }

    [Fact]
    public void PluginVersion_MatchesBundleCurrentJsonTemplate()
    {
        var bundleDir = FindBundleTemplateDir();
        var currentJson = File.ReadAllText(Path.Combine(bundleDir, "current.json"));
        var templateVersion = System.Text.Json.JsonDocument.Parse(currentJson)
            .RootElement.GetProperty("current").GetString();

        Assert.Equal(templateVersion, PluginState.PluginVersion);
    }

    [Fact]
    public void PluginVersion_MatchesPackageContentsAppVersion()
    {
        var bundleDir = FindBundleTemplateDir();
        var doc = XDocument.Load(Path.Combine(bundleDir, "PackageContents.xml"));
        var appVersion = doc.Root?.Attribute("AppVersion")?.Value;

        Assert.Equal(PluginState.PluginVersion, appVersion);
    }
}
