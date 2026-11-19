using System.Collections.Generic;
using CadAI.AutoCAD.Edits;

namespace CadAI.AutoCAD.Dto
{
    public sealed class EditBeginRequest
    {
        public List<string>? Handles { get; set; }
        public string? Selection { get; set; }
        public string? DocumentName { get; set; }
        public bool? IncludeDependencies { get; set; }
    }

    public sealed class EditBeginResult
    {
        public string EditId { get; set; } = "";
        public string DocumentIdentity { get; set; } = "";
        public string RevisionAtCapture { get; set; } = "";
        public List<EntityPreImage> PreImages { get; set; } = new();
        public List<EntityRefDto> Candidates { get; set; } = new();
        public string CandidateLayer { get; set; } = "";
        public List<string> UnsupportedFeatures { get; set; } = new();
    }

    public sealed class EditApplyRequest
    {
        public string EditId { get; set; } = "";
        public List<EntityOperationDto> Operations { get; set; } = new();
        public string? DocumentName { get; set; }
        public string? IdempotencyKey { get; set; }
        public ViewOverrideDto? View { get; set; }
        public bool? Progressive { get; set; }
        public double? PaceMs { get; set; }
    }

    public sealed class EditApplyResult
    {
        public string? BatchId { get; set; }
        public int? Sequence { get; set; }
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
        public string? StaleSince { get; set; }
    }

    public sealed class EditPreviewCaptureRequest
    {
        public int? Width { get; set; }
        public int? Height { get; set; }
    }

    public sealed class EditPreviewRequest
    {
        public string EditId { get; set; } = "";
        public string? DocumentName { get; set; }
        public EditPreviewCaptureRequest? Capture { get; set; }
    }

    public sealed class EditPreviewResult
    {
        public EditDiffResult Diff { get; set; } = null!;
        public string? BeforePng { get; set; }
        public string? AfterPng { get; set; }
    }

    public sealed class EditDiscardRequest
    {
        public string EditId { get; set; } = "";
        public string? ApprovalToken { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class EditDiscardResult
    {
        public string Status { get; set; } = "discarded";
        public List<string> RemovedCandidates { get; set; } = new();
    }

    public sealed class EditAcceptRequest
    {
        public string EditId { get; set; } = "";
        public string? ApprovalToken { get; set; }
        public string? ExpectedDiffDigest { get; set; }
        public string? ExpectedRevision { get; set; }
        public bool? AllowUnknownFeatures { get; set; }
        public string? IdempotencyKey { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class EditAcceptResult
    {
        public string Status { get; set; } = "accepted";
        public string EditId { get; set; } = "";
        public Dictionary<string, string> AppliedMapping { get; set; } = new();
        public string DiffDigest { get; set; } = "";
    }

    public sealed class EditStatusRequest
    {
        public string EditId { get; set; } = "";
        public string? DocumentName { get; set; }
    }

    public sealed class EditStatusResult
    {
        public string EditId { get; set; } = "";
        public string Status { get; set; } = "";
        public string CandidateLayer { get; set; } = "";
        public List<string> CandidateHandles { get; set; } = new();
        public List<string> SourceHandles { get; set; } = new();
        public int PreImageCount { get; set; }
        public string RevisionAtCapture { get; set; } = "";
        public Dictionary<string, string>? AppliedMapping { get; set; }
    }
}
