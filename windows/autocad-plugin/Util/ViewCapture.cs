using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.GraphicsSystem;
using CadAI.AutoCAD.Dto;

// The plugin only ever runs inside AutoCAD, i.e. on Windows; the analyzer can't see that from the
// TFM alone when the project is built on another OS (EnableWindowsTargeting).
#pragma warning disable CA1416
namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Renders a document's model space to a PNG through an off-screen graphics-system device
    /// (<see cref="Manager.CreateAutoCADOffScreenDevice"/>) so an AI caller can look at what it
    /// drew. Never touches the on-screen viewport: the current view is not changed, and a
    /// background document is rendered from its <see cref="Database"/> without being activated
    /// (see autocad-mcp#68) — the reason this does not use the screen-capture route.
    /// </summary>
    internal static class ViewCapture
    {
        public const int DefaultWidth = 1024;
        public const int DefaultHeight = 768;
        public const int MaxDimension = 2048;
        private const int MinDimension = 64;

        /// <summary>Base64-encoded PNG cap for one capture (autocad-mcp#27) — keeps a single result well under WSS/gateway frame limits instead of letting an oversized payload drop the socket.</summary>
        private const int MaxEncodedBytes = 2 * 1024 * 1024;

        /// <summary>Fraction of the fitted window added on each side, so edge geometry isn't flush with the frame.</summary>
        private const double MarginFraction = 0.05;

        public static ViewCaptureResult Render(Document doc, ViewCaptureRequest request, System.Threading.CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested();
            var width = Clamp(request.Width ?? DefaultWidth);
            var height = Clamp(request.Height ?? DefaultHeight);
            var db = doc.Database;

            using var tr = db.TransactionManager.StartTransaction();
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);

            if (IsEmpty(ms))
            {
                throw PluginExceptions.CaptureFailed("The drawing has no entities to capture.");
            }

            // Screen/Viewport capture path (Option A): preferred whenever targeting the active GUI document,
            // unless "drawing" (slow off-screen database render) is explicitly requested.
            var useViewport = request.Source != "drawing" && Application.DocumentManager.MdiActiveDocument == doc;
            if (useViewport)
            {
                try
                {
                    string vpFittedTo = "viewport";
                    List<string>? vpInvalidHandles = null;

                    // If framing on specific window or handles was requested, frame the viewport first
                    if (request.Window != null || (request.Handles is { Count: > 0 }))
                    {
                        try
                        {
                            var (minTarget, maxTarget, resolvedFittedTo, resolvedInvalidHandles) = ResolveWindow(tr, db, request);
                            vpFittedTo = resolvedFittedTo;
                            vpInvalidHandles = resolvedInvalidHandles;

                            using var edView = doc.Editor.GetCurrentView();
                            ViewFit.RepairDegenerateView(edView);
                            var (minEye, maxEye) = ToEyeBox(new Extents3d(minTarget, maxTarget), edView);
                            var bWidth = maxEye.X - minEye.X;
                            var bHeight = maxEye.Y - minEye.Y;
                            bWidth *= 1 + 2 * MarginFraction;
                            bHeight *= 1 + 2 * MarginFraction;
                            const double minSpan = 1e-6;
                            if (bWidth < minSpan) bWidth = minSpan;
                            if (bHeight < minSpan) bHeight = minSpan;
                            (bWidth, bHeight) = ViewFit.FitToAspect(bWidth, bHeight, edView.Width, edView.Height);
                            edView.Width = bWidth;
                            edView.Height = bHeight;
                            edView.CenterPoint = new Point2d(
                                (minEye.X + maxEye.X) / 2.0,
                                (minEye.Y + maxEye.Y) / 2.0);
                            ViewFit.ApplyView(doc.Editor, edView);
                        }
                        catch (OperationCanceledException) { throw; }
                        catch { /* if view framing fails, continue to take viewport snapshot */ }
                    }

                    short cvport = 1;
                    try
                    {
                        cvport = Convert.ToInt16(Application.GetSystemVariable("CVPORT"));
                    }
                    catch { }

                    Bitmap? bmp = null;
                    try
                    {
                        bmp = doc.CapturePreviewImage((uint)width, (uint)height);
                    }
                    catch { }

                    if (bmp == null)
                    {
                        var vpView = (cvport > 0 ? doc.GraphicsManager.GetCurrentAcGsView(cvport) : null)
                            ?? doc.GraphicsManager.GetCurrentAcGsView(1);
                        if (vpView != null)
                        {
                            bmp = vpView.GetSnapshot(new Rectangle(0, 0, width, height));
                        }
                    }

                    if (bmp != null)
                    {
                        using (bmp)
                        {
                            using var snapStream = new MemoryStream();
                            bmp.Save(snapStream, ImageFormat.Png);
                            var snapBytes = snapStream.ToArray();
                            var snapData = Convert.ToBase64String(snapBytes);
                            if (snapData.Length > MaxEncodedBytes)
                            {
                                throw PluginExceptions.CaptureTooLarge(snapData.Length, MaxEncodedBytes);
                            }
                            tr.Commit();
                            var windowDto = new CaptureWindowDto();
                            try
                            {
                                using var edView = doc.Editor.GetCurrentView();
                                if (edView != null && !ViewFit.IsDegenerate(edView.Width, edView.Height))
                                {
                                    var halfW = edView.Width / 2.0;
                                    var halfH = edView.Height / 2.0;
                                    windowDto.Min = new Point3dDto { X = edView.CenterPoint.X - halfW, Y = edView.CenterPoint.Y - halfH, Z = 0 };
                                    windowDto.Max = new Point3dDto { X = edView.CenterPoint.X + halfW, Y = edView.CenterPoint.Y + halfH, Z = 0 };
                                }
                                else
                                {
                                    windowDto.Min = new Point3dDto { X = db.Extmin.X, Y = db.Extmin.Y, Z = 0 };
                                    windowDto.Max = new Point3dDto { X = db.Extmax.X, Y = db.Extmax.Y, Z = 0 };
                                }
                            }
                            catch
                            {
                                windowDto.Min = new Point3dDto { X = db.Extmin.X, Y = db.Extmin.Y, Z = 0 };
                                windowDto.Max = new Point3dDto { X = db.Extmax.X, Y = db.Extmax.Y, Z = 0 };
                            }

                            return new ViewCaptureResult
                            {
                                DocumentName = doc.Name,
                                MimeType = "image/png",
                                Width = width,
                                Height = height,
                                Data = snapData,
                                FittedTo = vpFittedTo,
                                Source = "viewport",
                                InvalidHandles = vpInvalidHandles,
                                Window = windowDto
                            };
                        }
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch { /* fall through to accurate drawing render */ }
            }

            var (min, max, fittedTo, invalidHandles) = ResolveWindow(tr, db, request);
            ct.ThrowIfCancellationRequested();

            var (centerX, centerY, viewWidth, viewHeight) = FitToAspect(min, max, width / (double)height);

            var background = request.Background == "black" ? Color.Black : Color.White;
            var png = RenderPng(doc, ms, centerX, centerY, viewWidth, viewHeight, width, height, background, ct);
            var data = Convert.ToBase64String(png);
            if (data.Length > MaxEncodedBytes)
            {
                throw PluginExceptions.CaptureTooLarge(data.Length, MaxEncodedBytes);
            }
            tr.Commit();

            return new ViewCaptureResult
            {
                DocumentName = doc.Name,
                MimeType = "image/png",
                Width = width,
                Height = height,
                Data = data,
                FittedTo = fittedTo,
                Source = "drawing",
                InvalidHandles = invalidHandles,
                Window = new CaptureWindowDto
                {
                    Min = new Point3dDto { X = centerX - viewWidth / 2.0, Y = centerY - viewHeight / 2.0 },
                    Max = new Point3dDto { X = centerX + viewWidth / 2.0, Y = centerY + viewHeight / 2.0 },
                },
            };
        }

        private static int Clamp(int value) => Math.Min(MaxDimension, Math.Max(MinDimension, value));

        /// <summary>True when model space has no non-erased entities (a brand-new/blank drawing).</summary>
        private static bool IsEmpty(BlockTableRecord ms)
        {
            foreach (ObjectId id in ms)
            {
                if (!id.IsErased) return false;
            }
            return true;
        }

        /// <summary>The world-space XY window to show: explicit window, else the given entities, else all of model space.</summary>
        private static (Point3d Min, Point3d Max, string FittedTo, List<string>? InvalidHandles) ResolveWindow(
            Transaction tr, Database db, ViewCaptureRequest request)
        {
            if (request.Window is { } window)
            {
                var a = window.Min;
                var b = window.Max;
                if (double.IsNaN(a.X) || double.IsNaN(a.Y) || double.IsNaN(b.X) || double.IsNaN(b.Y) ||
                    double.IsInfinity(a.X) || double.IsInfinity(a.Y) || double.IsInfinity(b.X) || double.IsInfinity(b.Y))
                {
                    throw PluginExceptions.InvalidScope("Window coordinates must be finite numbers.");
                }
                var minX = Math.Min(a.X, b.X);
                var minY = Math.Min(a.Y, b.Y);
                var maxX = Math.Max(a.X, b.X);
                var maxY = Math.Max(a.Y, b.Y);
                if (Math.Abs(maxX - minX) < 1e-9 && Math.Abs(maxY - minY) < 1e-9)
                {
                    throw PluginExceptions.InvalidScope("Window rectangle cannot be degenerate (width and height are both 0).");
                }
                return (
                    new Point3d(minX, minY, 0),
                    new Point3d(maxX, maxY, 0),
                    "window",
                    null);
            }

            if (request.Handles is { Count: > 0 } handles)
            {
                Extents3d? union = null;
                var validCount = 0;
                var invalidHandles = new List<string>();
                foreach (var handle in handles)
                {
                    if (string.IsNullOrWhiteSpace(handle) || !HandleConvert.TryResolve(db, handle, out var id) || id.IsErased)
                    {
                        invalidHandles.Add(handle ?? "null");
                        continue;
                    }
                    if (tr.GetObject(id, OpenMode.ForRead) is not Entity entity)
                    {
                        invalidHandles.Add(handle);
                        continue;
                    }
                    Extents3d extents;
                    try { extents = entity.GeometricExtents; }
                    catch (Autodesk.AutoCAD.Runtime.Exception)
                    {
                        invalidHandles.Add(handle);
                        continue;
                    }
                    validCount++;
                    if (union is { } acc) { acc.AddExtents(extents); union = acc; }
                    else union = extents;
                }

                if (union == null || validCount == 0)
                {
                    throw PluginExceptions.InvalidScope(
                        $"None of the requested {handles.Count} handle(s) could be resolved to drawable entities. (Invalid handles: {string.Join(", ", handles)})"
                    );
                }

                var fittedTo = invalidHandles.Count > 0 ? "partial_entities" : "entities";
                return (union.Value.MinPoint, union.Value.MaxPoint, fittedTo, invalidHandles.Count > 0 ? invalidHandles : null);
            }

            db.UpdateExt(false);
            if (db.Extmin.X > db.Extmax.X)
            {
                throw PluginExceptions.CaptureFailed("The drawing has no entities to capture.");
            }
            return (db.Extmin, db.Extmax, "drawing", null);
        }

        /// <summary>Center and size of the smallest window with the image's aspect ratio that contains min..max plus margin.</summary>
        private static (double CenterX, double CenterY, double Width, double Height) FitToAspect(
            Point3d min, Point3d max, double aspect)
        {
            // Degenerate windows (a single point, or all geometry collinear on one axis) get a
            // minimum span instead of a zero-sized view.
            const double minSpan = 1e-3;
            var width = Math.Max(max.X - min.X, minSpan);
            var height = Math.Max(max.Y - min.Y, minSpan);
            width *= 1 + 2 * MarginFraction;
            height *= 1 + 2 * MarginFraction;

            if (width / height > aspect) height = width / aspect;
            else width = height * aspect;

            return ((min.X + max.X) / 2.0, (min.Y + max.Y) / 2.0, width, height);
        }

        private static (GraphicsKernel Kernel, bool Owned) AcquireKernel(Document doc)
        {
            var gsm = doc.GraphicsManager;
            // 1. Try active session kernels via reflection (AutoCAD 2024+ API, safe on 2021-2023)
            try
            {
                var prop = gsm.GetType().GetProperty("ActiveGraphicsKernels");
                if (prop != null && prop.GetValue(gsm) is GraphicsKernel[] active && active.Length > 0 && active[0] != null && !active[0].IsDisposed)
                {
                    return (active[0], false);
                }
            }
            catch { }

            // 2. Try Drawing2D
            try
            {
                var desc2D = new KernelDescriptor();
                desc2D.addRequirement(KernelDescriptor.Drawing2D);
                var k = Manager.AcquireGraphicsKernel(desc2D);
                if (k != null) return (k, true);
            }
            catch { }

            // 3. Try Drawing3D (DirectX 11/12 graphics pipeline used in modern AutoCAD)
            try
            {
                var desc3D = new KernelDescriptor();
                desc3D.addRequirement(KernelDescriptor.Drawing3D);
                var k = Manager.AcquireGraphicsKernel(desc3D);
                if (k != null) return (k, true);
            }
            catch { }

            // 4. Try default descriptor without explicit requirements
            try
            {
                var defaultDesc = new KernelDescriptor();
                var k = Manager.AcquireGraphicsKernel(defaultDesc);
                if (k != null) return (k, true);
            }
            catch (Exception ex)
            {
                throw PluginExceptions.CaptureFailed($"Failed to acquire graphics kernel (tried Active, Drawing2D, Drawing3D, Default): {DescribeRenderFailure(ex)}");
            }

            throw PluginExceptions.CaptureFailed("Failed to acquire graphics kernel: all descriptors returned null.");
        }

        private static byte[] RenderPng(
            Document doc, BlockTableRecord modelSpace,
            double centerX, double centerY, double viewWidth, double viewHeight,
            int pixelWidth, int pixelHeight, Color background,
            System.Threading.CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            var gsm = doc.GraphicsManager;
            var (kernel, owned) = AcquireKernel(doc);

            Device? device = null;
            Autodesk.AutoCAD.GraphicsSystem.View? view = null;
            Model? model = null;
            try
            {
                ct.ThrowIfCancellationRequested();
                device = gsm.CreateAutoCADOffScreenDevice(kernel);
                if (device == null)
                {
                    throw PluginExceptions.CaptureFailed("Off-screen graphics device creation returned null.");
                }

                device.OnSize(new Size(pixelWidth, pixelHeight));
                device.BackgroundColor = background;

                view = new Autodesk.AutoCAD.GraphicsSystem.View();
                model = gsm.CreateAutoCADModel(kernel);
                view.Add(modelSpace, model);
                // Plan view: looking down -Z at the window's centre, +Y up.
                view.SetView(
                    new Point3d(centerX, centerY, 1.0),
                    new Point3d(centerX, centerY, 0.0),
                    Vector3d.YAxis,
                    viewWidth,
                    viewHeight);
                device.Add(view);
                device.Update();

                ct.ThrowIfCancellationRequested();

                // AutoCAD off-screen Device.GetSnapshot takes the snapshot rectangle in client coordinates
                var snapRect = new Rectangle(0, 0, pixelWidth, pixelHeight);
                using var bitmap = device.GetSnapshot(snapRect);
                if (bitmap == null)
                {
                    throw PluginExceptions.CaptureFailed("Off-screen device snapshot returned null bitmap.");
                }
                ct.ThrowIfCancellationRequested();

                using var stream = new MemoryStream();
                bitmap.Save(stream, ImageFormat.Png);
                return stream.ToArray();
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw PluginExceptions.CaptureFailed(DescribeRenderFailure(ex));
            }
            finally
            {
                if (device != null && view != null)
                {
                    try { device.Erase(view); } catch { }
                }
                if (view != null)
                {
                    try { view.EraseAll(); } catch { }
                    try { view.Dispose(); } catch { }
                }
                if (model != null)
                {
                    try { model.Dispose(); } catch { }
                }
                if (device != null)
                {
                    try { device.Dispose(); } catch { }
                }
                if (owned && kernel != null)
                {
                    try { Manager.ReleaseGraphicsKernel(kernel); } catch { }
                }
            }
        }

        private static (Point2d Min, Point2d Max) ToEyeBox(Extents3d wcsExtents, ViewTableRecord view)
        {
            var worldToEye = ViewFit.EyeToWorld(view).Inverse();
            var pts = new[]
            {
                new Point3d(wcsExtents.MinPoint.X, wcsExtents.MinPoint.Y, wcsExtents.MinPoint.Z).TransformBy(worldToEye),
                new Point3d(wcsExtents.MaxPoint.X, wcsExtents.MinPoint.Y, wcsExtents.MinPoint.Z).TransformBy(worldToEye),
                new Point3d(wcsExtents.MinPoint.X, wcsExtents.MaxPoint.Y, wcsExtents.MinPoint.Z).TransformBy(worldToEye),
                new Point3d(wcsExtents.MaxPoint.X, wcsExtents.MaxPoint.Y, wcsExtents.MinPoint.Z).TransformBy(worldToEye),
                new Point3d(wcsExtents.MinPoint.X, wcsExtents.MinPoint.Y, wcsExtents.MaxPoint.Z).TransformBy(worldToEye),
                new Point3d(wcsExtents.MaxPoint.X, wcsExtents.MinPoint.Y, wcsExtents.MaxPoint.Z).TransformBy(worldToEye),
                new Point3d(wcsExtents.MinPoint.X, wcsExtents.MaxPoint.Y, wcsExtents.MaxPoint.Z).TransformBy(worldToEye),
                new Point3d(wcsExtents.MaxPoint.X, wcsExtents.MaxPoint.Y, wcsExtents.MaxPoint.Z).TransformBy(worldToEye),
            };

            var minX = double.MaxValue;
            var minY = double.MaxValue;
            var maxX = double.MinValue;
            var maxY = double.MinValue;

            foreach (var p in pts)
            {
                if (p.X < minX) minX = p.X;
                if (p.Y < minY) minY = p.Y;
                if (p.X > maxX) maxX = p.X;
                if (p.Y > maxY) maxY = p.Y;
            }

            return (new Point2d(minX, minY), new Point2d(maxX, maxY));
        }

        /// <summary>
        /// The off-screen graphics device throws generic BCL-style messages (e.g. "Operation is
        /// not valid due to the current state of the object") that give no clue which AutoCAD
        /// error actually fired. Append the structured <see cref="Autodesk.AutoCAD.Runtime.Exception.ErrorStatus"/>
        /// when the plugin host can read it, so a capture failure other than the already-handled
        /// empty-drawing case is still diagnosable from the RPC error alone.
        /// </summary>
        private static string DescribeRenderFailure(Exception ex) =>
            ex is Autodesk.AutoCAD.Runtime.Exception acadEx
                ? $"{ex.Message} (ErrorStatus: {acadEx.ErrorStatus})"
                : ex.Message;
    }
}
