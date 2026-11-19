using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Journal;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    public sealed class EntityHandlers
    {
        /// <summary>
        /// Hard cap on entity.list's <c>limit</c> (#10), mirroring
        /// contracts/mcp-tools's entityListParams.limit.max(). Requests above this throw
        /// InvalidGeometry rather than silently clamping, matching layer.ensure's MaxEnsureLayers.
        /// </summary>
        private const int MaxListLimit = 1000;

        [JsonRpcMethod("entity.create", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityCreateResult> Create(CreateEntityRequest request, CancellationToken ct = default) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                return Idempotency.WithCache(doc.Name, request.IdempotencyKey, request, () =>
                {
                    using (doc.LockDocument())
                    {
                        var db = doc.Database;
                        using var tr = db.TransactionManager.StartTransaction();
                        try
                        {
                            var entity = CreateOne(tr, db, request, doc.Name);
                            var result = new EntityCreateResult { Entity = entity };
                            tr.Commit();
                            ScreenRefresh.AfterCommit(doc);
                            LiveView.FollowAfterMutation(doc, new List<EntityRefDto> { entity }, request.View);
                            return result;
                        }
                        catch (LocalRpcException)
                        {
                            throw;
                        }
                        catch (Exception ex)
                        {
                            throw PluginExceptions.TransactionFailed(ex);
                        }
                    }
                });
            }, ct);

        /// <summary>
        /// Builds and appends one entity from <paramref name="request"/> inside an already-open
        /// transaction. Caller owns locking/commit/rollback — used both by the single-op
        /// <see cref="Create"/> RPC and by <c>OperationsHandlers.Apply</c>'s batch transaction.
        /// </summary>
        internal static EntityRefDto CreateOne(Transaction tr, Database db, CreateEntityRequest request, string documentName)
        {
            var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            var layerName = ResolveLayerName(request.Layer, lt, tr, db);
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);

            if (request.Kind == "hatch")
            {
                var hatch = BuildHatch(tr, db, ms, request);
                hatch.Layer = layerName;
                if (Annotation.Resolve(request.Annotative, documentName)) Annotation.Mark(db, hatch);
                return new EntityRefDto { Handle = hatch.Handle.ToString(), Kind = request.Kind, Layer = layerName };
            }

            var entity = BuildEntity(tr, request, bt, db, documentName);
            entity.Layer = layerName;
            ms.AppendEntity(entity);
            tr.AddNewlyCreatedDBObject(entity, true);
            EntityOwnership.Stamp(tr, entity);
            if (IsAnnotationCapable(request.Kind) && Annotation.Resolve(request.Annotative, documentName))
            {
                Annotation.Mark(db, entity);
            }

            if (request.Kind == "blockReference" && entity is BlockReference br)
            {
                ApplyBlockAttributes(tr, br, request.Attributes);
            }

            return new EntityRefDto { Handle = entity.Handle.ToString(), Kind = request.Kind, Layer = layerName };
        }

        /// <summary>
        /// Builds and appends one entity from <paramref name="request"/> into ANY block table record
        /// (not just ModelSpace) inside an already-open transaction. Used by
        /// <see cref="BlockHandlers.EnsureDefinition"/> (Slice 06 of specs/pccc-cad-drawing-truth/) to
        /// build a block definition straight from inline entity geometry — no source DWG ever opens.
        /// Caller owns the transaction/commit/lock; deliberately skips the layer resolution, stamping,
        /// and annotation marking <see cref="CreateOne"/> does, because entities inside a definition
        /// draw on layer "0" by AutoCAD convention and take their visible layer/color from the
        /// insertion, and CadAI ownership tracking is about erasable model-space content, not
        /// definition-internal geometry that never exists outside a block.
        /// </summary>
        internal static void AppendEntityToBlock(
            Transaction tr, Database db, BlockTableRecord target, CreateEntityRequest request, string documentName)
        {
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            if (request.Kind == "hatch")
            {
                var hatch = BuildHatch(tr, db, target, request);
                target.AppendEntity(hatch);
                tr.AddNewlyCreatedDBObject(hatch, true);
                return;
            }
            var entity = BuildEntity(tr, request, bt, db, documentName);
            target.AppendEntity(entity);
            tr.AddNewlyCreatedDBObject(entity, true);
        }

        /// <summary>Kinds that support <see cref="Entity.Annotative"/> + the annotation-scale object context (#74).</summary>
        private static bool IsAnnotationCapable(string kind) =>
            kind is "mtext" or "text.singleLine" or "dimension.linear" or "dimension.aligned" or "dimension.ordinate";

        [JsonRpcMethod("entity.list", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityListResult> List(EntityListRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var limit = request.Limit <= 0 ? 100 : request.Limit;
                if (limit > MaxListLimit)
                {
                    throw PluginExceptions.InvalidGeometry(
                        $"entity.list accepts a limit of at most {MaxListLimit} entities per call (got {limit}).");
                }
                var offset = request.Offset < 0 ? 0 : request.Offset;
                var includeBounds = request.IncludeBounds ?? true;
                var fullDetail = request.Detail == "full";
                // Cheap pre-filter (#10): only entities whose DXF class could possibly resolve to
                // the requested kind (see EntityKindResolver.DxfNameCandidates) are opened at all.
                var dxfNameCandidates = request.Kind != null ? EntityKindResolver.DxfNameCandidates(request.Kind) : null;

                var db = DocumentContext.ResolveDatabase(request.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);

                // Single pass in model-space order: total counts every match, but ToSummary/ToDetail
                // (which open entity.Bounds — the expensive part, see #10) only run for
                // entities that land on the returned page. Never materializes a List<> of
                // summaries for the whole drawing.
                //
                // `window` (region query): entities whose bounds miss the rectangle are skipped
                // before counting, so `total` means "matches the filters" — a region query reads
                // as its own count, not a whole-drawing one. Bounds is only opened for entities
                // that already passed the cheap DXF-class/layer/kind pre-filters.
                var window = request.Window;
                var page = new List<object>();
                var total = 0;
                foreach (ObjectId id in ms)
                {
                    if (dxfNameCandidates != null && !dxfNameCandidates.Contains(id.ObjectClass.DxfName))
                    {
                        continue;
                    }

                    var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                    if (request.Layer != null && entity.Layer != request.Layer)
                    {
                        continue;
                    }
                    if (request.Kind != null && EntityKindResolver.KindOf(entity) != request.Kind)
                    {
                        continue;
                    }
                    if (window != null && !IntersectsWindow(entity, window))
                    {
                        continue;
                    }

                    var matchIndex = total;
                    total++;
                    if (matchIndex >= offset && page.Count < limit)
                    {
                        page.Add(fullDetail ? (object)ToDetail(tr, entity, includeBounds) : ToSummary(entity, includeBounds));
                    }
                }

                tr.Commit();
                return new EntityListResult { Entities = page, Total = total };
            });

        /// <summary>
        /// entity.list's `window` filter: true when the entity's extents intersect the rectangle.
        /// <c>Entity.GeometricExtents</c> throws on some kinds (e.g. certain annotation/proxy
        /// objects — <c>eNotImplementedYet</c>), so an unmeasurable entity is INCLUDED rather than
        /// silently dropped: a region query must never hide entities it couldn't measure. Same
        /// catch idiom as <c>Util/ViewCapture.cs</c>'s handles-extents union.
        /// </summary>
        private static bool IntersectsWindow(Entity entity, WindowDto window)
        {
            Extents3d extents;
            try { extents = entity.GeometricExtents; }
            catch (Autodesk.AutoCAD.Runtime.Exception) { return true; }
            return extents.MinPoint.X <= window.Max.X && extents.MaxPoint.X >= window.Min.X
                && extents.MinPoint.Y <= window.Max.Y && extents.MaxPoint.Y >= window.Min.Y;
        }

        [JsonRpcMethod("entity.get", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityGetResult> Get(EntityGetRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var db = DocumentContext.ResolveDatabase(request.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                if (!HandleConvert.TryResolve(db, request.Handle, out var id))
                {
                    throw PluginExceptions.EntityNotFound(request.Handle);
                }
                var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                var full = request.Detail == "full";
                object result = full ? ToDetail(tr, entity) : ToSummary(entity);
                tr.Commit();
                return new EntityGetResult
                {
                    Entity = result,
                    // #413 phase B: same bounds-free digest operations.apply recomputes.
                    StateDigest = full ? Edits.PreImageCanonical.HashDetail((EntityDetailDto)result) : null,
                };
            });

        /// <summary>
        /// Read-only native area/perimeter measurement (<c>entity.areaMeasure</c>). Every number comes
        /// from AutoCAD's own geometry engine — <c>Polyline.Area</c>/<c>Curve.Area</c> for closed
        /// curves, <c>Circle.Area</c>, <c>Hatch.Area</c> (which already nets its holes out),
        /// <c>Region.Area</c>/<c>Region.Perimeter</c>. It never estimates an area from a text dump or a
        /// bounding box, and it never converts to m² unless the drawing declares usable INSUNITS —
        /// a unitless drawing reports <c>insUnits: "unitless"</c> with no <c>areaM2</c> at all.
        /// Scope is first-match-wins: <c>handles</c> (fast path: opens exactly those entities, never
        /// scans model space), else <c>selection: "implied"</c> (the user's current pick), else
        /// <c>window</c>.
        /// </summary>
        [JsonRpcMethod("entity.areaMeasure", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityAreaMeasureResult> MeasureArea(EntityAreaMeasureRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                var db = doc.Database;
                var wantsImplied = request.Selection == "implied";
                if (wantsImplied && !ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument))
                {
                    throw PluginExceptions.InvalidOperation(
                        "entity.areaMeasure selection:\"implied\" needs the active document — a background tab has no selection set.");
                }
                if (request.Handles.Count == 0 && !wantsImplied && request.Window == null)
                {
                    throw PluginExceptions.InvalidGeometry(
                        "entity.areaMeasure needs a scope: handles, selection:\"implied\", or window.");
                }

                var insUnitsValue = db.Insunits;
                var wantM2 = request.OutputUnit == "m2";

                // (candidate, its ObjectId) pairs: the ObjectId is only needed here, to flag a
                // polyline that is some measured hatch's own associative boundary.
                var measured = new List<(AreaMeasure.Candidate Candidate, ObjectId Id)>();
                var hatchHandleByBoundaryId = new Dictionary<ObjectId, string>();

                using var tr = db.TransactionManager.StartTransaction();
                if (request.Handles.Count > 0)
                {
                    foreach (var handle in request.Handles)
                    {
                        if (!HandleConvert.TryResolve(db, handle, out var id) || id.IsErased)
                        {
                            throw PluginExceptions.EntityNotFound(handle);
                        }
                        MeasureOne(tr, (Entity)tr.GetObject(id, OpenMode.ForRead), false, measured, hatchHandleByBoundaryId);
                    }
                }
                else if (wantsImplied)
                {
                    var implied = doc.Editor.SelectImplied();
                    if (implied.Status == PromptStatus.OK && implied.Value != null)
                    {
                        foreach (var id in implied.Value.GetObjectIds())
                        {
                            MeasureOne(tr, (Entity)tr.GetObject(id, OpenMode.ForRead), true, measured, hatchHandleByBoundaryId);
                        }
                    }
                }
                else
                {
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                    foreach (ObjectId id in ms)
                    {
                        var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                        if (!IntersectsWindow(entity, request.Window!))
                        {
                            continue;
                        }
                        MeasureOne(tr, entity, true, measured, hatchHandleByBoundaryId);
                    }
                }
                tr.Commit();

                // A closed polyline that IS a measured hatch's associative boundary is the same
                // region counted twice. Flag it rather than silently dropping it, so the caller can
                // see why the parts don't add up to the whole.
                foreach (var (candidate, id) in measured)
                {
                    if (candidate.Outcome == AreaMeasure.Outcome.Measured
                        && candidate.BoundaryOfHandle == null
                        && hatchHandleByBoundaryId.TryGetValue(id, out var ownerHandle)
                        && ownerHandle != candidate.Handle)
                    {
                        candidate.BoundaryOfHandle = ownerHandle;
                    }
                }

                var regions = AreaMeasure.Build(
                    measured.Select(pair => pair.Candidate).ToList(),
                    UnitFormat.SquareMetersPerUnitSquared(insUnitsValue),
                    wantM2,
                    out var skippedNonAreaCount,
                    out var convertedToM2);

                return new EntityAreaMeasureResult
                {
                    DocumentId = DocumentContext.IdOf(doc),
                    DocumentName = doc.Name,
                    Revision = $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}",
                    InsUnits = UnitFormat.FormatInsUnits(insUnitsValue),
                    ConvertedToM2 = convertedToM2,
                    Regions = regions.ToList(),
                    SkippedNonAreaCount = skippedNonAreaCount,
                };
            });

        /// <summary>
        /// Reads one entity's area from AutoCAD's own properties and appends the raw outcome.
        /// <paramref name="regionScope"/> marks a scan (window/implied) rather than an explicit handle:
        /// a line/arc matched by a region query is reported <c>ambiguous_region</c> ("which region was
        /// meant?"), while one named directly is simply <c>open_boundary</c>.
        /// </summary>
        private static void MeasureOne(
            Transaction tr,
            Entity entity,
            bool regionScope,
            List<(AreaMeasure.Candidate Candidate, ObjectId Id)> measured,
            Dictionary<ObjectId, string> hatchHandleByBoundaryId)
        {
            var candidate = new AreaMeasure.Candidate
            {
                Handle = entity.Handle.ToString(),
                Kind = EntityKindResolver.KindOf(entity),
                Layer = entity.Layer,
            };

            if (entity is Hatch hatch)
            {
                // Hatch.Area is already the net of every loop (outer minus holes) — that is the whole
                // reason a hatched room is the cheapest correct answer.
                candidate.Outcome = ReadArea(() => hatch.Area, candidate, "hatch");
                try
                {
                    candidate.LoopCount = hatch.NumberOfLoops;
                    candidate.HoleLoopCount = CountHatchHoles(hatch);
                }
                catch (Autodesk.AutoCAD.Runtime.Exception)
                {
                    // Loop bookkeeping is diagnostic only; a refusal there must not lose the area.
                }
                if (hatch.Associative)
                {
                    try
                    {
                        foreach (ObjectId boundaryId in hatch.GetAssociatedObjectIds())
                        {
                            hatchHandleByBoundaryId[boundaryId] = candidate.Handle;
                        }
                    }
                    catch (Autodesk.AutoCAD.Runtime.Exception)
                    {
                        // No association map → the overlap just goes unflagged, never a wrong number.
                    }
                }
            }
            else if (entity is Region region)
            {
                candidate.Outcome = ReadArea(() => region.Area, candidate, "region");
                candidate.Perimeter = ReadLength(() => region.Perimeter);
            }
            else if (entity is Circle circle)
            {
                candidate.Outcome = ReadArea(() => circle.Area, candidate, "circle");
                candidate.Perimeter = ReadLength(() => circle.Circumference);
            }
            else if (entity is Curve curve)
            {
                if (!curve.Closed)
                {
                    candidate.Outcome = regionScope
                        ? AreaMeasure.Outcome.AmbiguousRegion
                        : AreaMeasure.Outcome.OpenBoundary;
                }
                else
                {
                    candidate.Outcome = ReadArea(() => curve.Area, candidate, EntityKindResolver.DxfNameOf(entity));
                    candidate.Perimeter = curve is Polyline pl
                        ? ReadLength(() => pl.Length)
                        : curve is Polyline2d pl2
                            ? ReadLength(() => pl2.Length)
                            : curve is Polyline3d pl3
                                ? ReadLength(() => pl3.Length)
                                : (double?)null;
                }
            }
            else
            {
                // Text, dimension, block reference, point, image, 3d solid… — no area exists to read.
                candidate.Skipped = true;
            }

            measured.Add((candidate, entity.ObjectId));
        }

        /// <summary>
        /// Reads an AutoCAD area property, turning both failure modes into <c>unsupported_geometry</c>
        /// instead of a whole-call crash: the <see cref="Autodesk.AutoCAD.Runtime.Exception"/> AutoCAD
        /// throws when it refuses to evaluate the geometry (self-intersecting, unevaluable), and a
        /// non-finite number it can hand back for degenerate geometry. No estimate is substituted.
        /// </summary>
        private static AreaMeasure.Outcome ReadArea(Func<double> area, AreaMeasure.Candidate candidate, string what)
        {
            double value;
            try
            {
                value = area();
            }
            catch (Autodesk.AutoCAD.Runtime.Exception ex)
            {
                candidate.Message = $"AutoCAD refused the area of this {what}: {ex.Message}";
                return AreaMeasure.Outcome.UnsupportedGeometry;
            }
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                candidate.Message = $"AutoCAD returned no finite area for this {what}.";
                return AreaMeasure.Outcome.UnsupportedGeometry;
            }
            candidate.Area = value;
            return AreaMeasure.Outcome.Measured;
        }

        /// <summary>Perimeter/circumference is diagnostic garnish: a refusal drops it, never the area.</summary>
        private static double? ReadLength(Func<double> length)
        {
            try
            {
                var value = length();
                return (!double.IsNaN(value) && !double.IsInfinity(value)) ? value : (double?)null;
            }
            catch (Autodesk.AutoCAD.Runtime.Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Hatch boundary loops that are not outer boundaries, i.e. the holes <c>Hatch.Area</c> already
        /// subtracted. Verified against the real <c>AutoCAD.NET.Model</c> 25.1.0 assembly:
        /// <c>HatchLoopTypes</c> is a [Flags] enum (Default=0, External=1, Polyline=2, Derived=4,
        /// Textbox=8, Outermost=16, NotClosed=32, SelfIntersecting=64, TextIsland=128, Duplicate=256),
        /// so "hole" is exactly "the Outermost flag is clear".
        /// </summary>
        private static int CountHatchHoles(Hatch hatch)
        {
            var holes = 0;
            for (var i = 0; i < hatch.NumberOfLoops; i++)
            {
                if ((hatch.LoopTypeAt(i) & HatchLoopTypes.Outermost) == 0) holes++;
            }
            return holes;
        }

        /// <summary>
        /// Copies entities from one open document's model space into another's
        /// (<c>Database.WblockCloneObjects</c>, the same mechanism as copy/paste between tabs), so
        /// layers, linetypes, text styles and blocks the copies depend on that the target lacks are
        /// created there by the clone. Both documents are locked and neither is activated. Not
        /// recorded in the batch journal: it changes the target document, but there is no
        /// <c>operations.undo</c> for it (erase the returned handles to reverse it).
        /// </summary>
        [JsonRpcMethod("entity.copyTo", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityCopyToResult> CopyTo(EntityCopyToRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (string.IsNullOrEmpty(request.TargetDocumentName))
                {
                    throw PluginExceptions.InvalidGeometry("copyTo requires \"targetDocumentName\".");
                }
                if (request.Handles.Count == 0)
                {
                    throw PluginExceptions.InvalidGeometry("copyTo requires at least one handle.");
                }

                var source = DocumentContext.Resolve(request.DocumentName);
                var target = DocumentContext.Resolve(request.TargetDocumentName);
                if (ReferenceEquals(source, target))
                {
                    throw PluginExceptions.InvalidGeometry(
                        "Source and target are the same document; use entity transform copy instead.");
                }

                using (source.LockDocument())
                using (target.LockDocument())
                {
                    try
                    {
                        var ids = new ObjectIdCollection();
                        foreach (var handle in request.Handles)
                        {
                            if (!HandleConvert.TryResolve(source.Database, handle, out var id) || id.IsErased)
                            {
                                throw PluginExceptions.EntityNotFound(handle);
                            }
                            ids.Add(id);
                        }

                        ObjectId targetModelSpace;
                        using (var tr = target.Database.TransactionManager.StartTransaction())
                        {
                            var bt = (BlockTable)tr.GetObject(target.Database.BlockTableId, OpenMode.ForRead);
                            targetModelSpace = bt[BlockTableRecord.ModelSpace];
                            tr.Commit();
                        }

                        var mapping = new IdMapping();
                        source.Database.WblockCloneObjects(
                            ids, targetModelSpace, mapping, DuplicateRecordCloning.Ignore, false);

                        var copied = new List<EntityRefDto>();
                        using (var tr = target.Database.TransactionManager.StartTransaction())
                        {
                            var delta = request.Delta?.ToVector3d();
                            foreach (ObjectId sourceId in ids)
                            {
                                if (!mapping.Contains(sourceId)) continue;
                                var clone = (Entity)tr.GetObject(mapping[sourceId].Value, OpenMode.ForWrite);
                                EntityOwnership.Stamp(tr, clone);
                                if (delta.HasValue && delta.Value.Length > 0)
                                {
                                    clone.TransformBy(Matrix3d.Displacement(delta.Value));
                                }
                                copied.Add(new EntityRefDto
                                {
                                    Handle = clone.Handle.ToString(),
                                    Kind = EntityKindResolver.KindOf(clone),
                                    Layer = clone.Layer,
                                });
                            }
                            tr.Commit();
                        }

                        // #413 §11.5: a taskId-tagged copy (approved symbol-library import for a
                        // PCCC overlay) writes a durable compensating-erase receipt to the task
                        // ledger so the whole import rolls back as one operations.revert(taskId)
                        // unit. It is deliberately NOT recorded in BatchJournal: a cross-document
                        // clone has no native undo group, and a journal entry would sit at Top() and
                        // make the following apply batch un-undoable (#388). Revert reads the ledger,
                        // undo reads the journal — the two paths stay independent.
                        string? receiptBatchId = null;
                        if (!string.IsNullOrWhiteSpace(request.TaskId))
                        {
                            try
                            {
                                var receipt = CadTaskLedger.Record(new TaskChangeSet
                                {
                                    TaskId = request.TaskId,
                                    DocumentName = target.Name,
                                    OperationCount = copied.Count,
                                    EntityRefs = copied,
                                    CreatedHandles = copied.Select(c => c.Handle).ToList(),
                                    // Not undo-eligible: this unit is reverted, not undone.
                                    UndoSupported = false,
                                });
                                receiptBatchId = receipt.BatchId;
                            }
                            catch (Exception ex)
                            {
                                // A receipt that failed to persist must not fail the copy the user
                                // already got; mirror BatchJournal's durable-mirror posture.
                                System.Diagnostics.Trace.TraceWarning($"[entity.copyTo] ledger receipt failed: {ex.Message}");
                            }
                        }

                        ScreenRefresh.AfterCommit(target);
                        return new EntityCopyToResult { Copied = copied, TargetDocumentName = target.Name, ReceiptBatchId = receiptBatchId };
                    }
                    catch (Autodesk.AutoCAD.Runtime.Exception ex)
                    {
                        throw PluginExceptions.TransactionFailed(ex);
                    }
                }
            });

        /// <summary>
        /// Read-only boundary detection from one interior point (<c>entity.traceBoundary</c>), using
        /// AutoCAD's own <c>Editor.TraceBoundary</c> — the same engine behind HATCH's "pick points"
        /// boundary selection. This is what turns "the model can see an elevator shaft in a capture"
        /// into an enforceable polygon when the architecture arrives as one merged block: there is no
        /// closed room polyline to read directly, and a model-drawn rectangle is exactly what must not
        /// be trusted as a shaft boundary.
        ///
        /// Nothing in the drawing is modified: the traced curves are transient <c>DBObject</c>s owned by
        /// the collection, read here and disposed with it. No transaction commits, so the document
        /// revision does not move and no handle is created.
        ///
        /// Requires the ACTIVE document — boundary tracing evaluates what the view shows, and a
        /// background tab has no view to trace in (same restriction as <c>selection: "implied"</c> in
        /// <c>entity.areaMeasure</c>). A refusal never substitutes a guessed rectangle: <c>found:
        /// false</c> plus a <c>reason</c> is the answer, and the caller decides what to ask for.
        /// </summary>
        [JsonRpcMethod("entity.traceBoundary", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityTraceBoundaryResult> TraceBoundary(EntityTraceBoundaryRequest request, CancellationToken ct = default) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                if (!ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument))
                {
                    throw PluginExceptions.InvalidOperation(
                        "entity.traceBoundary needs the active document — boundary detection evaluates the visible view, " +
                        "which a background tab does not have. Activate the drawing (drawing.activate) and retry.");
                }

                var point = Require(request.Point, "point").ToPoint3d();
                var detectIslands = request.DetectIslands ?? true;

                // E1: Editor.TraceBoundary's seed point is evaluated in the document's ACTIVE UCS, but
                // the wire contract (docs/PROTOCOL.md) is WCS for both seed and result. A WCS seed fed
                // straight in is misread whenever the UCS is rotated/dilated (by the user, a layout, or
                // an active viewport) — the engine then traces the region around the WRONG world point.
                // Map the WCS seed into UCS for the call, then map every returned ring back to WCS so
                // the result stays WCS regardless of the active frame. ucsToWorld is null when the UCS
                // is already World (identity), keeping the common path free of extra transforms.
                var ucsToWorld = doc.Editor.CurrentUserCoordinateSystem;
                var ucsIsWorld = ucsToWorld == Matrix3d.Identity;
                var seed = ucsIsWorld ? point : point.TransformBy(ucsToWorld.Inverse());

                DBObjectCollection traced;
                try
                {
                    traced = doc.Editor.TraceBoundary(seed, detectIslands);
                }
                catch (Autodesk.AutoCAD.Runtime.Exception ex)
                {
                    // The usual case: the point sits in a gap, on a line, or the surrounding strokes
                    // never close. Report it; do not estimate a boundary.
                    return new EntityTraceBoundaryResult
                    {
                        Found = false,
                        UcsWithWorld = !ucsIsWorld,
                        Reason = $"AutoCAD found no closed boundary containing [{point.X}, {point.Y}]: {ex.Message}"
                    };
                }

                if (traced is null || traced.Count == 0)
                {
                    return new EntityTraceBoundaryResult
                    {
                        Found = false,
                        UcsWithWorld = !ucsIsWorld,
                        Reason = $"AutoCAD found no closed boundary containing [{point.X}, {point.Y}]."
                    };
                }

                try
                {
                    var boundaries = new List<BoundaryLoopDto>();
                    var unsupported = new List<string>();
                    double netArea = 0;

                    foreach (DBObject obj in traced)
                    {
                        if (obj is not Polyline pl)
                        {
                            // Splines/ellipses/2D polylines come back as curve types whose vertices
                            // are only safely readable through a database-resident ObjectId. Those
                            // objects are transient here, so their vertex lists are NOT read — the
                            // call says so instead of inventing a ring.
                            unsupported.Add(obj is Entity ent ? EntityKindResolver.DxfNameOf(ent) : obj.GetType().Name);
                            continue;
                        }

                        var pts = new List<Point3dDto>(pl.NumberOfVertices);
                        for (var i = 0; i < pl.NumberOfVertices; i++)
                        {
                            // Ring vertices come back in the active UCS; map them back to WCS so the
                            // result honours the WCS wire contract regardless of the trace frame. A
                            // rotation (the E1 case) leaves Area/NetArea invariant, so those stay as
                            // the engine computed them; a non-identity scale is not claimed here.
                            var wp = ucsIsWorld ? pl.GetPoint3dAt(i) : pl.GetPoint3dAt(i).TransformBy(ucsToWorld);
                            pts.Add(Point3dDto.From(wp));
                        }

                        var loop = new BoundaryLoopDto
                        {
                            Kind = boundaries.Count == 0 ? "outer" : "island",
                            Points = pts,
                            Area = pl.Area,
                            Perimeter = pl.Length,
                            IsClosed = pl.Closed
                        };
                        boundaries.Add(loop);
                        netArea += loop.Kind == "outer" ? pl.Area : -pl.Area;
                    }

                    if (boundaries.Count == 0)
                    {
                        return new EntityTraceBoundaryResult
                        {
                            Found = false,
                            UcsWithWorld = !ucsIsWorld,
                            Reason = "AutoCAD closed a boundary using curve types this call cannot read " +
                                     $"({string.Join(", ", unsupported)}); no vertices were invented. " +
                                     "Read the area with entity.areaMeasure or pick a point in a region bounded by polylines."
                        };
                    }

                    return new EntityTraceBoundaryResult
                    {
                        Found = true,
                        Boundaries = boundaries,
                        NetArea = Math.Max(0, netArea),
                        UcsWithWorld = !ucsIsWorld,
                        Reason = unsupported.Count > 0
                            ? $"Read {boundaries.Count} polyline boundary ring(s); ignored unsupported curve type(s): {string.Join(", ", unsupported)}."
                            : null
                    };
                }
                finally
                {
                    foreach (DBObject obj in traced) obj.Dispose();
                    traced.Dispose();
                }
            }, ct);

        [JsonRpcMethod("entity.erase", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityEraseResult> Erase(EntityEraseRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    try
                    {
                        var erased = EraseMany(tr, db, request.Handles);
                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);
                        LiveView.FollowAfterMutation(doc, erased, request.View);
                        return new EntityEraseResult { Erased = erased.Select(e => e.Handle).ToList() };
                    }
                    catch (LocalRpcException)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        throw PluginExceptions.TransactionFailed(ex);
                    }
                }
            });

        /// <summary>
        /// Erases each handle inside an already-open transaction, returning the pre-erase
        /// kind/layer of each so batch callers (<c>OperationsHandlers.Apply</c>) can report what
        /// was removed. Silently skips handles that don't resolve, matching the prior behavior.
        /// </summary>
        internal static List<EntityRefDto> EraseMany(Transaction tr, Database db, List<string> handles)
        {
            EntityOwnership.Guard(tr, db, handles, "erase");
            var erased = new List<EntityRefDto>();
            foreach (var handle in handles)
            {
                if (!HandleConvert.TryResolve(db, handle, out var id)) continue;
                var entity = (Entity)tr.GetObject(id, OpenMode.ForWrite);
                erased.Add(new EntityRefDto { Handle = handle, Kind = EntityKindResolver.KindOf(entity), Layer = entity.Layer });
                entity.Erase();
            }
            return erased;
        }

        [JsonRpcMethod("entity.transform", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityTransformResult> Transform(EntityTransformRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    try
                    {
                        var affected = TransformOne(tr, db, request);
                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);
                        LiveView.FollowAfterMutation(doc, affected, request.View);
                        return new EntityTransformResult { Affected = affected };
                    }
                    catch (LocalRpcException)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        throw PluginExceptions.TransactionFailed(ex);
                    }
                }
            });

        /// <summary>
        /// Applies one transform op inside an already-open transaction. Caller owns
        /// locking/commit/rollback — used both by the single-op <see cref="Transform"/> RPC and
        /// by <c>OperationsHandlers.Apply</c>'s batch transaction.
        /// </summary>
        internal static List<EntityRefDto> TransformOne(Transaction tr, Database db, EntityTransformRequest request) =>
            request.Op switch
            {
                "move" => ApplyInPlace(tr, db, request.Handles, Matrix3d.Displacement(RequireDelta(request).ToVector3d())),
                "rotate" => ApplyInPlace(
                    tr, db, request.Handles,
                    Matrix3d.Rotation(RequireAngle(request), Vector3d.ZAxis, RequireCenter(request).ToPoint3d())),
                "scale" => ApplyInPlace(
                    tr, db, request.Handles,
                    Matrix3d.Scaling(RequireFactor(request), RequireCenter(request).ToPoint3d())),
                "copy" => ApplyAsCopy(tr, db, request.Handles, Matrix3d.Displacement(RequireDelta(request).ToVector3d())),
                "mirror" => ApplyMirror(tr, db, request),
                "arrayRect" => ApplyArrayRect(tr, db, request),
                "arrayPolar" => ApplyArrayPolar(tr, db, request),
                "arrayPath" => ApplyArrayPath(tr, db, request),
                _ => throw PluginExceptions.InvalidGeometry($"Unknown transform op \"{request.Op}\"."),
            };

        [JsonRpcMethod("entity.update", UseSingleObjectParameterDeserialization = true)]
        public Task<EntityUpdateResult> Update(EntityUpdateRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    try
                    {
                        var entity = UpdateOne(tr, db, request);
                        var summary = ToSummary(entity);
                        var refDto = new EntityRefDto
                        {
                            Handle = entity.Handle.ToString(),
                            Kind = EntityKindResolver.KindOf(entity),
                            Layer = entity.Layer,
                        };
                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);
                        LiveView.FollowAfterMutation(doc, new List<EntityRefDto> { refDto }, request.View);
                        return new EntityUpdateResult { Entity = summary };
                    }
                    catch (LocalRpcException)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        throw PluginExceptions.TransactionFailed(ex);
                    }
                }
            });

        /// <summary>
        /// Applies <paramref name="request"/>'s common properties and (if given) kind-specific
        /// <c>geometry</c> patch to the handle it names, inside an already-open transaction — the
        /// handle itself never changes. <c>geometry.kind</c> is checked against the entity's
        /// actual current kind (<see cref="EntityKindResolver.KindOf"/>, read from the drawing —
        /// never trusted from the caller) before anything is applied; a mismatch throws
        /// <see cref="PluginExceptions.InvalidGeometry"/> and leaves the entity untouched.
        /// </summary>
        internal static Entity UpdateOne(Transaction tr, Database db, EntityUpdateRequest request)
        {
            if (!HandleConvert.TryResolve(db, request.Handle, out var id))
            {
                throw PluginExceptions.EntityNotFound(request.Handle);
            }
            var entity = (Entity)tr.GetObject(id, OpenMode.ForWrite);

            if (request.Layer != null)
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                if (!lt.Has(request.Layer))
                {
                    throw PluginExceptions.LayerNotFound(request.Layer);
                }
                entity.Layer = request.Layer;
            }
            if (request.Color != null)
            {
                entity.Color = ColorConvert.ToAcadColor(request.Color);
            }
            if (request.Linetype != null)
            {
                var ltt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
                if (!ltt.Has(request.Linetype))
                {
                    throw PluginExceptions.InvalidGeometry(
                        $"Linetype \"{request.Linetype}\" is not loaded into this drawing.");
                }
                entity.Linetype = request.Linetype;
            }
            if (request.Lineweight.HasValue)
            {
                entity.LineWeight = (LineWeight)request.Lineweight.Value;
            }

            if (request.Geometry != null)
            {
                var actualKind = EntityKindResolver.KindOf(entity);
                if (request.Geometry.Kind != actualKind)
                {
                    throw PluginExceptions.InvalidGeometry(
                        $"geometry.kind \"{request.Geometry.Kind}\" does not match entity " +
                        $"\"{request.Handle}\"'s actual kind \"{actualKind}\".");
                }
                ApplyGeometry(tr, entity, request.Geometry);
            }

            return entity;
        }

        /// <summary>
        /// Applies one kind-specific <c>geometry</c> patch's given fields (omitted fields keep
        /// their current value) — caller already verified <paramref name="g"/>'s <c>Kind</c>
        /// matches <paramref name="entity"/>'s actual kind. No case changes vertex count or an
        /// entity's kind — both are still erase+recreate territory (docs/PROTOCOL.md).
        /// </summary>
        private static void ApplyGeometry(Transaction tr, Entity entity, EntityUpdateGeometryDto g)
        {
            try
            {
                switch (g.Kind)
                {
                    case "line":
                    {
                        var line = (Line)entity;
                        if (g.Start != null) line.StartPoint = g.Start.ToPoint3d();
                        if (g.End != null) line.EndPoint = g.End.ToPoint3d();
                        break;
                    }
                    case "circle":
                    {
                        var circle = (Circle)entity;
                        if (g.Center != null) circle.Center = g.Center.ToPoint3d();
                        if (g.Radius.HasValue)
                        {
                            if (g.Radius.Value <= 0) throw PluginExceptions.InvalidGeometry("circle radius must be > 0.");
                            circle.Radius = g.Radius.Value;
                        }
                        break;
                    }
                    case "arc":
                    {
                        var arc = (Arc)entity;
                        if (g.Center != null) arc.Center = g.Center.ToPoint3d();
                        if (g.Radius.HasValue)
                        {
                            if (g.Radius.Value <= 0) throw PluginExceptions.InvalidGeometry("arc radius must be > 0.");
                            arc.Radius = g.Radius.Value;
                        }
                        if (g.StartAngle.HasValue) arc.StartAngle = g.StartAngle.Value;
                        if (g.EndAngle.HasValue) arc.EndAngle = g.EndAngle.Value;
                        break;
                    }
                    case "polyline":
                    {
                        var pl = (Polyline)entity;
                        if (g.Closed.HasValue) pl.Closed = g.Closed.Value;
                        break;
                    }
                    case "mtext":
                    {
                        var mtext = (MText)entity;
                        if (g.Insertion != null) mtext.Location = g.Insertion.ToPoint3d();
                        if (g.Text != null) mtext.Contents = g.Text;
                        if (g.Height.HasValue) mtext.TextHeight = g.Height.Value;
                        if (g.Width.HasValue) mtext.Width = g.Width.Value;
                        break;
                    }
                    case "text.singleLine":
                    {
                        var text = (DBText)entity;
                        if (g.Insertion != null) text.Position = g.Insertion.ToPoint3d();
                        if (g.Text != null) text.TextString = g.Text;
                        if (g.Height.HasValue) text.Height = g.Height.Value;
                        if (g.Rotation.HasValue) text.Rotation = g.Rotation.Value;
                        break;
                    }
                    case "blockReference":
                    {
                        var br = (BlockReference)entity;
                        if (g.Position != null) br.Position = g.Position.ToPoint3d();
                        if (g.Scale != null) br.ScaleFactors = new Scale3d(g.Scale.X, g.Scale.Y, g.Scale.Z);
                        if (g.Rotation.HasValue) br.Rotation = g.Rotation.Value;
                        if (g.Attributes != null) UpdateBlockAttributes(tr, br, g.Attributes);
                        break;
                    }
                    case "dimension.linear":
                    {
                        var rd = (RotatedDimension)entity;
                        if (g.ExtLine1 != null) rd.XLine1Point = g.ExtLine1.ToPoint3d();
                        if (g.ExtLine2 != null) rd.XLine2Point = g.ExtLine2.ToPoint3d();
                        if (g.DimLinePoint != null) rd.DimLinePoint = g.DimLinePoint.ToPoint3d();
                        if (g.DimText != null) rd.DimensionText = g.DimText;
                        if (g.Rotation.HasValue) rd.Rotation = g.Rotation.Value;
                        break;
                    }
                    case "dimension.aligned":
                    {
                        var ad = (AlignedDimension)entity;
                        if (g.ExtLine1 != null) ad.XLine1Point = g.ExtLine1.ToPoint3d();
                        if (g.ExtLine2 != null) ad.XLine2Point = g.ExtLine2.ToPoint3d();
                        if (g.DimLinePoint != null) ad.DimLinePoint = g.DimLinePoint.ToPoint3d();
                        if (g.DimText != null) ad.DimensionText = g.DimText;
                        break;
                    }
                    case "dimension.ordinate":
                    {
                        var od = (OrdinateDimension)entity;
                        if (g.Origin != null) od.Origin = g.Origin.ToPoint3d();
                        if (g.FeaturePoint != null) od.DefiningPoint = g.FeaturePoint.ToPoint3d();
                        if (g.LeaderEndPoint != null) od.LeaderEndPoint = g.LeaderEndPoint.ToPoint3d();
                        break;
                    }
                    case "hatch":
                    {
                        var hatch = (Hatch)entity;
                        if (g.Pattern != null) hatch.SetHatchPattern(HatchPatternType.PreDefined, g.Pattern);
                        if (g.PatternScale.HasValue) hatch.PatternScale = g.PatternScale.Value;
                        if (g.PatternAngle.HasValue) hatch.PatternAngle = g.PatternAngle.Value;
                        if (g.Pattern != null || g.PatternScale.HasValue || g.PatternAngle.HasValue)
                        {
                            hatch.EvaluateHatch(true);
                        }
                        break;
                    }
                    default:
                        throw PluginExceptions.InvalidGeometry($"entity.update does not support geometry for kind \"{g.Kind}\".");
                }
            }
            catch (LocalRpcException)
            {
                throw;
            }
            catch (InvalidCastException)
            {
                throw PluginExceptions.InvalidGeometry(
                    $"geometry.kind \"{g.Kind}\" does not match this entity's actual AutoCAD type.");
            }
            catch (Autodesk.AutoCAD.Runtime.Exception ex)
            {
                throw PluginExceptions.InvalidGeometry($"geometry update is invalid: {ex.Message}");
            }
        }

        /// <summary>
        /// Sets <see cref="AttributeReference.TextString"/> on each of <paramref name="br"/>'s
        /// existing attribute references whose <see cref="AttributeReference.Tag"/> is a key in
        /// <paramref name="attributes"/>; tags not present on this block reference are left as-is
        /// (same leniency as <see cref="ApplyBlockAttributes"/>'s unsupplied-tag case at create
        /// time — this never creates or removes an attribute reference).
        /// </summary>
        private static void UpdateBlockAttributes(Transaction tr, BlockReference br, Dictionary<string, string> attributes)
        {
            foreach (ObjectId attId in br.AttributeCollection)
            {
                var att = (AttributeReference)tr.GetObject(attId, OpenMode.ForWrite);
                if (attributes.TryGetValue(att.Tag, out var value))
                {
                    att.TextString = value;
                }
            }
        }

        // ---- helpers -------------------------------------------------------

        private static string ResolveLayerName(string? requested, LayerTable lt, Transaction tr, Database db)
        {
            if (string.IsNullOrEmpty(requested))
            {
                return ((LayerTableRecord)tr.GetObject(db.Clayer, OpenMode.ForRead)).Name;
            }
            if (!lt.Has(requested))
            {
                throw PluginExceptions.LayerNotFound(requested!);
            }
            return requested!;
        }

        private static Entity BuildEntity(Transaction tr, CreateEntityRequest r, BlockTable bt, Database db, string documentName) => r.Kind switch
        {
            "line" => new Line(Require(r.Start, "start").ToPoint3d(), Require(r.End, "end").ToPoint3d()),
            "circle" => BuildCircle(r),
            "arc" => BuildArc(r),
            "polyline" => BuildPolyline(Require(r.Points, "points"), r.Closed ?? false, r.Bulges, r.ConstantWidth),
            "rectangle" => BuildRectangle(Require(r.Corner1, "corner1"), Require(r.Corner2, "corner2")),
            "mtext" => BuildMText(tr, db, documentName, r),
            "text.singleLine" => BuildSingleLineText(tr, db, documentName, r),
            "blockReference" => BuildBlockReference(r, bt),
            "dimension.linear" => BuildLinearDimension(tr, db, documentName, r),
            "dimension.aligned" => BuildAlignedDimension(tr, db, documentName, r),
            "dimension.ordinate" => BuildOrdinateDimension(tr, db, documentName, r),
            _ => throw PluginExceptions.InvalidGeometry($"Unknown entity kind \"{r.Kind}\"."),
        };

        private static Circle BuildCircle(CreateEntityRequest r)
        {
            var radius = Require(r.Radius, "radius");
            if (radius <= 0) throw PluginExceptions.InvalidGeometry("circle radius must be > 0.");
            return new Circle(Require(r.Center, "center").ToPoint3d(), Vector3d.ZAxis, radius);
        }

        private static Arc BuildArc(CreateEntityRequest r)
        {
            var radius = Require(r.Radius, "radius");
            if (radius <= 0) throw PluginExceptions.InvalidGeometry("arc radius must be > 0.");
            return new Arc(
                Require(r.Center, "center").ToPoint3d(),
                radius,
                Require(r.StartAngle, "startAngle"),
                Require(r.EndAngle, "endAngle"));
        }

        private static Polyline BuildPolyline(List<Point3dDto> points, bool closed, List<double>? bulges, double? constantWidth)
        {
            if (points.Count < 2) throw PluginExceptions.InvalidGeometry("polyline needs at least 2 points.");
            var pl = new Polyline();
            pl.Elevation = points[0].Z;
            var halfWidth = (constantWidth ?? 0) / 2;
            for (int i = 0; i < points.Count; i++)
            {
                var bulge = bulges != null && i < bulges.Count ? bulges[i] : 0;
                pl.AddVertexAt(i, new Point2d(points[i].X, points[i].Y), bulge, halfWidth, halfWidth);
            }
            pl.Closed = closed;
            return pl;
        }

        private static Polyline BuildRectangle(Point3dDto c1, Point3dDto c2)
        {
            var pl = new Polyline();
            pl.Elevation = c1.Z;
            pl.AddVertexAt(0, new Point2d(c1.X, c1.Y), 0, 0, 0);
            pl.AddVertexAt(1, new Point2d(c2.X, c1.Y), 0, 0, 0);
            pl.AddVertexAt(2, new Point2d(c2.X, c2.Y), 0, 0, 0);
            pl.AddVertexAt(3, new Point2d(c1.X, c2.Y), 0, 0, 0);
            pl.Closed = true;
            return pl;
        }

        private static MText BuildMText(Transaction tr, Database db, string documentName, CreateEntityRequest r)
        {
            var height = r.PaperHeight.HasValue
                ? r.PaperHeight.Value * Annotation.CurrentScaleFactor(db)
                : r.Height ?? 2.5;
            var mtext = new MText
            {
                Location = Require(r.Insertion, "insertion").ToPoint3d(),
                Contents = Require(r.Text, "text"),
                TextHeight = height,
                Width = r.Width ?? 0,
            };
            if (Annotation.Resolve(r.Annotative, documentName))
            {
                mtext.TextStyleId = Annotation.EnsureAnnotativeTextStyle(tr, db);
            }
            return mtext;
        }

        private static DBText BuildSingleLineText(Transaction tr, Database db, string documentName, CreateEntityRequest r)
        {
            var height = r.PaperHeight.HasValue
                ? r.PaperHeight.Value * Annotation.CurrentScaleFactor(db)
                : r.Height ?? 2.5;
            var text = new DBText
            {
                Position = Require(r.Insertion, "insertion").ToPoint3d(),
                TextString = Require(r.Text, "text"),
                Height = height,
                Rotation = r.Rotation ?? 0.0,
            };
            if (Annotation.Resolve(r.Annotative, documentName))
            {
                text.TextStyleId = Annotation.EnsureAnnotativeTextStyle(tr, db);
            }
            return text;
        }

        private static BlockReference BuildBlockReference(CreateEntityRequest r, BlockTable bt)
        {
            var blockName = Require(r.BlockName, "blockName");
            if (!bt.Has(blockName)) throw PluginExceptions.BlockNotFound(blockName);
            var scale = r.Scale ?? new Point3dDto { X = 1, Y = 1, Z = 1 };
            return new BlockReference(Require(r.Position, "position").ToPoint3d(), bt[blockName])
            {
                ScaleFactors = new Scale3d(scale.X, scale.Y, scale.Z),
                Rotation = r.Rotation ?? 0.0,
            };
        }

        /// <summary>
        /// Appends one <see cref="AttributeReference"/> per non-constant
        /// <see cref="AttributeDefinition"/> the block defines, matching real AutoCAD INSERT
        /// behavior: attribute references always get created when the block has attribute
        /// definitions, whether or not the caller supplied a value (unsupplied tags keep the
        /// block's default text from <see cref="AttributeReference.SetAttributeFromBlock"/>).
        /// </summary>
        private static void ApplyBlockAttributes(Transaction tr, BlockReference br, Dictionary<string, string>? attributes)
        {
            var btr = (BlockTableRecord)tr.GetObject(br.BlockTableRecord, OpenMode.ForRead);
            foreach (ObjectId defId in btr)
            {
                if (tr.GetObject(defId, OpenMode.ForRead) is not AttributeDefinition def || def.Constant) continue;
                var att = new AttributeReference();
                att.SetAttributeFromBlock(def, br.BlockTransform);
                if (attributes != null && attributes.TryGetValue(def.Tag, out var value))
                {
                    att.TextString = value;
                }
                br.AttributeCollection.AppendAttribute(att);
                tr.AddNewlyCreatedDBObject(att, true);
            }
        }

        // Rotation is the dimension line's angle (radians): 0 = horizontal, PI/2 = vertical (#59).
        private static RotatedDimension BuildLinearDimension(Transaction tr, Database db, string documentName, CreateEntityRequest r) => new RotatedDimension(
            r.Rotation ?? 0.0,
            Require(r.ExtLine1, "extLine1").ToPoint3d(),
            Require(r.ExtLine2, "extLine2").ToPoint3d(),
            Require(r.DimLinePoint, "dimLinePoint").ToPoint3d(),
            r.DimText,
            DimStyleFor(tr, db, documentName, r));

        private static AlignedDimension BuildAlignedDimension(Transaction tr, Database db, string documentName, CreateEntityRequest r) => new AlignedDimension(
            Require(r.ExtLine1, "extLine1").ToPoint3d(),
            Require(r.ExtLine2, "extLine2").ToPoint3d(),
            Require(r.DimLinePoint, "dimLinePoint").ToPoint3d(),
            r.DimText,
            DimStyleFor(tr, db, documentName, r));

        private static OrdinateDimension BuildOrdinateDimension(Transaction tr, Database db, string documentName, CreateEntityRequest r)
        {
            var axis = r.Axis;
            if (axis != "x" && axis != "y")
            {
                throw PluginExceptions.InvalidGeometry("dimension.ordinate: axis must be \"x\" or \"y\".");
            }
            var dim = new OrdinateDimension(
                axis == "x",
                Require(r.FeaturePoint, "featurePoint").ToPoint3d(),
                Require(r.LeaderEndPoint, "leaderEndPoint").ToPoint3d(),
                null,
                DimStyleFor(tr, db, documentName, r))
            {
                Origin = Require(r.Origin, "origin").ToPoint3d(),
            };
            return dim;
        }

        /// <summary>The on-demand `CadAI-Annotative` dim style when this dimension resolves annotative (#74), else the ambient `Database.Dimstyle` (unchanged, pre-#74 behavior).</summary>
        private static ObjectId DimStyleFor(Transaction tr, Database db, string documentName, CreateEntityRequest r) =>
            Annotation.Resolve(r.Annotative, documentName) ? Annotation.EnsureAnnotativeDimStyle(tr, db) : db.Dimstyle;

        /// <summary>
        /// Builds a hatch from either the legacy single-loop <c>boundaryHandles</c> (all handles
        /// joined into one <see cref="HatchLoopTypes.Default"/> loop, unchanged) or the multi-loop
        /// <c>loops</c> form (#58): <c>loops[0]</c> is <see cref="HatchLoopTypes.Outermost"/>, every
        /// later entry <see cref="HatchLoopTypes.Default"/> (an island). Unlike every other kind,
        /// <see cref="Hatch"/> must be database-resident (appended +
        /// <see cref="Transaction.AddNewlyCreatedDBObject"/>) before
        /// <see cref="Hatch.AppendLoop(HatchLoopTypes, ObjectIdCollection)"/>/
        /// <see cref="Hatch.EvaluateHatch(bool)"/> can run, so it cannot go through the generic
        /// build-then-append flow the other kinds share. <c>AppendLoop</c>/<c>EvaluateHatch</c> throw
        /// an <see cref="Autodesk.AutoCAD.Runtime.Exception"/> for an open or self-intersecting
        /// loop, which this maps to <see cref="PluginExceptions.InvalidGeometry(string)"/> instead of
        /// letting the raw AutoCAD error escape (mirrors <c>EntityHandlers.CopyTo</c>'s wrapping).
        /// </summary>
        private static Hatch BuildHatch(Transaction tr, Database db, BlockTableRecord ms, CreateEntityRequest r)
        {
            var hasBoundaryHandles = r.BoundaryHandles is { Count: > 0 };
            var hasLoops = r.Loops is { Count: > 0 };
            if (hasBoundaryHandles == hasLoops)
            {
                throw PluginExceptions.InvalidGeometry(
                    "hatch requires exactly one of \"boundaryHandles\" or \"loops\" (with at least one entry).");
            }

            var hatch = new Hatch();
            ms.AppendEntity(hatch);
            tr.AddNewlyCreatedDBObject(hatch, true);
            hatch.SetDatabaseDefaults();
            EntityOwnership.Stamp(tr, hatch);
            hatch.Associative = r.Associative ?? false;

            try
            {
                // SetHatchPattern must run before PatternScale/PatternAngle/HatchStyle — AutoCAD
                // rejects those with eInvalidInput on a Hatch with no pattern defined yet. No
                // enumerable "list every predefined pattern name" surface exists on Hatch in the
                // AutoCAD .NET SDK (checked by reflection against acdbmgd.dll) — an unknown name
                // throws here too, caught below and mapped to InvalidGeometry.
                hatch.SetHatchPattern(HatchPatternType.PreDefined, r.Pattern ?? "SOLID");
                hatch.PatternScale = r.PatternScale ?? 1.0;
                hatch.PatternAngle = r.PatternAngle ?? 0.0;
                hatch.HatchStyle = ParseHatchStyle(r.Style);

                if (hasBoundaryHandles)
                {
                    var loopIds = new ObjectIdCollection();
                    foreach (var h in r.BoundaryHandles!)
                    {
                        if (!HandleConvert.TryResolve(db, h, out var id)) throw PluginExceptions.EntityNotFound(h);
                        loopIds.Add(id);
                    }
                    hatch.AppendLoop(HatchLoopTypes.Default, loopIds);
                }
                else
                {
                    for (var i = 0; i < r.Loops!.Count; i++)
                    {
                        AppendOneLoop(hatch, db, r.Loops[i], i == 0 ? HatchLoopTypes.Outermost : HatchLoopTypes.Default);
                    }
                }

                hatch.EvaluateHatch(true);
            }
            catch (LocalRpcException)
            {
                throw;
            }
            catch (Autodesk.AutoCAD.Runtime.Exception ex)
            {
                throw PluginExceptions.InvalidGeometry($"hatch boundary is invalid: {ex.Message}");
            }

            return hatch;
        }

        /// <summary>
        /// Builds one <c>loops[i]</c> entry. <c>handles</c> reuses existing closed-curve entities,
        /// same as the legacy <c>boundaryHandles</c> path. <c>points</c>/<c>bulges</c> and
        /// <c>circle</c> both go through
        /// <see cref="Hatch.AppendLoop(HatchLoopTypes, Point2dCollection, DoubleCollection)"/> — the
        /// AutoCAD .NET SDK has no <c>BulgeVertexCollection</c> type (verified by reflection against
        /// acdbmgd.dll; that overload only takes <see cref="Point2dCollection"/> +
        /// <see cref="DoubleCollection"/>), and there is no direct curve-based overload that accepts
        /// a database-transient <see cref="Circle"/>. A circle is instead built as the standard
        /// AutoCAD two-vertex trick: two points <c>2r</c> apart with bulge <c>1.0</c> on each of the
        /// two implied segments traces a full circle — no boundary entity is created in the drawing
        /// either way.
        /// </summary>
        private static void AppendOneLoop(Hatch hatch, Database db, HatchLoopDto loop, HatchLoopTypes loopType)
        {
            if (loop.Handles is { Count: > 0 } handles)
            {
                var ids = new ObjectIdCollection();
                foreach (var h in handles)
                {
                    if (!HandleConvert.TryResolve(db, h, out var id)) throw PluginExceptions.EntityNotFound(h);
                    ids.Add(id);
                }
                hatch.AppendLoop(loopType, ids);
                return;
            }

            if (loop.Circle is { } circle)
            {
                if (circle.Radius <= 0) throw PluginExceptions.InvalidGeometry("hatch loop circle radius must be > 0.");
                var cx = circle.Center.X;
                var cy = circle.Center.Y;
                var vertices = new Point2dCollection(new[]
                {
                    new Point2d(cx - circle.Radius, cy),
                    new Point2d(cx + circle.Radius, cy),
                });
                var bulges = new DoubleCollection(new[] { 1.0, 1.0 });
                hatch.AppendLoop(loopType | HatchLoopTypes.Polyline, vertices, bulges);
                return;
            }

            if (loop.Points is { Count: >= 3 } points)
            {
                var vertices = new Point2dCollection();
                var bulges = new DoubleCollection();
                for (var i = 0; i < points.Count; i++)
                {
                    vertices.Add(new Point2d(points[i].X, points[i].Y));
                    bulges.Add(loop.Bulges != null && i < loop.Bulges.Count ? loop.Bulges[i] : 0.0);
                }
                hatch.AppendLoop(loopType | HatchLoopTypes.Polyline, vertices, bulges);
                return;
            }

            throw PluginExceptions.InvalidGeometry(
                "each hatch loop requires \"handles\" (\u2265 1), \"points\" (\u2265 3), or \"circle\".");
        }

        private static HatchStyle ParseHatchStyle(string? style) => style switch
        {
            null => HatchStyle.Normal,
            "normal" => HatchStyle.Normal,
            "outer" => HatchStyle.Outer,
            "ignore" => HatchStyle.Ignore,
            _ => throw PluginExceptions.InvalidGeometry($"Unknown hatch style \"{style}\"."),
        };

        private static List<EntityRefDto> ApplyInPlace(Transaction tr, Database db, List<string> handles, Matrix3d matrix)
        {
            var affected = new List<EntityRefDto>();
            foreach (var handle in handles)
            {
                if (!HandleConvert.TryResolve(db, handle, out var id)) throw PluginExceptions.EntityNotFound(handle);
                var entity = (Entity)tr.GetObject(id, OpenMode.ForWrite);
                entity.TransformBy(matrix);
                if (entity is BlockReference blockRef)
                {
                    // BlockReference.TransformBy does not cascade to owned AttributeReferences.
                    foreach (ObjectId attId in blockRef.AttributeCollection)
                    {
                        ((AttributeReference)tr.GetObject(attId, OpenMode.ForWrite)).TransformBy(matrix);
                    }
                }
                affected.Add(new EntityRefDto { Handle = handle, Kind = EntityKindResolver.KindOf(entity), Layer = entity.Layer });
            }
            return affected;
        }

        private static List<EntityRefDto> ApplyAsCopy(Transaction tr, Database db, List<string> handles, Matrix3d matrix)
        {
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
            var affected = new List<EntityRefDto>();
            foreach (var handle in handles)
            {
                if (!HandleConvert.TryResolve(db, handle, out var id)) throw PluginExceptions.EntityNotFound(handle);
                var source = (Entity)tr.GetObject(id, OpenMode.ForRead);
                var clone = (Entity)source.Clone();
                clone.TransformBy(matrix);
                ms.AppendEntity(clone);
                tr.AddNewlyCreatedDBObject(clone, true);
                EntityOwnership.Stamp(tr, clone);
                affected.Add(new EntityRefDto { Handle = clone.Handle.ToString(), Kind = EntityKindResolver.KindOf(clone), Layer = clone.Layer });
            }
            return affected;
        }

        /// <summary>
        /// Rectangular array (#20): non-associative copies at every row/column position except the
        /// source's own, in row-major order, each position holding one copy per source handle.
        /// </summary>
        private static List<EntityRefDto> ApplyArrayRect(Transaction tr, Database db, EntityTransformRequest request)
        {
            var rows = Require(request.Rows, "rows");
            var columns = Require(request.Columns, "columns");
            var rowStep = new Vector3d(0, Require(request.RowSpacing, "rowSpacing"), 0);
            var columnStep = new Vector3d(Require(request.ColumnSpacing, "columnSpacing"), 0, 0);
            var axes = Matrix3d.Rotation(request.Angle ?? 0.0, Vector3d.ZAxis, Point3d.Origin);
            var affected = new List<EntityRefDto>();
            for (var row = 0; row < rows; row++)
            {
                for (var column = 0; column < columns; column++)
                {
                    if (row == 0 && column == 0) continue;
                    var offset = (rowStep * row + columnStep * column).TransformBy(axes);
                    affected.AddRange(ApplyAsCopy(tr, db, request.Handles, Matrix3d.Displacement(offset)));
                }
            }
            return affected;
        }

        /// <summary>
        /// Polar array (#20): <c>count</c> items including the source around <c>center</c>, spread
        /// over <c>fillAngle</c> (full circle by default). With <c>rotateItems</c> false, each copy is
        /// only moved so its extents centre follows the circle.
        /// </summary>
        private static List<EntityRefDto> ApplyArrayPolar(Transaction tr, Database db, EntityTransformRequest request)
        {
            var center = RequireCenter(request).ToPoint3d();
            var count = Require(request.Count, "count");
            var fill = request.FillAngle ?? 2 * Math.PI;
            var fullCircle = Math.Abs(Math.Abs(fill) - 2 * Math.PI) < 1e-9;
            var step = fullCircle ? fill / count : fill / (count - 1);
            var rotateItems = request.RotateItems ?? true;
            var affected = new List<EntityRefDto>();
            for (var i = 1; i < count; i++)
            {
                var rotation = Matrix3d.Rotation(step * i, Vector3d.ZAxis, center);
                if (rotateItems)
                {
                    affected.AddRange(ApplyAsCopy(tr, db, request.Handles, rotation));
                    continue;
                }
                foreach (var handle in request.Handles)
                {
                    if (!HandleConvert.TryResolve(db, handle, out var id)) throw PluginExceptions.EntityNotFound(handle);
                    var extents = ((Entity)tr.GetObject(id, OpenMode.ForRead)).GeometricExtents;
                    var reference = extents.MinPoint + (extents.MaxPoint - extents.MinPoint) / 2;
                    var move = Matrix3d.Displacement(reference.TransformBy(rotation) - reference);
                    affected.AddRange(ApplyAsCopy(tr, db, new List<string> { handle }, move));
                }
            }
            return affected;
        }

        /// <summary>
        /// Mirrors `contracts/mcp-tools`'s `MAX_ARRAY_COPIES` — arrayRect/arrayPolar are capped
        /// before this RPC is ever called (`server/src/tools/normalize.ts`); a
        /// `path: { handle }` path's length is only known once resolved here, so
        /// <see cref="ApplyArrayPath"/> enforces the cap itself.
        /// </summary>
        private const int MaxArrayCopies = 5000;

        /// <summary>
        /// Path/linear array (#20): equal arc-length spacing along an existing curve
        /// (<c>path.handle</c> — line/arc/polyline or any other <see cref="Curve"/>-derived
        /// entity) or an explicit straight-segment path (<c>path.points</c>, built as a
        /// transient, non-database-resident <see cref="Polyline"/> so both forms resolve through
        /// the same <see cref="Curve.GetDistanceAtParameter"/>/<see cref="Curve.GetPointAtDist"/>/
        /// <see cref="Curve.GetFirstDerivative(double)"/> arc-length API). <c>count</c> items are
        /// spaced evenly across the whole path including both endpoints (AutoCAD ARRAYPATH's
        /// "Divide" method); <c>spacing</c> places items every <c>spacing</c> from the path's
        /// start (its "Measure" method — a remainder short of <c>spacing</c> gets no extra item).
        /// <c>align</c> (default true, matching arrayPolar's <c>rotateItems</c> default) rotates
        /// each copy about its own extents centre by the path's tangent-angle change since the
        /// start; <c>false</c> only translates, keeping the source's own orientation.
        /// Non-associative — same <c>Clone()</c> + <c>TransformBy</c> copy path
        /// (<see cref="ApplyAsCopy"/>) as arrayRect/arrayPolar.
        /// </summary>
        private static List<EntityRefDto> ApplyArrayPath(Transaction tr, Database db, EntityTransformRequest request)
        {
            var path = request.Path ?? throw PluginExceptions.InvalidGeometry("Missing required field \"path\".");
            Curve curve;
            var transient = false;
            if (!string.IsNullOrEmpty(path.Handle))
            {
                if (!HandleConvert.TryResolve(db, path.Handle!, out var id)) throw PluginExceptions.EntityNotFound(path.Handle!);
                if (tr.GetObject(id, OpenMode.ForRead) is not Curve resolved)
                {
                    throw PluginExceptions.InvalidGeometry(
                        $"arrayPath path handle \"{path.Handle}\" must be a curve entity (line, arc, polyline, …).");
                }
                curve = resolved;
            }
            else if (path.Points is { Count: >= 2 } points)
            {
                var pl = new Polyline();
                for (var i = 0; i < points.Count; i++)
                {
                    pl.AddVertexAt(i, new Point2d(points[i].X, points[i].Y), 0, 0, 0);
                }
                curve = pl;
                transient = true;
            }
            else
            {
                throw PluginExceptions.InvalidGeometry("arrayPath requires \"path.handle\" or \"path.points\" (>= 2 points).");
            }

            try
            {
                var length = curve.GetDistanceAtParameter(curve.EndParam);
                double[] distances;
                if (request.Count.HasValue)
                {
                    var count = request.Count.Value;
                    if (count < 2) throw PluginExceptions.InvalidGeometry("arrayPath count must be >= 2.");
                    var step = length / (count - 1);
                    distances = new double[count];
                    for (var i = 0; i < count; i++) distances[i] = i * step;
                }
                else if (request.Spacing.HasValue)
                {
                    var spacing = request.Spacing.Value;
                    if (spacing <= 0) throw PluginExceptions.InvalidGeometry("arrayPath spacing must be > 0.");
                    var extraItems = (int)Math.Floor(length / spacing + 1e-9);
                    distances = new double[extraItems + 1];
                    for (var i = 0; i < distances.Length; i++) distances[i] = Math.Min(i * spacing, length);
                }
                else
                {
                    throw PluginExceptions.InvalidGeometry("arrayPath requires exactly one of \"count\" or \"spacing\".");
                }

                var totalCopies = (distances.Length - 1) * request.Handles.Count;
                if (totalCopies > MaxArrayCopies)
                {
                    throw PluginExceptions.InvalidGeometry(
                        $"arrayPath would create {totalCopies} copies (limit {MaxArrayCopies}); use a larger spacing or fewer items, or split it.");
                }

                var align = request.Align ?? true;
                var origin = curve.GetPointAtDist(distances[0]);
                var originTangent = curve.GetFirstDerivative(distances[0]);
                var originAngle = Math.Atan2(originTangent.Y, originTangent.X);

                var affected = new List<EntityRefDto>();
                for (var i = 1; i < distances.Length; i++)
                {
                    var delta = curve.GetPointAtDist(distances[i]) - origin;
                    foreach (var handle in request.Handles)
                    {
                        Matrix3d matrix;
                        if (align)
                        {
                            if (!HandleConvert.TryResolve(db, handle, out var id)) throw PluginExceptions.EntityNotFound(handle);
                            var extents = ((Entity)tr.GetObject(id, OpenMode.ForRead)).GeometricExtents;
                            var reference = extents.MinPoint + (extents.MaxPoint - extents.MinPoint) / 2;
                            var tangent = curve.GetFirstDerivative(distances[i]);
                            var angle = Math.Atan2(tangent.Y, tangent.X) - originAngle;
                            matrix = Matrix3d.Displacement(delta) * Matrix3d.Rotation(angle, Vector3d.ZAxis, reference);
                        }
                        else
                        {
                            matrix = Matrix3d.Displacement(delta);
                        }
                        affected.AddRange(ApplyAsCopy(tr, db, new List<string> { handle }, matrix));
                    }
                }
                return affected;
            }
            finally
            {
                if (transient) curve.Dispose();
            }
        }

        private static List<EntityRefDto> ApplyMirror(Transaction tr, Database db, EntityTransformRequest request)
        {
            var axisStart = RequireAxisStart(request).ToPoint3d();
            var axisEnd = RequireAxisEnd(request).ToPoint3d();
            var matrix = Matrix3d.Mirroring(new Line3d(axisStart, axisEnd));

            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
            var affected = new List<EntityRefDto>();
            if (request.Erase == true)
            {
                EntityOwnership.Guard(tr, db, request.Handles, "erase");
            }
            foreach (var handle in request.Handles)
            {
                if (!HandleConvert.TryResolve(db, handle, out var id)) throw PluginExceptions.EntityNotFound(handle);
                var source = (Entity)tr.GetObject(id, request.Erase == true ? OpenMode.ForWrite : OpenMode.ForRead);
                var clone = (Entity)source.Clone();
                clone.TransformBy(matrix);
                ms.AppendEntity(clone);
                tr.AddNewlyCreatedDBObject(clone, true);
                EntityOwnership.Stamp(tr, clone);
                affected.Add(new EntityRefDto { Handle = clone.Handle.ToString(), Kind = EntityKindResolver.KindOf(clone), Layer = clone.Layer });
                if (request.Erase == true) source.Erase();
            }
            return affected;
        }

        /// <summary>
        /// <paramref name="includeBounds"/> = false (#10) skips <c>entity.Bounds</c> — by far the
        /// most expensive part of this method on a large drawing — entirely; callers that only
        /// need handle/kind/layer (e.g. entity.list with includeBounds: false) should pass false.
        /// </summary>
        internal static EntitySummaryDto ToSummary(Entity entity, bool includeBounds = true)
        {
            var summary = new EntitySummaryDto
            {
                Handle = entity.Handle.ToString(),
                Kind = EntityKindResolver.KindOf(entity),
                Layer = entity.Layer,
            };
            if (!includeBounds)
            {
                return summary;
            }
            var bounds = entity.Bounds;
            if (bounds.HasValue)
            {
                summary.Bounds = new BoundsDto
                {
                    Min = Point3dDto.From(bounds.Value.MinPoint),
                    Max = Point3dDto.From(bounds.Value.MaxPoint),
                };
            }
            return summary;
        }

        /// <summary>
        /// `entity.get`/`entity.list`'s `detail: "full"` (#25): common properties + kind-specific
        /// geometry read straight from the live AutoCAD entity (<c>Circle.Center</c>/<c>Radius</c>,
        /// <c>Line.StartPoint</c>/<c>EndPoint</c>, <c>Dimension.Measurement</c>, …) — never a second
        /// copy of what was originally requested at create time. <paramref name="includeBounds"/>
        /// mirrors <see cref="ToSummary"/>'s opt-out (#10). <paramref name="tr"/> is needed to open a
        /// <c>blockReference</c>'s <c>AttributeReference</c> children.
        /// </summary>
        internal static EntityDetailDto ToDetail(Transaction tr, Entity entity, bool includeBounds = true)
        {
            var kind = EntityKindResolver.KindOf(entity);
            var detail = new EntityDetailDto
            {
                Handle = entity.Handle.ToString(),
                Kind = kind,
                Layer = entity.Layer,
                Properties = ToProperties(entity),
                Geometry = BuildGeometry(tr, entity, kind),
            };
            if (!includeBounds)
            {
                return detail;
            }
            var bounds = entity.Bounds;
            if (bounds.HasValue)
            {
                detail.Bounds = new BoundsDto
                {
                    Min = Point3dDto.From(bounds.Value.MinPoint),
                    Max = Point3dDto.From(bounds.Value.MaxPoint),
                };
            }
            return detail;
        }

        /// <summary>Common properties beyond `layer` (#25): <c>color</c>/<c>linetype</c>/<c>lineweight</c> are ByLayer/ByBlock-aware (see <see cref="Dto.EntityPropertiesDto"/>).</summary>
        internal static EntityPropertiesDto ToProperties(Entity entity)
        {
            var transparency = entity.Transparency;
            return new EntityPropertiesDto
            {
                Color = ColorConvert.FromAcadColor(entity.Color),
                Linetype = entity.Linetype,
                LinetypeScale = entity.LinetypeScale,
                Lineweight = (int)entity.LineWeight,
                Transparency = transparency.IsByLayer || transparency.IsByBlock
                    ? (int?)null
                    : (int)System.Math.Round(100 - (transparency.Alpha / 255.0 * 100)),
                Visible = entity.Visible,
            };
        }

        /// <summary>
        /// Kind-specific `EntityDetail.geometry` (#25). Falls back to <see cref="OtherGeometryDto"/>
        /// for any kind <see cref="EntityKindResolver"/> doesn't otherwise name — never throws on an
        /// unrecognized CLR type.
        /// </summary>
        internal static object BuildGeometry(Transaction tr, Entity entity, string kind) => kind switch
        {
            "line" => BuildLineGeometry((Line)entity),
            "circle" => BuildCircleGeometry((Circle)entity),
            "arc" => BuildArcGeometry((Arc)entity),
            "polyline" => BuildPolylineGeometry((Polyline)entity),
            "mtext" => BuildMTextGeometry((MText)entity),
            "text.singleLine" => BuildSingleLineTextGeometry((DBText)entity),
            "blockReference" => BuildBlockReferenceGeometry(tr, (BlockReference)entity),
            "dimension.linear" => BuildLinearDimensionGeometry((RotatedDimension)entity),
            "dimension.aligned" => BuildAlignedDimensionGeometry((AlignedDimension)entity),
            "dimension.ordinate" => BuildOrdinateDimensionGeometry((OrdinateDimension)entity),
            "hatch" => BuildHatchGeometry(tr, (Hatch)entity),
            _ => new OtherGeometryDto { DxfName = EntityKindResolver.DxfNameOf(entity) },
        };

        private static LineGeometryDto BuildLineGeometry(Line line) => new LineGeometryDto
        {
            Start = Point3dDto.From(line.StartPoint),
            End = Point3dDto.From(line.EndPoint),
            Length = line.Length,
        };

        private static CircleGeometryDto BuildCircleGeometry(Circle circle) => new CircleGeometryDto
        {
            Center = Point3dDto.From(circle.Center),
            Radius = circle.Radius,
        };

        private static ArcGeometryDto BuildArcGeometry(Arc arc) => new ArcGeometryDto
        {
            Center = Point3dDto.From(arc.Center),
            Radius = arc.Radius,
            StartAngle = arc.StartAngle,
            EndAngle = arc.EndAngle,
        };

        /// <summary><c>Area</c> is only meaningful for a closed polyline and throws on a self-intersecting one — both map to a null, never a thrown error here.</summary>
        private static PolylineGeometryDto BuildPolylineGeometry(Polyline pl)
        {
            var vertices = new List<PolylineVertexDto>();
            for (var i = 0; i < pl.NumberOfVertices; i++)
            {
                var bulge = pl.GetBulgeAt(i);
                var startWidth = pl.GetStartWidthAt(i);
                var endWidth = pl.GetEndWidthAt(i);
                vertices.Add(new PolylineVertexDto
                {
                    Point = Point3dDto.From(pl.GetPoint3dAt(i)),
                    Bulge = bulge == 0 ? (double?)null : bulge,
                    StartWidth = startWidth == 0 ? (double?)null : startWidth,
                    EndWidth = endWidth == 0 ? (double?)null : endWidth,
                });
            }
            double? area = null;
            if (pl.Closed)
            {
                try { area = pl.Area; }
                catch (Autodesk.AutoCAD.Runtime.Exception) { area = null; }
            }
            return new PolylineGeometryDto
            {
                Vertices = vertices,
                Closed = pl.Closed,
                Length = pl.Length,
                Area = area,
            };
        }

        private static MTextGeometryDto BuildMTextGeometry(MText mtext) => new MTextGeometryDto
        {
            Insertion = Point3dDto.From(mtext.Location),
            Text = mtext.Contents,
            Height = mtext.TextHeight,
            Rotation = mtext.Rotation,
            Width = mtext.Width > 0 ? mtext.Width : (double?)null,
            Style = mtext.TextStyleName,
        };

        private static SingleLineTextGeometryDto BuildSingleLineTextGeometry(DBText text) => new SingleLineTextGeometryDto
        {
            Insertion = Point3dDto.From(text.Position),
            Text = text.TextString,
            Height = text.Height,
            Rotation = text.Rotation,
            Style = text.TextStyleName,
            WidthFactor = text.WidthFactor != 1.0 ? text.WidthFactor : (double?)null,
        };

        /// <summary>Reads every non-constant <see cref="AttributeReference"/> actually attached to this block reference (same set <see cref="ApplyBlockAttributes"/> created, #25) — null when there are none.</summary>
        private static BlockReferenceGeometryDto BuildBlockReferenceGeometry(Transaction tr, BlockReference br)
        {
            Dictionary<string, string>? attributes = null;
            if (br.AttributeCollection.Count > 0)
            {
                attributes = new Dictionary<string, string>();
                foreach (ObjectId attId in br.AttributeCollection)
                {
                    if (tr.GetObject(attId, OpenMode.ForRead) is AttributeReference att)
                    {
                        attributes[att.Tag] = att.TextString;
                    }
                }
            }

            NestedGeometryDto? nested = null;
            try
            {
                var btrId = br.BlockTableRecord;
                if (!btrId.IsNull && tr.GetObject(btrId, OpenMode.ForRead) is BlockTableRecord btr)
                {
                    bool isXref = btr.IsFromExternalReference || btr.IsFromOverlayReference;
                    var entities = new List<NestedGeometryEntryDto>();
                    bool truncated = false;
                    const int MaxEntities = 200;

                    var scale = new Point3dDto { X = br.ScaleFactors.X, Y = br.ScaleFactors.Y, Z = br.ScaleFactors.Z };
                    var rot = br.Rotation;
                    var pos = Point3dDto.From(br.Position);

                    foreach (ObjectId entId in btr)
                    {
                        if (entities.Count >= MaxEntities)
                        {
                            truncated = true;
                            break;
                        }

                        if (tr.GetObject(entId, OpenMode.ForRead) is Entity ent)
                        {
                            if (ent is Polyline pl)
                            {
                                var verts = new List<PolylineVertexDto>();
                                for (int i = 0; i < pl.NumberOfVertices; i++)
                                {
                                    var pt = BlockInsertTransform.TransformPoint(Point3dDto.From(pl.GetPoint3dAt(i)), scale, rot, pos);
                                    var bulge = pl.GetBulgeAt(i);
                                    var sw = pl.GetStartWidthAt(i);
                                    var ew = pl.GetEndWidthAt(i);
                                    verts.Add(new PolylineVertexDto
                                    {
                                        Point = pt,
                                        Bulge = bulge == 0 ? null : bulge,
                                        StartWidth = sw == 0 ? null : sw,
                                        EndWidth = ew == 0 ? null : ew,
                                    });
                                }
                                entities.Add(new NestedGeometryEntryDto
                                {
                                    Kind = "polyline",
                                    Geometry = new PolylineGeometryDto
                                    {
                                        Vertices = verts,
                                        Closed = pl.Closed,
                                        Length = pl.Length,
                                        Area = null,
                                    }
                                });
                            }
                            else if (ent is Line line)
                            {
                                var start = BlockInsertTransform.TransformPoint(Point3dDto.From(line.StartPoint), scale, rot, pos);
                                var end = BlockInsertTransform.TransformPoint(Point3dDto.From(line.EndPoint), scale, rot, pos);
                                entities.Add(new NestedGeometryEntryDto
                                {
                                    Kind = "line",
                                    Geometry = new LineGeometryDto
                                    {
                                        Start = start,
                                        End = end,
                                        Length = line.Length * Math.Max(Math.Abs(scale.X), Math.Abs(scale.Y)),
                                    }
                                });
                            }
                            else if (ent is Arc arc)
                            {
                                var center = BlockInsertTransform.TransformPoint(Point3dDto.From(arc.Center), scale, rot, pos);
                                entities.Add(new NestedGeometryEntryDto
                                {
                                    Kind = "arc",
                                    Geometry = new ArcGeometryDto
                                    {
                                        Center = center,
                                        Radius = BlockInsertTransform.TransformRadius(arc.Radius, scale),
                                        StartAngle = BlockInsertTransform.TransformAngle(arc.StartAngle, rot),
                                        EndAngle = BlockInsertTransform.TransformAngle(arc.EndAngle, rot),
                                    }
                                });
                            }
                            else if (ent is Circle circle)
                            {
                                var center = BlockInsertTransform.TransformPoint(Point3dDto.From(circle.Center), scale, rot, pos);
                                entities.Add(new NestedGeometryEntryDto
                                {
                                    Kind = "circle",
                                    Geometry = new CircleGeometryDto
                                    {
                                        Center = center,
                                        Radius = BlockInsertTransform.TransformRadius(circle.Radius, scale),
                                    }
                                });
                            }
                            else if (ent is AttributeDefinition attDef)
                            {
                                var ins = BlockInsertTransform.TransformPoint(Point3dDto.From(attDef.Position), scale, rot, pos);
                                entities.Add(new NestedGeometryEntryDto
                                {
                                    Kind = "text.singleLine",
                                    Geometry = new SingleLineTextGeometryDto
                                    {
                                        Insertion = ins,
                                        Text = attDef.TextString,
                                        Height = attDef.Height * Math.Abs(scale.Y),
                                        Rotation = BlockInsertTransform.TransformAngle(attDef.Rotation, rot),
                                        Style = attDef.TextStyleName,
                                        WidthFactor = attDef.WidthFactor != 1.0 ? attDef.WidthFactor : (double?)null,
                                    }
                                });
                            }
                            else if (ent is DBText dbText)
                            {
                                var ins = BlockInsertTransform.TransformPoint(Point3dDto.From(dbText.Position), scale, rot, pos);
                                entities.Add(new NestedGeometryEntryDto
                                {
                                    Kind = "text.singleLine",
                                    Geometry = new SingleLineTextGeometryDto
                                    {
                                        Insertion = ins,
                                        Text = dbText.TextString,
                                        Height = dbText.Height * Math.Abs(scale.Y),
                                        Rotation = BlockInsertTransform.TransformAngle(dbText.Rotation, rot),
                                        Style = dbText.TextStyleName,
                                        WidthFactor = dbText.WidthFactor != 1.0 ? dbText.WidthFactor : (double?)null,
                                    }
                                });
                            }
                        }
                    }

                    nested = new NestedGeometryDto
                    {
                        Entities = entities,
                        Truncated = truncated,
                        IsXref = isXref
                    };
                }
            }
            catch
            {
                // Unreadable definition -> leave nested null
            }

            return new BlockReferenceGeometryDto
            {
                BlockName = br.Name,
                Position = Point3dDto.From(br.Position),
                Scale = new Point3dDto { X = br.ScaleFactors.X, Y = br.ScaleFactors.Y, Z = br.ScaleFactors.Z },
                Rotation = br.Rotation,
                Attributes = attributes,
                NestedGeometry = nested,
            };
        }

        private static LinearDimensionGeometryDto BuildLinearDimensionGeometry(RotatedDimension dim) => new LinearDimensionGeometryDto
        {
            ExtLine1 = Point3dDto.From(dim.XLine1Point),
            ExtLine2 = Point3dDto.From(dim.XLine2Point),
            DimLinePoint = Point3dDto.From(dim.DimLinePoint),
            Rotation = dim.Rotation,
            Measurement = dim.Measurement,
            Text = dim.DimensionText,
        };

        private static AlignedDimensionGeometryDto BuildAlignedDimensionGeometry(AlignedDimension dim) => new AlignedDimensionGeometryDto
        {
            ExtLine1 = Point3dDto.From(dim.XLine1Point),
            ExtLine2 = Point3dDto.From(dim.XLine2Point),
            DimLinePoint = Point3dDto.From(dim.DimLinePoint),
            Measurement = dim.Measurement,
            Text = dim.DimensionText,
        };

        private static OrdinateDimensionGeometryDto BuildOrdinateDimensionGeometry(OrdinateDimension dim) => new OrdinateDimensionGeometryDto
        {
            Origin = Point3dDto.From(dim.Origin),
            FeaturePoint = Point3dDto.From(dim.DefiningPoint),
            LeaderEndPoint = Point3dDto.From(dim.LeaderEndPoint),
            Axis = dim.UsingXAxis ? "x" : "y",
            Measurement = dim.Measurement,
            Text = dim.DimensionText,
        };

        /// <summary>Loop count/types only — never a full vertex dump (#25); <c>Area</c> throws on an unevaluated/self-intersecting hatch, mapped to null instead.</summary>
        private static HatchGeometryDto BuildHatchGeometry(Transaction tr, Hatch hatch)
        {
            var loopTypes = new List<string>();
            for (var i = 0; i < hatch.NumberOfLoops; i++)
            {
                loopTypes.Add(hatch.LoopTypeAt(i).ToString());
            }
            double? area = null;
            try { area = hatch.Area; }
            catch (Autodesk.AutoCAD.Runtime.Exception) { area = null; }

            List<HatchBoundaryLoopDto>? boundaryLoops = null;
            bool truncated = false;
            const int MaxVerticesPerHatch = 200;
            int totalVertices = 0;

            try
            {
                boundaryLoops = new List<HatchBoundaryLoopDto>();
                var plane = hatch.GetPlane();

                for (int i = 0; i < hatch.NumberOfLoops; i++)
                {
                    if (totalVertices >= MaxVerticesPerHatch)
                    {
                        truncated = true;
                        break;
                    }

                    var loop = hatch.GetLoopAt(i);
                    var loopTypeStr = hatch.LoopTypeAt(i).ToString();
                    var vertices = new List<Point3dDto>();

                    if (loop.IsPolyline)
                    {
                        var bvc = loop.Polyline;
                        for (int v = 0; v < bvc.Count; v++)
                        {
                            if (totalVertices >= MaxVerticesPerHatch)
                            {
                                truncated = true;
                                break;
                            }
                            var bv = bvc[v];
                            var pt3d = plane.EvaluatePoint(bv.Vertex);
                            vertices.Add(Point3dDto.From(pt3d));
                            totalVertices++;
                        }
                    }
                    else
                    {
                        var curves = loop.Curves;
                        for (int c = 0; c < curves.Count; c++)
                        {
                            if (totalVertices >= MaxVerticesPerHatch)
                            {
                                truncated = true;
                                break;
                            }
                            var curve = curves[c];
                            if (curve is Autodesk.AutoCAD.Geometry.CircularArc2d arc2d)
                            {
                                var samplePts = arc2d.GetSamplePoints(16);
                                foreach (var p2d in samplePts)
                                {
                                    if (totalVertices >= MaxVerticesPerHatch)
                                    {
                                        truncated = true;
                                        break;
                                    }
                                    vertices.Add(Point3dDto.From(plane.EvaluatePoint(p2d)));
                                    totalVertices++;
                                }
                            }
                            else if (curve != null)
                            {
                                if (curve.HasStartPoint)
                                {
                                    vertices.Add(Point3dDto.From(plane.EvaluatePoint(curve.StartPoint)));
                                    totalVertices++;
                                }
                                if (curve.HasEndPoint && totalVertices < MaxVerticesPerHatch)
                                {
                                    vertices.Add(Point3dDto.From(plane.EvaluatePoint(curve.EndPoint)));
                                    totalVertices++;
                                }
                            }
                        }
                    }

                    // Fallback to associative boundary objects if vertices could not be read
                    if (vertices.Count == 0 && hatch.Associative)
                    {
                        try
                        {
                            var assocIds = hatch.GetAssociatedObjectIdsAt(i);
                            foreach (ObjectId bId in assocIds)
                            {
                                if (totalVertices >= MaxVerticesPerHatch)
                                {
                                    truncated = true;
                                    break;
                                }
                                if (tr.GetObject(bId, OpenMode.ForRead) is Entity bEnt)
                                {
                                    if (bEnt is Polyline bPl)
                                    {
                                        for (int pv = 0; pv < bPl.NumberOfVertices; pv++)
                                        {
                                            if (totalVertices >= MaxVerticesPerHatch) { truncated = true; break; }
                                            vertices.Add(Point3dDto.From(bPl.GetPoint3dAt(pv)));
                                            totalVertices++;
                                        }
                                    }
                                    else if (bEnt is Line bLine)
                                    {
                                        vertices.Add(Point3dDto.From(bLine.StartPoint));
                                        vertices.Add(Point3dDto.From(bLine.EndPoint));
                                        totalVertices += 2;
                                    }
                                    else if (bEnt is Circle bCirc)
                                    {
                                        vertices.Add(Point3dDto.From(bCirc.Center));
                                        totalVertices++;
                                    }
                                }
                            }
                        }
                        catch
                        {
                            // Ignore fallback failure
                        }
                    }

                    boundaryLoops.Add(new HatchBoundaryLoopDto
                    {
                        LoopType = loopTypeStr,
                        Area = null,
                        Closed = true,
                        Vertices = vertices
                    });
                }
            }
            catch
            {
                // Boundary loop reading failure -> leave boundaryLoops as null
            }

            return new HatchGeometryDto
            {
                Pattern = hatch.PatternName,
                PatternScale = hatch.PatternScale,
                PatternAngle = hatch.PatternAngle,
                Associative = hatch.Associative,
                LoopCount = hatch.NumberOfLoops,
                LoopTypes = loopTypes,
                Area = area,
                BoundaryLoops = boundaryLoops,
                Truncated = truncated ? true : (bool?)null,
            };
        }

        private static T Require<T>(T? value, string field) where T : class =>
            value ?? throw PluginExceptions.InvalidGeometry($"Missing required field \"{field}\".");

        private static double Require(double? value, string field) =>
            value ?? throw PluginExceptions.InvalidGeometry($"Missing required field \"{field}\".");

        private static int Require(int? value, string field) =>
            value ?? throw PluginExceptions.InvalidGeometry($"Missing required field \"{field}\".");

        private static Point3dDto RequireDelta(EntityTransformRequest r) => Require(r.Delta, "delta");
        private static Point3dDto RequireCenter(EntityTransformRequest r) => Require(r.Center, "center");
        private static double RequireAngle(EntityTransformRequest r) => Require(r.Angle, "angle");
        private static double RequireFactor(EntityTransformRequest r) => Require(r.Factor, "factor");
        private static Point3dDto RequireAxisStart(EntityTransformRequest r) => Require(r.AxisStart, "axisStart");
        private static Point3dDto RequireAxisEnd(EntityTransformRequest r) => Require(r.AxisEnd, "axisEnd");
    }
}
