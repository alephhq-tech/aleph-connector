#if NET8_0_OR_GREATER
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
namespace CadAI.AutoCAD.Bootstrap
{
    /// <summary>
    /// Collectible <see cref="AssemblyLoadContext"/> the versioned plugin DLL is loaded
    /// into, so <see cref="BootstrapExtensionApplication"/> can <see cref="Unload"/> it and
    /// load a fresh copy from disk (the <c>CADAIRELOAD</c> command) without restarting
    /// AutoCAD. See README, "Hot reload".
    ///
    /// Only the versioned plugin's own assembly and private dependencies that AutoCAD's
    /// process has not already loaded (StreamJsonRpc, MessagePack, Nerdbank.Streams — pulled
    /// in transitively and copied next to the plugin by <c>CopyLocalLockFileAssemblies</c>)
    /// load into this context. Anything already present in the default context — most
    /// importantly Autodesk's own AutoCAD API assemblies (AcMgd/AcDbMgd/AcCoreMgd, also
    /// copied next to the plugin by the AutoCAD.NET NuGet packages, so the dependency
    /// resolver below would otherwise happily load a second copy of them) and
    /// <c>CadAI.AutoCAD.Bootstrap</c> itself — always resolves to that single already-loaded
    /// instance instead. This is not just a memory optimization: a second copy of an
    /// Autodesk assembly is a distinct type identity whose static state (most importantly
    /// <c>Application.Idle</c>) is never touched by the real AutoCAD the process is actually
    /// running, so <see cref="MainThreadDispatcher"/>-style "subscribe to Application.Idle"
    /// code would silently never fire if it bound to the wrong copy.
    /// </summary>
    internal sealed class PluginLoadContext : AssemblyLoadContext
    {
        private readonly AssemblyDependencyResolver _resolver;
        private readonly string _pluginDirectory;

        public PluginLoadContext(string pluginPath) : base(isCollectible: true)
        {
            _resolver = new AssemblyDependencyResolver(pluginPath);
            _pluginDirectory = Path.GetDirectoryName(pluginPath)
                ?? throw new ArgumentException($"\"{pluginPath}\" has no parent directory.", nameof(pluginPath));
        }

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            if (IsAlreadyLoadedInDefaultContext(assemblyName.Name)) return null;

            var resolved = _resolver.ResolveAssemblyToPath(assemblyName);
            if (resolved != null) return LoadFromAssemblyPath(resolved);

            // Fallback for a plain `dotnet build` output that lacks a `.deps.json` (the
            // resolver above needs one): probe the plugin's own directory directly. Every
            // private dependency physically ships next to the plugin DLL either way
            // (CopyLocalLockFileAssemblies=true in CadAI.AutoCAD.csproj).
            var candidate = Path.Combine(_pluginDirectory, assemblyName.Name + ".dll");
            return File.Exists(candidate) ? LoadFromAssemblyPath(candidate) : null;
        }

        private static bool IsAlreadyLoadedInDefaultContext(string? name) =>
            name != null && Default.Assemblies.Any(a => a.GetName().Name == name);
    }
}
#endif
