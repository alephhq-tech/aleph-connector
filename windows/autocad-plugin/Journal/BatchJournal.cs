using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.ApplicationServices;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Journal
{
    /// <summary>
    /// Per-document (<see cref="Document.Name"/>-keyed — matches every other RPC handler's
    /// existing single-active-document assumption, no new multi-document scope), in-memory
    /// journal of <c>operations.apply</c> batches. Backs <c>operations.apply/undo/redo/history</c>
    /// (see <c>RpcHandlers/OperationsHandlers.cs</c>, <c>specs/done/entity-and-operations-expansion</c>).
    ///
    /// LIFO-only by design: "top" is the most recent entry still in "committed" state (scanning
    /// from the end, skipping already-undone entries lets chained undos/redos work correctly).
    /// Redo is tracked via a separate per-document stack of undone batch ids in undo order — NOT
    /// by journal position — since the most-recently-undone batch is not necessarily the last one
    /// ever committed.
    /// </summary>
    public static class BatchJournal
    {
        private static readonly ConcurrentDictionary<string, List<BatchJournalEntry>> Entries = new();
        private static readonly ConcurrentDictionary<string, List<string>> UndoneStacks = new();
        private static readonly ConcurrentDictionary<string, int> SequenceCounters = new();
        private static readonly ConcurrentDictionary<string, int> Generations = new();
        private static readonly ConcurrentDictionary<string, bool> Suppressed = new();
        private static readonly ConcurrentDictionary<string, bool> Hooked = new();
        private static readonly ConcurrentDictionary<string, object> Locks = new();

        private static object LockFor(string documentName) => Locks.GetOrAdd(documentName, _ => new object());
        private static List<BatchJournalEntry> EntriesFor(string documentName) =>
            Entries.GetOrAdd(documentName, _ => new List<BatchJournalEntry>());
        private static List<string> UndoneStackFor(string documentName) =>
            UndoneStacks.GetOrAdd(documentName, _ => new List<string>());

        /// <summary>
        /// Subscribes this document's <c>CommandEnded</c>/<c>CommandCancelled</c>/<c>CommandFailed</c>
        /// events (once) to a per-document generation counter, used for best-effort undo-stack
        /// divergence detection. Idempotent — safe to call on every RPC entry point. There is no
        /// existing document-activation hook in this plugin to piggyback on (single-document
        /// assumption throughout), so each entry point self-hooks its document lazily instead.
        /// </summary>
        public static void EnsureHooked(Document doc)
        {
            if (!Hooked.TryAdd(doc.Name, true)) return;
            var name = doc.Name;
            doc.CommandEnded += (_, _) => Bump(name);
            doc.CommandCancelled += (_, _) => Bump(name);
            doc.CommandFailed += (_, _) => Bump(name);
        }

        private static void Bump(string documentName)
        {
            if (Suppressed.TryGetValue(documentName, out var suppressed) && suppressed) return;
            Generations.AddOrUpdate(documentName, 1, (_, g) => g + 1);
        }

        /// <summary>
        /// Wrap our own synthetic <c>_.UNDO</c>/<c>_.REDO</c> commands with
        /// <c>Suppress(name, true)</c>/<c>Suppress(name, false)</c> so they don't themselves count
        /// as "the command history changed" divergence.
        /// </summary>
        public static void Suppress(string documentName, bool suppressed) => Suppressed[documentName] = suppressed;

        public static int CurrentGeneration(string documentName) => Generations.TryGetValue(documentName, out var generation) ? generation : 0;

        public static BatchJournalEntry Record(
            string documentName,
            List<EntityRefDto> entityRefs,
            int operationCount,
            bool undoSupported = true,
            string? taskId = null,
            List<string>? createdHandles = null,
            List<CadAI.AutoCAD.Edits.EntityPreImage>? erasedPreImages = null,
            List<ModifiedEntityPreImage>? modifiedPreImages = null)
        {
            lock (LockFor(documentName))
            {
                var sequence = SequenceCounters.AddOrUpdate(documentName, 1, (_, s) => s + 1);
                var entry = new BatchJournalEntry
                {
                    BatchId = "batch_" + Guid.NewGuid().ToString("N"),
                    TaskId = taskId,
                    Sequence = sequence,
                    DocumentName = documentName,
                    TimestampUtc = DateTimeOffset.UtcNow,
                    OperationCount = operationCount,
                    EntityRefs = entityRefs,
                    Status = "committed",
                    GenerationAtCommit = CurrentGeneration(documentName),
                    UndoSupported = undoSupported,
                };
                EntriesFor(documentName).Add(entry);
                UndoneStackFor(documentName).Clear(); // a new action invalidates any pending redo

                // Bridge to durable CadTaskLedger
                try
                {
                    CadTaskLedger.Record(new TaskChangeSet
                    {
                        BatchId = entry.BatchId,
                        TaskId = taskId,
                        Sequence = sequence,
                        DocumentName = documentName,
                        TimestampUtc = entry.TimestampUtc,
                        OperationCount = operationCount,
                        EntityRefs = entityRefs,
                        Status = "committed",
                        GenerationAtCommit = entry.GenerationAtCommit,
                        UndoSupported = undoSupported,
                        CreatedHandles = createdHandles ?? entityRefs.Select(e => e.Handle).ToList(),
                        ErasedPreImages = erasedPreImages ?? new List<CadAI.AutoCAD.Edits.EntityPreImage>(),
                        ModifiedPreImages = modifiedPreImages ?? new List<ModifiedEntityPreImage>()
                    });
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Trace.TraceWarning($"[BatchJournal] Failed to mirror to CadTaskLedger: {ex.Message}");
                }

                return entry;
            }
        }

        /// <summary>The most recent still-committed (not yet undone) batch — the only one <c>operations.undo</c> may target.</summary>
        public static BatchJournalEntry? Top(string documentName)
        {
            lock (LockFor(documentName))
            {
                var list = EntriesFor(documentName);
                for (int i = list.Count - 1; i >= 0; i--)
                {
                    if (list[i].Status == "committed") return list[i];
                }
                return null;
            }
        }

        /// <summary>The most recently undone batch — the only one <c>operations.redo</c> may target.</summary>
        public static BatchJournalEntry? RedoCandidate(string documentName)
        {
            lock (LockFor(documentName))
            {
                var stack = UndoneStackFor(documentName);
                if (stack.Count == 0) return null;
                var batchId = stack[stack.Count - 1];
                return EntriesFor(documentName).Find(e => e.BatchId == batchId);
            }
        }

        public static BatchJournalEntry? Find(string documentName, string batchId)
        {
            lock (LockFor(documentName))
            {
                return EntriesFor(documentName).Find(e => e.BatchId == batchId);
            }
        }

        public static void MarkUndone(string documentName, string batchId)
        {
            lock (LockFor(documentName))
            {
                var entry = EntriesFor(documentName).Find(e => e.BatchId == batchId);
                if (entry != null) entry.Status = "undone";
                UndoneStackFor(documentName).Add(batchId);
                CadTaskLedger.MarkUndone(documentName, batchId);
            }
        }

        public static void MarkRedone(string documentName, string batchId)
        {
            lock (LockFor(documentName))
            {
                var entry = EntriesFor(documentName).Find(e => e.BatchId == batchId);
                if (entry != null) entry.Status = "committed";
                var stack = UndoneStackFor(documentName);
                if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
                CadTaskLedger.MarkRedone(documentName, batchId);
            }
        }
        public static IReadOnlyList<BatchJournalEntry> Recent(string documentName, int limit)
        {
            lock (LockFor(documentName))
            {
                var list = EntriesFor(documentName);
                return list.AsEnumerable().Reverse().Take(limit).ToList();
            }
        }
    }
}
