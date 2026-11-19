using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    /// <summary>
    /// <c>drawing.check</c> (read-only quality pass) and <c>drawing.cleanup</c> (the safe fixes).
    /// Mirrors <c>server/src/bridge/MockBridgeClient.ts</c>'s detection algorithm and
    /// tolerance math exactly, but reads real geometry (<see cref="Entity.Bounds"/>,
    /// <see cref="Curve.GetDistanceAtParameter(double)"/>, <see cref="Dimension.Measurement"/>)
    /// instead of the mock's stored creation params — not verified against a real AutoCAD (no
    /// install in this environment), only compile-proven; see docs/IMPLEMENTATION_STATUS.md.
    /// </summary>
    public sealed class CheckHandlers
    {
        private static readonly string[] AllChecks =
        {
            "duplicates", "overlaps", "zeroLength", "openOutlines",
            "layerZero", "textSize", "dimOverride", "offExtents",
        };

        private static readonly Regex[] OutlineLayerPatterns =
        {
            GlobToRegex("*-WALL"), GlobToRegex("*-OUTL"), GlobToRegex("*OUTLINE*"),
        };

        [JsonRpcMethod("drawing.check", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingCheckResult> Check(DrawingCheckRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var db = DocumentContext.ResolveDatabase(request.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                var all = ms.Cast<ObjectId>()
                    .Select(id => (Entity)tr.GetObject(id, OpenMode.ForRead))
                    .ToList();

                var checks = request.Checks is { Length: > 0 } ? request.Checks : AllChecks;
                var findings = RunChecks(all, Scoped(all, request.Scope), checks);
                // Read-only: never opened ForWrite, nothing to roll back either way.
                tr.Commit();
                return new DrawingCheckResult { Findings = findings };
            });

        [JsonRpcMethod("drawing.cleanup", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingCleanupResult> Cleanup(DrawingCleanupRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (request.Fixes.Contains("audit")) throw PluginExceptions.AuditUnsupported();

                var doc = DocumentContext.Resolve(request.DocumentName);
                bool dryRun = request.DryRun ?? true;
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    var nativeUndo = !dryRun && ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument);
                    if (nativeUndo) doc.Editor.Command("_.UNDO", "_Group");
                    using var tr = db.TransactionManager.StartTransaction();
                    try
                    {
                        var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                        var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                        var all = ms.Cast<ObjectId>()
                            .Select(id => (Entity)tr.GetObject(id, OpenMode.ForRead))
                            .ToList();

                        var applied = new List<DrawingCleanupAppliedDto>();
                        foreach (var fix in request.Fixes)
                        {
                            if (fix == "duplicates")
                            {
                                var handles = RunChecks(all, all, new[] { "duplicates" })
                                    .SelectMany(f => f.Handles.Skip(1))
                                    .ToList();
                                var (erased, skipped) = EraseByHandle(tr, db, handles, dryRun);
                                applied.Add(new DrawingCleanupAppliedDto
                                {
                                    Fix = "duplicates",
                                    Count = erased.Count,
                                    Handles = erased,
                                    SkippedProtected = skipped
                                });
                            }
                            else if (fix == "zeroLength")
                            {
                                var handles = RunChecks(all, all, new[] { "zeroLength" })
                                    .SelectMany(f => f.Handles)
                                    .ToList();
                                var (erased, skipped) = EraseByHandle(tr, db, handles, dryRun);
                                applied.Add(new DrawingCleanupAppliedDto
                                {
                                    Fix = "zeroLength",
                                    Count = erased.Count,
                                    Handles = erased,
                                    SkippedProtected = skipped
                                });
                            }
                            else if (fix == "purge")
                            {
                                var referenced = new HashSet<string>(all.Select(e => e.Layer)) { db.Clayer.ToString(), "0", "Defpoints" };
                                var lt = (LayerTable)tr.GetObject(db.LayerTableId, dryRun ? OpenMode.ForRead : OpenMode.ForWrite);
                                var allUnused = lt.Cast<ObjectId>()
                                    .Select(id => (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead))
                                    .Where(ltr => !referenced.Contains(ltr.Name))
                                    .ToList();
                                var unused = allUnused.Where(EntityOwnership.IsCadAiOwned).ToList();
                                var skippedLayers = allUnused.Count - unused.Count;
                                if (!dryRun)
                                {
                                    var ids = new ObjectIdCollection(unused.Select(l => l.ObjectId).ToArray());
                                    db.Purge(ids);
                                    foreach (ObjectId id in ids)
                                    {
                                        var ltr = (LayerTableRecord)tr.GetObject(id, OpenMode.ForWrite);
                                        ltr.Erase();
                                    }
                                }
                                applied.Add(new DrawingCleanupAppliedDto
                                {
                                    Fix = "purge",
                                    Count = unused.Count,
                                    SkippedProtected = skippedLayers
                                });
                            }
                        }
                        tr.Commit();
                        if (nativeUndo) doc.Editor.Command("_.UNDO", "_End");
                        if (!dryRun) ScreenRefresh.AfterCommit(doc);
                        return new DrawingCleanupResult { DryRun = dryRun, Applied = applied };
                    }
                    catch (LocalRpcException)
                    {
                        if (nativeUndo) doc.Editor.Command("_.UNDO", "_End");
                        throw;
                    }
                    catch (Exception ex)
                    {
                        if (nativeUndo) doc.Editor.Command("_.UNDO", "_End");
                        throw PluginExceptions.TransactionFailed(ex);
                    }
                }
            });

        internal static (List<string> Erased, int Skipped) EraseByHandle(Transaction tr, Database db, List<string> handles, bool dryRun = false) =>
            EraseByHandleCore(
                handles,
                dryRun,
                h => HandleConvert.TryResolve(db, h, out var id) && !id.IsErased,
                h =>
                {
                    if (!HandleConvert.TryResolve(db, h, out var id)) return false;
                    var entity = (Entity)tr.GetObject(id, dryRun ? OpenMode.ForRead : OpenMode.ForWrite);
                    return EntityOwnership.IsCadAiOwned(entity);
                },
                h =>
                {
                    if (HandleConvert.TryResolve(db, h, out var id) && !id.IsErased)
                    {
                        ((Entity)tr.GetObject(id, OpenMode.ForWrite)).Erase();
                    }
                });

        internal static (List<string> Erased, int Skipped) EraseByHandleCore(
            IEnumerable<string> handles,
            bool dryRun,
            Func<string, bool> isResolvable,
            Func<string, bool> isCadAiOwned,
            Action<string>? eraseAction = null)
        {
            var erased = new List<string>();
            var skipped = 0;
            foreach (var handle in handles)
            {
                if (!isResolvable(handle)) continue;
                if (isCadAiOwned(handle))
                {
                    if (!dryRun)
                    {
                        eraseAction?.Invoke(handle);
                    }
                    erased.Add(handle);
                }
                else
                {
                    skipped++;
                }
            }
            return (erased, skipped);
        }

        private static List<Entity> Scoped(List<Entity> all, DrawingCheckScopeDto? scope)
        {
            if (scope?.Handles is { Length: > 0 } handles)
            {
                var wanted = new HashSet<string>(handles);
                return all.Where(e => wanted.Contains(e.Handle.ToString())).ToList();
            }
            if (!string.IsNullOrEmpty(scope?.Layer)) return all.Where(e => e.Layer == scope!.Layer).ToList();
            if (scope?.Window is { } window)
            {
                return all.Where(e =>
                {
                    var b = e.Bounds;
                    if (!b.HasValue) return false;
                    return b.Value.MinPoint.X <= window.Max.X && b.Value.MaxPoint.X >= window.Min.X
                        && b.Value.MinPoint.Y <= window.Max.Y && b.Value.MaxPoint.Y >= window.Min.Y;
                }).ToList();
            }
            return all;
        }

        /// <summary>
        /// <paramref name="all"/> is the whole drawing (for the tolerance's extents diagonal, computed
        /// once over everything regardless of scope); <paramref name="scoped"/> is what each check
        /// actually inspects.
        /// </summary>
        private static List<DrawingCheckFindingDto> RunChecks(List<Entity> all, List<Entity> scoped, IReadOnlyList<string> checks)
        {
            var bounds = all.Select(e => e.Bounds).Where(b => b.HasValue).Select(b => b!.Value).ToList();
            double diagonal = bounds.Count > 0
                ? new Point3d(bounds.Min(b => b.MinPoint.X), bounds.Min(b => b.MinPoint.Y), 0)
                    .DistanceTo(new Point3d(bounds.Max(b => b.MaxPoint.X), bounds.Max(b => b.MaxPoint.Y), 0))
                : 0;
            double tolerance = Math.Max(diagonal * 1e-6, 1e-9);
            int decimals = Math.Max(0, Math.Min(6, (int)Math.Round(-Math.Log10(tolerance))));
            var findings = new List<DrawingCheckFindingDto>();
            bool Wants(string kind) => checks.Contains(kind);

            if (Wants("duplicates"))
            {
                var groups = scoped
                    .Select(e => new { e, sig = Signature(e, decimals) })
                    .Where(x => x.sig != null)
                    .GroupBy(x => $"{EntityKindResolver.KindOf(x.e)}\0{x.e.Layer}\0{x.sig}")
                    .Where(g => g.Count() > 1);
                foreach (var g in groups)
                {
                    var handles = g.Select(x => x.e.Handle.ToString()).ToList();
                    findings.Add(new DrawingCheckFindingDto
                    {
                        Check = "duplicates", Severity = "warning", Handles = handles,
                        Message = $"{handles.Count} entities share identical geometry on the same layer",
                        Fix = "duplicates",
                    });
                }
            }

            if (Wants("overlaps"))
            {
                var lines = scoped.OfType<Line>().ToList();
                // Bucketed pair enumeration instead of the old O(L^2) nested scan: 20k lines was
                // ~200M comparisons on AutoCAD's UI thread (a freeze). CandidatePairs returns a
                // superset of the pairs whose bboxes touch, sorted by (i, j) — so the collinear
                // overlap math and the finding order below are exactly what they were.
                var boxMinX = new double[lines.Count];
                var boxMinY = new double[lines.Count];
                var boxMaxX = new double[lines.Count];
                var boxMaxY = new double[lines.Count];
                for (int i = 0; i < lines.Count; i++)
                {
                    var l = lines[i];
                    boxMinX[i] = Math.Min(l.StartPoint.X, l.EndPoint.X);
                    boxMinY[i] = Math.Min(l.StartPoint.Y, l.EndPoint.Y);
                    boxMaxX[i] = Math.Max(l.StartPoint.X, l.EndPoint.X);
                    boxMaxY[i] = Math.Max(l.StartPoint.Y, l.EndPoint.Y);
                }
                foreach (var pair in SpatialGrid.CandidatePairs(boxMinX, boxMinY, boxMaxX, boxMaxY))
                {
                    int i = SpatialGrid.First(pair);
                    int j = SpatialGrid.Second(pair);
                    var a = lines[i];
                    var b = lines[j];
                    if (a.Layer != b.Layer) continue;
                    var d = a.EndPoint - a.StartPoint;
                    double len = d.Length;
                    if (len < tolerance) continue;
                    double Cross(Point3d p) => Math.Abs(d.X * (p.Y - a.StartPoint.Y) - d.Y * (p.X - a.StartPoint.X));
                    if (Cross(b.StartPoint) > tolerance * len || Cross(b.EndPoint) > tolerance * len) continue;
                    double Param(Point3d p) => (d.X * (p.X - a.StartPoint.X) + d.Y * (p.Y - a.StartPoint.Y)) / len;
                    double bMin = Math.Min(Param(b.StartPoint), Param(b.EndPoint));
                    double bMax = Math.Max(Param(b.StartPoint), Param(b.EndPoint));
                    double overlapLen = Math.Min(len, bMax) - Math.Max(0, bMin);
                    if (overlapLen > tolerance)
                    {
                        findings.Add(new DrawingCheckFindingDto
                        {
                            Check = "overlaps", Severity = "warning",
                            Handles = new List<string> { a.Handle.ToString(), b.Handle.ToString() },
                            Message = $"Collinear lines overlap by {overlapLen:F4} drawing units",
                        });
                    }
                }
            }

            if (Wants("zeroLength"))
            {
                var handles = new List<string>();
                foreach (var e in scoped)
                {
                    if (e is Curve curve)
                    {
                        double length;
                        try { length = curve.GetDistanceAtParameter(curve.EndParam) - curve.GetDistanceAtParameter(curve.StartParam); }
                        catch (Autodesk.AutoCAD.Runtime.Exception) { continue; }
                        if (length < tolerance) handles.Add(e.Handle.ToString());
                    }
                    else if (e is DBText text && text.TextString.Trim().Length == 0) handles.Add(e.Handle.ToString());
                    else if (e is MText mtext && mtext.Contents.Trim().Length == 0) handles.Add(e.Handle.ToString());
                }
                if (handles.Count > 0)
                {
                    findings.Add(new DrawingCheckFindingDto
                    {
                        Check = "zeroLength", Severity = "error", Handles = handles,
                        Message = $"{handles.Count} entities have zero length or empty text", Fix = "zeroLength",
                    });
                }
            }

            if (Wants("openOutlines"))
            {
                var handles = scoped.OfType<Polyline>()
                    .Where(p => !p.Closed && OutlineLayerPatterns.Any(re => re.IsMatch(p.Layer)))
                    .Select(p => p.Handle.ToString())
                    .ToList();
                if (handles.Count > 0)
                {
                    findings.Add(new DrawingCheckFindingDto
                    {
                        Check = "openOutlines", Severity = "warning", Handles = handles,
                        Message = $"{handles.Count} outline-layer polylines are not closed",
                    });
                }
            }

            if (Wants("layerZero"))
            {
                var handles = scoped.Where(e => e.Layer == "0" || e.Layer == "Defpoints").Select(e => e.Handle.ToString()).ToList();
                if (handles.Count > 0)
                {
                    findings.Add(new DrawingCheckFindingDto
                    {
                        Check = "layerZero", Severity = "info", Handles = handles,
                        Message = $"{handles.Count} entities are on layer \"0\" or \"Defpoints\"",
                    });
                }
            }

            if (Wants("textSize"))
            {
                double HeightOf(Entity e) => e is DBText t ? t.Height : e is MText m ? m.TextHeight : 0;
                var texts = scoped.Where(e => e is DBText or MText).ToList();
                string GroupOf(Entity e) => $"{e.Layer}\0{Math.Round(HeightOf(e), 2)}";
                var counts = texts.GroupBy(GroupOf).ToDictionary(g => g.Key, g => g.Count());
                var handles = texts.Where(e => counts[GroupOf(e)] - 1 < 2).Select(e => e.Handle.ToString()).ToList();
                if (handles.Count > 0)
                {
                    findings.Add(new DrawingCheckFindingDto
                    {
                        Check = "textSize", Severity = "warning", Handles = handles,
                        Message = $"{handles.Count} text entities use a height inconsistent with the rest of their layer",
                    });
                }
            }

            if (Wants("dimOverride"))
            {
                var handles = new List<string>();
                foreach (var e in scoped.OfType<Dimension>())
                {
                    var text = e.DimensionText;
                    if (string.IsNullOrWhiteSpace(text)) continue;
                    if (!double.TryParse(text, out var parsed)) continue;
                    if (Math.Abs(parsed - e.Measurement) > Math.Max(tolerance, 1e-4)) handles.Add(e.Handle.ToString());
                }
                if (handles.Count > 0)
                {
                    findings.Add(new DrawingCheckFindingDto
                    {
                        Check = "dimOverride", Severity = "warning", Handles = handles,
                        Message = $"{handles.Count} dimensions have a text override that doesn't match the measured value",
                    });
                }
            }

            if (Wants("offExtents"))
            {
                var withCenters = scoped
                    .Select(e => new { e, b = e.Bounds })
                    .Where(x => x.b.HasValue)
                    .Select(x => new
                    {
                        x.e,
                        dist = new Point3d(
                            (x.b!.Value.MinPoint.X + x.b.Value.MaxPoint.X) / 2,
                            (x.b.Value.MinPoint.Y + x.b.Value.MaxPoint.Y) / 2,
                            (x.b.Value.MinPoint.Z + x.b.Value.MaxPoint.Z) / 2).DistanceTo(Point3d.Origin),
                    })
                    .ToList();
                if (withCenters.Count >= 3)
                {
                    var sorted = withCenters.Select(w => w.dist).OrderBy(d => d).ToList();
                    double median = sorted[sorted.Count / 2];
                    if (median > tolerance)
                    {
                        var handles = withCenters.Where(w => w.dist > median * 10).Select(w => w.e.Handle.ToString()).ToList();
                        if (handles.Count > 0)
                        {
                            findings.Add(new DrawingCheckFindingDto
                            {
                                Check = "offExtents", Severity = "warning", Handles = handles,
                                Message = $"{handles.Count} entities sit far outside where the rest of the drawing is (possible typo)",
                            });
                        }
                    }
                }
            }

            return findings;
        }

        /// <summary>Grouping key for the `duplicates` check — null for kinds with no useful geometry signature (e.g. hatch).</summary>
        private static string? Signature(Entity e, int decimals)
        {
            string P(Point3d p) => $"{Math.Round(p.X, decimals)},{Math.Round(p.Y, decimals)},{Math.Round(p.Z, decimals)}";
            switch (e)
            {
                case Line l:
                    return string.Join("|", new[] { P(l.StartPoint), P(l.EndPoint) }.OrderBy(s => s));
                case Circle c:
                    return $"{P(c.Center)}@{Math.Round(c.Radius, decimals)}";
                case Arc a:
                    return $"{P(a.Center)}@{Math.Round(a.Radius, decimals)}:{Math.Round(a.StartAngle, decimals)}-{Math.Round(a.EndAngle, decimals)}";
                case Polyline pl:
                    var pts = Enumerable.Range(0, pl.NumberOfVertices).Select(i => P(pl.GetPoint3dAt(i)));
                    return string.Join("|", pts) + (pl.Closed ? ":closed" : "");
                case DBText t:
                    return $"{P(t.Position)}:{t.TextString}:{Math.Round(t.Height, decimals)}";
                case MText m:
                    return $"{P(m.Location)}:{m.Contents}:{Math.Round(m.TextHeight, decimals)}";
                case BlockReference br:
                    return $"{br.Name}@{P(br.Position)}";
                case RotatedDimension or AlignedDimension:
                    var b = e.Bounds;
                    return b.HasValue ? $"{P(b.Value.MinPoint)}|{P(b.Value.MaxPoint)}" : null;
                default:
                    return null;
            }
        }

        private static Regex GlobToRegex(string glob) =>
            new Regex("^" + Regex.Escape(glob).Replace("\\*", ".*") + "$", RegexOptions.IgnoreCase);
    }
}
