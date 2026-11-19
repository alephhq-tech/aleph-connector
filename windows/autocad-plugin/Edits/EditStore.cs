using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using CadAI.AutoCAD.Dto;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

namespace CadAI.AutoCAD.Edits
{
    public enum EditSessionState
    {
        Active,
        Revalidating,
        Orphaned,
        Accepted,
        Committed = Accepted,
        Discarded
    }

    /// <summary>
    /// Information about a live open AutoCAD tab, used by <see cref="EditStore.Reconcile"/> to
    /// match stored sessions across AutoCAD or plugin reloads (AC6 survivability).
    /// </summary>
    public sealed record DocumentTabInfo(
        string DocumentIdentity,
        string DocumentName,
        string Revision,
        string DependencyFingerprint);

    /// <summary>
    /// Durable edit session record (PR B Slice 02). Stored atomically as JSON under
    /// <c>%LOCALAPPDATA%\CadAI\edits\{editId}.json</c>.
    /// </summary>
    public sealed record EditSession(
        string EditId,
        string DocumentIdentity,
        string DocumentName,
        string RevisionAtCapture,
        string DependencyFingerprint,
        List<EntityPreImage> PreImages,
        List<EntityRefDto> CandidateRefs,
        string CandidateLayer,
        DateTimeOffset CreatedAtUtc,
        IReadOnlyList<string> UnsupportedFeatures,
        EditSessionState State = EditSessionState.Active,
        int Version = 1,
        Dictionary<string, string>? AppliedMapping = null);

    /// <summary>
    /// Local durability owner for edit sessions (PR B Slice 02).
    /// Manages atomic JSON files per session under %LOCALAPPDATA%\CadAI\edits\<editId>.json.
    /// All paths are built internally from sanitized edit IDs; caller-supplied paths are never accepted.
    /// </summary>
    public sealed class EditStore
    {
        private static readonly Regex SafeIdRegex = new("^[a-zA-Z0-9_-]{5,100}$", RegexOptions.Compiled);
        private static readonly TimeSpan OrphanRetention = TimeSpan.FromDays(7);
        private const int MaxSessionsPerDocument = 20;

        private readonly string _storageDir;
        private readonly object _lock = new();

        private static readonly JsonSerializerSettings JsonSettings = new()
        {
            Formatting = Formatting.Indented,
            NullValueHandling = NullValueHandling.Include,
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            Converters = { new StringEnumConverter(new CamelCaseNamingStrategy()) },
        };

        private static EditStore? _instance;
        public static EditStore Instance => _instance ??= new EditStore();

        public EditStore(string? baseDir = null)
        {
            _storageDir = !string.IsNullOrWhiteSpace(baseDir)
                ? Path.GetFullPath(baseDir)
                : Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "CadAI",
                    "edits");
        }

        public string StorageDirectory => _storageDir;

        /// <summary>
        /// Validates that an edit ID is structurally safe (alphanumeric with hyphens/underscores,
        /// no directory traversal like '..' or path separators).
        /// </summary>
        public static string ValidateEditId(string editId)
        {
            if (string.IsNullOrWhiteSpace(editId))
                throw new ArgumentException("editId must not be null or empty.", nameof(editId));

            if (!SafeIdRegex.IsMatch(editId) || editId.Contains("..") || editId.Contains('/') || editId.Contains('\\'))
                throw new ArgumentException($"Invalid editId \"{editId}\": must be 5-100 alphanumeric characters, hyphens or underscores without directory separators.", nameof(editId));

            return editId;
        }

        public string GetSessionPath(string editId)
        {
            ValidateEditId(editId);
            var fullPath = Path.GetFullPath(Path.Combine(_storageDir, $"{editId}.json"));
            if (!fullPath.StartsWith(_storageDir, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException($"Hostile editId escaped storage directory: \"{editId}\"", nameof(editId));
            return fullPath;
        }

        /// <summary>
        /// Saves the session to disk using an atomic write (temp file in same folder + replace/move).
        /// Enforces session quota for the document after save.
        /// </summary>
        public void Save(EditSession session)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            ValidateEditId(session.EditId);

            lock (_lock)
            {
                Directory.CreateDirectory(_storageDir);
                var targetPath = GetSessionPath(session.EditId);
                var tempPath = Path.Combine(_storageDir, $"{session.EditId}.tmp.{Guid.NewGuid():N}");

                var json = JsonConvert.SerializeObject(session, JsonSettings);
                File.WriteAllText(tempPath, json, Encoding.UTF8);

                if (File.Exists(targetPath))
                {
                    try
                    {
                        File.Replace(tempPath, targetPath, null);
                    }
                    catch
                    {
                        File.Delete(targetPath);
                        File.Move(tempPath, targetPath);
                    }
                }
                else
                {
                    File.Move(tempPath, targetPath);
                }

                EnforceQuota(session.DocumentIdentity);
            }
        }

        /// <summary>
        /// Reads and deserializes a session by ID. Corrupted files return an Orphaned placeholder.
        /// </summary>
        public EditSession? Get(string editId)
        {
            ValidateEditId(editId);
            var path = GetSessionPath(editId);

            lock (_lock)
            {
                if (!File.Exists(path)) return null;

                try
                {
                    var json = File.ReadAllText(path, Encoding.UTF8);
                    var session = JsonConvert.DeserializeObject<EditSession>(json, JsonSettings);
                    if (session == null)
                    {
                        return new EditSession(editId, "", "", "", "", new(), new(), "", DateTimeOffset.UtcNow, Array.Empty<string>(), EditSessionState.Orphaned);
                    }

                    foreach (var preImage in session.PreImages)
                    {
                        NormalizeGeometry(preImage.Detail);
                    }

                    return session;
                }
                catch
                {
                    return new EditSession(editId, "", "", "", "", new(), new(), "", DateTimeOffset.UtcNow, Array.Empty<string>(), EditSessionState.Orphaned);
                }
            }
        }

        /// <summary>
        /// Lists all edit sessions, optionally filtered by document identity, ordered by newest first.
        /// </summary>
        public IReadOnlyList<EditSession> List(string? documentIdentity = null)
        {
            lock (_lock)
            {
                if (!Directory.Exists(_storageDir)) return Array.Empty<EditSession>();

                var sessions = new List<EditSession>();
                foreach (var file in Directory.GetFiles(_storageDir, "edit_*.json"))
                {
                    var editId = Path.GetFileNameWithoutExtension(file);
                    try
                    {
                        var session = Get(editId);
                        if (session != null)
                        {
                            if (string.IsNullOrEmpty(documentIdentity) ||
                                string.Equals(session.DocumentIdentity, documentIdentity, StringComparison.OrdinalIgnoreCase))
                            {
                                sessions.Add(session);
                            }
                        }
                    }
                    catch
                    {
                        sessions.Add(new EditSession(editId, "", "", "", "", new(), new(), "", DateTimeOffset.UtcNow, Array.Empty<string>(), EditSessionState.Orphaned));
                    }
                }

                return sessions.OrderByDescending(s => s.CreatedAtUtc).ToList();
            }
        }

        /// <summary>
        /// Deletes a session file by edit ID.
        /// </summary>
        public bool Delete(string editId)
        {
            ValidateEditId(editId);
            var path = GetSessionPath(editId);

            lock (_lock)
            {
                if (!File.Exists(path)) return false;
                File.Delete(path);
                return true;
            }
        }

        /// <summary>
        /// Transitions a session to Accepted and records the applied source->candidate handle mapping.
        /// Refuses already accepted sessions with EditAlreadyApplied (-32033), and orphaned/revalidating/discarded
        /// sessions with EditConflict (-32031).
        /// </summary>
        public EditSession TransitionToAccepted(string editId, Dictionary<string, string> appliedMapping)
        {
            ValidateEditId(editId);
            lock (_lock)
            {
                var session = Get(editId) ?? throw PluginExceptions.EditNotFound(editId);
                if (session.State == EditSessionState.Accepted)
                {
                    throw PluginExceptions.EditAlreadyApplied(editId);
                }
                if (session.State == EditSessionState.Orphaned)
                {
                    throw PluginExceptions.EditConflict(editId, "Cannot accept an orphaned edit session.");
                }
                if (session.State == EditSessionState.Revalidating)
                {
                    throw PluginExceptions.EditConflict(editId, "Cannot accept an edit session that is still revalidating.");
                }
                if (session.State == EditSessionState.Discarded)
                {
                    throw PluginExceptions.EditConflict(editId, "Cannot accept a discarded edit session.");
                }

                var updated = session with
                {
                    State = EditSessionState.Accepted,
                    AppliedMapping = appliedMapping
                };
                Save(updated);
                return updated;
            }
        }

        /// <summary>
        /// Transitions a session to Discarded state. Idempotent if already discarded; refuses if already accepted.
        /// </summary>
        public EditSession TransitionToDiscarded(string editId)
        {
            ValidateEditId(editId);
            lock (_lock)
            {
                var session = Get(editId) ?? throw PluginExceptions.EditNotFound(editId);
                if (session.State == EditSessionState.Accepted)
                {
                    throw PluginExceptions.EditConflict(editId, "Cannot discard an edit session that has already been accepted.");
                }
                if (session.State == EditSessionState.Discarded)
                {
                    return session;
                }

                var updated = session with { State = EditSessionState.Discarded };
                Save(updated);
                return updated;
            }
        }

        /// <summary>
        /// Reconciles stored sessions against live open tabs (AC6 survivability).
        /// When AutoCAD restarts, DocumentIdentity is reassigned; matching (DocumentName, RevisionAtCapture,
        /// DependencyFingerprint) against exactly one open tab promotes the session to Revalidating.
        /// Zero or multiple matches mark the session Orphaned. Corrupt sessions are marked Orphaned.
        /// </summary>
        public IReadOnlyList<EditSession> Reconcile(IEnumerable<DocumentTabInfo> liveTabs)
        {
            var tabs = (liveTabs ?? Enumerable.Empty<DocumentTabInfo>()).ToList();
            var reconciled = new List<EditSession>();

            lock (_lock)
            {
                var sessions = List();
                foreach (var session in sessions)
                {
                    if (session.State == EditSessionState.Committed || session.State == EditSessionState.Discarded)
                    {
                        reconciled.Add(session);
                        continue;
                    }

                    // Direct match by live DocumentIdentity: still active in this process session
                    if (tabs.Any(t => string.Equals(t.DocumentIdentity, session.DocumentIdentity, StringComparison.OrdinalIgnoreCase)))
                    {
                        reconciled.Add(session);
                        continue;
                    }

                    // Recovery match across reloads by (DocumentName, RevisionAtCapture, DependencyFingerprint)
                    var matches = tabs.Where(t =>
                        string.Equals(t.DocumentName, session.DocumentName, StringComparison.OrdinalIgnoreCase) &&
                        string.Equals(t.Revision, session.RevisionAtCapture, StringComparison.Ordinal) &&
                        string.Equals(t.DependencyFingerprint, session.DependencyFingerprint, StringComparison.Ordinal)
                    ).ToList();

                    if (matches.Count == 1)
                    {
                        var updated = session with
                        {
                            DocumentIdentity = matches[0].DocumentIdentity,
                            State = EditSessionState.Revalidating
                        };
                        Save(updated);
                        reconciled.Add(updated);
                    }
                    else
                    {
                        var orphaned = session with
                        {
                            State = EditSessionState.Orphaned
                        };
                        Save(orphaned);
                        reconciled.Add(orphaned);
                    }
                }
            }

            return reconciled;
        }

        /// <summary>
        /// Enforces session quotas:
        /// 1. Purges Orphaned and Discarded sessions older than 7 days.
        /// 2. If sessions for documentIdentity exceed 20, cleans oldest Committed or Discarded sessions
        ///    (Active and Revalidating sessions are never pruned).
        /// </summary>
        public void EnforceQuota(string? documentIdentity = null)
        {
            lock (_lock)
            {
                if (!Directory.Exists(_storageDir)) return;

                var now = DateTimeOffset.UtcNow;
                var allSessions = List();

                // 1. Purge orphaned or discarded older than 7 days
                foreach (var s in allSessions)
                {
                    if ((s.State == EditSessionState.Orphaned || s.State == EditSessionState.Discarded) &&
                        (now - s.CreatedAtUtc) > OrphanRetention)
                    {
                        Delete(s.EditId);
                    }
                }

                // 2. Per-document cap of 20
                if (!string.IsNullOrEmpty(documentIdentity))
                {
                    var docSessions = allSessions
                        .Where(s => string.Equals(s.DocumentIdentity, documentIdentity, StringComparison.OrdinalIgnoreCase))
                        .OrderBy(s => s.CreatedAtUtc)
                        .ToList();

                    if (docSessions.Count > MaxSessionsPerDocument)
                    {
                        var excess = docSessions.Count - MaxSessionsPerDocument;
                        var candidates = docSessions
                            .Where(s => s.State == EditSessionState.Committed || s.State == EditSessionState.Discarded || s.State == EditSessionState.Orphaned)
                            .Take(excess);

                        foreach (var c in candidates)
                        {
                            Delete(c.EditId);
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Formats human-readable summary of sessions for the CADAIEDITS command.
        /// </summary>
        public string DescribeSessions()
        {
            var sessions = List();
            if (sessions.Count == 0)
                return "No edit sessions found.";

            var sb = new StringBuilder();
            sb.AppendLine($"CadAI edit sessions ({sessions.Count}):");
            foreach (var s in sessions)
            {
                sb.AppendLine($"  [{s.State}] {s.EditId} | Doc: {s.DocumentName} ({s.DocumentIdentity}) | PreImages: {s.PreImages.Count} | CandidateLayer: {s.CandidateLayer} | {s.CreatedAtUtc:yyyy-MM-dd HH:mm:ss} UTC");
            }
            return sb.ToString().TrimEnd();
        }

        /// <summary>
        /// Computes a deterministic 16-hex digest over pre-image fingerprints and touched layers/blocks.
        /// Used as the recovery key (DependencyFingerprint) across restarts.
        /// </summary>
        public static string ComputeDependencyFingerprint(
            IEnumerable<EntityPreImage> preImages,
            IEnumerable<string>? touchedLayers = null,
            IEnumerable<string>? touchedBlocks = null)
        {
            var sortedDigests = (preImages ?? Enumerable.Empty<EntityPreImage>())
                .Select(PreImageCanonical.Fingerprint)
                .OrderBy(d => d, StringComparer.Ordinal);

            var sortedLayers = (touchedLayers ?? Enumerable.Empty<string>())
                .Distinct()
                .OrderBy(l => l, StringComparer.Ordinal);

            var sortedBlocks = (touchedBlocks ?? Enumerable.Empty<string>())
                .Distinct()
                .OrderBy(b => b, StringComparer.Ordinal);

            var raw = $"digests:{string.Join(",", sortedDigests)};layers:{string.Join(",", sortedLayers)};blocks:{string.Join(",", sortedBlocks)}";
            return PreImageCanonical.Digest(raw);
        }

        private static void NormalizeGeometry(EntityDetailDto detail)
        {
            if (detail.Geometry is JObject jObj)
            {
                var targetType = GeometryTypeFor(detail.Kind);
                detail.Geometry = jObj.ToObject(targetType) ?? jObj;
            }
        }

        private static Type GeometryTypeFor(string kind) => kind switch
        {
            "line" => typeof(LineGeometryDto),
            "circle" => typeof(CircleGeometryDto),
            "arc" => typeof(ArcGeometryDto),
            "polyline" => typeof(PolylineGeometryDto),
            "mtext" => typeof(MTextGeometryDto),
            "text.singleLine" => typeof(SingleLineTextGeometryDto),
            "blockReference" => typeof(BlockReferenceGeometryDto),
            "dimension.linear" => typeof(LinearDimensionGeometryDto),
            "dimension.aligned" => typeof(AlignedDimensionGeometryDto),
            "dimension.ordinate" => typeof(OrdinateDimensionGeometryDto),
            "hatch" => typeof(HatchGeometryDto),
            _ => typeof(OtherGeometryDto),
        };
    }
}
