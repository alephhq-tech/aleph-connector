using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace CadAi.Bridge
{
    /// <summary>
    /// Whether a <c>CadAI.bundle</c> on disk can load a plugin at all, and whether it covers the
    /// AutoCAD generation a given machine needs. The rule's canonical definition is the data file
    /// <c>contracts/bundle-rules.json</c>: Rust embeds it (<c>aleph_host::autocad_bundle</c>) and this
    /// class mirrors it, and BOTH run that file's scenario table as a test
    /// (<c>BundleRuleScenarioTests</c> here, <c>every_canonical_scenario_gets_the_shared_verdict</c>
    /// there), so the two layers cannot disagree about what "valid bundle" means (aleph-platform#332 —
    /// they had: Desktop's card required only a manifest plus any Bootstrap DLL while recovery
    /// additionally demanded the versioned plugin assembly <c>current.json</c> names).
    /// </summary>
    public static class BundleRules
    {
        public const string Manifest = "PackageContents.xml";
        public const string CurrentJson = "current.json";
        public const string BootstrapDll = "CadAI.AutoCAD.Bootstrap.dll";
        public const string PluginDll = "CadAI.AutoCAD.dll";
        public const string BootstrapDir = "Bootstrap";
        public const string VersionsDir = "Versions";

        /// <summary>One row of the canonical AutoCAD-series -> plugin-generation table.</summary>
        public sealed record Generation(string Folder, string SeriesMin, string SeriesMax);

        /// <summary>Must equal <c>contracts/bundle-rules.json</c>'s <c>generations</c> table;
        /// <c>BundleRuleScenarioTests</c> fails the build if the two drift.</summary>
        public static IReadOnlyList<Generation> Generations { get; } =
        [
            new("net48", "R24.0", "R24.3"),
            new("net8.0-windows", "R25.0", "R25.1"),
            new("net10.0-windows", "R26.0", "R26.9"),
        ];

        /// <summary>Why this bundle can never load a plugin — the chain AutoCAD's Autoloader walks:
        /// manifest, <c>current.json</c>, a Bootstrap assembly, then the versioned plugin assembly
        /// <c>current.json</c> names under <c>Versions/&lt;current&gt;/&lt;generation&gt;/</c>.
        /// <c>null</c> = intact; otherwise the first broken link, in the same words Desktop's
        /// <c>repairRequired</c> message uses.</summary>
        public static string? Defect(string root)
        {
            if (!File.Exists(Path.Combine(root, Manifest))) return $"{Manifest} is missing";
            if (!File.Exists(Path.Combine(root, CurrentJson))) return $"{CurrentJson} is missing";
            if (BootstrapGenerations(root).Count > 0) return DeclaredPluginDllMissing(root);
            return Directory.Exists(Path.Combine(root, BootstrapDir))
                ? $"no {BootstrapDir} generation contains {BootstrapDll}"
                : $"{BootstrapDir} directory is missing";
        }

        /// <summary>Generations this bundle carries a Bootstrap assembly for.</summary>
        public static IReadOnlyList<string> BootstrapGenerations(string root) =>
            GenerationDirectories(Path.Combine(root, BootstrapDir), BootstrapDll);

        /// <summary>Generations with BOTH a Bootstrap assembly and the versioned plugin assembly
        /// <c>current.json</c> names — i.e. a generation that could load end to end.</summary>
        public static IReadOnlyList<string> CompleteGenerations(string root)
        {
            var version = DeclaredCurrentVersion(root);
            if (version is null) return [];
            return BootstrapGenerations(root)
                .Where(generation => File.Exists(Path.Combine(root, VersionsDir, version, generation, PluginDll)))
                .ToList();
        }

        /// <summary>The plugin generation an AutoCAD series needs (<c>"24.1.0.0"</c>, <c>"R25.0"</c>
        /// and <c>"25.0"</c> all spell the same series); <c>null</c> when the series is unparseable or
        /// outside every range the bundle layout covers.</summary>
        public static string? GenerationFolderForSeries(string series) =>
            Generations.FirstOrDefault(generation => SeriesInRange(series, generation))?.Folder;

        /// <summary>Does this bundle cover the generation <paramref name="series"/> needs? The same
        /// chain rule narrowed to one generation — the difference between "nothing here could load"
        /// and "THIS AutoCAD cannot load". A net48-only bundle against an installed AutoCAD 2025 is
        /// exactly that case, and today it surfaces only as a missing pipe (#332).</summary>
        public static string? CoverageDefect(string root, string series)
        {
            if (SeriesKey(series) is null) return null;
            var needed = Generations.FirstOrDefault(generation => SeriesInRange(series, generation));
            if (needed is null) return $"AutoCAD {series} is outside every plugin generation this bundle covers";
            var complete = CompleteGenerations(root);
            if (complete.Contains(needed.Folder, StringComparer.OrdinalIgnoreCase)) return null;
            var shipped = complete.Count == 0 ? "it ships none" : $"it ships {string.Join(", ", complete)}";
            return $"AutoCAD {series} needs the {needed.Folder} plugin build, which this bundle does not ship ({shipped})";
        }

        /// <summary>The first installed AutoCAD series this bundle cannot serve — the machine-level
        /// form of <see cref="CoverageDefect"/>: a bundle that loads for one window and never opens
        /// a pipe for another is an incomplete install, and the gap should be named at install time
        /// rather than discovered as a missing pipe later. Mirrors Rust's
        /// <c>aleph_host::autocad_bundle::generation_gap</c>.</summary>
        public static string? GenerationGap(string root, IEnumerable<string> series)
        {
            foreach (var value in series)
            {
                var defect = CoverageDefect(root, value);
                if (defect is not null) return defect;
            }
            return null;
        }

        private static bool SeriesInRange(string series, Generation generation) =>
            SeriesKey(series) is { } value
            && SeriesKey(generation.SeriesMin) is { } lo
            && SeriesKey(generation.SeriesMax) is { } hi
            && value >= lo
            && value <= hi;

        /// <summary>A series as a comparable key: <c>R24.1</c>, <c>25.0.0.0</c> and
        /// <c>R25.0.189.0.0</c> all reduce to the same (major, minor) the ranges compare against.
        /// <c>null</c> = not a series this can judge.</summary>
        private static int? SeriesKey(string raw)
        {
            var parts = raw.Trim().TrimStart('R').Split('.');
            if (parts.Length < 2) return null;
            if (!int.TryParse(parts[0], out var major) || !int.TryParse(parts[1], out var minor)) return null;
            return major * 100 + minor;
        }

        private static List<string> GenerationDirectories(string parent, string requiredDll)
        {
            if (!Directory.Exists(parent)) return [];
            return Directory.EnumerateDirectories(parent)
                .Where(generation => File.Exists(Path.Combine(generation, requiredDll)))
                .Select(Path.GetFileName)
                .Where(name => name is not null)
                .Select(name => name!)
                .ToList();
        }

        private static string? DeclaredCurrentVersion(string root)
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, CurrentJson)));
                if (!document.RootElement.TryGetProperty("current", out var declared)) return null;
                var value = declared.GetString();
                return string.IsNullOrWhiteSpace(value) ? null : value;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string? DeclaredPluginDllMissing(string root)
        {
            var currentPath = Path.Combine(root, CurrentJson);
            if (!File.Exists(currentPath)) return $"{CurrentJson} is missing";
            string? version;
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(currentPath));
                version = document.RootElement.TryGetProperty("current", out var declared)
                    ? declared.GetString()
                    : null;
            }
            catch (JsonException)
            {
                return $"{CurrentJson} is not valid JSON";
            }
            if (string.IsNullOrWhiteSpace(version)) return $"{CurrentJson} declares no \"current\" version";
            var versioned = $"{VersionsDir}/{version}";
            var versionsRoot = Path.Combine(root, VersionsDir, version);
            if (!Directory.Exists(versionsRoot)) return $"{CurrentJson} points at {versioned}, which does not exist";
            return Directory.EnumerateDirectories(versionsRoot)
                       .Any(generation => File.Exists(Path.Combine(generation, PluginDll)))
                ? null
                : $"{versioned} contains no {PluginDll} for any runtime generation";
        }
    }
}
