using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.RpcHandlers;

namespace CadAI.AutoCAD.Util
{
    public static class FloorplanInspector
    {
        /// <summary>
        /// The fail-closed verdict when the region walk hit its own time budget on a sheet too large
        /// to read in time. It carries NO bounds and NO rooms — a half-read region must never be
        /// offered as a frame the caller could design over — and it is distinct from "no such plan":
        /// <see cref="FloorplanInspectResult.StoppedReason"/> is what lets the Cloud tool say so.
        /// Pure so the contract is unit-testable without a live AutoCAD.
        /// </summary>
        internal static FloorplanInspectResult BudgetVerdict(double budgetSeconds) =>
            new FloorplanInspectResult
            {
                RegionBasis = "unresolved",
                StoppedReason = "budget",
                Note = string.Format(
                    CultureInfo.InvariantCulture,
                    "The floor-plan region walk exceeded its {0:0}s budget on this drawing and stopped without choosing a region. " +
                    "This is a read-size limit, not a missing title: do not retry with different wording. " +
                    "Narrow the sheet first (e.g. ask the user to isolate or freeze distant plans, or inspect a specific documentName).",
                    budgetSeconds)
            };

        private static BlockTableRecord? ResolveLayoutSpace(
            Transaction tr, Database db, string requestedName, out string actualName)
        {
            var layoutDict = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
            foreach (DBDictionaryEntry entry in layoutDict)
            {
                if (tr.GetObject(entry.Value, OpenMode.ForRead) is not Layout layout) continue;
                if (!layout.LayoutName.Equals(requestedName, StringComparison.OrdinalIgnoreCase)) continue;
                actualName = layout.LayoutName;
                return (BlockTableRecord)tr.GetObject(layout.BlockTableRecordId, OpenMode.ForRead);
            }
            actualName = requestedName;
            return null;
        }

        public static FloorplanInspectResult Inspect(
            Document doc, FloorplanInspectRequest request, CancellationToken ct, CancellationToken captureCt = default)
        {
            if (doc == null) throw new ArgumentNullException(nameof(doc));
            ct.ThrowIfCancellationRequested();

            var db = doc.Database;
            var result = new FloorplanInspectResult();
            // Identity + units + the coarse revision the region walk reflects, read from the same
            // locked database this inspect already holds. The caller feeds this to the CAD State
            // reconcile as the identity, which is why an inspect can reuse a snapshot without a
            // second drawing.info round trip (the 2-RPC gate). Read at walk start so the revision
            // pairs with the geometry read below.
            result.DocumentId = DocumentContext.IdOf(doc);
            result.Revision = CadStateHandlers.RevisionOf(db);
            result.FingerprintGuid = CadStateHandlers.FingerprintOf(db);
            result.Units = UnitFormat.FormatInsUnits(db.Insunits);
            var queryRaw = request.Name ?? string.Empty;
            var queryNorm = Normalize(queryRaw);

            using var tr = db.TransactionManager.StartTransaction();
            var requestedLayout = string.IsNullOrWhiteSpace(request.LayoutName) ? "Model" : request.LayoutName.Trim();
            var space = ResolveLayoutSpace(tr, db, requestedLayout, out var actualLayout);
            result.LayoutName = actualLayout;
            if (space == null)
            {
                result.RegionBasis = "unresolved";
                result.Note = $"layout '{requestedLayout}' was not found in this drawing";
                return result;
            }

            var candidateTitles = new List<(string Text, Point3d Position, Extents3d? Extents)>();
            var allEntities = new List<(ObjectId Id, Extents3d Extents, string Layer)>();
            // Two shapes the region decision needs, kept as plain doubles so the choice of frame is
            // testable without a live AutoCAD (FloorplanRegionTests): closed frames (a plan's own
            // border) and the raw strokes a plan is drawn from.
            var frameBoxes = new List<RegionBox>();
            var geometryBoxes = new List<RegionBox>();
            // Frames the CAD author supplied: a block reference whose NAME is a floor-plan title.
            // Its GeometricExtents is AutoCAD's own answer for what that insertion covers, so on a
            // drawing of one merged block per floor it groups the plan exactly as drawn. Only this
            // path qualifies — a caption found *inside* a block gets an anchor, never a frame, because
            // the enclosing insertion may be a wrapper around several plans.
            var planFrames = new List<PlanFrame>();

            foreach (ObjectId id in space)
            {
                ct.ThrowIfCancellationRequested();
                if (tr.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;

                // Safely read entity extents if available
                Extents3d? entExtents = null;
                try
                {
                    entExtents = entity.GeometricExtents;
                }
                catch
                {
                    // Ignore entities that cannot compute extents (e.g. empty text, ray, infinite xline)
                }

                if (entExtents.HasValue)
                {
                    allEntities.Add((id, entExtents.Value, entity.Layer));
                    if (entExtents.Value.IsUsableBox())
                        geometryBoxes.Add(entExtents.Value.ToRegionBox());
                }

                // A closed curve is a candidate frame: it is the only evidence that can bound a
                // plan to one title rather than the whole sheet.
                if (IsClosedFrame(entity) && entExtents.HasValue && entExtents.Value.IsUsableBox())
                    frameBoxes.Add(entExtents.Value.ToRegionBox());

                // Strokes inside a block carry the plan itself on drawings whose architecture is
                // one merged insertion; clustering the insertion's single bounding box could never
                // separate two plans, so the definition's curves are read and transformed too.
                if (entity is BlockReference nested)
                {
                    CollectBlockGeometry(tr, nested, nested.BlockTransform, frameBoxes, geometryBoxes, new HashSet<ObjectId>(), 0, ct);
                }

                // Collect text candidates for floor titles
                string? textContent = null;
                Point3d pos = Point3d.Origin;

                if (entity is DBText dbText)
                {
                    textContent = dbText.TextString;
                    pos = dbText.Position;
                }
                else if (entity is MText mtext)
                {
                    textContent = mtext.Text;
                    pos = mtext.Location;
                }
                else if (entity is BlockReference br)
                {
                    pos = br.Position;
                    var blockTitle = br.Name?.Trim();
                    // Only an insertion that IS a plan may title itself by its attributes. Measured
                    // on a live PCCC sheet: every device block (van CC, báo khói BC/CS, EX…) carries
                    // the SHEET name in an attribute, so joining attribute values produced 48 title
                    // candidates anchored at the device. One title query then matched ~50 names whose
                    // distinguishing tokens were device codes ("…TẦNG 1 - BC-02" vs "…TẦNG 1 -
                    // CC-02"), which are not nested plan names, so the matcher vetoed its own answer
                    // and returned found:false for plans that were on the sheet. The same anchors also
                    // polluted AvailableFloorplans (63 names for 10 plans) and every "does this frame
                    // hold another plan" test.
                    if (AttributeTextCanTitleThisPlan(blockTitle))
                    {
                        textContent = ReadBlockAttributes(tr, br);
                        if (!string.IsNullOrWhiteSpace(textContent))
                        {
                            var clean = textContent.Trim();
                            if (IsFloorplanTitleCandidate(clean))
                            {
                                candidateTitles.Add((clean, pos, entExtents));
                            }
                        }
                    }

                    // The block's own NAME is a title on drawings where each floor plan is one
                    // insertion named after the plan (SUNLAND: block "MẶT BẰNG TẦNG HẦM"). Attribute
                    // text and nested DBText both miss these, so the plan right in front of the
                    // matcher was reported as having no title at all. The anchor is the CENTER of the
                    // block's extents, not br.Position — a merged-plan block's insertion point can (and
                    // on SUNLAND does) land far outside the plan the block draws, and a point outside
                    // every frame cannot be attributed to one. The same IsFloorplanTitleCandidate
                    // filter guards anonymous/utility blocks (*D4, DIMTICK1, _ARCHTICK) becoming false
                    // titles.
                    if (!string.IsNullOrWhiteSpace(blockTitle) && IsFloorplanTitleCandidate(blockTitle))
                    {
                        var nameAnchor = entExtents.HasValue && entExtents.Value.IsUsableBox()
                            ? new Point3d(
                                (entExtents.Value.MinPoint.X + entExtents.Value.MaxPoint.X) / 2.0,
                                (entExtents.Value.MinPoint.Y + entExtents.Value.MaxPoint.Y) / 2.0,
                                0.0)
                            : pos;
                        if (entExtents.HasValue && entExtents.Value.IsUsableBox())
                        {
                            // One entry per INSERTION, deliberately not deduplicated by name: six
                            // copies of one plan on a sheet are six real places, and which one the
                            // caller wants is not the plugin's call.
                            planFrames.Add(new PlanFrame(Normalize(blockTitle), entExtents.Value.ToRegionBox()));
                        }
                        if (!candidateTitles.Any(c =>
                                c.Text.Equals(blockTitle, StringComparison.OrdinalIgnoreCase) &&
                                c.Position == nameAnchor))
                        {
                            candidateTitles.Add((blockTitle, nameAnchor, entExtents));
                        }
                    }

                    // Deep inspection: recursively extract floor title candidates from inside the block
                    ExtractTitleCandidatesFromBlock(tr, br, br.BlockTransform, candidateTitles, entExtents, 0, ct);
                }
                else if (!string.IsNullOrWhiteSpace(textContent))
                {
                    var clean = textContent.Trim();
                    if (IsFloorplanTitleCandidate(clean))
                    {
                        candidateTitles.Add((clean, pos, entExtents));
                    }
                }
            }

            // Deduplicate and populate AvailableFloorplans
            var distinctTitles = candidateTitles
                .Select(c => c.Text)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            result.AvailableFloorplans = distinctTitles;

            // Find best matching anchor for the user's query, then let the evidence decide which
            // rectangle that title owns. Two heuristics this replaces: clustering everything within
            // a hardcoded 60 m radius of the title (wrong on a tightly tiled sheet, or for a plan
            // larger than that), and falling back to db.Extmin/Extmax — the WHOLE drawing — which
            // silently inspected a frame belonging to no single plan. Every overlay drawn afterwards
            // would sit on that wrong frame, so an honest "cannot locate it" is the safer answer.
            var bestAnchor = FindBestAnchor(candidateTitles, queryNorm);
            double minX = double.NaN, minY = double.NaN, maxX = double.NaN, maxY = double.NaN;

            if (bestAnchor.HasValue)
            {
                result.Found = true;
                result.MatchedName = bestAnchor.Value.Text;
                var anchorPos = bestAnchor.Value.Position;

                // Every anchor except the one that was matched. Kept deliberately broad: a rectangle
                // that holds a SECOND INSTANCE of the same plan is just as unattributable as one that
                // holds a different plan's title, so tiers 1 and 3 must see sibling copies too. Only
                // the block-frame tier distinguishes them, because that is the tier that can name each
                // copy (regionCandidates); it excludes sibling centres from its wrapper test instead.
                var otherAnchors = candidateTitles
                    .Where(c => !(c.Text == bestAnchor.Value.Text && c.Position == bestAnchor.Value.Position))
                    .Select(c => new[] { c.Position.X, c.Position.Y })
                    .ToList();

                var decision = FloorplanRegion.Resolve(
                    new[] { anchorPos.X, anchorPos.Y }, otherAnchors, frameBoxes, geometryBoxes,
                    planFrames, Normalize(bestAnchor.Value.Text), request.CandidateIndex);

                if (decision.Verdict == RegionVerdict.Resolved && decision.Bounds is { Length: 4 } b)
                {
                    minX = b[0];
                    minY = b[1];
                    maxX = b[2];
                    maxY = b[3];
                    result.RegionBasis = decision.Basis;
                }
                else
                {
                    result.RegionBasis = decision.Verdict == RegionVerdict.NeedDisambiguation
                        ? "ambiguous"
                        : "unresolved";
                    result.Note = decision.Reason ??
                        $"the floor plan titled '{bestAnchor.Value.Text}' could not be bounded from the drawing's own geometry";
                    // When the sheet really does hold several copies of this plan, hand the caller the
                    // rectangles instead of a question: it picks one with candidateIndex, and no
                    // re-inspect is needed. Count > 0, not > 1: an out-of-range index comes back with
                    // whatever frames ARE usable, which can be exactly one, and a hint telling the
                    // caller to pick one must not be sent with the choices withheld.
                    if (decision.Candidates is { Count: > 0 } cands)
                        result.RegionCandidates = cands;
                }
            }
            else if (distinctTitles.Count > 0)
            {
                result.Note = $"no title in this drawing matches '{queryRaw}'. Floor plans found: {string.Join(" | ", distinctTitles)}";
            }

            if (!double.IsNaN(minX) && !double.IsNaN(maxX) && minX < maxX && minY < maxY)
            {
                // Add 5% visual margin so dimensions and boundary walls are not clipped at edges
                double spanX = maxX - minX;
                double spanY = maxY - minY;
                double padX = spanX * 0.05;
                double padY = spanY * 0.05;

                result.Bounds = new[]
                {
                    Math.Round(minX - padX, 2),
                    Math.Round(minY - padY, 2),
                    Math.Round(maxX + padX, 2),
                    Math.Round(maxY + padY, 2)
                };

                // Compute real-world dimensions mapped accurately to INSUNITS
                double rawW = maxX - minX;
                double rawH = maxY - minY;
                string units;
                switch (db.Insunits)
                {
                    case UnitsValue.Millimeters:
                        rawW /= 1000.0;
                        rawH /= 1000.0;
                        units = "m";
                        break;
                    case UnitsValue.Centimeters:
                        rawW /= 100.0;
                        rawH /= 100.0;
                        units = "m";
                        break;
                    case UnitsValue.Meters:
                        units = "m";
                        break;
                    case UnitsValue.Inches:
                        units = "in";
                        break;
                    case UnitsValue.Feet:
                        units = "ft";
                        break;
                    case UnitsValue.Yards:
                        units = "yd";
                        break;
                    default:
                        // Undefined (0) or custom units: if drawing extents clearly span thousands of units, treat as mm -> m
                        if (rawW > 500)
                        {
                            rawW /= 1000.0;
                            rawH /= 1000.0;
                            units = "m";
                        }
                        else
                        {
                            units = "units";
                        }
                        break;
                }

                result.Dimensions = new FloorplanDimensionsDto
                {
                    Width = Math.Round(rawW, 2),
                    Height = Math.Round(rawH, 2),
                    Units = units
                };

                // Collect layers and key room labels within this window
                var layersInWindow = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var roomLabels = new List<FloorplanRoomDto>();

                foreach (var item in allEntities)
                {
                    ct.ThrowIfCancellationRequested();
                    var b = item.Extents;
                    if (b.MaxPoint.X >= minX && b.MinPoint.X <= maxX &&
                        b.MaxPoint.Y >= minY && b.MinPoint.Y <= maxY)
                    {
                        layersInWindow.Add(item.Layer);

                        var ent = tr.GetObject(item.Id, OpenMode.ForRead) as Entity;
                        if (ent != null && roomLabels.Count < 100)
                        {
                            string? textVal = null;
                            Point3d textPos = Point3d.Origin;
                            if (ent is DBText dbt) { textVal = dbt.TextString; textPos = dbt.Position; }
                            else if (ent is MText mt) { textVal = mt.Text; textPos = mt.Location; }
                            else if (ent is BlockReference br)
                            {
                                // Deep inspection: unpack and read all text/rooms/layers nested inside this block
                                ExtractTextsAndLayersFromBlock(tr, br, br.BlockTransform, minX, minY, maxX, maxY, layersInWindow, roomLabels, 0, ct);
                            }

                            if (!string.IsNullOrWhiteSpace(textVal))
                            {
                                var clean = textVal.Trim();
                                if (IsRoomOrAreaLabel(clean) && !roomLabels.Any(r => r.Name.Equals(clean, StringComparison.OrdinalIgnoreCase) &&
                                                                                     Math.Abs(r.LabelPosition[0] - textPos.X) < 500 &&
                                                                                     Math.Abs(r.LabelPosition[1] - textPos.Y) < 500))
                                {
                                    roomLabels.Add(new FloorplanRoomDto
                                    {
                                        Name = clean,
                                        LabelPosition = new[] { Math.Round(textPos.X, 2), Math.Round(textPos.Y, 2) }
                                    });
                                }
                            }
                        }
                    }
                }

                result.Layers = layersInWindow.OrderBy(l => l).ToList();
                result.Rooms = roomLabels;

                var elevatorRooms = roomLabels.Where(r => IsElevatorLabel(r.Name)).ToList();
                if (elevatorRooms.Count > 0)
                {
                    result.Note = $"Auto-detected {elevatorRooms.Count} elevator shaft location(s): {string.Join(", ", elevatorRooms.Select(e => $"{e.Name} at [{e.LabelPosition[0]}, {e.LabelPosition[1]}]"))}.";
                }
            }

            tr.Commit();

            // Perform native off-screen capture if requested. A capture failure is data, not an
            // error: the CAD the same pass already read (bounds/rooms/layers) is what the caller
            // needs to keep working, so throwing here would reword-re-inspect a whole sheet over
            // one bad PNG. The render gets its OWN deadline (`captureCt`), never the walk's: the
            // walk is over and its result is worth returning even if the image never comes.
            if (request.Capture && result.Bounds != null && result.Bounds.Length == 4)
            {
                result.Capture = new FloorplanCaptureDto();
                if (!string.Equals(result.LayoutName, "Model", StringComparison.OrdinalIgnoreCase))
                {
                    result.Capture.Status = "failed";
                    result.Capture.Error = "Image capture currently supports model space only; layout geometry was read successfully.";
                    return result;
                }
                var capReq = new ViewCaptureRequest
                {
                    Window = new CaptureWindowDto
                    {
                        Min = new Point3dDto { X = result.Bounds[0], Y = result.Bounds[1] },
                        Max = new Point3dDto { X = result.Bounds[2], Y = result.Bounds[3] }
                    },
                    Width = request.Width ?? 1280,
                    Height = request.Height ?? 960
                };
                try
                {
                    var capRes = ViewCapture.Render(doc, capReq, captureCt);
                    result.Data = capRes.Data;
                    result.MimeType = capRes.MimeType;
                }
                catch (System.Exception ex)
                {
                    // Bounds/rooms/layers this pass already read stay valid; only the image is lost —
                    // including when the render itself was cancelled. The walk is finished here, so its
                    // data is complete: an OCE from the capture must never escape to the handler's
                    // budget path, which would replace the whole result with "unresolved" and no bounds
                    // (measured: the same frame resolved as block-frame in 3,3 s, then the ~29 s render
                    // blew the shared 30 s deadline and the answer was thrown away). Cancellation is
                    // reported like any other capture failure.
                    result.Capture.Status = "failed";
                    result.Capture.Error = ex.Message;
                    result.Data = null;
                    result.MimeType = null;
                }
            }

            return result;
        }

        /// <summary>An extents usable for comparison: AutoCAD leaves Extmin &gt; Extmax when there is
        /// nothing to bound, and a stray proxy can report non-finite coordinates.</summary>
        private static bool IsUsableBox(this Extents3d e) =>
            ViewFit.IsFinite(e.MinPoint) && ViewFit.IsFinite(e.MaxPoint) &&
            e.MinPoint.X <= e.MaxPoint.X && e.MinPoint.Y <= e.MaxPoint.Y;

        private static RegionBox ToRegionBox(this Extents3d e) =>
            new RegionBox(e.MinPoint.X, e.MinPoint.Y, e.MaxPoint.X, e.MaxPoint.Y);

        /// <summary>The box that CONTAINS a transformed box, over all four corners. Transforming only
        /// two opposite corners and re-min/maxing them under-estimates a rotated box, which silently
        /// drops real geometry out of the plan's region.</summary>
        private static RegionBox TransformBoxToWcs(this Extents3d e, Matrix3d xform)
        {
            double minX = double.MaxValue, minY = double.MaxValue;
            double maxX = double.MinValue, maxY = double.MinValue;
            foreach (var corner in new[]
            {
                new Point3d(e.MinPoint.X, e.MinPoint.Y, 0),
                new Point3d(e.MaxPoint.X, e.MinPoint.Y, 0),
                new Point3d(e.MinPoint.X, e.MaxPoint.Y, 0),
                new Point3d(e.MaxPoint.X, e.MaxPoint.Y, 0)
            })
            {
                var p = corner.TransformBy(xform);
                minX = Math.Min(minX, p.X);
                minY = Math.Min(minY, p.Y);
                maxX = Math.Max(maxX, p.X);
                maxY = Math.Max(maxY, p.Y);
            }
            return new RegionBox(minX, minY, maxX, maxY);
        }

        /// <summary>A closed curve can bound a plan; an open stroke soup cannot.</summary>
        private static bool IsClosedFrame(Entity entity) =>
            (entity is Polyline pl && pl.Closed) ||
            (entity is Polyline2d p2 && p2.Closed);

        /// <summary>
        /// Read the curves inside a block insertion, transformed into WCS, so a drawing whose
        /// architecture is one merged block still yields per-stroke geometry. Bounding boxes of a
        /// block reference alone cannot separate two plans; the definition's strokes can.
        /// </summary>
        private static void CollectBlockGeometry(
            Transaction tr,
            BlockReference br,
            Matrix3d currentXform,
            List<RegionBox> frameBoxes,
            List<RegionBox> geometryBoxes,
            HashSet<ObjectId> visited,
            int depth,
            CancellationToken ct)
        {
            // A block definition that references itself would recurse forever; the visited set is
            // per-insertion, so the same definition appearing twice in the sheet is still read.
            if (depth > 3 || !visited.Add(br.BlockTableRecord)) return;
            try
            {
                if (tr.GetObject(br.BlockTableRecord, OpenMode.ForRead) is not BlockTableRecord btr) return;
                foreach (ObjectId innerId in btr)
                {
                    ct.ThrowIfCancellationRequested();
                    if (tr.GetObject(innerId, OpenMode.ForRead) is not Entity innerEnt) continue;

                    if (innerEnt is BlockReference nestedBr)
                    {
                        // setToProduct order: the innermost transform is applied to the entity's own
                        // coordinates first, so the parent's accumulated map goes on the LEFT.
                        CollectBlockGeometry(
                            tr, nestedBr, currentXform * nestedBr.BlockTransform,
                            frameBoxes, geometryBoxes, visited, depth + 1, ct);
                        continue;
                    }

                    Extents3d local;
                    try
                    {
                        local = innerEnt.GeometricExtents;
                    }
                    catch (OperationCanceledException)
                    {
                        throw;
                    }
                    catch
                    {
                        continue;
                    }
                    if (!local.IsUsableBox()) continue;

                    // All four corners: a rotated block's axis-aligned box is not spanned by two
                    // opposite corners, and under-estimating it drops real geometry out of the region.
                    var box = TransformBoxToWcs(local, currentXform);
                    if (!box.IsFinite) continue;

                    geometryBoxes.Add(box);
                    if (IsClosedFrame(innerEnt)) frameBoxes.Add(box);
                }
            }
            catch (OperationCanceledException)
            {
                // The walk's own budget / the caller disconnecting MUST propagate: a bare `catch`
                // here swallowed it, so the 30 s budget never stopped a large sheet and the main
                // thread stayed inside the transaction long past the caller's timeout.
                throw;
            }
            catch
            {
                // A definition that cannot be read is missing evidence, never a reason to guess.
            }
            finally
            {
                visited.Remove(br.BlockTableRecord);
            }
        }

        internal static (string Text, Point3d Position, Extents3d? Extents)? FindBestAnchor(
            List<(string Text, Point3d Position, Extents3d? Extents)> candidates,
            string queryNorm)
        {
            if (candidates.Count == 0) return null;
            if (string.IsNullOrWhiteSpace(queryNorm)) return candidates[0];

            // Specific keywords for basement (hầm)
            bool isBasementQuery = queryNorm.Contains("ham") || queryNorm.Contains("basement") || queryNorm.Contains("b1");
            if (isBasementQuery)
            {
                var match = candidates.FirstOrDefault(c =>
                {
                    var n = Normalize(c.Text);
                    return n.Contains("ham") || n.Contains("basement") || n.Contains("b1");
                });
                if (!string.IsNullOrEmpty(match.Text)) return match;
            }

            // Whole-token containment, not substring: "tầng 1" is a token sequence of
            // "MẶT BẰNG TẦNG 1" but only a fragment of "MẶT BẰNG TẦNG 10". Measured on a live sheet,
            // the old substring rule plus model-space order made a query for one floor silently
            // resolve to a different floor, and the block-frame tier then rendered that guess as a
            // confident `block-frame` result instead of the `ambiguous` it used to be.
            var queryTokens = Tokenize(queryNorm);
            var matches = candidates
                .Where(c => queryTokens.Count > 0 && Tokenize(Normalize(c.Text)).IsSupersetOf(queryTokens))
                .ToList();

            var distinctNames = matches
                .Select(c => Normalize(c.Text))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            // Different, non-comparable plan names tie → say so by returning no anchor. The caller
            // then gets found:false plus AvailableFloorplans, an honest "which one do you mean".
            //
            // Names that nest into one another are NOT a contradiction: "TẦNG 1" (a caption) and
            // "MẶT BẰNG TẦNG 1" (a block name) name the same floor. Treating that as ambiguous was
            // measured live and broke every short query — "tầng 1", "tầng 2" and "mái" all returned
            // found:false on a sheet that has those plans, because each matched both a caption and a
            // block name. Only genuinely different plans (different distinguishing tokens) are
            // ambiguous.
            if (distinctNames.Count > 1 && HasGenuinelyDifferentPlan(matches)) return null;

            // Among the names that matched, prefer the most specific: a longer token set pins the
            // floor more precisely than a bare caption that happens to contain it. No explicit
            // index tie-break: OrderByDescending is a stable sort, so equal-length names keep
            // model-space order, and asking for an index would compare tuples containing Point3d,
            // whose AcMgd members throw InvalidProgramException outside a live AutoCAD.
            var direct = matches
                .OrderByDescending(c => Tokenize(Normalize(c.Text)).Count)
                .FirstOrDefault();
            if (!string.IsNullOrEmpty(direct.Text)) return direct;

            // Token overlap match, unchanged in intent, but only accepted when it is unambiguous for
            // the same reason.
            var ranked = candidates
                .Select(c => new
                {
                    Item = c,
                    Score = queryTokens.Count(t => Normalize(c.Text).Contains(t))
                })
                .Where(r => r.Score > 0)
                .OrderByDescending(r => r.Score)
                .ToList();
            var bestScore = ranked.Count > 0 ? ranked[0].Score : 0;
            var topNames = ranked.Where(r => r.Score == bestScore)
                .Select(r => Normalize(r.Item.Text))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (topNames.Count > 1 &&
                HasGenuinelyDifferentPlan(ranked.Where(r => r.Score == bestScore).Select(r => r.Item)))
                return null;

            return ranked.FirstOrDefault()?.Item;
        }

        private static readonly char[] TokenSeparators = { ' ', '-', '_' };

        private static HashSet<string> Tokenize(string normalized) =>
            new HashSet<string>(
                (normalized ?? string.Empty).Split(TokenSeparators, StringSplitOptions.RemoveEmptyEntries),
                StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Do two candidate names disagree about which plan they name? Names that nest ("TẦNG 1"
        /// inside "MẶT BẰNG TẦNG 1") are the same floor stated at different lengths, so they are not
        /// a contradiction. Names that neither contains the other ("TẦNG 1" vs "TẦNG 2", or
        /// "TẦNG HẦM" vs "TẦNG 1") are different plans, and a query that matches both cannot be
        /// answered without guessing.
        /// </summary>
        internal static bool AreDifferentPlans(string a, string b)
        {
            HashSet<string> ta = Tokenize(a);
            HashSet<string> tb = Tokenize(b);
            if (ta.SetEquals(tb)) return false;
            return !ta.IsSupersetOf(tb) && !tb.IsSupersetOf(ta);
        }

        private static bool HasGenuinelyDifferentPlan(
            IEnumerable<(string Text, Point3d Position, Extents3d? Extents)> matches)
        {
            var names = matches.Select(c => Normalize(c.Text)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            for (int i = 0; i < names.Count; i++)
                for (int j = i + 1; j < names.Count; j++)
                    if (AreDifferentPlans(names[i], names[j])) return true;
            return false;
        }

        // internal (not private) so FloorplanRegionTests pins that the block-NAME title path (E11)
        // cannot turn utility/anonymous blocks (DIMTICK1, _ARCHTICK, *D4) into floor-plan titles —
        // the same filter every other title source already routes through.
        //
        // Candidacy does not depend on the query. Measured on a live sheet, the old
        // "text contains the query" branch promoted whatever the user happened to ask for: the
        // company name "CÔNG TY TNHH ĐẦU TƯ VÀ THƯƠNG MẠI SUNLAND VIỆT NAM" (THƯƠNG MẠI folds to the
        // token "mai") became a floor plan for the query "mái", and an arrow caption "Hướng ống đi
        // lên tầng 1" became one for "tầng 1". A promoted non-title then vetoes the real title, so
        // inspect returns found:false for a plan that is plainly on the sheet. What names a plan is
        // the drawing's own wording, not the question being asked.
        internal static bool IsFloorplanTitleCandidate(string? text)
        {
            if (text is not { Length: >= 3 and <= 100 }) return false;
            return IsPlanNamed(Normalize(text));
        }

        /// <summary>
        /// Does this text NAME a floor plan, i.e. does it begin with the plan-family wording? A
        /// substring test is not enough: "Hướng ống đi lên tầng 1" (an arrow caption) contains the
        /// marker, and "…THƯƠNG MẠI…" contains "mai" — both were promoted on a live sheet, and a
        /// promoted non-title vetoes the real one, turning an existing plan into found:false.
        ///
        /// Every real title on both measured sheets starts with its marker ("MẶT BẰNG TẦNG 1",
        /// "MẶT BẰNG MÁI", "MẶT BẰNG SÂN THƯỢNG"), so the prefix rule costs nothing there. Tradeoff:
        /// a plan introduced as "SƠ ĐỒ TẦNG 1" or "TẦNG 1 – MẶT BẰNG PCCC" after a leading word is no
        /// longer recognized; it comes back as found:false plus the titles that were recognized.
        /// </summary>
        private static bool IsPlanNamed(string norm)
        {
            // char[] overload, not Split(char, StringSplitOptions): the latter is .NET Core 2.0+ and
            // does not compile on net48, while plugin.Tests builds the plugin for net8.0 and stays
            // green. Measured: a net8-green commit produced a net48 CS1503 and a stale DLL got
            // deployed as if it were current.
            string[] t = (norm ?? string.Empty).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            bool Pair(string a, string b) => t.Length > 1 && t[0] == a && t[1] == b;
            return t.Length > 0 && (
                Pair("mat", "bang") ||
                Pair("floor", "plan") ||
                Pair("san", "thuong") ||
                t[0] == "tang" ||
                t[0] == "floor" ||
                t[0] == "basement" ||
                t[0] == "plan");
        }

        /// <summary>
        /// May this insertion's ATTRIB text act as a floor-plan title? Only when the insertion's own
        /// NAME is already a plan title, i.e. the block IS a plan (SUNLAND: "MẶT BẰNG TẦNG HẦM").
        ///
        /// Structural check, deliberately independent of the query: passing queryNorm would let a
        /// device block named after the queried floor qualify, which is the leak being closed.
        ///
        /// Measured on a live PCCC sheet: every device insertion (van CC, đầu báo BC/CS, EXIT EX…)
        /// stores the SHEET name in a TEN-BAN-VE-1 attribute, so joining attribute values created 48
        /// title candidates anchored at the device. Consequences, all observed: AvailableFloorplans
        /// listed 63 names for 10 plans; one query matched ~50 names whose distinguishing tokens were
        /// device codes ("…TẦNG 1 - BC-02" vs "…TẦNG 1 - CC-02"), which do not nest, so the matcher
        /// vetoed its own answer and returned found:false for plans plainly on the sheet; and every
        /// frame looked like it "contains other floor-plan titles" because device anchors sit inside
        /// the frames.
        ///
        /// Cost: a plan block whose name is not plan-like (e.g. "PLAN-01") and whose only title lives
        /// in attributes loses that title source. Its real title text is normally a DBText/MText
        /// inside the definition, which ExtractTitleCandidatesFromBlock still finds, so the fallback
        /// stays reachable.
        /// </summary>
        internal static bool AttributeTextCanTitleThisPlan(string? blockName) =>
            IsFloorplanTitleCandidate(blockName);

        private static bool IsRoomOrAreaLabel(string text)
        {
            if (text.Length < 2 || text.Length > 50) return false;
            // Filter out plain numbers, scale factors, coordinates, dimensions
            if (double.TryParse(text.Replace(",", "."), NumberStyles.Any, CultureInfo.InvariantCulture, out _))
                return false;
            if (text.StartsWith("%%") || text.StartsWith("1:") || text.StartsWith("R=")) return false;

            var norm = Normalize(text);
            return norm.Contains("phong") ||
                   norm.Contains("gara") ||
                   norm.Contains("xe") ||
                   norm.Contains("be nuoc") ||
                   norm.Contains("thang") ||
                   norm.Contains("bep") ||
                   norm.Contains("wc") ||
                   norm.Contains("kho") ||
                   norm.Contains("sanh") ||
                   norm.Contains("dien") ||
                   norm.Contains("room") ||
                   norm.Contains("lobby") ||
                   norm.Contains("exit") ||
                   norm.Contains("ramp") ||
                   norm.Contains("doc");
        }

        private static string? ReadBlockAttributes(Transaction tr, BlockReference br)
        {
            var parts = new List<string>();
            foreach (var att in ReadAttributeReferences(tr, br))
            {
                parts.Add(att.Text);
            }
            return parts.Count == 0 ? null : string.Join(" - ", parts);
        }

        /// <summary>
        /// The ATTRIB entities attached to one block insertion. A room label placed as an attribute
        /// lives on the <see cref="BlockReference"/>, NOT inside its definition, so a walk over the
        /// BlockTableRecord never sees it. Positions are already world coordinates: an ATTRIB is a
        /// database-resident entity in model space, not a definition-local one.
        /// </summary>
        internal static List<(string Text, Point3d Position)> ReadAttributeReferences(Transaction tr, BlockReference br)
        {
            var found = new List<(string, Point3d)>();
            foreach (ObjectId attId in br.AttributeCollection)
            {
                if (tr.GetObject(attId, OpenMode.ForRead) is not AttributeReference att) continue;
                var clean = (att.TextString ?? string.Empty).Trim();
                if (clean.Length > 0) found.Add((clean, att.Position));
            }
            return found;
        }

        public static string Normalize(string input)
        {
            if (string.IsNullOrWhiteSpace(input)) return string.Empty;
            var formD = input.Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder();
            foreach (var ch in formD)
            {
                var uc = CharUnicodeInfo.GetUnicodeCategory(ch);
                if (uc != UnicodeCategory.NonSpacingMark)
                {
                    sb.Append(char.ToLowerInvariant(ch));
                }
            }
            return sb.ToString().Normalize(NormalizationForm.FormC).Trim();
        }

        private static bool IsElevatorLabel(string text)
        {
            var norm = Normalize(text);
            return norm.Contains("thang") || norm.Contains("elevator") || norm.Contains("lift");
        }

        private static void ExtractTitleCandidatesFromBlock(
            Transaction tr,
            BlockReference br,
            Matrix3d currentXform,
            List<(string Text, Point3d Position, Extents3d? Extents)> candidateTitles,
            Extents3d? brExtents,
            int depth,
            CancellationToken ct)
        {
            if (depth > 2) return;
            try
            {
                if (tr.GetObject(br.BlockTableRecord, OpenMode.ForRead) is not BlockTableRecord btr) return;
                foreach (ObjectId innerId in btr)
                {
                    ct.ThrowIfCancellationRequested();
                    if (tr.GetObject(innerId, OpenMode.ForRead) is not Entity innerEnt) continue;

                    string? text = null;
                    Point3d localPos = Point3d.Origin;

                    if (innerEnt is DBText dbt)
                    {
                        text = dbt.TextString;
                        localPos = dbt.Position;
                    }
                    else if (innerEnt is MText mt)
                    {
                        text = mt.Text;
                        localPos = mt.Location;
                    }
                    if (innerEnt is BlockReference nestedBr)
                    {
                        // Right-most matrix applies first to the point, so the accumulated
                        // parent map goes on the LEFT (see CollectBlockGeometry).
                        var nestedXform = currentXform * nestedBr.BlockTransform;
                        ExtractTitleCandidatesFromBlock(tr, nestedBr, nestedXform, candidateTitles, brExtents, depth + 1, ct);
                        continue;
                    }

                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        var clean = text.Trim();
                        if (IsFloorplanTitleCandidate(clean))
                        {
                            var worldPos = localPos.TransformBy(currentXform);
                            candidateTitles.Add((clean, worldPos, brExtents));
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                throw; // budget / caller gone: must not be swallowed by the nested-read catch below
            }
            catch
            {
                // Ignore nested block read errors
            }
        }

        private static void ExtractTextsAndLayersFromBlock(
            Transaction tr,
            BlockReference br,
            Matrix3d currentXform,
            double minX, double minY, double maxX, double maxY,
            HashSet<string> layersInWindow,
            List<FloorplanRoomDto> roomLabels,
            int depth,
            CancellationToken ct)
        {
            if (depth > 3) return;
            try
            {
                if (tr.GetObject(br.BlockTableRecord, OpenMode.ForRead) is not BlockTableRecord btr) return;
                foreach (ObjectId innerId in btr)
                {
                    ct.ThrowIfCancellationRequested();
                    if (roomLabels.Count >= 100) break;
                    if (tr.GetObject(innerId, OpenMode.ForRead) is not Entity innerEnt) continue;

                    var effLayer = string.Equals(innerEnt.Layer, "0", StringComparison.OrdinalIgnoreCase)
                        ? br.Layer
                        : innerEnt.Layer;
                    if (!string.IsNullOrWhiteSpace(effLayer))
                    {
                        layersInWindow.Add(effLayer);
                    }

                    string? text = null;
                    Point3d localPos = Point3d.Origin;

                    if (innerEnt is DBText dbt)
                    {
                        text = dbt.TextString;
                        localPos = dbt.Position;
                    }
                    else if (innerEnt is MText mt)
                    {
                        text = mt.Text;
                        localPos = mt.Location;
                    }
                    if (innerEnt is BlockReference nestedBr)
                    {
                        // Right-most matrix applies first to the point, so the accumulated
                        // parent map goes on the LEFT (see CollectBlockGeometry).
                        var nestedXform = currentXform * nestedBr.BlockTransform;
                        ExtractTextsAndLayersFromBlock(tr, nestedBr, nestedXform, minX, minY, maxX, maxY, layersInWindow, roomLabels, depth + 1, ct);
                        continue;
                    }

                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        var clean = text.Trim();
                        if (IsRoomOrAreaLabel(clean))
                        {
                            var worldPos = localPos.TransformBy(currentXform);
                            if (worldPos.X >= minX && worldPos.X <= maxX &&
                                worldPos.Y >= minY && worldPos.Y <= maxY)
                            {
                                if (!roomLabels.Any(r => r.Name.Equals(clean, StringComparison.OrdinalIgnoreCase) &&
                                                         Math.Abs(r.LabelPosition[0] - worldPos.X) < 500 &&
                                                         Math.Abs(r.LabelPosition[1] - worldPos.Y) < 500))
                                {
                                    roomLabels.Add(new FloorplanRoomDto
                                    {
                                        Name = clean,
                                        LabelPosition = new[] { Math.Round(worldPos.X, 2), Math.Round(worldPos.Y, 2) }
                                    });
                                }
                            }
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                throw; // budget / caller gone: never swallow it as a "nested read error"
            }
            catch
            {
                // Ignore nested block read errors
            }
        }
    }
}
