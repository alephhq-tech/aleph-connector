using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    public sealed class ViewHandlers
    {
        [JsonRpcMethod("view.zoomExtents", UseSingleObjectParameterDeserialization = true)]
        public Task<object> ZoomExtents(ViewZoomExtentsRequest? request = null) =>
            MainThreadDispatcher.RunAsync(async () =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                // Command context, not just a document lock (autocad-mcp#73's lesson, applied to
                // the camera): Editor.SetCurrentView is an editor operation, and running it from
                // the dispatcher's plain application context is what AutoCAD answers with a raw
                // eInvalidInput. CommandContext also waits out an in-progress user command
                // instead of racing it.
                await CommandContext.RunAsync(doc, () => ViewFit.ZoomExtents(doc));
                return (object)new { };
            });

        /// <summary>
        /// Renders the target document to a PNG off-screen (<see cref="ViewCapture"/>). Read-only:
        /// the on-screen view is untouched and a background document is never activated. Pending
        /// writes are flushed first so the picture shows what the last batch committed.
        /// </summary>
        [JsonRpcMethod("view.capture", UseSingleObjectParameterDeserialization = true)]
        public Task<ViewCaptureResult> Capture(ViewCaptureRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                request ??= new ViewCaptureRequest();
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    return ViewCapture.Render(doc, request);
                }
            });

        /// <summary>Live drafting mode (autocad-mcp#67): merges the given fields over this document's current settings and returns the effective result.</summary>
        [JsonRpcMethod("view.setLive", UseSingleObjectParameterDeserialization = true)]
        public Task<LiveViewSettingsDto> SetLive(ViewSetLiveRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                return LiveView.Set(doc, request);
            });

        [JsonRpcMethod("view.getLive", UseSingleObjectParameterDeserialization = true)]
        public Task<LiveViewSettingsDto> GetLive(ViewGetLiveRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                return LiveView.Get(doc);
            });

        /// <summary>
        /// Explicit "look here" (autocad-mcp#67/#27/#63): first match wins, window, then the union
        /// of handles' extents, then center+viewHeight. Always moves the view through the same
        /// eye/DCS-space math <see cref="LiveView"/> uses for follow, but without follow's
        /// inside-with-margin no-op check or its "already fits, keep the current height" clamp —
        /// an explicit zoom frames exactly what was asked.
        /// </summary>
        [JsonRpcMethod("view.zoom", UseSingleObjectParameterDeserialization = true)]
        public Task<ViewZoomResult> Zoom(ViewZoomRequest request) =>
            MainThreadDispatcher.RunAsync(async () =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                return await CommandContext.RunAsync(doc, () =>
                {
                    Point3d? explicitCenter = null;
                    Extents3d extents;
                    if (request.Window != null)
                    {
                        extents = new Extents3d(request.Window.Min.ToPoint3d(), request.Window.Max.ToPoint3d());
                    }
                    else if (request.Handles is { Count: > 0 })
                    {
                        extents = LiveView.UnionExtents(doc.Database, request.Handles)
                            ?? throw PluginExceptions.InvalidGeometry("None of the given handles resolved to a visible entity.");
                    }
                    else if (request.Center != null && request.ViewHeight.HasValue)
                    {
                        explicitCenter = request.Center.ToPoint3d();
                        var half = request.ViewHeight.Value / 2;
                        var c = explicitCenter.Value;
                        extents = new Extents3d(new Point3d(c.X - half, c.Y - half, 0), new Point3d(c.X + half, c.Y + half, 0));
                    }
                    else
                    {
                        throw PluginExceptions.InvalidGeometry("view.zoom requires \"window\", \"handles\", or \"center\" + \"viewHeight\".");
                    }

                    if (!ViewFit.IsFinite(extents.MinPoint) || !ViewFit.IsFinite(extents.MaxPoint))
                    {
                        throw PluginExceptions.InvalidGeometry(
                            "the requested zoom window has non-finite coordinates; pass finite numbers.");
                    }

                    var ed = doc.Editor;
                    using var view = ed.GetCurrentView();
                    ViewFit.RepairDegenerateView(view);
                    var box = LiveView.ToEyeExtents(extents, view);

                    // margin 0: an explicit zoom frames exactly what was asked, no live-follow padding.
                    var center = new Point2d(
                        (box.MinPoint.X + box.MaxPoint.X) / 2.0,
                        (box.MinPoint.Y + box.MaxPoint.Y) / 2.0);
                    double width, height;
                    if (explicitCenter != null && request.ViewHeight.HasValue)
                    {
                        // center+viewHeight states the zoom level outright — honor it instead of
                        // letting a fit clamp quietly keep the old height (which made the call
                        // report success while the camera never changed its zoom).
                        height = request.ViewHeight.Value;
                        width = height * ViewFit.SafeAspect(view.Width, view.Height);
                    }
                    else
                    {
                        (width, height) = ViewFit.FitToAspect(
                            Math.Max(box.MaxPoint.X - box.MinPoint.X, 1e-6),
                            Math.Max(box.MaxPoint.Y - box.MinPoint.Y, 1e-6),
                            view.Width, view.Height);
                    }

                    view.CenterPoint = center;
                    view.Width = width;
                    view.Height = height;
                    ViewFit.ApplyView(ed, view);

                    // Reported back in world space: the box's own center (or the caller's explicit
                    // center) and the resulting view height. Exact for the common unrotated/plan-view
                    // case (view twist 0, direction +Z); a twisted/3D view is still framed correctly
                    // on screen (the ViewTableRecord write above is twist-correct via
                    // ToEyeExtents/EyeToWorld) but this echo is only exact when untwisted.
                    var worldCenter = explicitCenter ?? new Point3d(
                        (extents.MinPoint.X + extents.MaxPoint.X) / 2,
                        (extents.MinPoint.Y + extents.MaxPoint.Y) / 2,
                        0);
                    return new ViewZoomResult { Center = Point3dDto.From(worldCenter), Height = height };
                });
            });
    }
}
