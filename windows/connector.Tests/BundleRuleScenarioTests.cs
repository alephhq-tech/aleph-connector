using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// The C# half of the drift guard for the shared bundle rule. <c>contracts/bundle-rules.json</c> is
/// the rule's canonical definition. Running it here against <see cref="BundleRules"/> means a rule
/// edited in the contract or C# runtime without the other fails.
/// </summary>
public sealed class BundleRuleScenarioTests
{
    private sealed record Scenario(
        string Name,
        List<string> Dirs,
        List<string> Files,
        string? CurrentJson,
        string? Defect);

    private static string FindContractFile()
    {
        // Walk up from bin/{config}/{tfm} to the repo, same rule as BridgeVersionTests/
        // PluginVersionTests, so the test does not care where CI put the checkout.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "windows", "contracts", "bundle-rules.json");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new FileNotFoundException("contracts/bundle-rules.json not found from " + AppContext.BaseDirectory);
    }

    private static List<string> Strings(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray().Select(item => item.GetString()!).ToList()
            : [];

    private sealed record Contract(
        List<Scenario> Scenarios,
        List<BundleRules.Generation> Generations,
        Dictionary<string, string> Names);

    private static Contract ReadContract()
    {
        // Parse into plain values: a JsonElement cannot outlive the JsonDocument it came from.
        using var document = JsonDocument.Parse(File.ReadAllText(FindContractFile()));
        var root = document.RootElement;
        var scenarios = root.GetProperty("scenarios").EnumerateArray()
            .Select(element => new Scenario(
                element.GetProperty("name").GetString()!,
                Strings(element, "dirs"),
                Strings(element, "files"),
                element.TryGetProperty("currentJson", out var current) ? current.GetString() : null,
                element.TryGetProperty("defect", out var defect) && defect.ValueKind != JsonValueKind.Null
                    ? defect.GetString()
                    : null))
            .ToList();
        var generations = root.GetProperty("generations").EnumerateArray()
            .Select(g => new BundleRules.Generation(
                g.GetProperty("folder").GetString()!,
                g.GetProperty("seriesMin").GetString()!,
                g.GetProperty("seriesMax").GetString()!))
            .ToList();
        var names = new Dictionary<string, string>
        {
            ["manifest"] = root.GetProperty("manifest").GetString()!,
            ["currentJson"] = root.GetProperty("currentJson").GetString()!,
            ["bootstrapDll"] = root.GetProperty("bootstrapDll").GetString()!,
            ["pluginDll"] = root.GetProperty("pluginDll").GetString()!,
            ["bootstrapDir"] = root.GetProperty("bootstrapDir").GetString()!,
            ["versionsDir"] = root.GetProperty("versionsDir").GetString()!,
        };
        return new Contract(scenarios, generations, names);
    }


    [Fact]
    public void TheFixtureTableIsPresentAndNotShrunk()
    {
        Assert.True(ReadContract().Scenarios.Count >= 8, "the shared fixture table shrank");
    }

    [Fact]
    public void EveryCanonicalScenarioGetsTheSharedVerdict()
    {
        foreach (var scenario in ReadContract().Scenarios)
        {
            var parent = Path.Combine(Path.GetTempPath(), $"cadai-scenario-{Guid.NewGuid():N}");
            var root = Path.Combine(parent, "CadAI.bundle");
            MaterializeAt(root, scenario);
            try
            {
                Assert.Equal(scenario.Defect, BundleRules.Defect(root));
            }
            finally
            {
                Directory.Delete(parent, recursive: true);
            }
        }
    }

    private static void MaterializeAt(string root, Scenario scenario)
    {
        Directory.CreateDirectory(root);
        foreach (var dir in scenario.Dirs) Directory.CreateDirectory(Path.Combine(root, dir.Replace('/', Path.DirectorySeparatorChar)));
        foreach (var file in scenario.Files)
        {
            var path = Path.Combine(root, file.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, file.EndsWith(BundleRules.CurrentJson, StringComparison.OrdinalIgnoreCase) ? scenario.CurrentJson ?? "" : "");
        }
    }

    [Fact]
    public void TheCSharpGenerationTableMatchesTheCanonicalOne()
    {
        Assert.Equal(ReadContract().Generations, BundleRules.Generations);
    }

    [Fact]
    public void TheCSharpFileNamesMatchTheCanonicalOnes()
    {
        var names = ReadContract().Names;
        Assert.Equal(BundleRules.Manifest, names["manifest"]);
        Assert.Equal(BundleRules.CurrentJson, names["currentJson"]);
        Assert.Equal(BundleRules.BootstrapDll, names["bootstrapDll"]);
        Assert.Equal(BundleRules.PluginDll, names["pluginDll"]);
        Assert.Equal(BundleRules.BootstrapDir, names["bootstrapDir"]);
        Assert.Equal(BundleRules.VersionsDir, names["versionsDir"]);
    }

    /// <summary>The #332 shape, named rather than inferred: an installed AutoCAD 2025 against a
    /// net48-only bundle must be reported as a missing generation, not as a broken pipe.</summary>
    [Fact]
    public void AGenerationGapIsNamedForTheSeriesThatNeedsIt()
    {
        var root = Path.Combine(Path.GetTempPath(), $"cadai-coverage-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path.Combine(root, "Bootstrap/net48"));
        Directory.CreateDirectory(Path.Combine(root, "Versions/9.9.9/net48"));
        File.WriteAllText(Path.Combine(root, BundleRules.Manifest), "");
        File.WriteAllText(Path.Combine(root, BundleRules.CurrentJson), "{ \"current\": \"9.9.9\" }");
        File.WriteAllText(Path.Combine(root, "Bootstrap/net48", BundleRules.BootstrapDll), "");
        File.WriteAllText(Path.Combine(root, "Versions/9.9.9/net48", BundleRules.PluginDll), "");

        // The chain rule says nothing is wrong: AutoCAD 2022 could load this bundle.
        Assert.Null(BundleRules.Defect(root));
        Assert.Null(BundleRules.CoverageDefect(root, "24.1.0.0"));
        Assert.Equal(
            "AutoCAD 25.0.0.0 needs the net8.0-windows plugin build, which this bundle does not ship (it ships net48)",
            BundleRules.CoverageDefect(root, "25.0.0.0"));
        // An unparseable series earns no claim, not a false alarm.
        Assert.Null(BundleRules.CoverageDefect(root, "unknown"));

        Directory.Delete(root, recursive: true);
    }

    [Theory]
    [InlineData("R24.0", "net48")]
    [InlineData("R24.3", "net48")]
    [InlineData("24.1.0.0", "net48")]
    [InlineData("R25.0", "net8.0-windows")]
    [InlineData("25.0.0.0", "net8.0-windows")]
    [InlineData("R25.0.189.0.0", "net8.0-windows")]
    [InlineData("R25.1", "net8.0-windows")]
    [InlineData("R26.0", "net10.0-windows")]
    [InlineData("R23.1", null)]
    [InlineData("not a series", null)]
    public void SeriesSpellingsResolveToTheirGeneration(string series, string? expected)
    {
        Assert.Equal(expected, BundleRules.GenerationFolderForSeries(series));
    }
}
