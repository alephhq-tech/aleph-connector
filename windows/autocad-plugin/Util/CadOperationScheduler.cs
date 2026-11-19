using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using CadAI.AutoCAD.Journal;
using CadAI.AutoCAD.RpcHandlers;
using StreamJsonRpc;
namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Cooperative, per-document CAD operation scheduler (Issue #282 PR A / PR A.1).
    /// Enforces:
    /// - Serialized writes per open document (never overlapping transactions on the same DB).
    /// - Independent documents do not block each other.
    /// - Micro-batching with per-phase transaction commit and screen refresh.
    /// - Cooperative yielding between commits to allow pending human commands to proceed.
    /// - Safe cancellation and document-identity revalidation at phase boundaries.
    /// - Truthful reporting of partial commits, completed phases, and committed batch IDs.
    /// - Strict UI-thread affinity: all database interactions and document resolutions run on main thread.
    /// - Atomic commit boundary: post-commit non-mutating errors never falsify the commit.
    /// </summary>
    internal static class CadOperationScheduler
    {
        public const int MinMicroBatchSize = 10;
        public const int MaxMicroBatchSize = 50;

        private static readonly ConcurrentDictionary<string, SemaphoreSlim> DocumentGates = new();

        private static SemaphoreSlim GateFor(string documentId) =>
            DocumentGates.GetOrAdd(documentId, _ => new SemaphoreSlim(1, 1));

        /// <summary>Runs action with command echoing suppressed so it doesn't pollute the prompt.</summary>
        internal static void RunSuppressed(string documentName, Action action)
        {
            var oldEcho = Application.GetSystemVariable("CMDECHO");
            var oldDiag = Application.GetSystemVariable("NOMUTT");
            try
            {
                BatchJournal.Suppress(documentName, true);
                Application.SetSystemVariable("CMDECHO", 0);
                Application.SetSystemVariable("NOMUTT", 1);
                action();
            }
            finally
            {
                try { Application.SetSystemVariable("CMDECHO", oldEcho); } catch { }
                try { Application.SetSystemVariable("NOMUTT", oldDiag); } catch { }
                BatchJournal.Suppress(documentName, false);
            }
        }

        /// <summary>Partitions operations into dependency-safe bounded micro-batches.</summary>
        internal static List<List<EntityOperationDto>> PartitionMicroBatches(
            IReadOnlyList<EntityOperationDto> operations, bool progressive)
        {
            if (operations.Count == 0) return new List<List<EntityOperationDto>>();
            if (!progressive)
            {
                return new List<List<EntityOperationDto>> { operations.ToList() };
            }

            // When progressive is true, partition into single-stroke micro-batches (batchSize = 1)
            // for drafting tasks (<= 100 ops), so every single line/entity is rendered on AutoCAD's
            // canvas immediately as it is drawn!
            var batchSize = operations.Count <= 100
                ? 1
                : Math.Min(MaxMicroBatchSize, Math.Max(1, operations.Count / 100));
            var result = new List<List<EntityOperationDto>>();
            for (var i = 0; i < operations.Count; i += batchSize)
            {
                var count = Math.Min(batchSize, operations.Count - i);
                var slice = new List<EntityOperationDto>(count);
                for (var j = 0; j < count; j++) slice.Add(operations[i + j]);
                result.Add(slice);
            }
            return result;
        }

        private sealed record PhaseOutcome(
            List<EntityRefDto> Refs,
            bool NativeUndo,
            string? BatchId,
            OperationsApplyResult? AbortedResult,
            List<StateConflictDto>? Conflicts = null);

        // #413 §13.2 machine-batch decisions, extracted as pure functions so the contract a
        // programmatic PCCC executor relies on is pinned by unit tests without a live document.
        // A batch executor MUST send progressive:false AND paceMs:0 together: an omitted (null)
        // paceMs falls back to LiveView's pacing even when progressive is false, and an omitted
        // progressive defaults to true (the Live-Drawing per-entity path, #282).
        internal static bool ResolveProgressive(bool? requested) => requested ?? true;

        internal static int ResolvePaceMs(double? requested, double livePaceMs) =>
            (int)Math.Max(0, Math.Min(100, requested ?? (livePaceMs > 0 ? livePaceMs : 70)));

        internal static int InterPhaseDelayMs(int paceMs, bool progressive) =>
            paceMs > 0 ? paceMs : (progressive ? 70 : 0);

        /// <summary>
        /// Native revision precondition (#413 phase A). An absent <paramref name="expectedRevision"/>
        /// means the caller opted out of the check -- never a conflict. Pure so the "no expectation
        /// set" / "match" / "mismatch" cases are unit-testable without a live AutoCAD Document.
        /// </summary>
        internal static bool IsRevisionConflict(string? expectedRevision, string liveRevision) =>
            !string.IsNullOrEmpty(expectedRevision) && expectedRevision != liveRevision;

        /// <summary>
        /// Per-entity write-set precondition (#413 phase B). The state fingerprint of an entity is
        /// its bounds-free <see cref="EntityDetailDto"/> digested by
        /// <see cref="PreImageCanonical.HashDetail"/> — the same digest the pre-image journal and
        /// the revert-conflict check use, so a caller can capture it once from
        /// <c>entity.get</c>'s <c>stateDigest</c> and re-verify it before mutating.
        /// </summary>
        internal static string ComputeStateDigest(EntityDetailDto detail) => PreImageCanonical.HashDetail(detail);

        /// <summary>
        /// An absent/empty <paramref name="expectedState"/> means the caller opted out of the check
        /// for that entity — never a conflict (same opt-out semantics as phase A's
        /// <paramref name="expectedRevision"/>). Digests are hex from <see cref="PreImageCanonical"/>;
        /// compared ordinally, exactly like the revert-conflict digest check. Pure, so the
        /// "no expectation" / "match" / "mismatch" cases are unit-testable without a live Document.
        /// </summary>
        internal static bool IsStateConflict(string? expectedState, string liveStateDigest) =>
            !string.IsNullOrEmpty(expectedState) && !string.Equals(expectedState, liveStateDigest, StringComparison.Ordinal);

        /// <summary>
        /// Looks up one handle's expected digest. Handle hex is case-insensitive at the wire edge
        /// (callers copy it from any read; <c>long.TryParse(HexNumber)</c> accepts either case), so
        /// an exact miss falls back to an ordinal-ignore-case scan. Returns null when the caller
        /// expressed no expectation for this handle — including an absent map.
        /// </summary>
        internal static string? ExpectedStateFor(IReadOnlyDictionary<string, string>? expectedState, string handle)
        {
            if (expectedState is null) return null;
            if (expectedState.TryGetValue(handle, out var exact)) return exact;
            foreach (var kvp in expectedState)
                if (string.Equals(kvp.Key, handle, StringComparison.OrdinalIgnoreCase)) return kvp.Value;
            return null;
        }

        /// <summary>
        /// #413 phase B core decision: of one batch step's handles, drop those whose live state
        /// digest contradicts the caller's <paramref name="expectedState"/>, recording each drop in
        /// <paramref name="conflicts"/>; every other handle proceeds. Unresolvable handles (erased
        /// between capture and this transaction) are left in the list — <c>EraseMany</c>/
        /// <c>TransformOne</c> already skip them, and "the entity is gone" is not a stale-fingerprint
        /// signal we can truthfully report as one. Why per-handle and not whole-batch: a concurrent
        /// edit to one entity must not veto unrelated writes elsewhere in the drawing — phase A's
        /// whole-document gate aborts everything, which is the wrong granularity for a batch that
        /// names the entities it touches. The live digests come from <paramref name="liveDetailOf"/>,
        /// computed inside the batch's already-open transaction, so the check is atomic with the
        /// mutation it guards. Pure given the provider, so the partial-skip semantics are testable.
        /// </summary>
        internal static List<string> PruneStateConflicts(
            IReadOnlyList<string> handles,
            IReadOnlyDictionary<string, string>? expectedState,
            Func<string, EntityDetailDto?> liveDetailOf,
            List<StateConflictDto> conflicts)
        {
            if (expectedState is null || expectedState.Count == 0) return handles.ToList();
            var allowed = new List<string>(handles.Count);
            foreach (var handle in handles)
            {
                var expected = ExpectedStateFor(expectedState, handle);
                if (expected is not null)
                {
                    var detail = liveDetailOf(handle);
                    if (detail is not null)
                    {
                        var actual = ComputeStateDigest(detail);
                        if (IsStateConflict(expected, actual))
                        {
                            conflicts.Add(new StateConflictDto { Handle = handle, Expected = expected, Actual = actual });
                            continue;
                        }
                    }
                }
                allowed.Add(handle);
            }
            return allowed;
        }

        /// <summary>
        /// The live bounds-free detail of one handle inside the batch's already-open transaction —
        /// null when it no longer resolves (erased since capture). ForRead only, never opens ForWrite.
        /// </summary>
        private static EntityDetailDto? LiveDetail(Transaction tr, Database db, string handle)
        {
            if (!HandleConvert.TryResolve(db, handle, out var id) || id.IsErased) return null;
            var ent = (Autodesk.AutoCAD.DatabaseServices.Entity)tr.GetObject(id, OpenMode.ForRead);
            return EntityHandlers.ToDetail(tr, ent, includeBounds: false);
        }

        /// <summary>Executes the logical apply task with cooperative micro-batches and truthful reporting.</summary>
        public static async Task<OperationsApplyResult> ExecuteAsync(
            OperationsApplyRequest request, CancellationToken ct = default)
        {
            if (ct.IsCancellationRequested)
            {
                return new OperationsApplyResult
                {
                    ExecutionId = request.IdempotencyKey ?? $"exec_{Guid.NewGuid():N}",
                    Status = "cancelled",
                    Partial = false,
                    EntityRefs = new List<EntityRefDto>(),
                    CommittedBatchIds = new List<string>(),
                    CompletedPhases = 0,
                    TotalPhases = 1,
                    Phases = new List<PhaseExecutionInfoDto>(),
                    Error = new ErrorInfoDto
                    {
                        Code = PluginErrorCodes.TransactionFailed,
                        Message = "Operation cancelled before execution started.",
                        FailedStep = 0,
                    },
                };
            }

            // 1. Resolve document identity on AutoCAD main thread
            var (docId, docName) = await MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                return (DocumentContext.IdOf(doc), doc.Name);
            }, ct).ConfigureAwait(false);

            var gate = GateFor(docId);

            // 2. Wait boundedly for document gate on background thread without blocking main thread
            try
            {
                if (!await gate.WaitAsync(2000, ct).ConfigureAwait(false))
                {
                    throw PluginExceptions.BridgeBusy("Another CAD operation is currently mutating this document; try again shortly.");
                }
            }
            catch (OperationCanceledException)
            {
                return new OperationsApplyResult
                {
                    ExecutionId = request.IdempotencyKey ?? $"exec_{Guid.NewGuid():N}",
                    Status = "cancelled",
                    Partial = false,
                    EntityRefs = new List<EntityRefDto>(),
                    CommittedBatchIds = new List<string>(),
                    CompletedPhases = 0,
                    TotalPhases = 1,
                    Phases = new List<PhaseExecutionInfoDto>(),
                    Error = new ErrorInfoDto
                    {
                        Code = PluginErrorCodes.TransactionFailed,
                        Message = "Operation cancelled while waiting for document gate.",
                        FailedStep = 0,
                    },
                };
            }

            try
            {
                return await Idempotency.WithCacheAsync(docName, request.IdempotencyKey, request, async () =>
                {
                    var totalSw = System.Diagnostics.Stopwatch.StartNew();
                    var liveSettings = LiveView.Get(docName);
                    var progressive = ResolveProgressive(request.Progressive);
                    var paceMs = ResolvePaceMs(request.PaceMs, liveSettings.PaceMs);
                    var microBatches = PartitionMicroBatches(request.Operations, progressive);
                    var totalPhases = Math.Max(1, microBatches.Count);

                    var executionId = request.IdempotencyKey ?? $"exec_{Guid.NewGuid():N}";
                    var allRefs = new List<EntityRefDto>();
                    var allConflicts = new List<StateConflictDto>();
                    var committedBatchIds = new List<string>();
                    var phaseInfos = new List<PhaseExecutionInfoDto>();
                    var globalStep = 0;
                    var lastNativeUndo = false;

                    for (var phaseIndex = 0; phaseIndex < microBatches.Count; phaseIndex++)
                    {
                        if (ct.IsCancellationRequested)
                        {
                            return new OperationsApplyResult
                            {
                                ExecutionId = executionId,
                                Status = "cancelled",
                                Partial = committedBatchIds.Count > 0,
                                EntityRefs = allRefs,
                                BatchId = committedBatchIds.LastOrDefault(),
                                CommittedBatchIds = committedBatchIds,
                                CompletedPhases = phaseIndex,
                                TotalPhases = totalPhases,
                                Phases = phaseInfos,
                                Error = new ErrorInfoDto
                                {
                                    Code = PluginErrorCodes.TransactionFailed,
                                    Message = "Operation cancelled before phase started.",
                                    FailedStep = globalStep,
                                },
                                Conflicts = allConflicts.Count > 0 ? allConflicts : null,
                            };
                        }

                        var phaseOps = microBatches[phaseIndex];
                        var startStepOfPhase = globalStep;
                        var phaseSw = System.Diagnostics.Stopwatch.StartNew();

                        // Execute the phase strictly on AutoCAD's main thread
                        PhaseOutcome outcome;
                        try
                        {
                            outcome = await MainThreadDispatcher.RunAsync(async () =>
                            {
                            // Re-verify open document identity before each phase mutation
                            var currentDoc = DocumentContext.Resolve(request.DocumentName);
                            if (DocumentContext.IdOf(currentDoc) != docId)
                            {
                                return new PhaseOutcome(
                                    new List<EntityRefDto>(),
                                    false,
                                    null,
                                    new OperationsApplyResult
                                    {
                                        ExecutionId = executionId,
                                        Status = "requires_revalidation",
                                        Partial = committedBatchIds.Count > 0,
                                        EntityRefs = allRefs,
                                        BatchId = committedBatchIds.LastOrDefault(),
                                        CommittedBatchIds = committedBatchIds,
                                        CompletedPhases = phaseIndex,
                                        TotalPhases = totalPhases,
                                        Phases = phaseInfos,
                                        Error = new ErrorInfoDto
                                        {
                                            Code = PluginErrorCodes.DocumentNotFound,
                                            Message = "Document identity changed during execution; revalidation required.",
                                            FailedStep = startStepOfPhase,
                                        },
                                        // Skips from earlier committed phases stay reported.
                                        Conflicts = allConflicts.Count > 0 ? allConflicts : null,
                                    });
                            }

                            return await CommandContext.RunAsync(currentDoc, () =>
                            {
                                var db = currentDoc.Database;

                                // Native revision precondition (#413 phase A), checked only before the
                                // FIRST phase: this call's own earlier phases legitimately advance the
                                // revision, so re-checking on phase 2+ would always spuriously fail.
                                // Zero side effects on a mismatch -- no transaction, no undo group.
                                if (phaseIndex == 0)
                                {
                                    var liveRevision = $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}";
                                    if (IsRevisionConflict(request.ExpectedRevision, liveRevision))
                                    {
                                        return new PhaseOutcome(
                                            new List<EntityRefDto>(),
                                            false,
                                            null,
                                            new OperationsApplyResult
                                            {
                                                ExecutionId = executionId,
                                                Status = "requires_revalidation",
                                                Partial = committedBatchIds.Count > 0,
                                                EntityRefs = allRefs,
                                                BatchId = committedBatchIds.LastOrDefault(),
                                                CommittedBatchIds = committedBatchIds,
                                                CompletedPhases = phaseIndex,
                                                TotalPhases = totalPhases,
                                                Phases = phaseInfos,
                                                Error = new ErrorInfoDto
                                                {
                                                    Code = PluginErrorCodes.RevisionConflict,
                                                    Message = $"Drawing \"{currentDoc.Name}\" changed since the caller's revision was captured (expected {request.ExpectedRevision}, now {liveRevision}) -- re-read and retry.",
                                                    FailedStep = startStepOfPhase,
                                                },
                                            });
                                    }
                                }

                                var ed = currentDoc.Editor;
                                var nativeUndo = ReferenceEquals(currentDoc, Application.DocumentManager.MdiActiveDocument);
                                if (nativeUndo) RunSuppressed(currentDoc.Name, () => ed.Command("_.UNDO", "_Group"));

                                var tr = db.TransactionManager.StartTransaction();
                                var phaseRefs = new List<EntityRefDto>();
                                var createdHandles = new List<string>();
                                var erasedPreImages = new List<EntityPreImage>();
                                var modifiedPreImages = new List<ModifiedEntityPreImage>();
                                var phaseConflicts = new List<StateConflictDto>();
                                var stepOffset = 0;
                                var transactionCommitted = false;
                                var phaseAborted = false;

                                try
                                {
                                    for (; stepOffset < phaseOps.Count; stepOffset++)
                                    {
                                        if (ct.IsCancellationRequested)
                                        {
                                            throw new OperationCanceledException(ct);
                                        }

                                        var op = phaseOps[stepOffset];
                                        List<EntityRefDto> stepRefs;
                                        switch (op.Op)
                                        {
                                            case "create":
                                                var created = EntityHandlers.CreateOne(
                                                    tr, db, op.Entity ?? throw PluginExceptions.InvalidGeometry("create op requires \"entity\"."), currentDoc.Name);
                                                stepRefs = new List<EntityRefDto> { created };
                                                createdHandles.Add(created.Handle);
                                                break;
                                            case "erase":
                                                var handlesToErase = op.Handles ?? throw PluginExceptions.InvalidGeometry("erase op requires \"handles\".");
                                                // #413 phase B: drop handles whose live state digest
                                                // contradicts expectedState; the rest erase normally.
                                                handlesToErase = PruneStateConflicts(
                                                    handlesToErase, request.ExpectedState,
                                                    h => LiveDetail(tr, db, h), phaseConflicts);
                                                foreach (var h in handlesToErase)
                                                {
                                                    if (HandleConvert.TryResolve(db, h, out var id) && !id.IsErased)
                                                    {
                                                        var ent = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                                        var detail = EntityHandlers.ToDetail(tr, ent, includeBounds: false);
                                                        erasedPreImages.Add(new EntityPreImage
                                                        {
                                                            Detail = detail,
                                                            RevisionAtCapture = db.Tduupdate.Ticks.ToString() + ":" + db.NumberOfSaves,
                                                            Document = new DocumentIdentityDto
                                                            {
                                                                DocumentId = DocumentContext.IdOf(currentDoc),
                                                                FingerprintGuid = db.FingerprintGuid.ToString(),
                                                                Path = currentDoc.Name
                                                            }
                                                        });
                                                    }
                                                }
                                                stepRefs = EntityHandlers.EraseMany(tr, db, handlesToErase);
                                                break;
                                            case "transform":
                                                var tf = op.Transform ?? throw PluginExceptions.InvalidGeometry("transform op requires \"transform\".");
                                                // #413 phase B: same per-handle skip; a stale handle
                                                // is simply left where the concurrent editor put it.
                                                // Mutating the deserialized request's own handle list
                                                // is safe: HashRequest already digested it (idempotency)
                                                // and the DTO is this call's alone.
                                                tf.Handles = PruneStateConflicts(tf.Handles, request.ExpectedState, h => LiveDetail(tr, db, h), phaseConflicts);
                                                var beforeDetails = new Dictionary<string, EntityDetailDto>();
                                                foreach (var h in tf.Handles)
                                                {
                                                    if (HandleConvert.TryResolve(db, h, out var id) && !id.IsErased)
                                                    {
                                                        var ent = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                                        beforeDetails[h] = EntityHandlers.ToDetail(tr, ent, includeBounds: false);
                                                    }
                                                }
                                                stepRefs = EntityHandlers.TransformOne(tr, db, tf);
                                                foreach (var kvp in beforeDetails)
                                                {
                                                    EntityDetailDto? afterDetail = null;
                                                    if (HandleConvert.TryResolve(db, kvp.Key, out var id) && !id.IsErased)
                                                    {
                                                        var ent = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                                        afterDetail = EntityHandlers.ToDetail(tr, ent, includeBounds: false);
                                                    }
                                                    modifiedPreImages.Add(new ModifiedEntityPreImage
                                                    {
                                                        Handle = kvp.Key,
                                                        Kind = kvp.Value.Kind,
                                                        Before = kvp.Value,
                                                        After = afterDetail
                                                    });
                                                }
                                                break;
                                            case "update":
                                                // Mutate the bound entity in place; retain its handle and journal
                                                // the before/after images for conflict-aware selective revert.
                                                var update = op.Update ?? throw PluginExceptions.InvalidGeometry("update op requires \"update\".");
                                                if (string.IsNullOrWhiteSpace(update.Handle))
                                                    throw PluginExceptions.InvalidGeometry("update.handle is required.");
                                                if (!HandleConvert.TryResolve(db, update.Handle, out var updateId) || updateId.IsErased)
                                                    throw PluginExceptions.EntityNotFound(update.Handle);
                                                var beforeUpdate = EntityHandlers.ToDetail(
                                                    tr, (Entity)tr.GetObject(updateId, OpenMode.ForRead), includeBounds: false);
                                                // #413 phase B: a stale expectedState for this one
                                                // handle skips only this update; the step reports no
                                                // refs (nothing was mutated), like a no-op step.
                                                {
                                                    var expected = ExpectedStateFor(request.ExpectedState, update.Handle);
                                                    var actual = ComputeStateDigest(beforeUpdate);
                                                    if (IsStateConflict(expected, actual))
                                                    {
                                                        phaseConflicts.Add(new StateConflictDto
                                                        {
                                                            Handle = update.Handle,
                                                            Expected = expected!,
                                                            Actual = actual,
                                                        });
                                                        stepRefs = new List<EntityRefDto>();
                                                        break;
                                                    }
                                                }
                                                var restoreVerdict = Restorability.Of(beforeUpdate);
                                                if (restoreVerdict.Verdict != RestoreVerdict.Supported)
                                                    throw PluginExceptions.EditNotRestorable(
                                                        update.Handle, beforeUpdate.Kind, restoreVerdict.Reason ?? "Cannot safely restore edited geometry.");
                                                var updatedEntity = EntityHandlers.UpdateOne(tr, db, update);
                                                var afterUpdate = EntityHandlers.ToDetail(tr, updatedEntity, includeBounds: false);
                                                modifiedPreImages.Add(new ModifiedEntityPreImage
                                                {
                                                    Handle = beforeUpdate.Handle,
                                                    Kind = beforeUpdate.Kind,
                                                    Before = beforeUpdate,
                                                    After = afterUpdate
                                                });
                                                stepRefs = new List<EntityRefDto>
                                                {
                                                    new EntityRefDto
                                                    {
                                                        Handle = updatedEntity.Handle.ToString(),
                                                        Kind = EntityKindResolver.KindOf(updatedEntity),
                                                        Layer = updatedEntity.Layer
                                                    }
                                                };
                                                break;
                                            default:
                                                throw PluginExceptions.InvalidGeometry($"Unknown batch op \"{op.Op}\".");
                                        }
                                        phaseRefs.AddRange(stepRefs);
                                    }

                                    tr.Commit();
                                    transactionCommitted = true;

                                    // Post-commit non-mutating updates: MUST NOT falsify commit if they throw
                                    try
                                    {
                                        if (nativeUndo) RunSuppressed(currentDoc.Name, () => ed.Command("_.UNDO", "_End"));
                                        ScreenRefresh.AfterCommit(currentDoc);
                                        LiveView.FollowAfterMutation(currentDoc, phaseRefs, request.View);
                                    }
                                    catch (Exception postCommitEx)
                                    {
                                        System.Diagnostics.Trace.TraceWarning(
                                            $"[CadScheduler] Post-commit non-mutating update failed in phase {phaseIndex + 1}: {postCommitEx.Message}");
                                    }

                                    var journalEntry = BatchJournal.Record(
                                        currentDoc.Name,
                                        phaseRefs,
                                        phaseOps.Count,
                                        nativeUndo,
                                        request.TaskId,
                                        createdHandles,
                                        erasedPreImages,
                                        modifiedPreImages);
                                    System.Diagnostics.Trace.TraceInformation(
                                        $"[CadScheduler] {executionId} phase {phaseIndex + 1}/{totalPhases} committed in {phaseSw.ElapsedMilliseconds}ms (entities={phaseRefs.Count})");
                                    return new PhaseOutcome(phaseRefs, nativeUndo, journalEntry.BatchId, null, phaseConflicts);
                                }
                                catch (Exception ex)
                                {
                                    if (transactionCommitted)
                                    {
                                        // Once tr.Commit() succeeds, the DWG is committed. NEVER claim rollback or abort!
                                        return new PhaseOutcome(phaseRefs, nativeUndo, null, null);
                                    }

                                    if (nativeUndo) RunSuppressed(currentDoc.Name, () => ed.Command("_.UNDO", "_End"));
                                    phaseAborted = true;
                                    var isCancelled = ex is OperationCanceledException || ct.IsCancellationRequested;
                                    var abortedResult = new OperationsApplyResult
                                    {
                                        ExecutionId = executionId,
                                        Status = isCancelled ? "cancelled" : (committedBatchIds.Count > 0 ? "partial" : "aborted"),
                                        Partial = committedBatchIds.Count > 0,
                                        EntityRefs = allRefs,
                                        BatchId = committedBatchIds.LastOrDefault(),
                                        CommittedBatchIds = committedBatchIds,
                                        CompletedPhases = phaseIndex,
                                        TotalPhases = totalPhases,
                                        Phases = phaseInfos,
                                        Error = new ErrorInfoDto
                                        {
                                            Code = (ex as LocalRpcException)?.ErrorCode ?? PluginErrorCodes.TransactionFailed,
                                            Message = isCancelled ? "Operation cancelled during execution." : ex.Message,
                                            FailedStep = startStepOfPhase + stepOffset,
                                            CauseCode = (ex as LocalRpcException)?.ErrorCode,
                                        },
                                        // Handles skipped by earlier COMMITTED phases stay reported here.
                                        Conflicts = allConflicts.Count > 0 ? allConflicts : null,
                                    };
                                    return new PhaseOutcome(new List<EntityRefDto>(), nativeUndo, null, abortedResult);
                                }
                                finally
                                {
                                    tr.Dispose();
                                    if (phaseAborted) ScreenRefresh.AfterCommit(currentDoc);
                                }
                            }).ConfigureAwait(false);
                        }, ct).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException)
                        {
                            return new OperationsApplyResult
                            {
                                ExecutionId = executionId,
                                Status = "cancelled",
                                Partial = committedBatchIds.Count > 0,
                                EntityRefs = allRefs,
                                BatchId = committedBatchIds.LastOrDefault(),
                                CommittedBatchIds = committedBatchIds,
                                CompletedPhases = phaseIndex,
                                TotalPhases = totalPhases,
                                Phases = phaseInfos,
                                Error = new ErrorInfoDto
                                {
                                    Code = PluginErrorCodes.TransactionFailed,
                                    Message = "Operation cancelled while dispatching phase.",
                                    FailedStep = startStepOfPhase,
                                },
                                Conflicts = allConflicts.Count > 0 ? allConflicts : null,
                            };
                        }

                        lastNativeUndo = outcome.NativeUndo;
                        if (outcome.AbortedResult != null)
                        {
                            phaseInfos.Add(new PhaseExecutionInfoDto
                            {
                                Phase = phaseIndex,
                                Status = outcome.AbortedResult.Status,
                                EntityCount = 0,
                                Error = outcome.AbortedResult.Error?.Message,
                            });
                            return outcome.AbortedResult;
                        }

                        if (!string.IsNullOrEmpty(outcome.BatchId))
                        {
                            committedBatchIds.Add(outcome.BatchId!);
                        }
                        // Skipped-for-stale-state handles accumulate across committed phases.
                        if (outcome.Conflicts is { Count: > 0 }) allConflicts.AddRange(outcome.Conflicts);
                        allRefs.AddRange(outcome.Refs);
                        phaseInfos.Add(new PhaseExecutionInfoDto
                        {
                            Phase = phaseIndex,
                            Status = "committed",
                            BatchId = outcome.BatchId,
                            EntityCount = outcome.Refs.Count,
                        });
                        globalStep += phaseOps.Count;

                        // Cooperative yield between phases on ThreadPool without holding document lock
                        if (phaseIndex < microBatches.Count - 1)
                        {
                            var delayMs = InterPhaseDelayMs(paceMs, progressive);
                            if (delayMs > 0)
                            {
                                try
                                {
                                    await Task.Delay(delayMs, ct);
                                }
                                catch (OperationCanceledException)
                                {
                                    return new OperationsApplyResult
                                    {
                                        ExecutionId = executionId,
                                        Status = "cancelled",
                                        Partial = committedBatchIds.Count > 0,
                                        EntityRefs = allRefs,
                                        BatchId = committedBatchIds.LastOrDefault(),
                                        CommittedBatchIds = committedBatchIds,
                                        CompletedPhases = phaseIndex + 1,
                                        TotalPhases = totalPhases,
                                        Phases = phaseInfos,
                                        Error = new ErrorInfoDto
                                        {
                                            Code = PluginErrorCodes.TransactionFailed,
                                            Message = "Operation cancelled after phase committed.",
                                            FailedStep = globalStep,
                                        },
                                    };
                                }
                            }
                            else
                            {
                                await Task.Yield();
                            }
                        }
                    }

                    return new OperationsApplyResult
                    {
                        ExecutionId = executionId,
                        BatchId = committedBatchIds.LastOrDefault(),
                        TaskId = request.TaskId,
                        Sequence = BatchJournal.Top(docName)?.Sequence,
                        Partial = false,
                        EntityRefs = allRefs,
                        Conflicts = allConflicts.Count > 0 ? allConflicts : null,
                        CommittedBatchIds = committedBatchIds,
                        CompletedPhases = totalPhases,
                        TotalPhases = totalPhases,
                        Phases = phaseInfos,
                        Undo = lastNativeUndo
                            ? new UndoInfoDto()
                            : new UndoInfoDto { Supported = false, Mode = "unsupported-background", State = "none" },
                    };
                }).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return new OperationsApplyResult
                {
                    ExecutionId = request.IdempotencyKey ?? $"exec_{Guid.NewGuid():N}",
                    Status = "cancelled",
                    Partial = false,
                    EntityRefs = new List<EntityRefDto>(),
                    CommittedBatchIds = new List<string>(),
                    CompletedPhases = 0,
                    TotalPhases = 1,
                    Phases = new List<PhaseExecutionInfoDto>(),
                    Error = new ErrorInfoDto
                    {
                        Code = PluginErrorCodes.TransactionFailed,
                        Message = "Operation cancelled.",
                        FailedStep = 0,
                    },
                };
            }
            finally
            {
                gate.Release();
            }
        }
    }
}
