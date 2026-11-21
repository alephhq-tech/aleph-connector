using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    /// <summary>
    /// In-place curve edits for operations.apply (#23): offset, break, trim, extend, fillet.
    /// Prefer geometry APIs over Editor.Command so batches stay transactional.
    /// </summary>
    public static class CurveEditHandlers
    {
        public static List<EntityRefDto> OffsetOne(
            Transaction tr,
            Database db,
            EntityOffsetRequest request,
            string documentName
        )
        {
            if (string.IsNullOrWhiteSpace(request.Handle))
                throw PluginExceptions.InvalidGeometry("offset.handle is required.");
            if (request.Distance == 0)
                throw PluginExceptions.InvalidGeometry("offset.distance must not be 0.");

            var curve = OpenCurve(tr, db, request.Handle, OpenMode.ForRead);
            DBObjectCollection? offsets;
            try
            {
                offsets = curve.GetOffsetCurves(request.Distance);
            }
            catch (Exception ex)
            {
                throw PluginExceptions.InvalidGeometry(
                    $"offset failed on handle {request.Handle}: {ex.Message}");
            }

            if (offsets == null || offsets.Count == 0)
                throw PluginExceptions.InvalidGeometry(
                    $"offset produced no curves for handle {request.Handle}.");

            var space = CurrentSpace(tr, db);
            var refs = new List<EntityRefDto>();
            foreach (DBObject obj in offsets)
            {
                if (obj is not Entity ent)
                {
                    obj.Dispose();
                    continue;
                }
                if (!string.IsNullOrWhiteSpace(request.Layer))
                    ent.Layer = request.Layer!;
                else
                    ent.Layer = curve.Layer;
                ent.Color = curve.Color;
                ent.Linetype = curve.Linetype;
                space.AppendEntity(ent);
                tr.AddNewlyCreatedDBObject(ent, true);
                EntityOwnership.Stamp(tr, ent);
                refs.Add(ToRef(ent));
            }

            if (request.Replace)
            {
                EntityOwnership.Guard(tr, db, new[] { request.Handle }, "offset replace");
                curve.UpgradeOpen();
                curve.Erase(true);
            }

            return refs;
        }

        public static List<EntityRefDto> BreakOne(Transaction tr, Database db, EntityBreakRequest request)
        {
            if (string.IsNullOrWhiteSpace(request.Handle))
                throw PluginExceptions.InvalidGeometry("break.handle is required.");
            if (request.Points == null || request.Points.Count is < 1 or > 2)
                throw PluginExceptions.InvalidGeometry("break.points must contain 1 or 2 points.");

            var curve = OpenCurve(tr, db, request.Handle, OpenMode.ForRead);
            var pts = new Point3dCollection();
            foreach (var p in request.Points)
            {
                var world = new Point3d(p.X, p.Y, 0);
                var onCurve = curve.GetClosestPointTo(world, false);
                pts.Add(onCurve);
            }

            DBObjectCollection? pieces;
            try
            {
                pieces = curve.GetSplitCurves(pts);
            }
            catch (Exception ex)
            {
                throw PluginExceptions.InvalidGeometry($"break failed on {request.Handle}: {ex.Message}");
            }

            if (pieces == null || pieces.Count == 0)
                throw PluginExceptions.InvalidGeometry($"break produced no pieces for {request.Handle}.");

            var space = CurrentSpace(tr, db);
            var refs = new List<EntityRefDto>();
            foreach (DBObject obj in pieces)
            {
                if (obj is not Entity ent)
                {
                    obj.Dispose();
                    continue;
                }
                ent.Layer = curve.Layer;
                ent.Color = curve.Color;
                ent.Linetype = curve.Linetype;
                space.AppendEntity(ent);
                tr.AddNewlyCreatedDBObject(ent, true);
                EntityOwnership.Stamp(tr, ent);
                refs.Add(ToRef(ent));
            }

            if (request.Replace)
            {
                // Breaking replaces the source; allow CadAI-owned freely. User geometry: require
                // ownership stamp so we never silently destroy floor-plan walls.
                if (!EntityOwnership.IsCadAiOwned(curve))
                    EntityOwnership.Guard(tr, db, new[] { request.Handle }, "break");
                curve.UpgradeOpen();
                curve.Erase(true);
            }

            return refs;
        }

        public static List<EntityRefDto> TrimOne(Transaction tr, Database db, EntityTrimRequest request)
        {
            if (string.IsNullOrWhiteSpace(request.Handle))
                throw PluginExceptions.InvalidGeometry("trim.handle is required.");
            if (request.CutPoint == null || request.KeepPoint == null)
                throw PluginExceptions.InvalidGeometry("trim.cutPoint and trim.keepPoint are required.");

            var breakReq = new EntityBreakRequest
            {
                Handle = request.Handle,
                Points = new List<Point3dDto> { request.CutPoint },
                Replace = true
            };
            var pieces = BreakOne(tr, db, breakReq);
            if (pieces.Count == 0)
                return pieces;

            var keep = new Point3d(request.KeepPoint.X, request.KeepPoint.Y, 0);
            string? keepHandle = null;
            double best = double.MaxValue;
            foreach (var r in pieces)
            {
                if (!HandleConvert.TryResolve(db, r.Handle, out var id) || id.IsErased) continue;
                var ent = (Entity)tr.GetObject(id, OpenMode.ForRead);
                if (ent is not Curve c) continue;
                var d = c.GetClosestPointTo(keep, false).DistanceTo(keep);
                if (d < best)
                {
                    best = d;
                    keepHandle = r.Handle;
                }
            }

            var kept = new List<EntityRefDto>();
            foreach (var r in pieces)
            {
                if (r.Handle == keepHandle)
                {
                    kept.Add(r);
                    continue;
                }
                if (HandleConvert.TryResolve(db, r.Handle, out var id) && !id.IsErased)
                {
                    var ent = (Entity)tr.GetObject(id, OpenMode.ForWrite);
                    ent.Erase(true);
                }
            }
            return kept;
        }

        public static List<EntityRefDto> ExtendOne(Transaction tr, Database db, EntityExtendRequest request)
        {
            if (string.IsNullOrWhiteSpace(request.Handle) || string.IsNullOrWhiteSpace(request.BoundaryHandle))
                throw PluginExceptions.InvalidGeometry("extend.handle and extend.boundaryHandle are required.");

            var curve = OpenCurve(tr, db, request.Handle, OpenMode.ForWrite);
            var boundary = OpenCurve(tr, db, request.BoundaryHandle, OpenMode.ForRead);

            var endMode = (request.End ?? "end").Trim().ToLowerInvariant();
            var extendStart = endMode is "start" or "both";
            var extendEnd = endMode is "end" or "both" or "";

            try
            {
                if (extendStart)
                    TryExtendEnd(curve, boundary, atStart: true);
                if (extendEnd)
                    TryExtendEnd(curve, boundary, atStart: false);
            }
            catch (Exception ex)
            {
                throw PluginExceptions.InvalidGeometry($"extend failed on {request.Handle}: {ex.Message}");
            }

            if (!EntityOwnership.IsCadAiOwned(curve))
                EntityOwnership.Stamp(tr, curve);

            return new List<EntityRefDto> { ToRef(curve) };
        }

        public static List<EntityRefDto> FilletOne(Transaction tr, Database db, EntityFilletRequest request)
        {
            if (request.Radius <= 0)
                throw PluginExceptions.InvalidGeometry("fillet.radius must be positive.");

            if (!string.IsNullOrWhiteSpace(request.PolylineHandle))
            {
                if (request.VertexIndex is null)
                    throw PluginExceptions.InvalidGeometry("fillet.vertexIndex is required with polylineHandle.");
                return FilletPolylineVertex(tr, db, request.PolylineHandle!, request.VertexIndex.Value, request.Radius);
            }

            if (request.Handles == null || request.Handles.Count != 2)
                throw PluginExceptions.InvalidGeometry(
                    "fillet requires handles:[a,b] or polylineHandle+vertexIndex.");

            var c1 = OpenCurve(tr, db, request.Handles[0], OpenMode.ForWrite);
            var c2 = OpenCurve(tr, db, request.Handles[1], OpenMode.ForWrite);

            try
            {
                FilletTwoCurves(tr, db, c1, c2, request.Radius, out var refs);
                return refs;
            }
            catch (LocalRpcException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw PluginExceptions.InvalidGeometry(
                    $"fillet failed on {request.Handles[0]},{request.Handles[1]}: {ex.Message}");
            }
        }

        private static List<EntityRefDto> FilletPolylineVertex(
            Transaction tr,
            Database db,
            string handle,
            int vertexIndex,
            double radius
        )
        {
            if (!HandleConvert.TryResolve(db, handle, out var id) || id.IsErased)
                throw PluginExceptions.EntityNotFound(handle);
            var ent = tr.GetObject(id, OpenMode.ForWrite);
            if (ent is not Polyline pl)
                throw PluginExceptions.InvalidGeometry($"fillet.polylineHandle {handle} is not a polyline.");
            if (vertexIndex < 0 || vertexIndex >= pl.NumberOfVertices)
                throw PluginExceptions.InvalidGeometry(
                    $"fillet.vertexIndex {vertexIndex} out of range (0..{pl.NumberOfVertices - 1}).");

            // Approximate fillet by setting bulge at the vertex from radius and adjacent segments.
            var i0 = vertexIndex == 0 ? (pl.Closed ? pl.NumberOfVertices - 1 : -1) : vertexIndex - 1;
            var i1 = vertexIndex;
            var i2 = vertexIndex + 1;
            if (i2 >= pl.NumberOfVertices)
            {
                if (!pl.Closed)
                    throw PluginExceptions.InvalidGeometry("Cannot fillet an open polyline end vertex.");
                i2 = 0;
            }
            if (i0 < 0)
                throw PluginExceptions.InvalidGeometry("Cannot fillet an open polyline start vertex.");

            var p0 = pl.GetPoint2dAt(i0);
            var p1 = pl.GetPoint2dAt(i1);
            var p2 = pl.GetPoint2dAt(i2);
            var v1 = p0 - p1;
            var v2 = p2 - p1;
            var len1 = v1.Length;
            var len2 = v2.Length;
            if (len1 < 1e-9 || len2 < 1e-9)
                throw PluginExceptions.InvalidGeometry("fillet: degenerate polyline segment.");

            var ang = v1.GetAngleTo(v2);
            if (ang < 1e-6 || Math.Abs(Math.PI - ang) < 1e-6)
                throw PluginExceptions.InvalidGeometry("fillet: segments are collinear.");

            var half = ang / 2.0;
            var t = radius / Math.Tan(half);
            if (t > len1 - 1e-6 || t > len2 - 1e-6)
                throw PluginExceptions.InvalidGeometry("fillet.radius too large for adjacent segments.");

            // Bulge for a circular arc spanning the turn: bulge = tan(sweep/4); sweep = π - ang.
            var sweep = Math.PI - ang;
            var cross = v1.X * v2.Y - v1.Y * v2.X;
            var bulge = Math.Tan(sweep / 4.0) * (cross < 0 ? -1 : 1);

            // Insert trim points along both legs and set bulge on the new middle segment.
            var u1 = v1 / len1;
            var u2 = v2 / len2;
            var a = p1 + u1 * t;
            var b = p1 + u2 * t;

            // Rebuild polyline vertices: … → a → (arc via bulge) → b → …
            var pts = new List<(Point2d pt, double bulge)>();
            for (int i = 0; i < pl.NumberOfVertices; i++)
            {
                if (i == i1)
                {
                    pts.Add((a, bulge));
                    pts.Add((b, 0));
                    continue;
                }
                pts.Add((pl.GetPoint2dAt(i), i == pl.NumberOfVertices - 1 ? 0 : pl.GetBulgeAt(i)));
            }

            var neu = new Polyline();
            for (int i = 0; i < pts.Count; i++)
            {
                neu.AddVertexAt(i, pts[i].pt, pts[i].bulge, 0, 0);
            }
            neu.Closed = pl.Closed;
            neu.Layer = pl.Layer;
            neu.Color = pl.Color;
            neu.Linetype = pl.Linetype;

            var space = (BlockTableRecord)tr.GetObject(pl.OwnerId, OpenMode.ForWrite);
            space.AppendEntity(neu);
            tr.AddNewlyCreatedDBObject(neu, true);
            EntityOwnership.Stamp(tr, neu);
            if (!EntityOwnership.IsCadAiOwned(pl))
                EntityOwnership.Guard(tr, db, new[] { handle }, "fillet polyline replace");
            pl.Erase(true);
            return new List<EntityRefDto> { ToRef(neu) };
        }

        private static void FilletTwoCurves(
            Transaction tr,
            Database db,
            Curve c1,
            Curve c2,
            double radius,
            out List<EntityRefDto> refs
        )
        {
            refs = new List<EntityRefDto>();
            if (c1 is not Line l1 || c2 is not Line l2)
            {
                throw PluginExceptions.InvalidGeometry(
                    "fillet of two handles currently supports Line entities; use polylineHandle for LWPOLYLINE corners.");
            }

            var p1s = new Point2d(l1.StartPoint.X, l1.StartPoint.Y);
            var p1e = new Point2d(l1.EndPoint.X, l1.EndPoint.Y);
            var p2s = new Point2d(l2.StartPoint.X, l2.StartPoint.Y);
            var p2e = new Point2d(l2.EndPoint.X, l2.EndPoint.Y);

            // Find closest endpoint pair as the corner.
            var pairs = new[]
            {
                (a: p1s, b: p2s, on1Start: true, on2Start: true),
                (a: p1s, b: p2e, on1Start: true, on2Start: false),
                (a: p1e, b: p2s, on1Start: false, on2Start: true),
                (a: p1e, b: p2e, on1Start: false, on2Start: false)
            };
            var best = pairs.OrderBy(p => p.a.GetDistanceTo(p.b)).First();
            if (best.a.GetDistanceTo(best.b) > 1.0)
                throw PluginExceptions.InvalidGeometry("fillet: line endpoints are not near a shared corner.");

            var corner = best.a;
            var dir1 = best.on1Start ? (p1e - p1s) : (p1s - p1e);
            var dir2 = best.on2Start ? (p2e - p2s) : (p2s - p2e);
            var len1 = dir1.Length;
            var len2 = dir2.Length;
            if (len1 < 1e-9 || len2 < 1e-9)
                throw PluginExceptions.InvalidGeometry("fillet: degenerate line.");
            dir1 /= len1;
            dir2 /= len2;
            var ang = dir1.GetAngleTo(dir2);
            var half = ang / 2.0;
            var t = radius / Math.Tan(half);
            if (t > len1 || t > len2)
                throw PluginExceptions.InvalidGeometry("fillet.radius too large.");

            var a = corner + dir1 * t;
            var b = corner + dir2 * t;
            var bis = dir1 + dir2;
            if (bis.Length < 1e-9)
                throw PluginExceptions.InvalidGeometry("fillet: opposite directions.");
            bis = bis.GetNormal();
            var center = corner + bis * (radius / Math.Sin(half));
            var cross = dir1.X * dir2.Y - dir1.Y * dir2.X;
            var startAng = Math.Atan2(a.Y - center.Y, a.X - center.X);
            var endAng = Math.Atan2(b.Y - center.Y, b.X - center.X);

            // Shorten lines to tangent points.
            if (best.on1Start) l1.StartPoint = new Point3d(a.X, a.Y, 0);
            else l1.EndPoint = new Point3d(a.X, a.Y, 0);
            if (best.on2Start) l2.StartPoint = new Point3d(b.X, b.Y, 0);
            else l2.EndPoint = new Point3d(b.X, b.Y, 0);

            var arc = new Arc(
                new Point3d(center.X, center.Y, 0),
                radius,
                cross >= 0 ? startAng : endAng,
                cross >= 0 ? endAng : startAng
            );
            // Ensure arc goes the short way matching the turn.
            if (arc.Length > Math.PI * radius)
            {
                var sa = arc.StartAngle;
                arc.StartAngle = arc.EndAngle;
                arc.EndAngle = sa;
            }
            arc.Layer = c1.Layer;
            arc.Color = c1.Color;
            var space = CurrentSpace(tr, db);
            space.AppendEntity(arc);
            tr.AddNewlyCreatedDBObject(arc, true);
            EntityOwnership.Stamp(tr, arc);
            if (!EntityOwnership.IsCadAiOwned(c1)) EntityOwnership.Stamp(tr, c1);
            if (!EntityOwnership.IsCadAiOwned(c2)) EntityOwnership.Stamp(tr, c2);

            refs.Add(ToRef(c1));
            refs.Add(ToRef(c2));
            refs.Add(ToRef(arc));
        }

        private static void TryExtendEnd(Curve curve, Curve boundary, bool atStart)
        {
            var tip = atStart ? curve.StartPoint : curve.EndPoint;
            var pts = new Point3dCollection();
            curve.IntersectWith(
                boundary,
                Intersect.ExtendThis,
                pts,
                IntPtr.Zero,
                IntPtr.Zero
            );
            if (pts.Count == 0)
            {
                // Try extending both.
                curve.IntersectWith(
                    boundary,
                    Intersect.ExtendBoth,
                    pts,
                    IntPtr.Zero,
                    IntPtr.Zero
                );
            }
            if (pts.Count == 0)
                throw new InvalidOperationException("no intersection with boundary when extended.");

            Point3d best = pts[0];
            double bestDist = tip.DistanceTo(best);
            for (int i = 1; i < pts.Count; i++)
            {
                var d = tip.DistanceTo(pts[i]);
                if (d < bestDist)
                {
                    bestDist = d;
                    best = pts[i];
                }
            }

            if (curve is Line line)
            {
                if (atStart) line.StartPoint = best;
                else line.EndPoint = best;
                return;
            }
            if (curve is Polyline pl)
            {
                if (atStart)
                    pl.SetPointAt(0, new Point2d(best.X, best.Y));
                else
                    pl.SetPointAt(pl.NumberOfVertices - 1, new Point2d(best.X, best.Y));
                return;
            }

            throw new InvalidOperationException($"extend unsupported for {curve.GetType().Name}");
        }

        private static Curve OpenCurve(Transaction tr, Database db, string handle, OpenMode mode)
        {
            if (!HandleConvert.TryResolve(db, handle, out var id) || id.IsErased)
                throw PluginExceptions.EntityNotFound(handle);
            var ent = tr.GetObject(id, mode);
            if (ent is not Curve curve)
                throw PluginExceptions.InvalidGeometry($"Handle {handle} is not a curve.");
            return curve;
        }

        private static BlockTableRecord CurrentSpace(Transaction tr, Database db)
        {
            return (BlockTableRecord)tr.GetObject(db.CurrentSpaceId, OpenMode.ForWrite);
        }

        private static EntityRefDto ToRef(Entity ent) =>
            new EntityRefDto
            {
                Handle = ent.Handle.ToString(),
                Kind = EntityKindResolver.KindOf(ent),
                Layer = ent.Layer
            };
    }
}
