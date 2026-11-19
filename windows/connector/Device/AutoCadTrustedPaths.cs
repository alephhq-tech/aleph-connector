using CadAi.Bridge.Diagnostics;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Win32;

namespace CadAi.Bridge.Device
{
    /// <summary>
    /// Keeps AutoCAD's per-profile <c>TRUSTEDPATHS</c> aware of the bundle this machine installed.
    ///
    /// Only <c>%ProgramFiles%\Autodesk\ApplicationPlugins</c> is implicitly trusted; Autodesk's
    /// TRUSTEDPATHS reference states that "the setting of the SECURELOAD system variable determines
    /// whether other locations, including the current drawing folder, are trusted", and Aleph
    /// installs to the per-user <c>%APPDATA%</c> location precisely to avoid needing elevation. With
    /// AutoCAD's default <c>SECURELOAD=1</c> and an unsigned assembly, that leaves the plugin
    /// untrusted: nothing fails loudly, AutoCAD simply never loads it — the "Aleph says installed
    /// but CADAISTATUS never answers" class. This appends the installed bundle folder to each
    /// profile's list (HKCU, so no elevation) and never touches any other entry.
    /// </summary>
    public sealed class AutoCadTrustedPaths
    {
        private const string AutoCadRoot = @"Software\Autodesk\AutoCAD";
        private const string VariablesValue = "TRUSTEDPATHS";

        private readonly IBridgeLogger _logger;

        public AutoCadTrustedPaths(IBridgeLogger logger)
        {
            _logger = logger;
        }

        public int EnsureTrusted(string bundleRoot)
        {
            if (BundleLayout.RequiresElevation(bundleRoot)) return 0; // always trusted already
            var wanted = TrustedEntry(bundleRoot);
            var updated = 0;
            foreach (var variables in EnumerateProfileVariableKeys())
            {
                try
                {
                    var merged = MergeTrustedPaths(variables.GetValue(VariablesValue) as string, wanted);
                    if (merged is null) continue;
                    variables.SetValue(VariablesValue, merged, RegistryValueKind.String);
                    updated++;
                }
                catch (Exception ex)
                {
                    // An administrator-locked TRUSTEDPATHS profile is a report, not a crash.
                    _logger.LogWarning($"could not add \"{wanted}\" to AutoCAD trusted paths for {variables.Name}", ex);
                }
            }
            if (updated > 0)
                _logger.LogInformation($"added \"{wanted}\" to AutoCAD trusted paths in {updated} profile(s); restart AutoCAD to load the plugin");
            return updated;
        }

        private static string TrustedEntry(string bundleRoot) =>
            bundleRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + SubfolderSuffix;

        /// <summary>Autodesk's documented suffix for "this folder and all its subfolders".</summary>
        private const string SubfolderSuffix = @"\...";

        /// <summary>Every <c>...\Profiles\&lt;name&gt;\Variables</c> key this user owns. AutoCAD nests
        /// profiles one level below its release folder — the layout on this machine is
        /// <c>HKCU\Software\Autodesk\AutoCAD\R24.1\ACAD-5101:409\Profiles\&lt;profile&gt;\Variables</c>
        /// (verified against real AutoCAD 2022 + 2025 installs) — so <c>Profiles</c> is looked for at
        /// both depths instead of assuming one.</summary>
        private static IEnumerable<RegistryKey> EnumerateProfileVariableKeys()
        {
            using var root = Registry.CurrentUser.OpenSubKey(AutoCadRoot);
            if (root is null) yield break;
            foreach (var releaseName in root.GetSubKeyNames())
            {
                using var release = root.OpenSubKey(releaseName, writable: true);
                if (release is null) continue;
                foreach (var profiles in OpenProfilesKeys(release))
                {
                    using (profiles)
                    {
                        foreach (var profileName in profiles.GetSubKeyNames())
                        {
                            using var profile = profiles.OpenSubKey(profileName, writable: true);
                            var variables = profile?.OpenSubKey("Variables", writable: true);
                            if (variables is not null) yield return variables;
                        }
                    }
                }
            }
        }

        private static IEnumerable<RegistryKey> OpenProfilesKeys(RegistryKey release)
        {
            var direct = release.OpenSubKey("Profiles", writable: true);
            if (direct is not null) yield return direct;
            foreach (var productName in release.GetSubKeyNames())
            {
                var nested = release.OpenSubKey($@"{productName}\Profiles", writable: true);
                if (nested is not null) yield return nested;
            }
        }

        /// <summary>The list <paramref name="existing"/> needs in order to cover
        /// <paramref name="wanted"/>, or null when it already does. Pure, so the merge rule is
        /// testable without a registry: entries are kept in their original order and this only ever
        /// appends — a path the user or an administrator set is never rewritten or dropped, and a
        /// covered path is never written twice.</summary>
        public static string? MergeTrustedPaths(string? existing, string wanted)
        {
            if (ContainsTrustedPath(existing, wanted)) return null;
            var entries = SplitTrustedPaths(existing);
            entries.Add(wanted);
            return string.Join(";", entries);
        }

        /// <summary>True when <paramref name="existing"/> already lets AutoCAD load code from
        /// <paramref name="wanted"/>: the identical entry, or a broader entry whose documented
        /// <c>\...</c> subtree covers it.</summary>
        public static bool ContainsTrustedPath(string? existing, string wanted)
        {
            if (string.IsNullOrWhiteSpace(wanted)) return true;
            var wantedPath = Normalize(wanted);
            foreach (var entry in SplitTrustedPaths(existing))
            {
                var entryPath = Normalize(entry);
                if (entryPath == wantedPath) return true;
                if (entryPath.EndsWith(SubfolderSuffix)
                    && wantedPath.StartsWith(entryPath[..^SubfolderSuffix.Length], StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        private static List<string> SplitTrustedPaths(string? existing) =>
            string.IsNullOrWhiteSpace(existing)
                ? []
                : existing.Split(';').Where(entry => !string.IsNullOrWhiteSpace(entry)).ToList();

        private static string Normalize(string path) =>
            path.Trim().Trim('"').Replace('/', Path.DirectorySeparatorChar);
    }
}
