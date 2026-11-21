using System.Diagnostics;

namespace CadAI.AutoCAD
{
    /// <summary>Process-wide state shared across RPC handler instances.</summary>
    public static class PluginState
    {
        /// <summary>
        /// Version of this build of the versioned plugin assembly. Must match the
        /// folder name it ships under in the bundle's <c>Versions/</c> directory
        /// (see installer/autocad-bundle/CadAI.bundle/current.json) — the Updater
        /// (<c>CadAi.Updater.IUpdateCoordinator.StagePluginAsync</c>) is what keeps
        /// those in sync at install time. <c>PluginVersionTests</c> fails the build if
        /// this constant and the installer bundle templates ever drift apart — a real
        /// drift shipped once (constant 0.1.0 inside a bundle installed as 0.1.1, so
        /// <c>CADAISTATUS</c> and <c>system.status</c> reported the wrong version).
        /// Bump together with the <c>-Version</c> passed to build-bundle.ps1/package-client.ps1.
        /// </summary>
        public const string PluginVersion = "0.1.0";

        public static readonly Stopwatch Uptime = new Stopwatch();

        /// <summary>
        /// The AutoCAD managed-runtime generation this assembly was built for, which is also the
        /// folder AutoCAD's Autoloader picked it from (<c>Versions/{current}/{this}/</c>). Reported
        /// by <c>system.status</c> and <c>CADAISTATUS</c> so a bundle that ships the wrong
        /// generation reads as a named mismatch instead of a missing pipe (aleph-platform#332).
        /// Must stay equal to Bootstrap's <c>RuntimeFolderName</c> — a plugin can only be loaded by
        /// a Bootstrap of its own generation — and <c>RuntimeGenerationTests</c> pins both to
        /// <c>contracts/bundle-rules.json</c>.
        /// </summary>
        public const string RuntimeGeneration =
#if NET10_0_OR_GREATER
            "net10.0-windows";
#elif NET8_0_OR_GREATER
            "net8.0-windows";
#else
            "net48";
#endif
    }
}
