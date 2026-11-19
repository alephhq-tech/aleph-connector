using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;

namespace CadAI.AutoCAD.Journal
{
    /// <summary>
    /// Pre-image capture of an entity before it was modified by an operation, plus optional post-state.
    /// Used by non-LIFO compensating revert to invert property mutations and transforms.
    /// </summary>
    public sealed class ModifiedEntityPreImage
    {
        public string Handle { get; set; } = "";
        public string Kind { get; set; } = "";
        public EntityDetailDto Before { get; set; } = new EntityDetailDto();
        public EntityDetailDto? After { get; set; }
    }

    /// <summary>
    /// Durable, task-scoped record of an executed operations batch or task phase.
    /// Stored on disk under %LOCALAPPDATA%\CadAI\tasks\{documentIdentity}\{changeSetId}.json.
    /// Enables non-LIFO selective recovery by capturing created handles, erased pre-images,
    /// and modified pre-images, indexed by both TaskId and BatchId.
    /// </summary>
    public sealed class TaskChangeSet
    {
        public string ChangeSetId { get; set; } = "";
        /// <summary>Logical task identifier (e.g. "task_fire_protection_123") spanning multiple batches.</summary>
        public string? TaskId { get; set; }
        /// <summary>Unique batch identifier (e.g. "batch_4a1b2c3d").</summary>
        public string BatchId { get; set; } = "";
        public int Sequence { get; set; }
        public string DocumentName { get; set; } = "";
        public string DocumentIdentity { get; set; } = "";
        public DateTimeOffset TimestampUtc { get; set; }
        public int OperationCount { get; set; }
        /// <summary>"committed", "undone" (via native LIFO undo), or "reverted" (via non-LIFO compensating revert).</summary>
        public string Status { get; set; } = "committed";
        public int GenerationAtCommit { get; set; }
        public bool UndoSupported { get; set; } = true;
        public string? BaselineRevision { get; set; }

        /// <summary>All entity refs affected (backward compatibility with BatchJournalEntry).</summary>
        public List<EntityRefDto> EntityRefs { get; set; } = new();

        /// <summary>Handles of entities created in this batch (inverse action: erase).</summary>
        public List<string> CreatedHandles { get; set; } = new();

        /// <summary>Pre-images of entities erased in this batch (inverse action: recreate).</summary>
        public List<EntityPreImage> ErasedPreImages { get; set; } = new();

        /// <summary>Pre-images of entities modified in this batch (inverse action: restore properties).</summary>
        public List<ModifiedEntityPreImage> ModifiedPreImages { get; set; } = new();
    }
}
