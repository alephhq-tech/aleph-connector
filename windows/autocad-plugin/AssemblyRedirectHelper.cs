#if !NET8_0_OR_GREATER
using System;
using System.IO;
using System.Reflection;

namespace CadAI.AutoCAD
{
    /// <summary>
    /// Works around a classic .NET Framework 4.8 "LoadFrom" limitation: a plugin loaded via
    /// <see cref="Assembly.LoadFrom(string)"/> (see Bootstrap/BootstrapExtensionApplication.cs's
    /// net48 branch) gets no binding-redirect support from its own config — only the host
    /// process's own config (<c>acad.exe.config</c>, which this plugin cannot ship or safely
    /// edit) is consulted. NuGet's net472 reference assemblies for StreamJsonRpc's dependency
    /// chain (MessagePack -> System.Buffers/System.Memory/System.Numerics.Vectors/etc.) are
    /// typically compiled against an old facade version (e.g. System.Buffers 4.0.2.0) while the
    /// package actually ships a newer one (e.g. 4.0.4.0) next to this assembly — so the CLR's
    /// default resolution fails with <see cref="FileNotFoundException"/> even though the DLL is
    /// sitting right there, just under a different version identity.
    ///
    /// On net8.0-windows/net10.0-windows this is a non-issue: PluginLoadContext (an
    /// AssemblyDependencyResolver) always resolves to whatever's physically shipped — see its own
    /// doc comment. This file is net48-only for that reason.
    /// </summary>
    internal static class AssemblyRedirectHelper
    {
        private static bool _installed;

        /// <summary>
        /// Registers an <see cref="AppDomain.AssemblyResolve"/> handler that loads any assembly
        /// by its simple name from this plugin's own directory, ignoring the requested version —
        /// idempotent, and a no-op past the first call (net48 has no CADAIRELOAD, so
        /// <see cref="PluginEntryPoint.Initialize"/> only ever runs once per process anyway, but
        /// this stays safe if that assumption ever changes).
        /// </summary>
        public static void Install()
        {
            if (_installed) return;
            _installed = true;

            var pluginDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (pluginDirectory == null) return;

            AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
            {
                var simpleName = new AssemblyName(args.Name).Name;
                var candidate = Path.Combine(pluginDirectory, simpleName + ".dll");
                return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
            };
        }
    }
}
#endif
