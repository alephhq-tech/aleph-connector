using System;
using System.IO;

namespace CadAi.Bridge
{
    /// <summary>
    /// Where an installed AutoCAD plugin bundle lives. Autodesk documents three
    /// <c>ApplicationPlugins</c> discovery folders and states plainly that only the one under
    /// <c>%ProgramFiles%</c> is trusted unconditionally — "The plug-ins in this location are trusted
    /// and are not checked for the presence of a digital signature. All other ApplicationPlugins
    /// folders must be trusted as part of the application's preferences and should to be digitally
    /// signed." (About Installing and Uninstalling Plug-In Applications). Aleph installs to the
    /// per-user <c>%APPDATA%</c> location so an install needs no elevation (installer/README.md),
    /// which is why a bundle an administrator placed in the trusted location has to outrank ours:
    /// that is the bundle AutoCAD will load regardless of what we installed.
    /// </summary>
    public static class BundleLayout
    {
        private const string VendorFolder = "Autodesk";
        private const string PluginsFolder = "ApplicationPlugins";
        private const string BundleFolder = "CadAI.bundle";

        /// <summary>Autodesk's implicitly-trusted location: loads with no security prompt, but
        /// writable only by administrators, so Aleph's own installer never writes it.</summary>
        public static string TrustedBundleRoot()
        {
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            return Path.Combine(programFiles, VendorFolder, PluginsFolder, BundleFolder);
        }

        /// <summary>The per-user location Aleph's installer writes: no elevation, but under
        /// <c>SECURELOAD=1</c> it loads without a prompt only once the folder is in
        /// <c>TRUSTEDPATHS</c> or the assemblies are signed.</summary>
        public static string UserBundleRoot()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, VendorFolder, PluginsFolder, BundleFolder);
        }

        /// <summary>The bundle this machine actually uses: a populated trusted bundle first, then
        /// the per-user one (also the install target when neither exists).</summary>
        public static string ResolveInstalledBundleRoot() =>
            ResolveBundleRoot(TrustedBundleRoot(), UserBundleRoot());

        /// <summary>Precedence over explicit roots so the recovery/update decision is testable
        /// against temp directories instead of whatever this machine happens to have. Mirrors Rust's
        /// <c>aleph_host::autocad_layout::choose_bundle_root</c> — the two layers must land on the
        /// same bundle on the same machine.</summary>
        public static string ResolveBundleRoot(string trusted, string user)
        {
            if (Directory.Exists(trusted)) return trusted;
            return user;
        }

        /// <summary>True when writing this path needs elevation, i.e. it is at or under
        /// <c>%ProgramFiles%\Autodesk\ApplicationPlugins</c>. Deterministic rather than probing the
        /// ACL: which folder we chose is a product rule, not a property of the machine, and this
        /// stays testable against a temp-directory bundle.</summary>
        public static bool RequiresElevation(string bundleRoot)
        {
            var programPlugins = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), VendorFolder, PluginsFolder);
            var candidate = Path.GetFullPath(bundleRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var prefix = Path.GetFullPath(programPlugins).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return candidate.Equals(prefix, StringComparison.OrdinalIgnoreCase)
                || candidate.StartsWith(prefix + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
    }
}
