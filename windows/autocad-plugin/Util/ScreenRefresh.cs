using Autodesk.AutoCAD.ApplicationServices;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Repaints the viewport after a committed database mutation. Outside a running command
    /// (i.e. every mutation made from application/command context by this plugin, not typed by
    /// the user), AutoCAD does not always regen the viewport on its own, so new or changed
    /// geometry can go unseen until the next unrelated repaint (mouse move, pan, focus change).
    /// See autocad-mcp#66. Never call this from a read-only handler — there is nothing to flush.
    /// </summary>
    internal static class ScreenRefresh
    {
        /// <summary>
        /// Never throws: the mutation this repaints has already committed by the time this runs, so
        /// a repaint failure (e.g. a transient AutoCAD graphics-system error) must not surface as
        /// "the call failed" — that would misreport an already-successful mutation as failed/rolled
        /// back to the caller, risking a retry that duplicates the entities just created. Swallowed
        /// failures are traced, not silently dropped.
        /// </summary>
        public static void AfterCommit(Document doc)
        {
            try
            {
                doc.TransactionManager.EnableGraphicsFlush(true);
                doc.TransactionManager.QueueForGraphicsFlush();
                doc.TransactionManager.FlushGraphics();
                doc.Editor.UpdateScreen();
                doc.Editor.UpdateTiledViewportsFromDatabase();
            }
            catch (System.Exception ex)
            {
                System.Diagnostics.Trace.TraceWarning(
                    $"ScreenRefresh.AfterCommit: repaint failed after a successful mutation, ignoring: {ex.Message}");
            }
        }
    }
}
