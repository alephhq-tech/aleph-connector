using System;
using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    /// <summary>
    /// Wire shape for one step of an <c>operations.apply</c> batch (docs/PROTOCOL.md). Reuses
    /// the exact same per-kind request shapes <c>entity.create</c>/<c>entity.transform</c> use.
    /// </summary>
    public sealed class EntityOperationDto
    {
        public string Op { get; set; } = "";
        public CreateEntityRequest? Entity { get; set; }
        public List<string>? Handles { get; set; }
        public EntityTransformRequest? Transform { get; set; }
        /// <summary>Patch an existing entity in place without replacing its handle.</summary>
        public EntityUpdateRequest? Update { get; set; }
    }

    public sealed class OperationsApplyRequest
    {
        public List<EntityOperationDto> Operations { get; set; } = new();
        public string? DocumentName { get; set; }
        public string? TaskId { get; set; }
        /// <summary>Repeat this key on retry to get the original result back instead of re-executing (autocad-mcp#9).</summary>
        public string? IdempotencyKey { get; set; }
        public ViewOverrideDto? View { get; set; }
        /// <summary>Repaint partway through the batch instead of only at the end (autocad-mcp#67). Default false.</summary>
        public bool? Progressive { get; set; }
        /// <summary>Extra delay (ms) between progressive repaints; hard-capped, see OperationsHandlers.Apply.</summary>
        public double? PaceMs { get; set; }
        /// <summary>
        /// Native revision precondition (#413 phase A). Checked atomically against
        /// <c>tdu:{Database.Tduupdate.Ticks};saves:{Database.NumberOfSaves}</c> before the FIRST
        /// phase's transaction starts -- never on later phases, since this call's own earlier
        /// phases legitimately advance it. A mismatch returns
        /// <c>Status = "requires_revalidation"</c> with zero side effects (no transaction opened).
        /// Optional and caller-supplied from a prior read -- never a mandatory round trip.
        /// </summary>
        public string? ExpectedRevision { get; set; }
        /// <summary>
        /// Per-entity write-set precondition (#413 phase B). Maps a handle the batch is about to
        /// mutate (erase/transform/update) to a state fingerprint of that entity from a prior read
        /// (entity.get detail:"full"'s <c>stateDigest</c> — the PreImageCanonical digest of its
        /// bounds-free detail). Handles in this map whose live digest differs are SKIPPED (zero
        /// mutation for them) and reported in <see cref="OperationsApplyResult.Conflicts"/>; every
        /// other handle in the batch proceeds normally — conflict-aware reconciliation, deliberately
        /// NOT the all-or-nothing whole-document gate phase A's ExpectedRevision is. A handle with
        /// no entry (including the whole map being absent) is never checked. Keys are matched
        /// case-insensitively against handle hex.
        /// </summary>
        public Dictionary<string, string>? ExpectedState { get; set; }
    }

    /// <summary>
    /// One per-entity write-set precondition miss (#413 phase B): the named handle was NOT
    /// mutated because its live state digest no longer matches the caller's captured one.
    /// </summary>
    public sealed class StateConflictDto
    {
        public string Handle { get; set; } = "";
        /// <summary>The caller's captured digest.</summary>
        public string Expected { get; set; } = "";
        /// <summary>The digest recomputed live inside the batch's transaction.</summary>
        public string Actual { get; set; } = "";
        public string Reason { get; set; } = "state_conflict";
    }

    public sealed class UndoInfoDto
    {
        public bool Supported { get; set; } = true;
        /// <summary>"native-lifo", or "unsupported-background" for a batch run on a non-active tab.</summary>
        public string Mode { get; set; } = "native-lifo";
        public string State { get; set; } = "top";
    }

    public sealed class ErrorInfoDto
    {
        public int Code { get; set; }
        public string Message { get; set; } = "";

        /// <summary>Zero-based index of the batch step that failed, when known.</summary>
        public int? FailedStep { get; set; }

        /// <summary>The failing step's own plugin error code (e.g. LayerNotFound), when it raised one.</summary>
        public int? CauseCode { get; set; }
    }

    public sealed class PhaseExecutionInfoDto
    {
        public int Phase { get; set; }
        public string Status { get; set; } = "";
        public string? BatchId { get; set; }
        public int EntityCount { get; set; }
        public string? Error { get; set; }
    }

    /// <summary>
    /// Result of operations.apply. When progressive or multi-phase commits are used,
    /// <see cref="Partial"/>, <see cref="CommittedBatchIds"/>, and <see cref="Phases"/> report
    /// the exact state of what was committed before completion, failure, or cancellation.
    /// </summary>
    public sealed class OperationsApplyResult
    {
        public string? BatchId { get; set; }
        public string? TaskId { get; set; }
        public int? Sequence { get; set; }
        /// <summary>
        /// Execution outcome: "committed", "aborted", "partial", "cancelled", "failed", "busy",
        /// "requires_revalidation", or "outcome_unknown".
        /// </summary>
        public string Status { get; set; } = "";
        public List<EntityRefDto> EntityRefs { get; set; } = new();
        public ErrorInfoDto? Error { get; set; }
        public UndoInfoDto? Undo { get; set; }
        public string? ExecutionId { get; set; }
        public bool? Partial { get; set; }
        public List<string>? CommittedBatchIds { get; set; }
        public int? CompletedPhases { get; set; }
        public int? TotalPhases { get; set; }
        public List<PhaseExecutionInfoDto>? Phases { get; set; }
        /// <summary>
        /// Handles this batch SKIPPED because their live state digest didn't match the caller's
        /// <c>expectedState</c> entry (#413 phase B). Absent/empty when nothing was skipped; the
        /// batch itself still committed everything else (status stays "committed").
        /// </summary>
        public List<StateConflictDto>? Conflicts { get; set; }
    }

    public sealed class OperationsPreviewRequest
    {
        public List<EntityOperationDto> Operations { get; set; } = new();
        public string? DocumentName { get; set; }
        public string? TaskId { get; set; }
    }

    public sealed class OperationsPreviewResult
    {
        public bool Valid { get; set; } = true;
        public int OperationCount { get; set; }
        public List<EntityRefDto> EntityRefs { get; set; } = new();
        public BoundsDto? Extents { get; set; }
        public ErrorInfoDto? Error { get; set; }
    }
    public sealed class OperationsRevertRequest
    {
        public string? DocumentName { get; set; }
        public string? BatchId { get; set; }
        public string? TaskId { get; set; }
    }

    public sealed class OperationsRevertResult
    {
        public string Status { get; set; } = "reverted";
        public string? BatchId { get; set; }
        public string? TaskId { get; set; }
        public int RevertedChangeSetsCount { get; set; }
        public List<string> ErasedHandles { get; set; } = new();
        public List<string> RecreatedHandles { get; set; } = new();
        public List<string> RestoredHandles { get; set; } = new();
    }
    public sealed class OperationsUndoRequest
    {
        public string BatchId { get; set; } = "";
        public string? DocumentName { get; set; }
    }

    public sealed class OperationsUndoResult
    {
        public string BatchId { get; set; } = "";
        public string Status { get; set; } = "";
    }

    public sealed class OperationsHistoryRequest
    {
        public int? Limit { get; set; }
        public string? DocumentName { get; set; }
        public string? TaskId { get; set; }
    }

    public sealed class BatchJournalEntrySummaryDto
    {
        public string BatchId { get; set; } = "";
        public string? TaskId { get; set; }
        public int Sequence { get; set; }
        public DateTimeOffset TimestampUtc { get; set; }
        public int OperationCount { get; set; }
        public List<EntityRefDto> EntityRefs { get; set; } = new();
        public string Status { get; set; } = "";
    }

    public sealed class OperationsHistoryResult
    {
        public List<BatchJournalEntrySummaryDto> Batches { get; set; } = new();
    }
}
