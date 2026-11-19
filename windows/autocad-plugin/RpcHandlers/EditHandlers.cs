using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using CadAI.AutoCAD.Journal;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    /// <summary>
    /// RPC handlers for the safe-editing workflow (PR B Slice 02).
    /// Implements <c>edit.begin</c>: captures pre-images, clones candidates to an isolated layer,
    /// and persists local edit sessions before committing the transaction.
    /// </summary>
    public sealed class EditHandlers
    {
        private readonly EditStore _editStore;

        public EditHandlers(EditStore? editStore = null)
        {
            _editStore = editStore ?? EditStore.Instance;
        }

        [JsonRpcMethod("edit.begin", UseSingleObjectParameterDeserialization = true)]
        public Task<EditBeginResult> Begin(EditBeginRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();

                    // 1. Resolve target entity IDs
                    var targetIds = new List<ObjectId>();
                    var wantsImplied = string.Equals(request?.Selection, "implied", StringComparison.OrdinalIgnoreCase);

                    if (request?.Handles != null && request.Handles.Count > 0)
                    {
                        foreach (var handle in request.Handles)
                        {
                            if (!HandleConvert.TryResolve(db, handle, out var id) || id.IsErased)
                            {
                                throw PluginExceptions.EntityNotFound(handle);
                            }
                            targetIds.Add(id);
                        }
                    }
                    else if (wantsImplied)
                    {
                        var implied = doc.Editor.SelectImplied();
                        if (implied.Status == PromptStatus.OK && implied.Value != null)
                        {
                            foreach (var id in implied.Value.GetObjectIds())
                            {
                                if (!id.IsErased) targetIds.Add(id);
                            }
                        }
                    }
                    else
                    {
                        throw PluginExceptions.InvalidOperation("Either handles or selection: \"implied\" must be provided.");
                    }

                    if (targetIds.Count == 0)
                    {
                        throw PluginExceptions.InvalidOperation("No entities resolved for edit.begin.");
                    }

                    // 2. Validate targets before cloning: layer locks, xrefs, block definitions, attribute definitions
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    var sourceEntities = new List<Entity>();

                    foreach (var id in targetIds)
                    {
                        var dbObj = tr.GetObject(id, OpenMode.ForRead);
                        if (dbObj is not Entity entity)
                        {
                            throw PluginExceptions.InvalidOperation($"Object {id.Handle} is a {dbObj.GetType().Name}, not an Entity.");
                        }

                        if (entity is AttributeDefinition)
                        {
                            throw PluginExceptions.InvalidOperation($"Entity \"{entity.Handle}\" is an AttributeDefinition; definition edits are not supported.");
                        }

                        // Locked layer refusal (LayerProtected -32012)
                        if (lt.Has(entity.Layer))
                        {
                            var ltr = (LayerTableRecord)tr.GetObject(lt[entity.Layer], OpenMode.ForRead);
                            if (ltr.IsLocked)
                            {
                                throw PluginExceptions.LayerProtected(entity.Layer);
                            }
                        }

                        // Target inside an xref or anonymous block definition
                        var ownerObj = tr.GetObject(entity.OwnerId, OpenMode.ForRead);
                        if (ownerObj is BlockTableRecord ownerBtr)
                        {
                            if (ownerBtr.IsFromExternalReference || ownerBtr.IsFromOverlayReference)
                            {
                                throw PluginExceptions.InvalidOperation($"Entity \"{entity.Handle}\" is inside an external reference and cannot be edited.");
                            }
                            if (ownerBtr.IsAnonymous || (!ownerBtr.IsLayout && ownerBtr.Name.StartsWith("*", StringComparison.Ordinal)))
                            {
                                throw PluginExceptions.InvalidOperation($"Entity \"{entity.Handle}\" is inside an anonymous block definition and cannot be edited.");
                            }
                        }

                        // Target is a blockReference referencing an external reference or anonymous definition
                        if (entity is BlockReference br)
                        {
                            var defBtr = (BlockTableRecord)tr.GetObject(br.BlockTableRecord, OpenMode.ForRead);
                            if (defBtr.IsFromExternalReference || defBtr.IsFromOverlayReference)
                            {
                                throw PluginExceptions.InvalidOperation($"Entity \"{entity.Handle}\" is an external reference and cannot be edited.");
                            }
                            if (defBtr.IsAnonymous)
                            {
                                throw PluginExceptions.InvalidOperation($"Entity \"{entity.Handle}\" is an anonymous block reference and cannot be edited.");
                            }
                        }

                        sourceEntities.Add(entity);
                    }

                    // 3. Restorability gate: evaluate Restorability.Of for each entity.
                    // ANY NotSupported / UnknownKind refuses the entire edit.begin call.
                    var preImages = new List<EntityPreImage>();
                    var allUnsupportedFeatures = new List<string>();
                    var unRestorable = new List<(string Handle, string Kind, string Reason)>();

                    string revisionAtCapture = $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}";
                    string documentIdentity = DocumentContext.IdOf(doc);
                    string documentName = doc.Name;
                    string? filePath = string.IsNullOrEmpty(db.Filename) ? null : db.Filename;
                    string? fingerprintGuid = CadStateHandlers.FingerprintOf(db);
                    string capturedAtUtc = DateTime.UtcNow.ToString("O");

                    foreach (var entity in sourceEntities)
                    {
                        var detail = EntityHandlers.ToDetail(tr, entity, includeBounds: true);
                        var restorability = Restorability.Of(detail);
                        if (restorability.Verdict != RestoreVerdict.Supported)
                        {
                            unRestorable.Add((entity.Handle.ToString(), detail.Kind, restorability.Reason ?? "Not restorable"));
                        }
                        else
                        {
                            if (restorability.UnsupportedFeatures != null && restorability.UnsupportedFeatures.Length > 0)
                            {
                                allUnsupportedFeatures.AddRange(restorability.UnsupportedFeatures);
                            }

                            preImages.Add(new EntityPreImage
                            {
                                Detail = detail,
                                RevisionAtCapture = revisionAtCapture,
                                Document = new DocumentIdentityDto
                                {
                                    DocumentId = documentIdentity,
                                    FingerprintGuid = fingerprintGuid,
                                    Path = filePath
                                },
                                CapturedAtUtc = capturedAtUtc
                            });
                        }
                    }

                    if (unRestorable.Count > 0)
                    {
                        var first = unRestorable[0];
                        throw PluginExceptions.EditNotRestorable(first.Handle, first.Kind, first.Reason);
                    }

                    // 4. Create isolated candidate layer and clone entities
                    string editId = $"edit_{Guid.NewGuid():N}";
                    string candidateLayer = $"CadAI-Candidate-{editId}";

                    if (!lt.Has(candidateLayer))
                    {
                        lt.UpgradeOpen();
                        var candidateLtr = new LayerTableRecord
                        {
                            Name = candidateLayer,
                            Color = Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci, 30) // ACI 30 (orange)
                        };
                        lt.Add(candidateLtr);
                        tr.AddNewlyCreatedDBObject(candidateLtr, true);
                        EntityOwnership.Stamp(tr, candidateLtr);
                    }

                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                    var candidateRefs = new List<EntityRefDto>();

                    foreach (var source in sourceEntities)
                    {
                        var clone = (Entity)source.Clone();
                        clone.Layer = candidateLayer;
                        ms.AppendEntity(clone);
                        tr.AddNewlyCreatedDBObject(clone, true);
                        EntityOwnership.Stamp(tr, clone);
                        candidateRefs.Add(new EntityRefDto
                        {
                            Handle = clone.Handle.ToString(),
                            Kind = EntityKindResolver.KindOf(clone),
                            Layer = clone.Layer
                        });
                    }

                    // 5. Build and persist edit session before transaction commit
                    var touchedLayers = sourceEntities.Select(e => e.Layer).Distinct().ToList();
                    var touchedBlocks = sourceEntities
                        .OfType<BlockReference>()
                        .Select(br => ((BlockTableRecord)tr.GetObject(br.BlockTableRecord, OpenMode.ForRead)).Name)
                        .Distinct()
                        .ToList();

                    var dependencyFingerprint = EditStore.ComputeDependencyFingerprint(preImages, touchedLayers, touchedBlocks);
                    var distinctUnsupported = allUnsupportedFeatures.Distinct().ToList();

                    var session = new EditSession(
                        EditId: editId,
                        DocumentIdentity: documentIdentity,
                        DocumentName: documentName,
                        RevisionAtCapture: revisionAtCapture,
                        DependencyFingerprint: dependencyFingerprint,
                        PreImages: preImages,
                        CandidateRefs: candidateRefs,
                        CandidateLayer: candidateLayer,
                        CreatedAtUtc: DateTimeOffset.UtcNow,
                        UnsupportedFeatures: distinctUnsupported,
                        State: EditSessionState.Active,
                        Version: 1
                    );

                    try
                    {
                        _editStore.Save(session);
                    }
                    catch (Exception ex)
                    {
                        tr.Abort();
                        throw PluginExceptions.EditStorageFailed(editId, ex.Message);
                    }

                    tr.Commit();

                    // 6. Record batch in journal for LIFO undo optimization
                    BatchJournal.EnsureHooked(doc);
                    BatchJournal.Record(doc.Name, candidateRefs, candidateRefs.Count, undoSupported: true);

                    return new EditBeginResult
                    {
                        EditId = editId,
                        DocumentIdentity = documentIdentity,
                        RevisionAtCapture = revisionAtCapture,
                        PreImages = preImages,
                        Candidates = candidateRefs,
                        CandidateLayer = candidateLayer,
                        UnsupportedFeatures = distinctUnsupported
                    };
                }
            });

        [JsonRpcMethod("edit.apply", UseSingleObjectParameterDeserialization = true)]
        public async Task<EditApplyResult> Apply(EditApplyRequest? request = null, System.Threading.CancellationToken ct = default)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.EditId))
            {
                throw PluginExceptions.InvalidOperation("editId is required for edit.apply.");
            }

            var session = _editStore.Get(request.EditId)
                ?? throw PluginExceptions.EditNotFound(request.EditId);

            if (session.State != EditSessionState.Active && session.State != EditSessionState.Revalidating)
            {
                throw PluginExceptions.EditConflict(session.EditId, $"Edit session is in {session.State} state and cannot accept mutations.");
            }

            // Confinement check: every modified/erased handle must be a candidate in this session;
            // create operations must target candidateLayer.
            var candidateHandleSet = new HashSet<string>(session.CandidateRefs.Select(c => c.Handle), StringComparer.OrdinalIgnoreCase);

            if (request.Operations != null)
            {
                for (int i = 0; i < request.Operations.Count; i++)
                {
                    var op = request.Operations[i];
                    var opType = op.Op?.ToLowerInvariant();

                    if (opType == "create")
                    {
                        if (op.Entity != null)
                        {
                            if (string.IsNullOrEmpty(op.Entity.Layer))
                            {
                                op.Entity.Layer = session.CandidateLayer;
                            }
                            else if (!string.Equals(op.Entity.Layer, session.CandidateLayer, StringComparison.OrdinalIgnoreCase))
                            {
                                throw PluginExceptions.EditConflict(session.EditId, $"Create operation must target candidate layer \"{session.CandidateLayer}\", got \"{op.Entity.Layer}\".");
                            }
                        }
                    }

                    // Even a preview/edit session must not mutate the real source by smuggling
                    // an in-place update step; the safe-edit route stays candidate-only.
                    if (op.Update != null)
                    {
                        if (!candidateHandleSet.Contains(op.Update.Handle))
                        {
                            throw PluginExceptions.EditConflict(session.EditId,
                                $"Update targets handle \"{op.Update.Handle}\" which is not a candidate in edit session \"{session.EditId}\".");
                        }
                    }

                    if (op.Handles != null)
                    {
                        foreach (var handle in op.Handles)
                        {
                            if (handle.StartsWith("@", StringComparison.Ordinal)) continue; // batch-local reference
                            if (!candidateHandleSet.Contains(handle))
                            {
                                throw PluginExceptions.EditConflict(session.EditId, $"Operation targets handle \"{handle}\" which is not a candidate in edit session \"{session.EditId}\".");
                            }
                        }
                    }

                    if (op.Transform?.Handles != null)
                    {
                        foreach (var handle in op.Transform.Handles)
                        {
                            if (handle.StartsWith("@", StringComparison.Ordinal)) continue; // batch-local reference
                            if (!candidateHandleSet.Contains(handle))
                            {
                                throw PluginExceptions.EditConflict(session.EditId, $"Transform targets handle \"{handle}\" which is not a candidate in edit session \"{session.EditId}\".");
                            }
                        }
                    }
                }
            }

            // Dispatch via CadOperationScheduler
            var opsRequest = new OperationsApplyRequest
            {
                Operations = request.Operations ?? new List<EntityOperationDto>(),
                DocumentName = session.DocumentName,
                IdempotencyKey = request.IdempotencyKey,
                View = request.View,
                Progressive = request.Progressive,
                PaceMs = request.PaceMs,
            };

            var result = await CadOperationScheduler.ExecuteAsync(opsRequest, ct).ConfigureAwait(false);

            // Record newly created entities into candidate refs
            if (result.EntityRefs != null && result.EntityRefs.Count > 0)
            {
                bool sessionChanged = false;
                foreach (var created in result.EntityRefs)
                {
                    if (!candidateHandleSet.Contains(created.Handle))
                    {
                        session.CandidateRefs.Add(created);
                        candidateHandleSet.Add(created.Handle);
                        sessionChanged = true;
                    }
                }
                if (sessionChanged)
                {
                    _editStore.Save(session);
                }
            }

            var revisionNow = await MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(session.DocumentName);
                return $"tdu:{doc.Database.Tduupdate.Ticks};saves:{doc.Database.NumberOfSaves}";
            }).ConfigureAwait(false);

            string? staleSince = !string.Equals(revisionNow, session.RevisionAtCapture, StringComparison.Ordinal)
                ? revisionNow
                : null;

            return new EditApplyResult
            {
                BatchId = result.BatchId,
                Sequence = result.Sequence,
                Status = result.Status,
                EntityRefs = result.EntityRefs ?? new List<EntityRefDto>(),
                Error = result.Error,
                Undo = result.Undo,
                ExecutionId = result.ExecutionId,
                Partial = result.Partial,
                CommittedBatchIds = result.CommittedBatchIds,
                CompletedPhases = result.CompletedPhases,
                TotalPhases = result.TotalPhases,
                Phases = result.Phases,
                StaleSince = staleSince
            };
        }

        [JsonRpcMethod("edit.preview", UseSingleObjectParameterDeserialization = true)]
        public Task<EditPreviewResult> Preview(EditPreviewRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (request == null || string.IsNullOrWhiteSpace(request.EditId))
                {
                    throw PluginExceptions.InvalidOperation("editId is required for edit.preview.");
                }

                var session = _editStore.Get(request.EditId)
                    ?? throw PluginExceptions.EditNotFound(request.EditId);

                var doc = DocumentContext.Resolve(session.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    string revisionNow;
                    var candidateDetails = new List<EntityDetailDto>();

                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        revisionNow = $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}";

                        // Snapshot candidate entities in one atomic transaction pass
                        foreach (var candRef in session.CandidateRefs)
                        {
                            if (HandleConvert.TryResolve(db, candRef.Handle, out var id) && !id.IsErased)
                            {
                                var ent = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                var detail = EntityHandlers.ToDetail(tr, ent, includeBounds: true);
                                candidateDetails.Add(detail);
                            }
                        }

                        tr.Commit();
                    }

                    var diff = EditDiff.Compute(session, revisionNow, candidateDetails);

                    string? beforePng = null;
                    string? afterPng = null;

                    if (request.Capture != null)
                    {
                        var width = request.Capture.Width ?? ViewCapture.DefaultWidth;
                        var height = request.Capture.Height ?? ViewCapture.DefaultHeight;

                        var sourceHandles = session.PreImages.Select(p => p.Detail.Handle).ToList();
                        var candidateHandles = candidateDetails.Select(c => c.Handle).ToList();

                        try
                        {
                            if (sourceHandles.Count > 0)
                            {
                                var beforeResult = ViewCapture.Render(doc, new ViewCaptureRequest
                                {
                                    DocumentName = doc.Name,
                                    Handles = sourceHandles,
                                    Width = width,
                                    Height = height
                                });
                                beforePng = beforeResult.Data;
                            }
                        }
                        catch
                        {
                            // Off-screen rendering failure does not fail the diff
                        }

                        try
                        {
                            if (candidateHandles.Count > 0)
                            {
                                var afterResult = ViewCapture.Render(doc, new ViewCaptureRequest
                                {
                                    DocumentName = doc.Name,
                                    Handles = candidateHandles,
                                    Width = width,
                                    Height = height
                                });
                                afterPng = afterResult.Data;
                            }
                        }
                        catch
                        {
                            // Off-screen rendering failure does not fail the diff
                        }
                    }

                    return new EditPreviewResult
                    {
                        Diff = diff,
                        BeforePng = beforePng,
                        AfterPng = afterPng
                    };
                }
            });

        [JsonRpcMethod("edit.discard", UseSingleObjectParameterDeserialization = true)]
        public Task<EditDiscardResult> Discard(EditDiscardRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (request == null || string.IsNullOrWhiteSpace(request.EditId))
                {
                    throw PluginExceptions.InvalidOperation("editId is required for edit.discard.");
                }

                var session = _editStore.Get(request.EditId)
                    ?? throw PluginExceptions.EditNotFound(request.EditId);

                if (session.State == EditSessionState.Accepted)
                {
                    throw PluginExceptions.EditConflict(session.EditId, "Cannot discard an edit session that has already been accepted.");
                }

                var doc = DocumentContext.Resolve(session.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    var removedCandidates = new List<string>();

                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        foreach (var candRef in session.CandidateRefs)
                        {
                            if (HandleConvert.TryResolve(db, candRef.Handle, out var id) && !id.IsErased)
                            {
                                var ent = (Entity)tr.GetObject(id, OpenMode.ForWrite);
                                ent.Erase();
                                removedCandidates.Add(candRef.Handle);
                            }
                        }

                        var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                        if (lt.Has(session.CandidateLayer))
                        {
                            try
                            {
                                var ltr = (LayerTableRecord)tr.GetObject(lt[session.CandidateLayer], OpenMode.ForWrite);
                                ltr.Erase();
                            }
                            catch { }
                        }

                        tr.Commit();
                    }

                    _editStore.TransitionToDiscarded(session.EditId);

                    return new EditDiscardResult
                    {
                        Status = "discarded",
                        RemovedCandidates = removedCandidates
                    };
                }
            });

        [JsonRpcMethod("edit.accept", UseSingleObjectParameterDeserialization = true)]
        public Task<EditAcceptResult> Accept(EditAcceptRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (request == null || string.IsNullOrWhiteSpace(request.EditId))
                {
                    throw PluginExceptions.InvalidOperation("editId is required for edit.accept.");
                }

                // Human-approver interlock (Slice 04 stub refusal):
                // edit.accept requires an approvalToken verified against Cloud (Slice 06).
                // Until Slice 06 lands, any call without a verified dev/test token returns EDIT_REQUIRES_HUMAN_APPROVAL (-32032).
                if (string.IsNullOrEmpty(request.ApprovalToken) || !IsValidApprovalToken(request.ApprovalToken))
                {
                    throw PluginExceptions.EditRequiresHumanApproval(request.EditId);
                }

                var session = _editStore.Get(request.EditId)
                    ?? throw PluginExceptions.EditNotFound(request.EditId);

                if (session.State == EditSessionState.Accepted)
                {
                    throw PluginExceptions.EditAlreadyApplied(session.EditId);
                }
                if (session.State == EditSessionState.Orphaned)
                {
                    throw PluginExceptions.EditConflict(session.EditId, "Cannot accept an orphaned edit session.");
                }
                if (session.State == EditSessionState.Revalidating)
                {
                    throw PluginExceptions.EditConflict(session.EditId, "Cannot accept an edit session that is still revalidating.");
                }
                if (session.State == EditSessionState.Discarded)
                {
                    throw PluginExceptions.EditConflict(session.EditId, "Cannot accept a discarded edit session.");
                }

                var doc = DocumentContext.Resolve(session.DocumentName);
                return Idempotency.WithCache(doc.Name, request.IdempotencyKey, request, () =>
                {
                    using (doc.LockDocument())
                    {
                        var db = doc.Database;

                        // Check 1: Re-resolve every source handle
                        using (var trCheck = db.TransactionManager.StartTransaction())
                        {
                            foreach (var pre in session.PreImages)
                            {
                                if (!HandleConvert.TryResolve(db, pre.Detail.Handle, out var srcId) || srcId.IsErased)
                                {
                                    throw PluginExceptions.EditStalePreImage(session.EditId, session.RevisionAtCapture, $"Source entity \"{pre.Detail.Handle}\" was erased or missing.");
                                }
                            }
                            trCheck.Commit();
                        }

                        // Check 2: Re-read document revision
                        string revisionNow = $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}";
                        var expectedRev = !string.IsNullOrEmpty(request.ExpectedRevision) ? request.ExpectedRevision : session.RevisionAtCapture;
                        if (!string.Equals(revisionNow, expectedRev, StringComparison.Ordinal))
                        {
                            throw PluginExceptions.EditStalePreImage(session.EditId, expectedRev, revisionNow);
                        }

                        // Check 3: Recompute diff and compare expectedDiffDigest
                        var candidateDetails = new List<EntityDetailDto>();
                        using (var trDiff = db.TransactionManager.StartTransaction())
                        {
                            foreach (var candRef in session.CandidateRefs)
                            {
                                if (HandleConvert.TryResolve(db, candRef.Handle, out var id) && !id.IsErased)
                                {
                                    var ent = (Entity)trDiff.GetObject(id, OpenMode.ForRead);
                                    candidateDetails.Add(EntityHandlers.ToDetail(trDiff, ent, includeBounds: true));
                                }
                            }
                            trDiff.Commit();
                        }

                        var diff = EditDiff.Compute(session, revisionNow, candidateDetails);

                        if (!string.IsNullOrEmpty(request.ExpectedDiffDigest) &&
                            !string.Equals(diff.DiffDigest, request.ExpectedDiffDigest, StringComparison.Ordinal))
                        {
                            throw PluginExceptions.EditConflict(session.EditId, "The candidate changed since you reviewed it (diff digest mismatch).");
                        }

                        // Check 4: Unsupported features check
                        if (session.UnsupportedFeatures != null && session.UnsupportedFeatures.Count > 0 && request.AllowUnknownFeatures != true)
                        {
                            throw PluginExceptions.EditConflict(session.EditId, $"Session carries unsupported features ({string.Join(", ", session.UnsupportedFeatures)}). Pass allowUnknownFeatures: true to accept lossy changes.");
                        }

                        // One transaction + one native undo group
                        var nativeUndo = ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument);
                        if (nativeUndo) doc.Editor.Command("_.UNDO", "_Group");

                        var mapping = new Dictionary<string, string>();
                        try
                        {
                            using (var tr = db.TransactionManager.StartTransaction())
                            {
                                foreach (var entityDiff in diff.Entities)
                                {
                                    if (entityDiff.Status == "modified" || entityDiff.Status == "unchanged")
                                    {
                                        if (HandleConvert.TryResolve(db, entityDiff.Handle, out var srcId) && !srcId.IsErased)
                                        {
                                            var srcEnt = (Entity)tr.GetObject(srcId, OpenMode.ForWrite);
                                            var srcLayer = srcEnt.Layer;
                                            srcEnt.Erase();

                                            if (HandleConvert.TryResolve(db, entityDiff.CandidateHandle, out var candId) && !candId.IsErased)
                                            {
                                                var candEnt = (Entity)tr.GetObject(candId, OpenMode.ForWrite);
                                                candEnt.Layer = srcLayer;
                                            }
                                        }
                                        mapping[entityDiff.Handle] = entityDiff.CandidateHandle;
                                    }
                                    else if (entityDiff.Status == "removed")
                                    {
                                        if (HandleConvert.TryResolve(db, entityDiff.Handle, out var srcId) && !srcId.IsErased)
                                        {
                                            var srcEnt = (Entity)tr.GetObject(srcId, OpenMode.ForWrite);
                                            srcEnt.Erase();
                                        }
                                        mapping[entityDiff.Handle] = "";
                                    }
                                    else if (entityDiff.Status == "added")
                                    {
                                        var targetLayer = session.PreImages.FirstOrDefault()?.Detail.Layer ?? "0";
                                        if (HandleConvert.TryResolve(db, entityDiff.CandidateHandle, out var candId) && !candId.IsErased)
                                        {
                                            var candEnt = (Entity)tr.GetObject(candId, OpenMode.ForWrite);
                                            candEnt.Layer = targetLayer;
                                        }
                                        mapping[""] = entityDiff.CandidateHandle;
                                    }
                                }

                                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                                if (lt.Has(session.CandidateLayer))
                                {
                                    try
                                    {
                                        var ltr = (LayerTableRecord)tr.GetObject(lt[session.CandidateLayer], OpenMode.ForWrite);
                                        ltr.Erase();
                                    }
                                    catch { }
                                }

                                tr.Commit();
                            }
                        }
                        finally
                        {
                            if (nativeUndo) doc.Editor.Command("_.UNDO", "_End");
                        }

                        _editStore.TransitionToAccepted(session.EditId, mapping);

                        BatchJournal.EnsureHooked(doc);
                        var affectedRefs = diff.Entities
                            .Where(e => !string.IsNullOrEmpty(e.CandidateHandle))
                            .Select(e => new EntityRefDto { Handle = e.CandidateHandle, Kind = e.Kind, Layer = session.PreImages.FirstOrDefault()?.Detail.Layer ?? "0" })
                            .ToList();
                        BatchJournal.Record(doc.Name, affectedRefs, affectedRefs.Count, undoSupported: true);

                        return new EditAcceptResult
                        {
                            Status = "accepted",
                            EditId = session.EditId,
                            AppliedMapping = mapping,
                            DiffDigest = diff.DiffDigest
                        };
                    }
                });
            });

        [JsonRpcMethod("edit.status", UseSingleObjectParameterDeserialization = true)]
        public Task<EditStatusResult> Status(EditStatusRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (request == null || string.IsNullOrWhiteSpace(request.EditId))
                {
                    throw PluginExceptions.InvalidOperation("editId is required for edit.status.");
                }

                var session = _editStore.Get(request.EditId);
                if (session == null)
                {
                    throw PluginExceptions.EditNotFound(request.EditId);
                }

                var candidateHandles = new List<string>();
                foreach (var c in session.CandidateRefs)
                {
                    candidateHandles.Add(c.Handle);
                }

                var sourceHandles = new List<string>();
                foreach (var pi in session.PreImages)
                {
                    sourceHandles.Add(pi.Detail.Handle);
                }

                return new EditStatusResult
                {
                    EditId = session.EditId,
                    Status = session.State.ToString().ToLowerInvariant(),
                    CandidateLayer = session.CandidateLayer,
                    CandidateHandles = candidateHandles,
                    SourceHandles = sourceHandles,
                    PreImageCount = session.PreImages.Count,
                    RevisionAtCapture = session.RevisionAtCapture,
                    AppliedMapping = session.AppliedMapping != null ? new Dictionary<string, string>(session.AppliedMapping) : null
                };
            });

        private static bool IsValidApprovalToken(string? token)
        {
            return !string.IsNullOrEmpty(token) && token.StartsWith("apv_test", StringComparison.Ordinal);
        }
    }
}
