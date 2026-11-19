using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Fits a document's current view to its model-space extents through the view API
    /// (<see cref="Editor.GetCurrentView"/>/<see cref="Editor.SetCurrentView"/>) instead of
    /// queuing a "_.ZOOM _E" command string — see autocad-mcp#66. Runs synchronously: the view
    /// has already changed by the time <see cref="ZoomExtents"/> returns. Operates on
    /// <paramref name="doc"/>'s own <see cref="Editor"/>, so it never activates the document —
    /// unlike the command string it replaces (relevant for a background-tab target, see
    /// autocad-mcp#68).
    ///
    /// The WCS-to-eye transform (<see cref="EyeToWorld"/>'s inverse, built from the view's
    /// <c>ViewDirection</c>/<c>ViewTwist</c>/<c>Target</c>) is the standard technique for mapping
    /// database extents into a <see cref="ViewTableRecord"/>'s <c>CenterPoint</c>/<c>Width</c>/
    /// <c>Height</c>, which are defined in the view's own display coordinate system, not WCS
    /// directly — verified against a community-reviewed AutoCAD .NET reference implementation
    /// (Gile Chanteau, https://stackoverflow.com/a/46333315).
    ///
    /// A document whose model space has never been displayed (a tab created by <c>drawing.new</c>
    /// nobody looked at, or a background tab) can report a degenerate current view —
    /// <c>Width</c>/<c>Height</c> of 0, sometimes a zero-length <c>ViewDirection</c>. Feeding that
    /// straight into the aspect math yields NaN/Infinity, and <c>SetCurrentView</c> rejects it with
    /// a raw <c>eInvalidInput</c> that used to escape as an unstructured -32000.
    /// <see cref="RepairDegenerateView"/> seeds such a view before anything reads it;
    /// <see cref="ApplyView"/> turns any rejection AutoCAD still makes into the typed
    /// <see cref="PluginExceptions.ViewFailed"/> error carrying the underlying
    /// <c>ErrorStatus</c> — the same structuring <see cref="ViewCapture"/> applies to a render
    /// failure (autocad-mcp#27).
    ///
    /// <see cref="IsDegenerate"/>, <see cref="SafeAspect"/> and <see cref="FitToAspect"/> take and
    /// return plain doubles so plugin.Tests (no live AutoCAD) can exercise them — the same seam
    /// posture as <see cref="ColorConvert"/>.
    /// </summary>
    public static class ViewFit
    {
        /// <summary>Span (drawing units) a degenerate current view is seeded with before fitting.</summary>
        public const double DefaultViewSpan = 1000.0;

        public static void ZoomExtents(Document doc)
        {
            var db = doc.Database;
            db.UpdateExt(false);

            // AutoCAD leaves Extmin > Extmax when the space has no entities to bound. No-op,
            // not an error — there is nothing to fit to.
            if (db.Extmin.X > db.Extmax.X) return;

            // Non-finite extents (a stray proxy/annotation object at an undefined coordinate)
            // would poison every downstream division the same way a degenerate view does, and
            // AutoCAD would answer with the same opaque eInvalidInput. Say so instead.
            if (!IsFinite(db.Extmin) || !IsFinite(db.Extmax))
            {
                throw PluginExceptions.ViewFailed(
                    "the drawing reports non-finite extents, so there is nothing to fit to — check it with AUDIT in AutoCAD");
            }

            var extents = new Extents3d(db.Extmin, db.Extmax);
            var ed = doc.Editor;
            using var view = ed.GetCurrentView();
            RepairDegenerateView(view);
            extents.TransformBy(EyeToWorld(view).Inverse());

            var width = extents.MaxPoint.X - extents.MinPoint.X;
            var height = extents.MaxPoint.Y - extents.MinPoint.Y;
            var center = new Point2d(
                (extents.MaxPoint.X + extents.MinPoint.X) / 2.0,
                (extents.MaxPoint.Y + extents.MinPoint.Y) / 2.0);

            // Degenerate extents (a single point, or every entity collinear on one axis): give
            // the view a minimum span instead of zooming to zero width or height.
            const double minSpan = 1e-6;
            if (width < minSpan) width = minSpan;
            if (height < minSpan) height = minSpan;

            // Keep the view's existing aspect ratio: grow whichever dimension the raw extents
            // would otherwise clip, rather than stretching the drawing.
            (width, height) = FitToAspect(width, height, view.Width, view.Height);

            view.Width = width;
            view.Height = height;
            view.CenterPoint = center;
            ApplyView(ed, view);
        }

        /// <summary>True when all three coordinates are finite (not NaN/Infinity).</summary>
        public static bool IsFinite(Point3d p) =>
            !double.IsNaN(p.X) && !double.IsInfinity(p.X) &&
            !double.IsNaN(p.Y) && !double.IsInfinity(p.Y) &&
            !double.IsNaN(p.Z) && !double.IsInfinity(p.Z);

        private static bool IsUsable(double value) =>
            !double.IsNaN(value) && !double.IsInfinity(value) && value > 0.0;

        /// <summary>
        /// Pure: true when a current view's <c>Width</c>/<c>Height</c> pair can't serve as an
        /// aspect basis — the degenerate case a never-displayed model-space tab reports.
        /// </summary>
        public static bool IsDegenerate(double width, double height) => !IsUsable(width) || !IsUsable(height);

        /// <summary>
        /// Pure: a finite, positive aspect ratio to fit against, falling back to square (1.0) when
        /// the current view is degenerate. Never returns NaN/Infinity/0/negative.
        /// </summary>
        public static double SafeAspect(double width, double height) =>
            IsDegenerate(width, height) ? 1.0 : width / height;

        /// <summary>
        /// Pure: the smallest box with the view's aspect ratio that contains boxWidth x boxHeight,
        /// growing whichever dimension the raw box would otherwise clip. Box dimensions must
        /// already be positive (callers clamp their own degenerate extents); the aspect goes
        /// through <see cref="SafeAspect"/> so a degenerate current view can never poison it.
        /// </summary>
        public static (double Width, double Height) FitToAspect(
            double boxWidth, double boxHeight, double viewWidth, double viewHeight)
        {
            var aspect = SafeAspect(viewWidth, viewHeight);
            return boxWidth / boxHeight > aspect
                ? (boxWidth, boxWidth / aspect)
                : (boxHeight * aspect, boxHeight);
        }

        /// <summary>
        /// Seeds a degenerate current view (never-displayed tab) with a usable plan orientation and
        /// span before anything reads its dimensions or transforms geometry through it.
        /// </summary>
        internal static void RepairDegenerateView(ViewTableRecord view)
        {
            if (view.ViewDirection.Length < 1e-9) view.ViewDirection = Vector3d.ZAxis;
            if (IsDegenerate(view.Width, view.Height))
            {
                view.Width = DefaultViewSpan;
                view.Height = DefaultViewSpan;
            }
        }

        /// <summary>
        /// Writes the view and refreshes the screen, mapping AutoCAD's own rejection (a raw
        /// <see cref="Autodesk.AutoCAD.Runtime.Exception"/>, e.g. <c>eInvalidInput</c>) to the
        /// typed <see cref="PluginExceptions.ViewFailed"/> instead of letting it escape as an
        /// unstructured -32000.
        /// </summary>
        internal static void ApplyView(Editor ed, ViewTableRecord view)
        {
            try
            {
                ed.SetCurrentView(view);
                ed.UpdateScreen();
            }
            catch (System.Exception ex)
            {
                throw PluginExceptions.ViewFailed(
                    ex is Autodesk.AutoCAD.Runtime.Exception acadEx
                        ? $"{ex.Message} (ErrorStatus: {acadEx.ErrorStatus})"
                        : ex.Message);
            }
        }

        /// <summary>Eye (view display) coordinate system to WCS, for the given view's orientation. Shared with <see cref="LiveView"/> (autocad-mcp#67).</summary>
        internal static Matrix3d EyeToWorld(ViewTableRecord view) =>
            Matrix3d.Rotation(-view.ViewTwist, view.ViewDirection, view.Target) *
            Matrix3d.Displacement(view.Target - Point3d.Origin) *
            Matrix3d.PlaneToWorld(view.ViewDirection);
    }
}
