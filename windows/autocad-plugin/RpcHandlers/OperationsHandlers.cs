using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using CadAI.AutoCAD.Journal;
using CadAI.AutoCAD.Util;
using Newtonsoft.Json.Linq;
using StreamJsonRpc;
namespace CadAI.AutoCAD.RpcHandlers
{
    /// <summary>
    /// Batches multiple entity mutations into one AutoCAD transaction plus one native undo group
    /// (<c>operations.apply</c>), and exposes LIFO undo/redo against the resulting per-document
    /// <see cref="BatchJournal"/> (<c>operations.undo</c>/<c>operations.redo</c>/<c>operations.history</c>).
    /// See docs/PROTOCOL.md and specs/done/entity-and-operations-expansion/README.md.
    /// </summary>
    public sealed class OperationsHandlers
    {
        [JsonRpcMethod("operations.apply", UseSingleObjectParameterDeserialization = true)]
        public Task<OperationsApplyResult> Apply(OperationsApplyRequest request, CancellationToken ct = default) =>
            CadOperationScheduler.ExecuteAsync(request, ct);

        [JsonRpcMethod("operations.preview", UseSingleObjectParameterDeserialization = true)]
        public Task<OperationsPreviewResult> Preview(OperationsPreviewRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                var db = doc.Database;

                // Preview runs in an isolated transaction that is ALWAYS aborted.
                // It NEVER creates a native undo group, never invokes ScreenRefresh,
                // and never writes to BatchJournal or CadTaskLedger.
                using var tr = db.TransactionManager.StartTransaction();
                var stepIndex = 0;
                try
                {
                    var predictedRefs = new List<EntityRefDto>();
                    BoundsDto? combinedExtents = null;

                    for (; stepIndex < request.Operations.Count; stepIndex++)
                    {
                        var op = request.Operations[stepIndex];
                        List<EntityRefDto> stepRefs;

                        switch (op.Op)
                        {
                            case "create":
                                if (op.Entity == null)
                                {
                                    throw PluginExceptions.InvalidGeometry("create op requires \"entity\".");
                                }
                                var created = EntityHandlers.CreateOne(tr, db, op.Entity, doc.Name);
                                stepRefs = new List<EntityRefDto> { created };

                                // Calculate extents of the newly created entity
                                if (HandleConvert.TryResolve(db, created.Handle, out var id) && !id.IsErased)
                                {
                                    var ent = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                    var detail = EntityHandlers.ToDetail(tr, ent, includeBounds: true);
                                    if (detail.Bounds != null)
                                    {
                                        if (combinedExtents == null)
                                        {
                                            combinedExtents = new BoundsDto
                                            {
                                                Min = new Point3dDto { X = detail.Bounds.Min.X, Y = detail.Bounds.Min.Y, Z = detail.Bounds.Min.Z },
                                                Max = new Point3dDto { X = detail.Bounds.Max.X, Y = detail.Bounds.Max.Y, Z = detail.Bounds.Max.Z }
                                            };
                                        }
                                        else
                                        {
                                            combinedExtents.Min.X = Math.Min(combinedExtents.Min.X, detail.Bounds.Min.X);
                                            combinedExtents.Min.Y = Math.Min(combinedExtents.Min.Y, detail.Bounds.Min.Y);
                                            combinedExtents.Min.Z = Math.Min(combinedExtents.Min.Z, detail.Bounds.Min.Z);
                                            combinedExtents.Max.X = Math.Max(combinedExtents.Max.X, detail.Bounds.Max.X);
                                            combinedExtents.Max.Y = Math.Max(combinedExtents.Max.Y, detail.Bounds.Max.Y);
                                            combinedExtents.Max.Z = Math.Max(combinedExtents.Max.Z, detail.Bounds.Max.Z);
                                        }
                                    }
                                }
                                break;

                            case "erase":
                                if (op.Handles == null || op.Handles.Count == 0)
                                {
                                    throw PluginExceptions.InvalidGeometry("erase op requires \"handles\".");
                                }
                                stepRefs = EntityHandlers.EraseMany(tr, db, op.Handles);
                                break;

                            case "transform":
                                if (op.Transform == null)
                                {
                                    throw PluginExceptions.InvalidGeometry("transform op requires \"transform\".");
                                }
                                stepRefs = EntityHandlers.TransformOne(tr, db, op.Transform);
                                break;

                            case "update":
                                if (op.Update == null || string.IsNullOrWhiteSpace(op.Update.Handle))
                                    throw PluginExceptions.InvalidGeometry("update op requires \"update.handle\".");
                                var updated = EntityHandlers.UpdateOne(tr, db, op.Update);
                                stepRefs = new List<EntityRefDto>
                                {
                                    new EntityRefDto
                                    {
                                        Handle = updated.Handle.ToString(),
                                        Kind = EntityKindResolver.KindOf(updated),
                                        Layer = updated.Layer
                                    }
                                };
                                break;
                            default:
                                throw PluginExceptions.InvalidGeometry($"Unknown batch op \"{op.Op}\".");
                        }

                        predictedRefs.AddRange(stepRefs);
                    }

                    // Always abort the transaction — preview leaves 0 changes in database!
                    tr.Abort();

                    return new OperationsPreviewResult
                    {
                        Valid = true,
                        OperationCount = request.Operations.Count,
                        EntityRefs = predictedRefs,
                        Extents = combinedExtents
                    };
                }
                catch (LocalRpcException ex)
                {
                    tr.Abort();
                    return new OperationsPreviewResult
                    {
                        Valid = false,
                        OperationCount = request.Operations.Count,
                        Error = new ErrorInfoDto
                        {
                            Code = ex.ErrorCode,
                            Message = ex.Message,
                            FailedStep = stepIndex,
                            CauseCode = ex.ErrorCode
                        }
                    };
                }
                catch (Exception ex)
                {
                    tr.Abort();
                    return new OperationsPreviewResult
                    {
                        Valid = false,
                        OperationCount = request.Operations.Count,
                        Error = new ErrorInfoDto
                        {
                            Code = PluginErrorCodes.TransactionFailed,
                            Message = ex.Message,
                            FailedStep = stepIndex,
                            CauseCode = (ex as LocalRpcException)?.ErrorCode
                        }
                    };
                }
            });
        [JsonRpcMethod("operations.revert", UseSingleObjectParameterDeserialization = true)]
        public Task<OperationsRevertResult> Revert(OperationsRevertRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (string.IsNullOrWhiteSpace(request.BatchId) && string.IsNullOrWhiteSpace(request.TaskId))
                {
                    throw PluginExceptions.InvalidOperation("Either batchId or taskId must be specified for operations.revert.");
                }

                var doc = DocumentContext.Resolve(request.DocumentName);
                var db = doc.Database;
                CadTaskLedger.EnsureLoaded(doc.Name);

                // Resolve target change sets
                List<TaskChangeSet> targets;
                if (!string.IsNullOrWhiteSpace(request.BatchId))
                {
                    var cs = CadTaskLedger.FindByBatchId(doc.Name, request.BatchId!)
                        ?? throw PluginExceptions.BatchNotFound(request.BatchId!);
                    if (cs.Status == "reverted")
                    {
                        throw PluginExceptions.RevertConflict(cs.BatchId, "", $"Batch \"{request.BatchId}\" has already been reverted.");
                    }
                    targets = new List<TaskChangeSet> { cs };
                }
                else
                {
                    var list = CadTaskLedger.FindByTaskId(doc.Name, request.TaskId!);
                    if (list == null || list.Count == 0)
                    {
                        throw PluginExceptions.BatchNotFound(request.TaskId!);
                    }
                    var pending = list.Where(c => c.Status != "reverted").OrderByDescending(c => c.Sequence).ToList();
                    if (pending.Count == 0)
                    {
                        throw PluginExceptions.RevertConflict(request.TaskId!, "", $"All change sets for task \"{request.TaskId}\" have already been reverted.");
                    }
                    targets = pending;
                }

                // Step 1: Dependency Conflict Detection
                using (var trRead = db.TransactionManager.StartTransaction())
                {
                    foreach (var cs in targets)
                    {
                        foreach (var handle in cs.CreatedHandles)
                        {
                            if (!HandleConvert.TryResolve(db, handle, out var id) || id.IsErased)
                            {
                                throw PluginExceptions.RevertConflict(
                                    cs.BatchId,
                                    handle,
                                    $"Entity \"{handle}\" created in this change set was already deleted.");
                            }
                        }

                        foreach (var mod in cs.ModifiedPreImages)
                        {
                            if (!HandleConvert.TryResolve(db, mod.Handle, out var id) || id.IsErased)
                            {
                                throw PluginExceptions.RevertConflict(
                                    cs.BatchId,
                                    mod.Handle,
                                    $"Entity \"{mod.Handle}\" was modified by this change set but has since been deleted.");
                            }

                            if (mod.After != null)
                            {
                                var ent = (Entity)trRead.GetObject(id, OpenMode.ForRead);
                                var currentDetail = EntityHandlers.ToDetail(trRead, ent, includeBounds: false);
                                var currentDigest = PreImageCanonical.HashDetail(currentDetail);
                                var afterDigest = PreImageCanonical.HashDetail(mod.After);

                                if (!string.Equals(currentDigest, afterDigest, StringComparison.Ordinal))
                                {
                                    throw PluginExceptions.RevertConflict(
                                        cs.BatchId,
                                        mod.Handle,
                                        $"Entity \"{mod.Handle}\" has been modified since change set was committed (state fingerprint mismatch).");
                                }
                            }
                        }
                    }
                    trRead.Commit();
                }

                // Step 2: Forward Compensating Transaction
                var nativeUndo = ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument);
                if (nativeUndo) RunSuppressed(doc.Name, () => doc.Editor.Command("_.UNDO", "_Group"));

                var erasedHandles = new List<string>();
                var recreatedHandles = new List<string>();
                var restoredHandles = new List<string>();

                try
                {
                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        foreach (var cs in targets)
                        {
                            // 1. Erase created entities
                            foreach (var handle in cs.CreatedHandles)
                            {
                                if (HandleConvert.TryResolve(db, handle, out var id) && !id.IsErased)
                                {
                                    var ent = (Entity)tr.GetObject(id, OpenMode.ForWrite);
                                    ent.Erase(true);
                                    erasedHandles.Add(handle);
                                }
                            }

                            // 2. Recreate erased entities
                            foreach (var preImage in cs.ErasedPreImages)
                            {
                                var createReq = PreImageToCreateRequest(preImage);
                                var recreated = EntityHandlers.CreateOne(tr, db, createReq, doc.Name);
                                if (preImage.Detail.Properties != null)
                                {
                                    var updateReq = DetailToUpdateRequest(preImage.Detail);
                                    updateReq.Handle = recreated.Handle;
                                    updateReq.Geometry = null;
                                    EntityHandlers.UpdateOne(tr, db, updateReq);
                                }
                                recreatedHandles.Add(recreated.Handle);
                            }

                            // 3. Restore modified entities
                            foreach (var mod in cs.ModifiedPreImages)
                            {
                                if (HandleConvert.TryResolve(db, mod.Handle, out var id) && !id.IsErased)
                                {
                                    var updateReq = DetailToUpdateRequest(mod.Before);
                                    EntityHandlers.UpdateOne(tr, db, updateReq);
                                    restoredHandles.Add(mod.Handle);
                                }
                            }
                        }

                        tr.Commit();
                    }

                    foreach (var cs in targets)
                    {
                        CadTaskLedger.MarkReverted(doc.Name, cs.ChangeSetId);
                    }

                    ScreenRefresh.AfterCommit(doc);

                    return new OperationsRevertResult
                    {
                        Status = "reverted",
                        BatchId = request.BatchId,
                        TaskId = request.TaskId,
                        RevertedChangeSetsCount = targets.Count,
                        ErasedHandles = erasedHandles,
                        RecreatedHandles = recreatedHandles,
                        RestoredHandles = restoredHandles
                    };
                }
                finally
                {
                    if (nativeUndo) RunSuppressed(doc.Name, () => doc.Editor.Command("_.UNDO", "_End"));
                }
            });

        private static readonly Newtonsoft.Json.JsonSerializer WireSerializer =
            Newtonsoft.Json.JsonSerializer.Create(new Newtonsoft.Json.JsonSerializerSettings
            {
                ContractResolver = new Newtonsoft.Json.Serialization.CamelCasePropertyNamesContractResolver(),
                NullValueHandling = Newtonsoft.Json.NullValueHandling.Ignore
            });

        private static JObject ToWireJObject(object? obj) =>
            obj as JObject ?? (obj != null ? JObject.FromObject(obj, WireSerializer) : new JObject());

        private static JToken? GetProp(JObject jo, string name) =>
            jo[name] ?? (name.Length > 0 ? jo[char.ToUpperInvariant(name[0]) + name.Substring(1)] : null);

        internal static CreateEntityRequest PreImageToCreateRequest(EntityPreImage preImage)
        {
            var detail = preImage.Detail;
            var req = new CreateEntityRequest
            {
                Kind = detail.Kind,
                Layer = detail.Layer,
            };
            var geom = detail.Geometry;
            var jo = ToWireJObject(geom);
            switch (detail.Kind)
            {
                case "line":
                    req.Start = GetProp(jo, "start")?.ToObject<Point3dDto>();
                    req.End = GetProp(jo, "end")?.ToObject<Point3dDto>();
                    break;
                case "circle":
                    req.Center = GetProp(jo, "center")?.ToObject<Point3dDto>();
                    req.Radius = GetProp(jo, "radius")?.ToObject<double>();
                    break;
                case "arc":
                    req.Center = GetProp(jo, "center")?.ToObject<Point3dDto>();
                    req.Radius = GetProp(jo, "radius")?.ToObject<double>();
                    req.StartAngle = GetProp(jo, "startAngle")?.ToObject<double>();
                    req.EndAngle = GetProp(jo, "endAngle")?.ToObject<double>();
                    break;
                case "polyline":
                    var vertices = GetProp(jo, "vertices")?.ToObject<List<PolylineVertexDto>>();
                    if (vertices != null)
                    {
                        req.Points = vertices.Select(v => v.Point).ToList();
                        req.Bulges = vertices.Select(v => v.Bulge ?? 0.0).ToList();
                    }
                    req.Closed = GetProp(jo, "closed")?.ToObject<bool>();
                    req.ConstantWidth = GetProp(jo, "constantWidth")?.ToObject<double>();
                    break;
                case "mtext":
                    req.Insertion = GetProp(jo, "insertion")?.ToObject<Point3dDto>();
                    req.Text = GetProp(jo, "text")?.ToString();
                    req.Height = GetProp(jo, "height")?.ToObject<double>();
                    req.Width = GetProp(jo, "width")?.ToObject<double>();
                    break;
                case "text.singleLine":
                    req.Insertion = GetProp(jo, "insertion")?.ToObject<Point3dDto>();
                    req.Text = GetProp(jo, "text")?.ToString();
                    req.Height = GetProp(jo, "height")?.ToObject<double>();
                    req.Rotation = GetProp(jo, "rotation")?.ToObject<double>();
                    break;
                case "blockReference":
                    req.BlockName = GetProp(jo, "blockName")?.ToString();
                    req.Position = GetProp(jo, "position")?.ToObject<Point3dDto>();
                    req.Scale = GetProp(jo, "scale")?.ToObject<Point3dDto>();
                    req.Rotation = GetProp(jo, "rotation")?.ToObject<double>();
                    break;
                case "dimension.linear":
                    req.ExtLine1 = GetProp(jo, "extLine1")?.ToObject<Point3dDto>();
                    req.ExtLine2 = GetProp(jo, "extLine2")?.ToObject<Point3dDto>();
                    req.DimLinePoint = GetProp(jo, "dimLinePoint")?.ToObject<Point3dDto>();
                    req.Rotation = GetProp(jo, "rotation")?.ToObject<double>();
                    break;
                case "dimension.aligned":
                    req.ExtLine1 = GetProp(jo, "extLine1")?.ToObject<Point3dDto>();
                    req.ExtLine2 = GetProp(jo, "extLine2")?.ToObject<Point3dDto>();
                    req.DimLinePoint = GetProp(jo, "dimLinePoint")?.ToObject<Point3dDto>();
                    break;
                case "dimension.ordinate":
                    req.Origin = GetProp(jo, "origin")?.ToObject<Point3dDto>();
                    req.FeaturePoint = GetProp(jo, "featurePoint")?.ToObject<Point3dDto>();
                    req.LeaderEndPoint = GetProp(jo, "leaderEndPoint")?.ToObject<Point3dDto>();
                    req.Axis = GetProp(jo, "axis")?.ToString();
                    break;
            }

            return req;
        }

        internal static EntityUpdateRequest DetailToUpdateRequest(EntityDetailDto detail)
        {
            var req = new EntityUpdateRequest
            {
                Handle = detail.Handle,
                Layer = detail.Layer,
            };

            if (detail.Properties != null)
            {
                if (detail.Properties.Color != null)
                {
                    req.Color = new ColorSpecDto
                    {
                        Aci = detail.Properties.Color.Aci,
                        Rgb = detail.Properties.Color.Rgb
                    };
                }
                {
                    req.Linetype = detail.Properties.Linetype;
                }
                req.Lineweight = detail.Properties.Lineweight;
            }

            var geom = detail.Geometry;
            var jo = ToWireJObject(geom);

            var updateGeom = new EntityUpdateGeometryDto
            {
                Kind = detail.Kind
            };

            switch (detail.Kind)
            {
                case "line":
                    updateGeom.Start = GetProp(jo, "start")?.ToObject<Point3dDto>();
                    updateGeom.End = GetProp(jo, "end")?.ToObject<Point3dDto>();
                    break;
                case "circle":
                    updateGeom.Center = GetProp(jo, "center")?.ToObject<Point3dDto>();
                    updateGeom.Radius = GetProp(jo, "radius")?.ToObject<double>();
                    break;
                case "arc":
                    updateGeom.Center = GetProp(jo, "center")?.ToObject<Point3dDto>();
                    updateGeom.Radius = GetProp(jo, "radius")?.ToObject<double>();
                    updateGeom.StartAngle = GetProp(jo, "startAngle")?.ToObject<double>();
                    updateGeom.EndAngle = GetProp(jo, "endAngle")?.ToObject<double>();
                    break;
                case "polyline":
                    updateGeom.Closed = GetProp(jo, "closed")?.ToObject<bool>();
                    break;
                case "mtext":
                    updateGeom.Insertion = GetProp(jo, "insertion")?.ToObject<Point3dDto>();
                    updateGeom.Text = GetProp(jo, "text")?.ToString();
                    updateGeom.Height = GetProp(jo, "height")?.ToObject<double>();
                    updateGeom.Width = GetProp(jo, "width")?.ToObject<double>();
                    break;
                case "text.singleLine":
                    updateGeom.Insertion = GetProp(jo, "insertion")?.ToObject<Point3dDto>();
                    updateGeom.Text = GetProp(jo, "text")?.ToString();
                    updateGeom.Height = GetProp(jo, "height")?.ToObject<double>();
                    updateGeom.Rotation = GetProp(jo, "rotation")?.ToObject<double>();
                    break;
                case "blockReference":
                    updateGeom.Position = GetProp(jo, "position")?.ToObject<Point3dDto>();
                    updateGeom.Scale = GetProp(jo, "scale")?.ToObject<Point3dDto>();
                    updateGeom.Rotation = GetProp(jo, "rotation")?.ToObject<double>();
                    updateGeom.Attributes = GetProp(jo, "attributes")?.ToObject<Dictionary<string, string>>();
                    break;
                case "dimension.linear":
                    updateGeom.ExtLine1 = GetProp(jo, "extLine1")?.ToObject<Point3dDto>();
                    updateGeom.ExtLine2 = GetProp(jo, "extLine2")?.ToObject<Point3dDto>();
                    updateGeom.DimLinePoint = GetProp(jo, "dimLinePoint")?.ToObject<Point3dDto>();
                    updateGeom.Rotation = GetProp(jo, "rotation")?.ToObject<double>();
                    break;
                case "dimension.aligned":
                    updateGeom.ExtLine1 = GetProp(jo, "extLine1")?.ToObject<Point3dDto>();
                    updateGeom.ExtLine2 = GetProp(jo, "extLine2")?.ToObject<Point3dDto>();
                    updateGeom.DimLinePoint = GetProp(jo, "dimLinePoint")?.ToObject<Point3dDto>();
                    break;
                case "dimension.ordinate":
                    updateGeom.Origin = GetProp(jo, "origin")?.ToObject<Point3dDto>();
                    updateGeom.FeaturePoint = GetProp(jo, "featurePoint")?.ToObject<Point3dDto>();
                    updateGeom.LeaderEndPoint = GetProp(jo, "leaderEndPoint")?.ToObject<Point3dDto>();
                    break;
            }

            req.Geometry = updateGeom;
            return req;
        }
        [JsonRpcMethod("operations.undo", UseSingleObjectParameterDeserialization = true)]
        public Task<OperationsUndoResult> Undo(OperationsUndoRequest request) =>
            MainThreadDispatcher.RunAsync(async () =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                BatchJournal.EnsureHooked(doc);

                var top = BatchJournal.Top(doc.Name) ?? throw PluginExceptions.BatchNotFound(request.BatchId);
                if (top.BatchId != request.BatchId) throw PluginExceptions.UndoNotTop(request.BatchId);
                if (!top.UndoSupported) throw PluginExceptions.UndoUnsupported(request.BatchId);
                if (top.GenerationAtCommit != BatchJournal.CurrentGeneration(doc.Name))
                {
                    throw PluginExceptions.UndoStackDiverged(request.BatchId);
                }

                // A batch that had a native undo group can still only be undone from the active tab.
                if (!ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument))
                {
                    throw PluginExceptions.UndoUnsupported(request.BatchId);
                }

                return await RunNativeCommandAtPromptAsync(doc, "_.UNDO 1\n", request.BatchId, undo: true);
            });

        [JsonRpcMethod("operations.redo", UseSingleObjectParameterDeserialization = true)]
        public Task<OperationsUndoResult> Redo(OperationsUndoRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                BatchJournal.EnsureHooked(doc);

                var candidate = BatchJournal.RedoCandidate(doc.Name) ?? throw PluginExceptions.BatchNotFound(request.BatchId);
                if (candidate.BatchId != request.BatchId) throw PluginExceptions.UndoNotTop(request.BatchId);
                if (!candidate.UndoSupported) throw PluginExceptions.UndoUnsupported(request.BatchId);

                if (!ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument))
                {
                    throw PluginExceptions.UndoUnsupported(request.BatchId);
                }

                // REDO restores the most recently native-undone level (no repeat count — unlike
                // "UNDO 1"). KNOWN LIVE GAP: the native UNDO above reverts the batch's committed
                // Transaction (entity list confirms the level is gone), but the matching "_.REDO"
                // returns "redone" (CommandEnded fires) WITHOUT repopulating it — the live lane reads
                // aliveAfterRedo=[E2,E3] with E4 still absent, under both "REDO 1" and bare "_.REDO",
                // so the count argument is not the cause. Undoing a raw Transaction (not a user-typed
                // command) evidently leaves no native redo entry to restore; fixing this needs the
                // same non-nested native UNDO-group the apply path is missing (see BatchJournal /
                // CadOperationScheduler), not a command-string tweak. Left as an open redo defect.
                return RunNativeCommandAtPromptAsync(doc, "_.REDO\n", request.BatchId, undo: false);
            });

        [JsonRpcMethod("operations.history", UseSingleObjectParameterDeserialization = true)]
        public Task<OperationsHistoryResult> History(OperationsHistoryRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                var limit = request.Limit is > 0 ? request.Limit.Value : 20;
                IReadOnlyList<TaskChangeSet> items;
                if (!string.IsNullOrWhiteSpace(request.TaskId))
                {
                    items = CadTaskLedger.FindByTaskId(doc.Name, request.TaskId!);
                    if (limit > 0) items = items.Take(limit).ToList();
                }
                else
                {
                    items = CadTaskLedger.Recent(doc.Name, limit);
                }

                return new OperationsHistoryResult
                {
                    Batches = items.Select(entry => new BatchJournalEntrySummaryDto
                    {
                        BatchId = entry.BatchId,
                        TaskId = entry.TaskId,
                        Sequence = entry.Sequence,
                        TimestampUtc = entry.TimestampUtc,
                        OperationCount = entry.OperationCount,
                        EntityRefs = entry.EntityRefs,
                        Status = entry.Status,
                    }).ToList(),
                };
            });

        /// <summary>Bounded wait for a queued native command (undo/redo) to reach a command boundary.</summary>
        private const int NativeCommandTimeoutMs = 10000;

        /// <summary>
        /// Runs a native undo/redo command (e.g. "_.UNDO 1") and returns only once AutoCAD has
        /// actually finished it, then flips the journal. The committed batch's Transaction is itself
        /// the native undo level (StartTransaction = undo mark, Commit = undo end), so the level to
        /// undo always exists — the old bug was WHERE the command was issued, never that there was
        /// nothing to undo.
        ///
        /// UNDO/REDO cannot run while another command is active. They must NOT be issued inside
        /// CommandContext.RunAsync, whose ExecuteInCommandContextAsync wrapper is itself a command
        /// (CMDACTIVE==1 there): AutoCAD then silently refuses a nested command, so Editor.Command
        /// (returns void) was a no-op reported as "undone" and CommandAsync hung the RPC (15s
        /// capability.result timeout) — both caught by the live lane. Instead the command is queued
        /// at the prompt via SendStringToExecute and awaited on CommandEnded/Cancelled/Failed. The
        /// await yields this queued dispatcher item (MainThreadDispatcher.Drain is fire-and-forget),
        /// so AutoCAD's message loop is free to run the queued command.
        ///
        /// Divergence suppression is held across the whole operation so our own native command's
        /// CommandEnded does not register as a user command that diverged the undo stack, and CMDECHO/
        /// NOMUTT keep the prompt clean, same as RunSuppressed.
        /// </summary>
        private static async Task<OperationsUndoResult> RunNativeCommandAtPromptAsync(
            Document doc, string commandLine, string batchId, bool undo)
        {
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            CommandEventHandler onEnded = (_, _) => tcs.TrySetResult(true);
            CommandEventHandler onCancelled = (_, _) => tcs.TrySetResult(false);
            CommandEventHandler onFailed = (_, _) => tcs.TrySetResult(false);

            object? prevEcho = null;
            object? prevMutt = null;
            BatchJournal.Suppress(doc.Name, true);
            try
            {
                try
                {
                    prevEcho = Application.GetSystemVariable("CMDECHO");
                    prevMutt = Application.GetSystemVariable("NOMUTT");
                    Application.SetSystemVariable("CMDECHO", 0);
                    Application.SetSystemVariable("NOMUTT", 1);
                }
                catch
                {
                }

                doc.CommandEnded += onEnded;
                doc.CommandCancelled += onCancelled;
                doc.CommandFailed += onFailed;
                // activate=false: the document is already active (checked by the caller); the trailing
                // newline in commandLine submits it. echoCommand=false keeps it off the prompt history.
                doc.SendStringToExecute(commandLine, false, false, false);

                var winner = await Task.WhenAny(tcs.Task, Task.Delay(NativeCommandTimeoutMs));
                if (winner != tcs.Task)
                {
                    throw PluginExceptions.TransactionFailed(new TimeoutException(
                        $"native command \"{commandLine.Trim()}\" did not complete within {NativeCommandTimeoutMs}ms"));
                }
                var completed = await tcs.Task;

                // No ScreenRefresh on this native path: _.UNDO/_.REDO are commands AutoCAD runs and
                // regenerates itself. (A repaint between the pair is NOT what broke REDO — removing it
                // changed nothing.) KNOWN OPEN DEFECT, measured across three hypotheses, all falsified
                // on the live lane: native REDO does not restore a batch on AutoCAD 2022. undo
                // genuinely reverts (entity list: the level is gone) yet REDO reports "redone" while
                // restoring nothing, under (a) REDO with/without a count arg, (b) undo->redo with zero
                // reads between them, (c) the apply phase wrapped in a real registered command
                // (ARCDIOAPPLY) so its writes are a command-level undo record, not just a raw
                // transaction. AutoCAD 2022 REDO replays a *command action*, and neither a managed
                // transaction nor that command host performs an entity-creating action AutoCAD can
                // replay. Fixing redo needs journal replay (BatchJournal/CadTaskLedger pre-images),
                // which the "native-lifo" contract and handle stability forbid as-is — a separate,
                // contract-changing slice.
                if (undo) BatchJournal.MarkUndone(doc.Name, batchId);
                else BatchJournal.MarkRedone(doc.Name, batchId);
                return new OperationsUndoResult
                {
                    BatchId = batchId,
                    Status = completed
                        ? (undo ? "undone" : "redone")
                        : (undo ? "undo_cancelled" : "redo_cancelled")
                };
            }
            finally
            {
                doc.CommandEnded -= onEnded;
                doc.CommandCancelled -= onCancelled;
                doc.CommandFailed -= onFailed;
                try
                {
                    if (prevMutt != null) Application.SetSystemVariable("NOMUTT", prevMutt);
                    if (prevEcho != null) Application.SetSystemVariable("CMDECHO", prevEcho);
                }
                catch
                {
                }
                BatchJournal.Suppress(doc.Name, false);
            }
        }

        /// <summary>Runs <paramref name="action"/> without it counting toward divergence detection or echoing prompts to the command line.</summary>
        private static void RunSuppressed(string documentName, Action action)
        {
            BatchJournal.Suppress(documentName, true);
            object? prevCmdecho = null;
            object? prevNomutt = null;
            try
            {
                prevCmdecho = Application.GetSystemVariable("CMDECHO");
                prevNomutt = Application.GetSystemVariable("NOMUTT");
                Application.SetSystemVariable("CMDECHO", 0);
                Application.SetSystemVariable("NOMUTT", 1);
            }
            catch
            {
            }

            try
            {
                action();
            }
            finally
            {
                try
                {
                    if (prevNomutt != null) Application.SetSystemVariable("NOMUTT", prevNomutt);
                    if (prevCmdecho != null) Application.SetSystemVariable("CMDECHO", prevCmdecho);
                }
                catch
                {
                }
                BatchJournal.Suppress(documentName, false);
            }
        }
    }
}
