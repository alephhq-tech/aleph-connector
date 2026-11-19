using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using CadAi.Bridge.Diagnostics;

namespace CadAi.Bridge.Device
{
    /// <summary>
    /// Reacts to "AutoCAD is running but its plugin IPC never appeared" — the only signal the
    /// headless Bridge has that the plugin failed to load. Two distinct causes, two distinct fixes:
    /// a bundle that is missing or broken gets recopied from the packaged repair bundle, and a
    /// complete bundle AutoCAD refuses to load gets registered in that profile's TRUSTEDPATHS
    /// (only <c>%ProgramFiles%\Autodesk\ApplicationPlugins</c> is implicitly trusted, and Aleph
    /// installs per-user to avoid elevation). Neither ever touches a running AutoCAD process or an
    /// open drawing; the user closes and reopens AutoCAD to pick up the fix.
    /// </summary>
    public sealed class PluginRecoveryService
    {
        private readonly string _sourceBundle;
        private readonly string _installedBundle;
        private readonly Func<string, int> _ensureTrusted;
        private readonly Func<string, bool> _requiresElevation;
        private readonly IBridgeLogger _logger;

        /// <param name="ensureTrusted">Registers <c>_installedBundle</c> in AutoCAD's trusted paths,
        /// returning how many profiles changed.</param>
        /// <param name="requiresElevation">Defaults to <see cref="BundleLayout.RequiresElevation"/>;
        /// injectable so the unwritable-location branch is testable without touching a real
        /// <c>%ProgramFiles%</c> path (which a CI runner may well allow writing).</param>
        public PluginRecoveryService(
            string sourceBundle,
            string installedBundle,
            Func<string, int> ensureTrusted,
            IBridgeLogger logger,
            Func<string, bool>? requiresElevation = null)
        {
            _sourceBundle = sourceBundle;
            _installedBundle = installedBundle;
            _ensureTrusted = ensureTrusted;
            _requiresElevation = requiresElevation ?? BundleLayout.RequiresElevation;
            _logger = logger;
        }

        public bool TryRepair(int processId, string reason)
        {
            var validation = ValidateBundle(_sourceBundle);
            if (validation is not null)
            {
                _logger.LogWarning($"AutoCAD pid {processId} needs plugin recovery ({reason}), but packaged repair bundle is invalid: {validation}");
                return false;
            }

            // A missing installed bundle is already covered by BundlesMatch (it compares files);
            // naming it "incomplete" would just mislabel the ordinary first-install case.
            var installedDefect = Directory.Exists(_installedBundle) ? DeclaredPluginDllMissing(_installedBundle) : null;
            if (BundlesMatch(_sourceBundle, _installedBundle) && installedDefect is null)
            {
                // Files are right, so the load failure is AutoCAD declining to trust this location.
                // HKCU is user-writable: fixing it needs no elevation and no reinstall.
                var profiles = _ensureTrusted(_installedBundle);
                if (profiles > 0)
                {
                    _logger.LogWarning($"AutoCAD pid {processId} has no plugin IPC ({reason}); added the bundle to AutoCAD's trusted paths in {profiles} profile(s). Close and reopen AutoCAD to load it.");
                    return true;
                }
                _logger.LogWarning($"AutoCAD pid {processId} has no plugin IPC ({reason}), but the installed bundle matches the packaged bundle and is already in AutoCAD's trusted paths; inspect AutoCAD SECURELOAD/TRUSTEDPATHS and bootstrap logs");
                return false;
            }
            if (installedDefect is not null)
            {
                // The case the two-file compare could never see: `PackageContents.xml` and
                // `current.json` byte-identical to the packaged bundle, so it concluded "files are
                // right" and went hunting for a trust problem, while the versioned plugin DLL that
                // `current.json` points the Bootstrap at was simply not there and nothing could load.
                _logger.LogWarning($"AutoCAD pid {processId} has no plugin IPC ({reason}); the installed bundle is incomplete: {installedDefect}");
            }

            if (_requiresElevation(_installedBundle))
            {
                // The Bridge runs as an unprivileged Scheduled-Task process, so it cannot write the
                // implicitly-trusted %ProgramFiles% location. Aleph Desktop owns that install, so
                // name the action instead of failing mid-copy with an access error nobody can read.
                _logger.LogWarning($"AutoCAD pid {processId} needs plugin recovery ({reason}), but \"{_installedBundle}\" is only writable with elevated rights; reinstall the integration from Aleph Desktop (Settings -> Plugin)");
                return false;
            }

            CopyDirectory(_sourceBundle, _installedBundle);
            _ensureTrusted(_installedBundle);
            _logger.LogWarning($"Repaired CadAI.bundle for AutoCAD pid {processId}. The running process was not modified; close and reopen AutoCAD to load it.");
            return true;
        }

        /// <summary>Everything the packaged bundle has to hold for a repair to be worth attempting —
        /// the same canonical chain Desktop validates (<see cref="BundleRules.Defect"/>; two
        /// definitions of "valid bundle" is what let one layer call a dead bundle valid).</summary>
        private static string? ValidateBundle(string root) => BundleRules.Defect(root);

        /// <summary>The one check recovery still needs on the installed side: whether the bundle's
        /// chain is broken even though its manifests match the packaged copy.</summary>
        private static string? DeclaredPluginDllMissing(string root) => BundleRules.Defect(root);

        private static bool BundlesMatch(string source, string destination)
        {
            if (!Directory.Exists(destination)) return false;
            foreach (var relative in new[] { "PackageContents.xml", "current.json" })
            {
                var sourcePath = Path.Combine(source, relative);
                var destinationPath = Path.Combine(destination, relative);
                if (!File.Exists(destinationPath)) return false;
                if (!File.ReadAllBytes(sourcePath).AsSpan().SequenceEqual(File.ReadAllBytes(destinationPath))) return false;
            }
            return true;
        }

        private static void CopyDirectory(string source, string destination)
        {
            Directory.CreateDirectory(destination);
            foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            {
                Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
            }
            foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
            {
                var target = Path.Combine(destination, Path.GetRelativePath(source, file));
                File.Copy(file, target, overwrite: true);
            }
        }
    }
}
