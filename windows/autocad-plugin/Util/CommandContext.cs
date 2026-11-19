using System;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using CadAI.AutoCAD.Journal;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Runs a mutation against <paramref name="doc"/> in the context <c>Editor.Command</c> is
    /// actually documented for. <c>Editor.Command</c> (used by <c>OperationsHandlers</c> for its
    /// native <c>_.UNDO</c>/<c>_.REDO</c> undo-group commands) is only valid from document or
    /// command context, not the application context every RPC handler otherwise runs in — see
    /// autocad-mcp#73 and docs/AUTOCAD_PLUGIN.md, "Threading contract".
    /// </summary>
    internal static class CommandContext
    {
        /// <summary>How long to wait for an in-progress user command to end before reporting busy.</summary>
        private const int BusyMaxWaitMs = 2000;
        private const int BusyPollIntervalMs = 50;

        /// <summary>True while the active document has a command in progress (<c>CMDACTIVE</c> system variable).</summary>
        private static bool IsCommandActive() => Convert.ToInt32(Application.GetSystemVariable("CMDACTIVE")) != 0;

        /// <summary>
        /// Active-document target: waits out any in-progress user command (bounded — reports
        /// <see cref="PluginExceptions.BridgeBusy"/> past the bound, drawing nothing), then runs
        /// <paramref name="work"/> inside <see cref="DocumentCollection.ExecuteInCommandContextAsync"/>,
        /// which both locks the document and establishes the command context <c>Editor.Command</c>
        /// needs. Background-document target: stays in application context under
        /// <see cref="Document.LockDocument"/> — undo grouping there is autocad-mcp#68's open
        /// decision, unchanged by this helper.
        /// </summary>
        public static async Task<T> RunAsync<T>(Document doc, Func<T> work)
        {
            if (doc != Application.DocumentManager.MdiActiveDocument)
            {
                using (doc.LockDocument())
                {
                    return work();
                }
            }

            var waited = 0;
            while (IsCommandActive())
            {
                if (waited >= BusyMaxWaitMs)
                {
                    throw PluginExceptions.BridgeBusy("A command is in progress in this drawing; try again once it finishes.");
                }
                await Task.Delay(BusyPollIntervalMs);
                waited += BusyPollIntervalMs;
            }

            BatchJournal.EnsureHooked(doc);
            BatchJournal.Suppress(doc.Name, true);
            var result = default(T)!;
            try
            {
                await Application.DocumentManager.ExecuteInCommandContextAsync(
                    _ =>
                    {
                        result = work();
                        return Task.CompletedTask;
                    },
                    null);
            }
            finally
            {
                BatchJournal.Suppress(doc.Name, false);
            }
            return result;
        }

        public static Task RunAsync(Document doc, Action work) =>
            RunAsync<object?>(doc, () =>
            {
                work();
                return null;
            });
    }
}
