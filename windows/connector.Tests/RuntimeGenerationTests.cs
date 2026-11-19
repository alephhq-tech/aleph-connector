using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// Pins the two per-TFM generation constants in the plugin — <c>PluginState.RuntimeGeneration</c> and
/// Bootstrap's <c>RuntimeFolderName</c> — to the folder names in <c>contracts/bundle-rules.json</c>,
/// the canonical series-to-generation table both languages already judge bundles with (#332).
/// <para>
/// Why this matters: the Autoloader picks the Bootstrap folder from AutoCAD's own version, then that
/// Bootstrap loads <c>Versions/{current}/{RuntimeFolderName}/CadAI.AutoCAD.dll</c>. A constant that
/// drifts from the table (or from the folder the packager writes) means AutoCAD 2025 silently loads a
/// build for a different runtime — which surfaces as a named bundle defect at best and a missing
/// named pipe at worst, and neither end can see it. These constants are also the value
/// <c>system.status</c> reports as <c>runtimeGeneration</c>, so a wrong one makes the Bridge's
/// diagnosis wrong too.
/// </para>
/// The constants are read from source text rather than referenced as assemblies: the plugin projects
/// need AutoCAD's reference assemblies, and a test-only project reference would drag them into the
/// Bridge's CI build — the same reason <see cref="BridgeVersionTests"/> does this.
/// </summary>
public sealed class RuntimeGenerationTests
{
    private static string FindIntegrationRoot()
    {
        // Walk up from the test assembly's output dir to the Windows runtime root, which holds
        // contracts/ and autocad-plugin/.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "contracts", "bundle-rules.json"))) return dir.FullName;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not walk up from the test assembly to a directory containing contracts/bundle-rules.json — " +
            "the canonical bundle rule moved without this test being updated.");
    }

    private static string Read(string relative) =>
        File.ReadAllText(Path.Combine(FindIntegrationRoot(), relative));

    /// <summary>The folder names a per-TFM <c>#if</c> constant can assign — every branch, not just
    /// the one this test assembly happens to compile against.</summary>
    private static string[] GenerationBranches(string relative, string constant)
    {
        var source = Read(relative);
        var block = Regex.Match(source, constant + @"\s*=\s*(.*?)#endif", RegexOptions.Singleline);
        if (block.Success)
        {
            var branches = Regex.Matches(block.Groups[1].Value, "\"([^\"]+)\"")
                .Select(quoted => quoted.Groups[1].Value)
                .ToArray();
            Assert.True(branches.Length > 1, $"{constant} in {relative} lost its #if branches.");
            return branches;
        }
        var single = Regex.Match(source, constant + "\\s*=\\s*\"([^\"]+)\"");
        Assert.True(single.Success, $"Could not find {constant} in {relative} — it was renamed or reformatted.");
        return [single.Groups[1].Value];
    }

    private static string[] ContractFolders() =>
        JsonDocument.Parse(Read(Path.Combine("contracts", "bundle-rules.json")))
            .RootElement.GetProperty("generations").EnumerateArray()
            .Select(generation => generation.GetProperty("folder").GetString()!)
            .ToArray();

    /// <summary>Every branch names a folder the layout table knows, and the two constants agree —
    /// a Bootstrap can only load a plugin assembly of its own generation.</summary>
    [Fact]
    public void PluginAndBootstrapGenerationBranchesMatchTheCanonicalTable()
    {
        var expected = ContractFolders().OrderBy(x => x).ToArray();

        var plugin = GenerationBranches(Path.Combine("autocad-plugin", "PluginState.cs"), "RuntimeGeneration");
        var bootstrap = GenerationBranches(
            Path.Combine("autocad-plugin", "Bootstrap", "BootstrapExtensionApplication.cs"), "RuntimeFolderName");

        Assert.Equal(expected, plugin.OrderBy(x => x).ToArray());
        Assert.Equal(expected, bootstrap.OrderBy(x => x).ToArray());
    }

    /// <summary>The packager builds exactly the generations the table names, so a table row cannot
    /// promise a folder no artifact is ever produced for.</summary>
    [Fact]
    public void BuildBundleScriptProducesTheCanonicalGenerations()
    {
        var script = Read(Path.Combine("installer", "autocad-bundle", "build-bundle.ps1"));

        foreach (var folder in ContractFolders())
        {
            Assert.Contains($"Name = '{folder}'", script);
        }
    }
}
