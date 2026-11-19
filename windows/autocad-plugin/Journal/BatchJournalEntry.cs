using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Journal
{
    /// <summary>
    /// One committed <c>operations.apply</c> batch, kept in <see cref="BatchJournal"/>'s
    /// per-document in-memory list. Not persisted across plugin reload/AutoCAD restart — same
    /// MVP posture as <c>device-gateway</c>'s device registry.
    /// </summary>
    public sealed class BatchJournalEntry
    {
        public string BatchId { get; init; } = "";
        public string? TaskId { get; init; }
        public int Sequence { get; init; }
        public string DocumentName { get; init; } = "";
        public DateTimeOffset TimestampUtc { get; init; }
        public int OperationCount { get; init; }
        public List<EntityRefDto> EntityRefs { get; init; } = new();

        /// <summary>"committed" | "undone". Flips back to "committed" on a successful redo.</summary>
        public string Status { get; set; } = "committed";

        /// <summary>
        /// <see cref="BatchJournal"/>'s per-document command-generation counter at the moment
        /// this batch committed — compared against the current generation at undo time to
        /// detect (best-effort) that AutoCAD's command history diverged since.
        /// </summary>
        public int GenerationAtCommit { get; init; }

        /// <summary>
        /// False for a batch committed on a background tab: it ran without a native undo group
        /// (<c>Editor.Command</c> is only valid for the active document), so <c>_.UNDO 1</c> would
        /// revert some other step of that drawing. Undo/redo of it is refused.
        /// </summary>
        public bool UndoSupported { get; init; } = true;
    }
}
