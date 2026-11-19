using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Util;

namespace CadAI.AutoCAD.CadState
{
    /// <summary>
    /// Per-document change observation for the Cloud CAD State Engine's incremental sync.
    ///
    /// AutoCAD's own database reactors (<c>Database.ObjectAppended</c>/<c>ObjectModified</c>/
    /// <c>ObjectErased</c>) say WHICH objects a command touched; the document's command boundaries
    /// (<c>CommandEnded</c>/<c>CommandCancelled</c>/<c>CommandFailed</c> — the same trio
    /// <see cref="CadAI.AutoCAD.Journal.BatchJournal"/> already uses) say WHEN that state is stable.
    /// The tracker therefore does exactly two things:
    ///
    ///  1. In the reactor callbacks: record the touched handle into a per-document pending set.
    ///     NO transaction, NO network, NO property reads beyond <c>Handle</c>/<c>OwnerId</c> — these
    ///     callbacks run inside AutoCAD's own object-open path, and Autodesk's guidance is explicit
    ///     that a reactor must not query or mutate the database it reacts to. A callback that throws
    ///     or blocks would corrupt or hang the user's command, so that is a hard rule here.
    ///  2. At a command boundary (and before any <c>cad.changes</c> read): coalesce the pending
    ///     handles into ONE event with a monotonic per-document sequence in a bounded ring.
    ///
    /// When the ring overflows the OLDEST events drop and <see cref="DocumentTracker.EarliestSequence"/>
    /// advances — exactly the signal Cloud needs to detect a lost-event gap and reconcile instead of
    /// applying a partial delta. Losing events is survivable; silently pretending they never happened
    /// is not.
    ///
    /// Scope of what is recorded: model-space graphic entities (the entity index's own scope) as
    /// created/modified/erased, and block-definition / layer-table record touches as
    /// <c>dependency_invalidated</c> (they silently change what many indexed entities mean).
    /// Paper-space and block-definition CHILD entities are not recorded individually — any such edit
    /// still moves the drawing revision, which Cloud detects through its revision check, so the
    /// tracker never has to be the only line of defense.
    ///
    /// Lifetime: plugin-process memory keyed by <see cref="Document.Name"/>, like every other
    /// per-document journal here (<c>BatchJournal</c>, <c>IdempotencyCache</c>, <c>LiveView</c>). A
    /// plugin reload (<c>CADAIRELOAD</c>) clears it and the sequence restarts at 1; Cloud sees the
    /// reset (its cursor sits above the new <c>latestSequence</c>) and falls back to a scoped refresh.
    /// </summary>
    public static class ChangeTracker
    {
        /// <summary>Ring capacity per document: 2000 coalesced command-batches covers a long editing
        /// session; beyond it the oldest drop and Cloud reconciles.</summary>
        public const int MaxEventsPerDocument = 2000;

        /// <summary>Cap on handles per event — one command touching 50k entities reports the first N
        /// and flags truncation rather than shipping a megabyte over the pipe.</summary>
        public const int MaxHandlesPerEvent = 500;

        /// <summary>Keyed by <see cref="DocumentContext.IdOf"/> — the stable per-tab id, NOT
        /// <c>Document.Name</c>. A SAVEAS changes the name but not the tab, and two tabs can hold
        /// the same file name from different folders; both would collide under a name key.</summary>
        private static readonly ConcurrentDictionary<string, DocumentTracker> PerDocument =
            new(StringComparer.Ordinal);

        private static bool _destroyedHooked;

        /// <summary>
        /// Subscribes <paramref name="doc"/>'s reactors + command boundaries, once per document.
        /// Idempotent — safe to call from every RPC entry point, mirroring
        /// <see cref="Journal.BatchJournal"/>. Runs on AutoCAD's main thread (it opens the block
        /// table once to resolve the model-space owner id), which every handler already is via
        /// <see cref="MainThreadDispatcher"/>.
        /// </summary>
        public static void WatchDocument(Document doc)
        {
            EnsureDestroyedHook();
            var tracker = PerDocument.GetOrAdd(DocumentContext.IdOf(doc), _ => new DocumentTracker());
            tracker.DocumentName = doc.Name;
            if (tracker.Watched) return;

            var db = doc.Database;
            ObjectId modelSpaceId;
            using (var tr = db.TransactionManager.StartTransaction())
            {
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                modelSpaceId = bt[BlockTableRecord.ModelSpace];
                tr.Commit();
            }

            // Delegates are stored on the tracker so `Unwatch` can detach them. Anonymous lambdas
            // cannot be unsubscribed, and a leaked reactor keeps firing on a closed database.
            tracker.Appended = (_, e) => tracker.Record("created", e.DBObject, modelSpaceId);
            tracker.Modified = (_, e) => tracker.Record("modified", e.DBObject, modelSpaceId);
            // AutoCAD's ObjectErased reactor fires for BOTH erase and unerased (Undo/Redo).
            // e.Erased is true if the entity was erased; false if it was restored/unerased (e.g. by Undo).
            tracker.Erased = (_, e) => tracker.Record(e.Erased ? "erased" : "created", e.DBObject, modelSpaceId);
            tracker.XrefSubCommandEnd = (_, e) =>
            {
                try
                {
                    bool recorded = false;
                    if (e.btrIds != null)
                    {
                        foreach (ObjectId id in e.btrIds)
                        {
                            if (id.IsValid)
                            {
                                tracker.RecordHandle(id.Handle.ToString(), "dependency_invalidated", dependency: true);
                                recorded = true;
                            }
                        }
                    }
                    if (!recorded)
                    {
                        tracker.RecordHandle("xref", "dependency_invalidated", dependency: true);
                    }
                    tracker.Flush();
                }
                catch
                {
                    // Reactors must never throw back into AutoCAD
                }
            };
            tracker.CommandEnded = (_, _) => tracker.Flush();
            tracker.CommandCancelled = (_, _) => tracker.Flush();
            tracker.CommandFailed = (_, _) => tracker.Flush();

            db.ObjectAppended += tracker.Appended;
            db.ObjectModified += tracker.Modified;
            db.ObjectErased += tracker.Erased;
            db.XrefSubCommandEnd += tracker.XrefSubCommandEnd;

            // Command boundaries: where AutoCAD's state is stable enough to snapshot the pending
            // handles. Cancelled/Failed matter too — a cancelled command can append objects that
            // AutoCAD then un-appends, and the erase reactor fires for that rollback; recording it
            // keeps the delta honest about what actually happened.
            doc.CommandEnded += tracker.CommandEnded;
            doc.CommandCancelled += tracker.CommandCancelled;
            doc.CommandFailed += tracker.CommandFailed;

            tracker.Watched = true;
        }

        /// <summary>The tracker for an open document (an empty one when it was never watched — an
        /// empty feed reads as "no delta available, reconcile", never as "nothing changed").</summary>
        public static DocumentTracker ForDocument(Document doc)
        {
            var tracker = PerDocument.GetOrAdd(DocumentContext.IdOf(doc), _ => new DocumentTracker());
            tracker.DocumentName = doc.Name;
            return tracker;
        }

        /// <summary>Testing seam and string lookup: returns the tracker for <paramref name="key"/>.</summary>
        public static DocumentTracker For(string key) =>
            PerDocument.GetOrAdd(key, _ => new DocumentTracker());

        /// <summary>Drops a closed document's tracker so a reopened file starts a clean sequence
        /// instead of inheriting handles from a drawing that no longer exists.</summary>
        public static void Forget(Document doc)
        {
            if (PerDocument.TryRemove(DocumentContext.IdOf(doc), out var tracker)) tracker.Unwatch(doc);
        }

        /// <summary>Testing seam and string cleanup: removes the tracker for <paramref name="key"/>.</summary>
        public static void Forget(string key) =>
            PerDocument.TryRemove(key, out _);

        /// <summary>Closes the feed for a destroyed document. Keyed by name because
        /// `DocumentDestroyed` no longer exposes the live Document object.</summary>
        public static void ForgetByName(string? fileName)
        {
            if (string.IsNullOrEmpty(fileName)) return;
            foreach (var pair in PerDocument)
            {
                if (string.Equals(pair.Value.DocumentName, fileName, StringComparison.OrdinalIgnoreCase))
                {
                    PerDocument.TryRemove(pair.Key, out _);
                }
            }
        }

        private static void EnsureDestroyedHook()
        {
            if (_destroyedHooked) return;
            _destroyedHooked = true;
            Application.DocumentManager.DocumentDestroyed += (_, e) => ForgetByName(e.FileName);
        }
    }

    /// <summary>One document's change feed: pending handle sets + the bounded coalesced ring.</summary>
    public sealed class DocumentTracker
    {
        private readonly object _gate = new();
        private readonly Dictionary<string, PendingEntry> _pending = new(StringComparer.Ordinal);
        private readonly LinkedList<ChangeRecord> _events = new();
        private long _sequence;

        internal bool Watched { get; set; }

        /// <summary>Last known `Document.Name` — used only to find the tracker on
        /// `DocumentDestroyed`, never as the identity key.</summary>
        public string DocumentName { get; set; } = "";

        /// <summary>
        /// Feed epoch. A plugin reload (new process) or a close/reopen (new tracker) produces a
        /// NEW generation while the sequence restarts at 1. Cloud compares the generation to
        /// distinguish "the plugin restarted" from "the feed continued" — a cursor above the new
        /// `latestSequence` is only a reset when the generation changed; without this, a
        /// coincidence could be mistaken for a normal continuation.
        /// </summary>
        public string Generation { get; } = Guid.NewGuid().ToString("N").Substring(0, 16);

        internal ObjectEventHandler? Appended;
        internal ObjectEventHandler? Modified;
        internal ObjectErasedEventHandler? Erased;
        internal XrefSubCommandEndEventHandler? XrefSubCommandEnd;
        internal CommandEventHandler? CommandEnded;
        internal CommandEventHandler? CommandCancelled;
        internal CommandEventHandler? CommandFailed;

        /// <summary>Detaches every reactor this tracker installed. Called on document close so a
        /// destroyed database never keeps firing into plugin memory.</summary>
        internal void Unwatch(Document doc)
        {
            if (!Watched) return;
            Watched = false;
            var db = doc.Database;
            if (Appended != null) db.ObjectAppended -= Appended;
            if (Modified != null) db.ObjectModified -= Modified;
            if (Erased != null) db.ObjectErased -= Erased;
            if (XrefSubCommandEnd != null) db.XrefSubCommandEnd -= XrefSubCommandEnd;
            if (CommandEnded != null) doc.CommandEnded -= CommandEnded;
            if (CommandCancelled != null) doc.CommandCancelled -= CommandCancelled;
            if (CommandFailed != null) doc.CommandFailed -= CommandFailed;
        }

        private sealed class PendingEntry
        {
            public string Operation = "";
            /// <summary>True for a block-definition / layer-table record touch: the index must
            /// invalidate dependents, not just this handle.</summary>
            public bool Dependency;
        }

        public sealed class ChangeRecord
        {
            public long Sequence;
            public string Operation = "";
            public bool Truncated;
            public List<string> Handles = new();
            public long Timestamp;
        }

        /// <summary>
        /// Reactor callback: a dictionary insert under a lock and nothing else. Never throws back
        /// into AutoCAD's object-open path — a dropped observation is safe, because Cloud detects
        /// the resulting sequence gap and reconciles.
        /// </summary>
        internal void Record(string operation, DBObject? obj, ObjectId modelSpaceId)
        {
            try
            {
                if (obj is null) return;

                bool dependency = false;
                if (obj is Entity entity)
                {
                    ObjectId owner;
                    try { owner = entity.OwnerId; }
                    catch (Autodesk.AutoCAD.Runtime.Exception) { return; }
                    // Only model-space entities are index rows; anything else (paper space, a block
                    // definition's children) is covered by the drawing revision check instead.
                    if (owner != modelSpaceId) return;
                }
                else if (obj is BlockTableRecord || obj is LayerTableRecord)
                {
                    dependency = true;
                }
                else
                {
                    return;
                }

                string handle;
                try { handle = obj.Handle.ToString(); }
                catch (Autodesk.AutoCAD.Runtime.Exception) { return; }
                if (string.IsNullOrEmpty(handle)) return;

                RecordHandle(handle, operation, dependency);
            }
            catch (Exception)
            {
                // See the method comment: a reactor must never surface an exception to AutoCAD.
            }
        }

        /// <summary>
        /// The pure half of <see cref="Record"/>: handle-string bookkeeping with no AutoCAD types,
        /// so the coalescing/precedence/ring rules are unit-testable without a running AutoCAD (a
        /// <c>DBObject</c> cannot be constructed outside one). The reactor callback above is a thin
        /// extraction-and-filter wrapper over this.
        /// </summary>
        internal void RecordHandle(string handle, string operation, bool dependency)
        {
            lock (_gate)
            {
                if (!_pending.TryGetValue(handle, out var entry))
                {
                    entry = new PendingEntry { Dependency = dependency };
                    _pending[handle] = entry;
                }
                entry.Dependency |= dependency;
                // Precedence within one batch:
                // - If operation is "erased", erased wins.
                // - If an entity was marked "erased" and now unerased/created (Undo) in the same command, it becomes "modified".
                // - Otherwise the first operation recorded stands.
                if (operation == "erased") entry.Operation = "erased";
                else if (entry.Operation == "erased" && operation == "created") entry.Operation = "modified";
                else if (entry.Operation.Length == 0) entry.Operation = operation;
            }
        }

        /// <summary>Coalesces the pending handles into sequence-numbered events and appends them to
        /// the bounded ring. Called at command boundaries and before any <c>cad.changes</c> read.</summary>
        public void Flush()
        {
            List<KeyValuePair<string, PendingEntry>> batch;
            lock (_gate)
            {
                if (_pending.Count == 0) return;
                batch = new List<KeyValuePair<string, PendingEntry>>(_pending);
                _pending.Clear();
                AppendBatchLocked(batch);
            }
        }

        private void AppendBatchLocked(List<KeyValuePair<string, PendingEntry>> batch)
        {
            var entityHandles = new List<string>();
            var dependencyHandles = new List<string>();
            string entityOperation = "modified";
            bool entityOperationUniform = true;

            foreach (var kv in batch)
            {
                var handle = kv.Key;
                var entry = kv.Value;
                if (entry.Dependency)
                {
                    dependencyHandles.Add(handle);
                    continue;
                }
                if (entityHandles.Count == 0) entityOperation = entry.Operation;
                else if (entityOperation != entry.Operation) entityOperationUniform = false;
                entityHandles.Add(handle);
            }

            if (entityHandles.Count > 0)
            {
                // Several handles touched by one command: unless they all share one operation, the
                // honest label is "modified" (a mixed create+edit batch is not purely either).
                AppendLocked(entityOperationUniform ? entityOperation : "modified", entityHandles);
            }
            if (dependencyHandles.Count > 0)
            {
                AppendLocked("dependency_invalidated", dependencyHandles);
            }
        }

        private void AppendLocked(string operation, List<string> handles)
        {
            bool truncated = handles.Count > ChangeTracker.MaxHandlesPerEvent;
            if (truncated) handles = handles.GetRange(0, ChangeTracker.MaxHandlesPerEvent);
            _events.AddLast(new ChangeRecord
            {
                Sequence = ++_sequence,
                Operation = operation,
                Truncated = truncated,
                Handles = handles,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
            while (_events.Count > ChangeTracker.MaxEventsPerDocument)
            {
                _events.RemoveFirst();
            }
        }

        /// <summary>Lowest sequence still held (0 when the ring is empty). A cursor below this means
        /// events were dropped — Cloud must reconcile, not apply a partial delta.</summary>
        public long EarliestSequence
        {
            get { lock (_gate) { return _events.First?.Value.Sequence ?? 0; } }
        }

        public long LatestSequence
        {
            get { lock (_gate) { return _sequence; } }
        }

        /// <summary>Everything strictly after <paramref name="afterSequence"/>, bounded by
        /// <paramref name="limit"/>, plus whether more remain. Flushes pending handles first so a
        /// read never reports a stale watermark. Each record carries its own `Truncated` flag, so
        /// Cloud knows a single command touched more handles than the event can name.</summary>
        public (List<ChangeRecord> Records, bool HasMore) Since(long afterSequence, int limit)
        {
            Flush();
            var result = new List<ChangeRecord>();
            lock (_gate)
            {
                foreach (var node in _events)
                {
                    if (node.Sequence <= afterSequence) continue;
                    if (result.Count >= limit) return (result, true);
                    result.Add(node);
                }
            }
            return (result, false);
        }
    }
}
