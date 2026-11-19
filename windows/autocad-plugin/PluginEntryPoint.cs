using System.Diagnostics;
using Autodesk.AutoCAD.ApplicationServices;
using CadAI.AutoCAD.Bootstrap;

namespace CadAI.AutoCAD
{
    /// <summary>
    /// The versioned plugin's side of the Bootstrap/versioned split: loaded
    /// reflectively by <c>CadAI.AutoCAD.Bootstrap.BootstrapExtensionApplication</c>
    /// once per AutoCAD process, never registered with AutoCAD directly (this
    /// assembly carries no <c>[assembly: ExtensionApplication]</c>). Owns the
    /// pipe server and the main-thread dispatcher for its lifetime. See
    /// ../README.md, "Bootstrap vs versioned plugin".
    /// </summary>
    public sealed class PluginEntryPoint : IPluginEntryPoint
    {
        private PipeServer? _pipeServer;

        public void Initialize()
        {
#if !NET8_0_OR_GREATER
            // Must run before anything touches StreamJsonRpc's formatter types (PipeServer ->
            // JsonMessageFormatter's static ctor) — see AssemblyRedirectHelper's doc comment.
            AssemblyRedirectHelper.Install();
#endif
            MainThreadDispatcher.Initialize();

            // Per-process, not configurable: bridge enumerates running
            // acad.exe/acadcore.exe processes and dials each instance's pipe by
            // its own PID, so there is nothing to coordinate via an env var
            // (contrast the old single fixed AUTOCAD_MCP_PIPE_NAME).
            var pipeName = $"cadai-autocad-{Process.GetCurrentProcess().Id}";

            _pipeServer = new PipeServer(pipeName);
            _pipeServer.Start();

            WriteLine($"CadAI AutoCAD plugin v{PluginState.PluginVersion} listening on pipe \"{pipeName}\".");
        }

        public void Terminate()
        {
            _pipeServer?.Dispose();
            MainThreadDispatcher.Shutdown();
        }

        public string DescribeStatus() =>
            $"CadAI AutoCAD plugin v{PluginState.PluginVersion} ({PluginState.RuntimeGeneration}), uptime {PluginState.Uptime.Elapsed:hh\\:mm\\:ss}.";

        public string DescribeEdits() =>
            Edits.EditStore.Instance.DescribeSessions();
        private static void WriteLine(string message)
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            doc?.Editor.WriteMessage($"\n[cadai] {message}");
        }
    }
}
