using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using CadAI.AutoCAD.Dto;
using Newtonsoft.Json;

namespace CadAI.AutoCAD.Journal
{
    /// <summary>
    /// Summary record stored inside index.json for fast chronological traversal across restarts.
    /// </summary>
    public sealed class TaskChangeSetSummary
    {
        public string ChangeSetId { get; set; } = "";
        public string? TaskId { get; set; }
        public string BatchId { get; set; } = "";
        public int Sequence { get; set; }
        public string DocumentName { get; set; } = "";
        public string DocumentIdentity { get; set; } = "";
        public DateTimeOffset TimestampUtc { get; set; }
        public int OperationCount { get; set; }
        public string Status { get; set; } = "committed";
        public int CreatedCount { get; set; }
        public int ErasedCount { get; set; }
        public int ModifiedCount { get; set; }
    }

    /// <summary>
    /// Local durability owner for CAD task change sets (PR C Slice 01).
    /// Replaces volatile in-memory BatchJournal with disk-persisted TaskChangeSets under
    /// %LOCALAPPDATA%\CadAI\tasks\{documentIdentity}\{changeSetId}.json and index.json.
    /// Provides dual indexing by BatchId and TaskId, supporting both batch and task selective restore.
    /// </summary>
    public static class CadTaskLedger
    {
        private static readonly Regex SafeIdRegex = new("^[a-zA-Z0-9_-]{3,100}$", RegexOptions.Compiled);
        private static string _storageRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CadAI",
            "tasks");

        private static readonly ConcurrentDictionary<string, object> DocumentLocks = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, List<TaskChangeSet>> MemoryEntries = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, TaskChangeSet> ByBatchId = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, bool>> LoadedDocuments = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, string> NameToIdentityMap = new(StringComparer.OrdinalIgnoreCase);

        private static readonly JsonSerializerSettings SerializerSettings = new()
        {
            Formatting = Formatting.Indented,
            NullValueHandling = NullValueHandling.Ignore
        };

        /// <summary>Allows unit tests to redirect storage to a temporary directory.</summary>
        public static void SetStorageRoot(string? path)
        {
            _storageRoot = string.IsNullOrWhiteSpace(path)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CadAI", "tasks")
                : path!;
        }

        public static string StorageRoot => _storageRoot;

        /// <summary>Resets in-memory state; used by tests.</summary>
        public static void Reset()
        {
            MemoryEntries.Clear();
            ByBatchId.Clear();
            LoadedDocuments.Clear();
            NameToIdentityMap.Clear();
            DocumentLocks.Clear();
        }

        private static object LockFor(string docKey) =>
            DocumentLocks.GetOrAdd(docKey, _ => new object());

        private static string SanitizeDocKey(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return "default";
            var clean = Regex.Replace(raw, @"[^a-zA-Z0-9_\-\.]", "_");
            return clean.Length > 80 ? clean.Substring(0, 80) : clean;
        }

        private static string ResolveDocKey(string docNameOrIdentity)
        {
            if (string.IsNullOrWhiteSpace(docNameOrIdentity)) return "default";
            if (NameToIdentityMap.TryGetValue(docNameOrIdentity, out var mapped))
            {
                return SanitizeDocKey(mapped);
            }
            return SanitizeDocKey(docNameOrIdentity);
        }

        private static string GetDocFolder(string docKey)
        {
            var folder = Path.Combine(_storageRoot, docKey);
            Directory.CreateDirectory(folder);
            return folder;
        }

        /// <summary>Ensures the document's on-disk index and entries are loaded into memory.</summary>
        public static void EnsureLoaded(string docNameOrIdentity)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            if (LoadedDocuments.ContainsKey(docKey)) return;

            lock (LockFor(docKey))
            {
                if (LoadedDocuments.ContainsKey(docKey)) return;

                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                var folder = Path.Combine(_storageRoot, docKey);
                if (Directory.Exists(folder))
                {
                    var files = Directory.GetFiles(folder, "*.json");
                    foreach (var file in files)
                    {
                        var fileName = Path.GetFileName(file);
                        if (string.Equals(fileName, "index.json", StringComparison.OrdinalIgnoreCase)) continue;

                        try
                        {
                            var json = File.ReadAllText(file);
                            var changeSet = JsonConvert.DeserializeObject<TaskChangeSet>(json, SerializerSettings);
                            if (changeSet != null && !string.IsNullOrEmpty(changeSet.ChangeSetId))
                            {
                                if (!list.Any(c => c.ChangeSetId == changeSet.ChangeSetId))
                                {
                                    list.Add(changeSet);
                                    ByBatchId[changeSet.BatchId] = changeSet;
                                    if (!string.IsNullOrEmpty(changeSet.DocumentName))
                                    {
                                        NameToIdentityMap[changeSet.DocumentName] = changeSet.DocumentIdentity;
                                    }
                                }
                            }
                        }
                        catch
                        {
                            // Ignore corrupted single file on reload
                        }
                    }

                    list.Sort((a, b) => a.Sequence.CompareTo(b.Sequence));
                }

                LoadedDocuments.TryAdd(docKey, new ConcurrentDictionary<string, bool>());
            }
        }

        /// <summary>
        /// Records a completed task change set both in memory and durably on disk.
        /// </summary>
        public static TaskChangeSet Record(TaskChangeSet changeSet)
        {
            if (changeSet == null) throw new ArgumentNullException(nameof(changeSet));
            if (string.IsNullOrEmpty(changeSet.ChangeSetId))
            {
                changeSet.ChangeSetId = "cs_" + Guid.NewGuid().ToString("N");
            }
            if (string.IsNullOrEmpty(changeSet.BatchId))
            {
                changeSet.BatchId = "batch_" + Guid.NewGuid().ToString("N");
            }
            if (changeSet.TimestampUtc == default)
            {
                changeSet.TimestampUtc = DateTimeOffset.UtcNow;
            }

            var docKey = !string.IsNullOrEmpty(changeSet.DocumentIdentity)
                ? SanitizeDocKey(changeSet.DocumentIdentity)
                : SanitizeDocKey(changeSet.DocumentName);

            if (!string.IsNullOrEmpty(changeSet.DocumentName) && !string.IsNullOrEmpty(changeSet.DocumentIdentity))
            {
                NameToIdentityMap[changeSet.DocumentName] = changeSet.DocumentIdentity;
            }

            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                if (changeSet.Sequence <= 0)
                {
                    changeSet.Sequence = list.Count > 0 ? list.Max(c => c.Sequence) + 1 : 1;
                }

                list.Add(changeSet);
                ByBatchId[changeSet.BatchId] = changeSet;

                PersistToDisk(docKey, changeSet);
                UpdateIndex(docKey, list);

                return changeSet;
            }
        }

        private static void PersistToDisk(string docKey, TaskChangeSet changeSet)
        {
            try
            {
                var folder = GetDocFolder(docKey);
                var safeId = SafeIdRegex.IsMatch(changeSet.ChangeSetId)
                    ? changeSet.ChangeSetId
                    : "cs_" + Guid.NewGuid().ToString("N");

                var targetPath = Path.Combine(folder, safeId + ".json");
                var tempPath = targetPath + ".tmp." + Guid.NewGuid().ToString("N");

                var json = JsonConvert.SerializeObject(changeSet, SerializerSettings);
                File.WriteAllText(tempPath, json);

                if (File.Exists(targetPath))
                {
                    File.Delete(targetPath);
                }
                File.Move(tempPath, targetPath);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.TraceWarning(
                    $"[CadTaskLedger] Failed to persist change set {changeSet.ChangeSetId} to disk: {ex.Message}");
            }
        }

        private static void UpdateIndex(string docKey, List<TaskChangeSet> list)
        {
            try
            {
                var folder = GetDocFolder(docKey);
                var indexPath = Path.Combine(folder, "index.json");
                var tempPath = indexPath + ".tmp." + Guid.NewGuid().ToString("N");

                var summaries = list.Select(c => new TaskChangeSetSummary
                {
                    ChangeSetId = c.ChangeSetId,
                    TaskId = c.TaskId,
                    BatchId = c.BatchId,
                    Sequence = c.Sequence,
                    DocumentName = c.DocumentName,
                    DocumentIdentity = c.DocumentIdentity,
                    TimestampUtc = c.TimestampUtc,
                    OperationCount = c.OperationCount,
                    Status = c.Status,
                    CreatedCount = c.CreatedHandles.Count,
                    ErasedCount = c.ErasedPreImages.Count,
                    ModifiedCount = c.ModifiedPreImages.Count
                }).ToList();

                var json = JsonConvert.SerializeObject(summaries, SerializerSettings);
                File.WriteAllText(tempPath, json);

                if (File.Exists(indexPath))
                {
                    File.Delete(indexPath);
                }
                File.Move(tempPath, indexPath);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.TraceWarning(
                    $"[CadTaskLedger] Failed to update index for {docKey}: {ex.Message}");
            }
        }

        /// <summary>Finds a change set by its unique BatchId.</summary>
        public static TaskChangeSet? FindByBatchId(string docNameOrIdentity, string batchId)
        {
            if (string.IsNullOrEmpty(batchId)) return null;
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            if (ByBatchId.TryGetValue(batchId, out var cached)) return cached;

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                return list.Find(c => c.BatchId == batchId);
            }
        }

        /// <summary>Finds all change sets belonging to a TaskId, in chronological order.</summary>
        public static IReadOnlyList<TaskChangeSet> FindByTaskId(string docNameOrIdentity, string taskId)
        {
            if (string.IsNullOrEmpty(taskId)) return Array.Empty<TaskChangeSet>();
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                return list.Where(c => string.Equals(c.TaskId, taskId, StringComparison.OrdinalIgnoreCase))
                           .OrderBy(c => c.Sequence)
                           .ToList();
            }
        }

        /// <summary>Returns the most recent still-committed change set (for native LIFO undo).</summary>
        public static TaskChangeSet? Top(string docNameOrIdentity)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                for (int i = list.Count - 1; i >= 0; i--)
                {
                    if (list[i].Status == "committed") return list[i];
                }
                return null;
            }
        }

        /// <summary>Returns recent change sets for operations.history.</summary>
        public static IReadOnlyList<TaskChangeSet> Recent(string docNameOrIdentity, int limit)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                return list.AsEnumerable().Reverse().Take(limit > 0 ? limit : 20).ToList();
            }
        }

        /// <summary>Returns all change sets for this document in chronological order.</summary>
        public static IReadOnlyList<TaskChangeSet> All(string docNameOrIdentity)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                return list.ToList();
            }
        }

        /// <summary>Marks a change set as reverted (via non-LIFO selective restore).</summary>
        public static bool MarkReverted(string docNameOrIdentity, string batchIdOrChangeSetId)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                var entry = list.Find(c => c.BatchId == batchIdOrChangeSetId || c.ChangeSetId == batchIdOrChangeSetId);
                if (entry == null) return false;

                entry.Status = "reverted";
                PersistToDisk(docKey, entry);
                UpdateIndex(docKey, list);
                return true;
            }
        }

        /// <summary>Marks a change set as undone (via native LIFO undo).</summary>
        public static bool MarkUndone(string docNameOrIdentity, string batchIdOrChangeSetId)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                var entry = list.Find(c => c.BatchId == batchIdOrChangeSetId || c.ChangeSetId == batchIdOrChangeSetId);
                if (entry == null) return false;

                entry.Status = "undone";
                PersistToDisk(docKey, entry);
                UpdateIndex(docKey, list);
                return true;
            }
        }

        /// <summary>Marks a change set as redone (via native LIFO redo).</summary>
        public static bool MarkRedone(string docNameOrIdentity, string batchIdOrChangeSetId)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                var entry = list.Find(c => c.BatchId == batchIdOrChangeSetId || c.ChangeSetId == batchIdOrChangeSetId);
                if (entry == null) return false;

                entry.Status = "committed";
                PersistToDisk(docKey, entry);
                UpdateIndex(docKey, list);
                return true;
            }
        }

        /// <summary>Marks a change set as cancelled (e.g. when an in-flight task was cancelled).</summary>
        public static bool MarkCancelled(string docNameOrIdentity, string batchIdOrChangeSetId)
        {
            var docKey = ResolveDocKey(docNameOrIdentity);
            EnsureLoaded(docKey);

            lock (LockFor(docKey))
            {
                var list = MemoryEntries.GetOrAdd(docKey, _ => new List<TaskChangeSet>());
                var entry = list.Find(c => c.BatchId == batchIdOrChangeSetId || c.ChangeSetId == batchIdOrChangeSetId);
                if (entry == null) return false;

                entry.Status = "cancelled";
                PersistToDisk(docKey, entry);
                UpdateIndex(docKey, list);
                return true;
            }
        }
    }
}
