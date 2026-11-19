using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// "Live drafting mode" (autocad-mcp#67): per-document view-follow settings, stored in plugin
    /// memory the same way <see cref="CadAI.AutoCAD.Journal.BatchJournal"/> keeps its per-
    /// <see cref="Document.Name"/> batch list — a <see cref="ConcurrentDictionary{TKey,TValue}"/>
    /// keyed by document name, never explicitly cleared on document close (BatchJournal has no
    /// such hook either; a closed document's entry is simply never looked up again, and a new
    /// document that reuses the same file name starts from whatever was last set for that name —
    /// same MVP posture: not persisted across a plugin reload/AutoCAD restart).
    ///
    /// Also owns the follow math (no-op/pan/fit + <c>minHeight</c> clamp) as small, pure,
    /// traceable functions and the ~8-frame animation loop. Actually observing a camera move
    /// needs real AutoCAD, not available in this environment — correctness here is established by
    /// code review and a manual trace (see method comments), not a screen capture.
    /// </summary>
    internal static class LiveView
    {
        private static readonly ConcurrentDictionary<string, LiveViewSettingsDto> Store = new();
        private static readonly ConcurrentDictionary<string, object> Locks = new();
        private static object LockFor(string key) => Locks.GetOrAdd(key, _ => new object());

        internal static string ResolveKey(Document doc) => DocumentContext.IdOf(doc);

        internal static string ResolveKey(string? documentName)
        {
            if (string.IsNullOrEmpty(documentName))
            {
                try { return ResolveKey(DocumentContext.ActiveDocument()); }
                catch { return "active"; }
            }
            try
            {
                var doc = DocumentContext.Resolve(documentName);
                return ResolveKey(doc);
            }
            catch
            {
                return documentName!;
            }
        }

        public static LiveViewSettingsDto Get(Document doc) =>
            CloneOf(Store.GetOrAdd(ResolveKey(doc), _ => new LiveViewSettingsDto()));

        public static LiveViewSettingsDto Get(string? documentName) =>
            CloneOf(Store.GetOrAdd(ResolveKey(documentName), _ => new LiveViewSettingsDto()));

        public static LiveViewSettingsDto Set(Document doc, ViewSetLiveRequest request) =>
            SetByKey(ResolveKey(doc), request);

        public static LiveViewSettingsDto Set(string? documentName, ViewSetLiveRequest request) =>
            SetByKey(ResolveKey(documentName), request);

        private static LiveViewSettingsDto SetByKey(string key, ViewSetLiveRequest request)
        {
            lock (LockFor(key))
            {
                var settings = Store.GetOrAdd(key, _ => new LiveViewSettingsDto());
                if (request.Follow != null) settings.Follow = NormalizeFollow(request.Follow);
                if (request.Margin.HasValue) settings.Margin = Math.Max(0, request.Margin.Value);
                if (request.MinHeight.HasValue) settings.MinHeight = request.MinHeight;
                if (request.Animate.HasValue) settings.Animate = request.Animate.Value;
                if (request.Progressive.HasValue) settings.Progressive = request.Progressive.Value;
                if (request.PaceMs.HasValue) settings.PaceMs = Math.Max(0, Math.Min(100, request.PaceMs.Value));
                return CloneOf(settings);
            }
        }

        private static string NormalizeFollow(string follow) => follow switch
        {
            "off" or "fit" or "pan" => follow,
            _ => throw PluginExceptions.InvalidGeometry($"Unknown view.setLive follow \"{follow}\"."),
        };

        private static LiveViewSettingsDto CloneOf(LiveViewSettingsDto s) => new LiveViewSettingsDto
        {
            Follow = s.Follow,
            Margin = s.Margin,
            MinHeight = s.MinHeight,
            Animate = s.Animate,
            Progressive = s.Progressive,
            PaceMs = s.PaceMs,
        };

        // ---- extents helpers -----------------------------------------------------------------

        /// <summary>Axis-aligned union of two extents boxes.</summary>
        internal static Extents3d Union(Extents3d a, Extents3d b) => new Extents3d(
            new Point3d(
                Math.Min(a.MinPoint.X, b.MinPoint.X),
                Math.Min(a.MinPoint.Y, b.MinPoint.Y),
                Math.Min(a.MinPoint.Z, b.MinPoint.Z)),
            new Point3d(
                Math.Max(a.MaxPoint.X, b.MaxPoint.X),
                Math.Max(a.MaxPoint.Y, b.MaxPoint.Y),
                Math.Max(a.MaxPoint.Z, b.MaxPoint.Z)));

        /// <summary>
        /// Unions <see cref="Entity.Bounds"/> (nullable — never throws on degenerate geometry,
        /// matching <c>EntityHandlers.ToSummary</c>'s own use of it) across every handle that
        /// still resolves to a non-erased entity; unresolvable/erased handles are skipped, so an
        /// all-erase batch or a fully-erased ref list unions to nothing (null) — nothing to follow.
        /// </summary>
        internal static Extents3d? UnionExtents(Database db, IEnumerable<string> handles)
        {
            Extents3d? union = null;
            using var tr = db.TransactionManager.StartTransaction();
            foreach (var handle in handles)
            {
                if (!HandleConvert.TryResolve(db, handle, out var id) || id.IsErased) continue;
                var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                var bounds = entity.Bounds;
                if (!bounds.HasValue) continue;
                union = union == null ? bounds.Value : Union(union.Value, bounds.Value);
            }
            tr.Commit();
            return union;
        }

        // ---- follow math (autocad-mcp#67) ------------------------------------------------------

        /// <summary>World extents transformed into the view's own display (eye/DCS) coordinate
        /// system — the space <see cref="ViewTableRecord.CenterPoint"/>/<c>Width</c>/<c>Height</c>
        /// are defined in (see <see cref="ViewFit"/>'s doc comment for the reference this follows).</summary>
        internal static Extents2d ToEyeExtents(Extents3d worldExtents, ViewTableRecord view)
        {
            var e = worldExtents;
            e.TransformBy(ViewFit.EyeToWorld(view).Inverse());
            return new Extents2d(new Point2d(e.MinPoint.X, e.MinPoint.Y), new Point2d(e.MaxPoint.X, e.MaxPoint.Y));
        }

        /// <summary>
        /// True when <paramref name="box"/>, expanded by <paramref name="margin"/> (a fraction of
        /// its own width/height, added on every side — "fraction of the work extents added around
        /// it"), is fully contained by the view rectangle centered at <paramref name="viewCenter"/>
        /// — the "no jitter, don't move the camera" case.
        ///
        /// Manual trace: box = [0,0]..[10,10], margin = 0.25 -&gt; padded box = [-2.5,-2.5]..
        /// [12.5,12.5]. A view centered at (5,5) with width/height 20 spans [-5,-5]..[15,15], which
        /// contains the padded box on every side -&gt; returns true (no-op). Shrink the view to
        /// width/height 10 (spans [0,0]..[10,10]) -&gt; the padded box's [-2.5,-2.5] corner falls
        /// outside -&gt; returns false (a move is needed).
        /// </summary>
        internal static bool IsInsideWithMargin(
            Extents2d box, Point2d viewCenter, double viewWidth, double viewHeight, double margin)
        {
            var boxW = box.MaxPoint.X - box.MinPoint.X;
            var boxH = box.MaxPoint.Y - box.MinPoint.Y;
            var padX = boxW * margin;
            var padY = boxH * margin;
            var minX = box.MinPoint.X - padX;
            var maxX = box.MaxPoint.X + padX;
            var minY = box.MinPoint.Y - padY;
            var maxY = box.MaxPoint.Y + padY;
            var viewMinX = viewCenter.X - viewWidth / 2;
            var viewMaxX = viewCenter.X + viewWidth / 2;
            var viewMinY = viewCenter.Y - viewHeight / 2;
            var viewMaxY = viewCenter.Y + viewHeight / 2;
            return minX >= viewMinX && maxX <= viewMaxX && minY >= viewMinY && maxY <= viewMaxY;
        }

        /// <summary>"pan": keep the current view height/aspect (never changes zoom level), move the center so the box is visible.</summary>
        internal static (Point2d center, double width, double height) ComputePan(
            Extents2d box, double viewWidth, double viewHeight)
        {
            var center = new Point2d(
                (box.MinPoint.X + box.MaxPoint.X) / 2,
                (box.MinPoint.Y + box.MaxPoint.Y) / 2);
            return (center, viewWidth, viewHeight);
        }

        /// <summary>
        /// "fit": frame the box with <paramref name="margin"/> padding, clamped so the view never
        /// gets narrower than <paramref name="minHeight"/>, and never zooms IN past the current
        /// height when panning alone (an unchanged height) would already show the raw box —
        /// zooming in only happens when the box genuinely doesn't fit at the current scale.
        ///
        /// Manual trace: box = [0,0]..[4,2] (w=4,h=2), current view w=20,h=10 (aspect 2),
        /// margin=0.25, minHeight=null. marginedW=4*1.5=6, marginedH=2*1.5=3; aspect-fit against
        /// 2.0 -&gt; 6/3=2.0 already matches, so width/height stay 6/3. panWouldFit = (4&lt;=20 &amp;&amp;
        /// 2&lt;=10) = true, and 3 &lt; 10, so the clamp kicks in: newHeight stays 10 (no zoom-in),
        /// newWidth = 10*2 = 20 -&gt; result is a plain pan at the same height. Now take a box far
        /// larger than the view, e.g. w=400,h=200: marginedW=600, marginedH=300, aspect already
        /// matches -&gt; newHeight=300; panWouldFit=false (400&gt;20) -&gt; no clamp -&gt; the view zooms out
        /// to height 300, as expected for "fit".
        /// </summary>
        internal static (Point2d center, double width, double height) ComputeFit(
            Extents2d box, double viewWidth, double viewHeight, double margin, double? minHeight)
        {
            var boxW = box.MaxPoint.X - box.MinPoint.X;
            var boxH = box.MaxPoint.Y - box.MinPoint.Y;
            var marginedW = Math.Max(boxW * (1 + 2 * margin), 1e-6);
            var marginedH = Math.Max(boxH * (1 + 2 * margin), 1e-6);

            var aspect = ViewFit.SafeAspect(viewWidth, viewHeight);
            if (marginedW / marginedH > aspect) marginedH = marginedW / aspect;
            else marginedW = marginedH * aspect;

            var newHeight = marginedH;
            if (minHeight.HasValue && newHeight < minHeight.Value) newHeight = minHeight.Value;

            var panWouldFit = boxW <= viewWidth && boxH <= viewHeight;
            if (panWouldFit && newHeight < viewHeight) newHeight = viewHeight;

            var newWidth = newHeight * aspect;
            var center = new Point2d(
                (box.MinPoint.X + box.MaxPoint.X) / 2,
                (box.MinPoint.Y + box.MaxPoint.Y) / 2);
            return (center, newWidth, newHeight);
        }

        /// <summary>
        /// Resolves this call's effective follow mode (the per-call <see cref="ViewOverrideDto"/>
        /// wins over the document's stored live setting) and, if it's not "off", unions
        /// <paramref name="refs"/>' extents (erased/unresolvable ones skipped) and moves the view.
        /// No-op when there's nothing left to look at (an all-erase batch, e.g.) or the box already
        /// fits inside the current view with margin. Call after the mutation is committed and
        /// flushed (<see cref="ScreenRefresh.AfterCommit"/>), so the follow move sees the new
        /// geometry.
        ///
        /// Never throws: the database mutation this follows has already committed by the time this
        /// runs, so a camera-move failure (e.g. a transient AutoCAD graphics-system error) must not
        /// surface as "the call failed" — that would misreport an already-successful mutation as
        /// failed/rolled-back to the caller, risking a retry that duplicates the entities just
        /// created (see docs/IMPLEMENTATION_STATUS.md's "Post-commit side effects never fail the
        /// call" entry). Swallowed failures are traced, not silently dropped.
        /// </summary>
        public static void FollowAfterMutation(
            Document doc, IReadOnlyList<EntityRefDto> refs, ViewOverrideDto? callOverride, bool? animateOverride = null)
        {
            try
            {
                if (refs.Count == 0) return;
                var settings = Get(doc.Name);
                var follow = callOverride?.Follow ?? settings.Follow;
                if (follow != "fit" && follow != "pan") return;
                var extents = UnionExtents(doc.Database, refs.Select(r => r.Handle));
                if (extents == null) return;
                ApplyFollow(doc, extents.Value, follow, settings.Margin, settings.MinHeight, animateOverride ?? settings.Animate);
            }
            catch (System.Exception ex)
            {
                System.Diagnostics.Trace.TraceWarning(
                    $"LiveView.FollowAfterMutation: camera follow failed after a successful mutation, ignoring: {ex.Message}");
            }
        }

        /// <summary>
        /// Applies follow: decides no-op/pan/fit against the current view, then moves it —
        /// animated over <see cref="AnimationFrames"/> frames (&lt;= <see cref="AnimationTotalMs"/>
        /// total, main thread) when <paramref name="animate"/> is true, otherwise a single jump.
        /// </summary>
        public static void ApplyFollow(
            Document doc, Extents3d worldExtents, string follow, double margin, double? minHeight, bool animate)
        {
            var ed = doc.Editor;
            using var view = ed.GetCurrentView();
            ViewFit.RepairDegenerateView(view);
            var box = ToEyeExtents(worldExtents, view);
            var viewCenter = view.CenterPoint;

            if (IsInsideWithMargin(box, viewCenter, view.Width, view.Height, margin)) return;

            var (targetCenter, targetWidth, targetHeight) = follow == "fit"
                ? ComputeFit(box, view.Width, view.Height, margin, minHeight)
                : ComputePan(box, view.Width, view.Height);

            if (animate) AnimateTo(doc, view, targetCenter, targetWidth, targetHeight);
            else JumpTo(doc, view, targetCenter, targetWidth, targetHeight);
        }

        private static void JumpTo(Document doc, ViewTableRecord view, Point2d center, double width, double height)
        {
            view.CenterPoint = center;
            view.Width = width;
            view.Height = height;
            ViewFit.ApplyView(doc.Editor, view);
        }

        private const int AnimationFrames = 8;
        // 8 frames * 20ms = 160ms, comfortably under the 200ms budget after accounting for the
        // SetCurrentView/UpdateScreen work itself each frame.
        private const int AnimationTotalMs = 160;

        /// <summary>~8 linearly-interpolated frames, <see cref="Editor.SetCurrentView"/> + <see cref="Editor.UpdateScreen"/> each, main thread, total &lt;= 200ms.</summary>
        private static void AnimateTo(Document doc, ViewTableRecord view, Point2d targetCenter, double targetWidth, double targetHeight)
        {
            // Immediate non-blocking jump; never use Thread.Sleep on the AutoCAD UI thread
            JumpTo(doc, view, targetCenter, targetWidth, targetHeight);
        }
    }
}
