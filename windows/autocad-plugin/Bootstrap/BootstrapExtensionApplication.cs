using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Application = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using Autodesk.AutoCAD.Runtime;
using Newtonsoft.Json.Linq;

[assembly: ExtensionApplication(typeof(CadAI.AutoCAD.Bootstrap.BootstrapExtensionApplication))]
[assembly: CommandClass(typeof(CadAI.AutoCAD.Bootstrap.BootstrapExtensionApplication))]

namespace CadAI.AutoCAD.Bootstrap
{
    /// <summary>
    /// The only assembly AutoCAD ever registers directly (via
    /// <c>CadAI.bundle/PackageContents.xml</c>). Its whole job is to read
    /// <c>current.json</c> next to the bundle root and load the versioned plugin
    /// DLL it names (from <c>Versions/{version}/{RuntimeFolderName}/</c>), then
    /// forward the AutoCAD lifecycle (<see cref="Initialize"/>/<see cref="Terminate"/>)
    /// into it through <see cref="IPluginEntryPoint"/>. See README, "Bootstrap vs
    /// versioned plugin" — this indirection is what lets an update land a new
    /// versioned DLL without ever touching (or needing to unload) this assembly
    /// while AutoCAD is running.
    ///
    /// On net8.0-windows/net10.0-windows (AutoCAD 2025+) the versioned plugin loads
    /// into a collectible <see cref="PluginLoadContext"/>, which also backs
    /// <c>CADAIRELOAD</c> (see README, "Hot reload"): unload the current versioned
    /// plugin and load whatever <c>current.json</c> names right now, fresh from
    /// disk, without restarting AutoCAD. On net48 (AutoCAD 2021-2024) there is no
    /// <c>AssemblyLoadContext</c> in .NET Framework, so loading is a plain
    /// <see cref="Assembly.LoadFrom(string)"/> and <c>CADAIRELOAD</c> just reports
    /// that hot-reload isn't available — updating the plugin there requires
    /// restarting AutoCAD.
    /// </summary>
    public sealed class BootstrapExtensionApplication : IExtensionApplication
    {
        // Static, not instance fields: AutoCAD creates a *new* instance of this class for
        // every non-static [CommandMethod] invocation (CADAISTATUS, CADAIRELOAD) — it does
        // NOT reuse the one instance IExtensionApplication.Initialize() ran on. Instance
        // fields here would make every CADAIRELOAD operate on a blank object with `_plugin`
        // always null, so `_plugin?.Terminate()` would silently no-op and the previous
        // plugin/pipe server would never actually stop — exactly the documented AutoCAD .NET
        // "IExtensionApplication + instance CommandMethod" trap. One AutoCAD process only
        // ever has one versioned plugin loaded, so process-wide static state is correct here
        // (not per-document — this class has nothing to do with which document is active).
#if NET8_0_OR_GREATER
        private static PluginLoadContext? _loadContext;
#endif
        private static IPluginEntryPoint? _plugin;
        private static string? _loadedVersion;

        // Matches the per-generation subfolder this build's own Versions/{version}/ layout
        // uses — see installer/autocad-bundle/README.md and build-bundle.ps1.
        private const string RuntimeFolderName =
#if NET10_0_OR_GREATER
            "net10.0-windows";
#elif NET8_0_OR_GREATER
            "net8.0-windows";
#else
            "net48";
#endif

        public void Initialize() => LoadVersionedPlugin();

        public void Terminate()
        {
            try
            {
                _plugin?.Terminate();
            }
            catch
            {
                // AutoCAD is already tearing down; nothing left to recover into.
            }
        }

        [CommandMethod("CADAISTATUS")]
        public void ReportStatus()
        {
            if (_plugin != null)
            {
                WriteLine(_plugin.DescribeStatus());
                return;
            }
            try
            {
                var bundleRoot = ResolveBundleRoot();
                var offered = OfferedGenerations(bundleRoot);
                WriteLine(offered.Count == 0
                    ? "No versioned CadAI plugin is currently loaded, and no Bootstrap generation was found under this bundle."
                    : $"No versioned CadAI plugin is currently loaded. This AutoCAD needs the {RuntimeFolderName} build; this bundle offers: {string.Join(", ", offered)}.");
            }
            catch (System.Exception ex)
            {
                WriteLine($"No versioned CadAI plugin is currently loaded ({ex.Message}).");
            }
        }

        [CommandMethod("CADAIEDITS")]
        public void ReportEdits()
        {
            if (_plugin != null)
            {
                WriteLine(_plugin.DescribeEdits());
                return;
            }
            WriteLine("No versioned CadAI plugin is currently loaded.");
        }
        /// <summary>Which generations this bundle carries a Bootstrap assembly for — the same
        /// evidence <c>BundleRules.CompleteGenerations</c>/<c>aleph_host::autocad_bundle</c> read
        /// from the installed copy, read here from inside the live AutoCAD process so
        /// <c>CADAISTATUS</c> can name a mismatch without the Bridge (aleph-platform#332).</summary>
        private static List<string> OfferedGenerations(string bundleRoot) =>
            GenerationsWithDll(Path.Combine(bundleRoot, "Bootstrap"), "CadAI.AutoCAD.Bootstrap.dll");

        /// <summary>Immediate subdirectories of <paramref name="root"/> that carry <paramref name="dll"/>,
        /// sorted — the shared scan behind both <see cref="OfferedGenerations"/> (what the bundle can
        /// load at all) and <see cref="LoadVersionedPlugin"/>'s missing-DLL message (what THIS
        /// version ships). Missing <paramref name="root"/> is silently empty, not an error.</summary>
        private static List<string> GenerationsWithDll(string root, string dll)
        {
            if (!Directory.Exists(root)) return new List<string>();
            return Directory.GetDirectories(root)
                .Where(dir => File.Exists(Path.Combine(dir, dll)))
                .Select(dir => Path.GetFileName(dir) ?? dir)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();
        }

        /// <summary>
        /// Unloads the currently-loaded versioned plugin (if any) and loads whatever
        /// <c>current.json</c> names right now, fresh from disk — without restarting
        /// AutoCAD. Rebuild <c>CadAI.AutoCAD.dll</c>, run this, and the new code is live;
        /// no NETLOAD needed since Bootstrap itself never changes. See README, "Hot reload".
        /// </summary>
        [CommandMethod("CADAIRELOAD")]
        public void Reload()
        {
#if NET8_0_OR_GREATER
            var previousVersion = _loadedVersion;
            var weakContext = UnloadCurrentPlugin();
            _loadedVersion = null;

            if (weakContext != null && weakContext.IsAlive)
            {
                WriteLine("Warning: the previous plugin assembly did not fully unload (something is still holding a reference to it) — loading the new version anyway, but the old version's memory will not be reclaimed until AutoCAD restarts.");
            }

            LoadVersionedPlugin();

            WriteLine(_loadedVersion == null
                ? $"Reload failed — see the message above. Previous version (v{previousVersion ?? "none"}) is no longer loaded."
                : previousVersion == _loadedVersion
                    ? $"Reloaded CadAI plugin v{_loadedVersion} from disk."
                    : $"Reloaded CadAI plugin: v{previousVersion ?? "none"} -> v{_loadedVersion}.");
#else
            WriteLine("CADAIRELOAD is not supported on this AutoCAD version (.NET Framework 4.8 has no AssemblyLoadContext to unload from). Restart AutoCAD to load a new plugin version.");
#endif
        }

        private void LoadVersionedPlugin()
        {
            try
            {
                var bundleRoot = ResolveBundleRoot();
                var version = ReadCurrentVersion(Path.Combine(bundleRoot, "current.json"));
                if (version == null)
                {
                    WriteLine("current.json is missing or malformed under the bundle root; no versioned plugin was loaded. AutoCAD will continue starting normally.");
                    return;
                }

                var versionedDllPath = Path.Combine(bundleRoot, "Versions", version, RuntimeFolderName, "CadAI.AutoCAD.dll");
                if (!File.Exists(versionedDllPath))
                {
                    var offered = OfferedGenerations(bundleRoot);
                    var versionOffers = GenerationsWithDll(Path.Combine(bundleRoot, "Versions", version), "CadAI.AutoCAD.dll");
                    // Names the aleph-platform#332 shape: this AutoCAD needs RuntimeFolderName (it
                    // is what picked this very Bootstrap), but version "{version}" never shipped
                    // that generation's DLL — a mismatch, not a missing pipe.
                    WriteLine(versionOffers.Count == 0
                        ? $"This AutoCAD needs the {RuntimeFolderName} plugin build, but version \"{version}\" ships none of {(offered.Count == 0 ? "any generation" : string.Join(", ", offered))}; no versioned plugin was loaded."
                        : $"This AutoCAD needs the {RuntimeFolderName} plugin build, but version \"{version}\" only ships {string.Join(", ", versionOffers)}; no versioned plugin was loaded.");
                    return;
                }

                Assembly assembly;
#if NET8_0_OR_GREATER
                // Load via a byte stream, not LoadFromAssemblyPath: the latter memory-maps
                // the file and keeps it locked for the assembly's lifetime even inside a
                // collectible context, so a rebuild while AutoCAD is running would fail with
                // "file in use" regardless of how thoroughly CADAIRELOAD's Unload() collects
                // the previous load. Reading the bytes up front and closing the FileStream
                // immediately releases the file the instant this call returns.
                var loadContext = new PluginLoadContext(versionedDllPath);
                using (var dllStream = File.OpenRead(versionedDllPath))
                {
                    var pdbPath = Path.ChangeExtension(versionedDllPath, ".pdb");
                    if (File.Exists(pdbPath))
                    {
                        using var pdbStream = File.OpenRead(pdbPath);
                        assembly = loadContext.LoadFromStream(dllStream, pdbStream);
                    }
                    else
                    {
                        assembly = loadContext.LoadFromStream(dllStream);
                    }
                }
#else
                // net48 has no AssemblyLoadContext (.NET Framework has only the default load
                // context), so there is no isolated/collectible load and no CADAIRELOAD support
                // here — see Reload(). A plain LoadFrom is enough since nothing ever tries to
                // unload or replace this assembly while AutoCAD is running on this generation.
                assembly = Assembly.LoadFrom(versionedDllPath);
#endif
                var entryType = assembly.GetTypes()
                    .FirstOrDefault(t => !t.IsAbstract && typeof(IPluginEntryPoint).IsAssignableFrom(t));
                if (entryType == null)
                {
                    WriteLine($"\"{versionedDllPath}\" contains no IPluginEntryPoint implementation; no versioned plugin was loaded.");
                    return;
                }

                var plugin = (IPluginEntryPoint)Activator.CreateInstance(entryType)!;
                plugin.Initialize();

#if NET8_0_OR_GREATER
                _loadContext = loadContext;
#endif
                _plugin = plugin;
                _loadedVersion = version;
                WriteLine($"CadAI AutoCAD plugin v{version} loaded from \"{versionedDllPath}\".");
            }
            catch (System.Exception ex)
            {
                // A bad update package or a corrupted bundle must never take AutoCAD's
                // startup (or a CADAIRELOAD) down with it — log and continue without a
                // versioned plugin loaded.
                WriteLine($"Failed to bootstrap the versioned CadAI plugin: {ex.Message}");
            }
        }

#if NET8_0_OR_GREATER
        /// <summary>
        /// Terminates and unloads the current plugin (if any), then forces enough GC
        /// cycles to give the collectible <see cref="PluginLoadContext"/> a chance to
        /// actually release <c>CadAI.AutoCAD.dll</c>'s file handle before the caller loads
        /// a freshly-rebuilt copy from the same path. Returns a <see cref="WeakReference"/>
        /// to the unloaded context so the caller can tell whether it actually went away.
        /// </summary>
        private WeakReference? UnloadCurrentPlugin()
        {
            try
            {
                _plugin?.Terminate();
            }
            catch (System.Exception ex)
            {
                WriteLine($"Warning: the previous plugin threw during Terminate(): {ex.Message}");
            }
            _plugin = null;

            var context = _loadContext;
            _loadContext = null;
            if (context == null) return null;

            var weakContext = new WeakReference(context, trackResurrection: true);
            context.Unload();

            for (var i = 0; i < 10 && weakContext.IsAlive; i++)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }

            return weakContext;
        }
#endif

        private static string ResolveBundleRoot()
        {
            // Bootstrap.dll lives at CadAI.bundle/Bootstrap/{RuntimeFolderName}/ (since the
            // multi-generation bundle layout landed — see installer/autocad-bundle/README.md);
            // current.json and Versions/ are two levels up, at the bundle root. Walking only one
            // level up (the pre-multi-generation layout, CadAI.bundle/Bootstrap/ flat) resolves
            // to Bootstrap/ itself instead of the bundle root, so current.json always reads as
            // missing — confirmed live against a real AutoCAD 2022 NETLOAD before this fix.
            var generationDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
                ?? throw new InvalidOperationException("Could not resolve the Bootstrap assembly's own directory.");
            var bootstrapDir = Path.GetDirectoryName(generationDir)
                ?? throw new InvalidOperationException("Could not resolve the directory above Bootstrap/{generation}/.");
            return Path.GetDirectoryName(bootstrapDir)
                ?? throw new InvalidOperationException("Could not resolve the bundle root above Bootstrap/.");
        }

        private static string? ReadCurrentVersion(string currentJsonPath)
        {
            try
            {
                if (!File.Exists(currentJsonPath)) return null;
                var parsed = JObject.Parse(File.ReadAllText(currentJsonPath));
                var current = parsed["current"]?.Value<string>();
                return string.IsNullOrWhiteSpace(current) ? null : current;
            }
            catch
            {
                // Malformed JSON, unreadable file, etc. — treated the same as "missing".
                return null;
            }
        }

        private static void WriteLine(string message)
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            doc?.Editor.WriteMessage($"\n[cadai] {message}");
        }
    }
}
