using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using Xunit;

namespace CadAI.AutoCAD.Tests.Edits
{
    public sealed class EditStoreTests : IDisposable
    {
        private readonly string _testDir;
        private readonly EditStore _store;

        public EditStoreTests()
        {
            _testDir = Path.Combine(Path.GetTempPath(), "cadai_store_test_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_testDir);
            _store = new EditStore(_testDir);
        }

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(_testDir))
                {
                    Directory.Delete(_testDir, true);
                }
            }
            catch
            {
                // Best-effort temp dir cleanup
            }
        }

        private static EditSession SampleSession(
            string editId = "edit_1234567890abcdef1234567890abcdef",
            string docId = "doc_test123",
            string docName = "Drawing1.dwg",
            string revision = "tdu:1000;saves:1",
            string fingerprint = "fp_abc123",
            EditSessionState state = EditSessionState.Active,
            DateTimeOffset? createdAt = null)
        {
            return new EditSession(
                EditId: editId,
                DocumentIdentity: docId,
                DocumentName: docName,
                RevisionAtCapture: revision,
                DependencyFingerprint: fingerprint,
                PreImages: new List<EntityPreImage>
                {
                    new()
                    {
                        Detail = new EntityDetailDto
                        {
                            Handle = "1A",
                            Kind = "line",
                            Layer = "WALLS",
                            Geometry = new LineGeometryDto
                            {
                                Start = new Point3dDto { X = 0, Y = 0, Z = 0 },
                                End = new Point3dDto { X = 10, Y = 0, Z = 0 },
                                Length = 10
                            }
                        },
                        RevisionAtCapture = revision,
                        Document = new DocumentIdentityDto { DocumentId = docId, Path = "C:/drawings/Drawing1.dwg" },
                        CapturedAtUtc = DateTime.UtcNow.ToString("O")
                    }
                },
                CandidateRefs: new List<EntityRefDto>
                {
                    new() { Handle = "C1A", Kind = "line", Layer = $"CadAI-Candidate-{editId}" }
                },
                CandidateLayer: $"CadAI-Candidate-{editId}",
                CreatedAtUtc: createdAt ?? DateTimeOffset.UtcNow,
                UnsupportedFeatures: new List<string>(),
                State: state,
                Version: 1
            );
        }

        [Theory]
        [InlineData("../hostile")]
        [InlineData("..\\hostile")]
        [InlineData("/etc/passwd")]
        [InlineData("C:\\Windows\\System32\\bad")]
        [InlineData("with spaces")]
        [InlineData("")]
        [InlineData("bad!chars")]
        public void Path_IsInternal_AndHostileEditIdCannotEscape(string hostileId)
        {
            Assert.Throws<ArgumentException>(() => EditStore.ValidateEditId(hostileId));
            Assert.Throws<ArgumentException>(() => _store.GetSessionPath(hostileId));
        }

        [Fact]
        public void AtomicWrite_PersistsSession_AndSurvivesOverwrite()
        {
            var session = SampleSession();
            _store.Save(session);

            var path = _store.GetSessionPath(session.EditId);
            Assert.True(File.Exists(path));

            var loaded = _store.Get(session.EditId);
            Assert.NotNull(loaded);
            Assert.Equal(session.EditId, loaded.EditId);
            Assert.Equal(session.DocumentIdentity, loaded.DocumentIdentity);
            Assert.Equal(session.DocumentName, loaded.DocumentName);
            Assert.Equal(session.RevisionAtCapture, loaded.RevisionAtCapture);
            Assert.Equal(session.CandidateLayer, loaded.CandidateLayer);
            Assert.Equal(session.State, loaded.State);
            Assert.Single(loaded.PreImages);
            Assert.Equal("1A", loaded.PreImages[0].Detail.Handle);
            Assert.IsType<LineGeometryDto>(loaded.PreImages[0].Detail.Geometry);

            // Overwrite cleanly (atomic replace)
            var updated = session with { State = EditSessionState.Committed };
            _store.Save(updated);

            var reloaded = _store.Get(session.EditId);
            Assert.NotNull(reloaded);
            Assert.Equal(EditSessionState.Committed, reloaded.State);
        }

        [Fact]
        public void CorruptFile_IsLoadedAsOrphaned_NeverHalfTrusted()
        {
            var editId = "edit_corruptfile1234567890abcdef1234";
            var path = _store.GetSessionPath(editId);
            File.WriteAllText(path, "{ this is not valid json; broken content");

            var session = _store.Get(editId);
            Assert.NotNull(session);
            Assert.Equal(EditSessionState.Orphaned, session.State);
            Assert.Equal(editId, session.EditId);
        }

        [Fact]
        public void List_IndexesByDocumentIdentity_AndOrdersByNewestFirst()
        {
            var s1 = SampleSession("edit_11111111111111111111111111111111", docId: "doc_A", createdAt: DateTimeOffset.UtcNow.AddMinutes(-10));
            var s2 = SampleSession("edit_22222222222222222222222222222222", docId: "doc_A", createdAt: DateTimeOffset.UtcNow.AddMinutes(-5));
            var s3 = SampleSession("edit_33333333333333333333333333333333", docId: "doc_B", createdAt: DateTimeOffset.UtcNow);

            _store.Save(s1);
            _store.Save(s2);
            _store.Save(s3);

            var all = _store.List();
            Assert.Equal(3, all.Count);
            Assert.Equal(s3.EditId, all[0].EditId); // Newest first

            var docAOnly = _store.List("doc_A");
            Assert.Equal(2, docAOnly.Count);
            Assert.Contains(docAOnly, s => s.EditId == s1.EditId);
            Assert.Contains(docAOnly, s => s.EditId == s2.EditId);
            Assert.DoesNotContain(docAOnly, s => s.EditId == s3.EditId);

            var docBOnly = _store.List("doc_B");
            Assert.Single(docBOnly);
            Assert.Equal(s3.EditId, docBOnly[0].EditId);
        }

        [Fact]
        public void Delete_RemovesSessionFile()
        {
            var session = SampleSession();
            _store.Save(session);
            Assert.True(File.Exists(_store.GetSessionPath(session.EditId)));

            Assert.True(_store.Delete(session.EditId));
            Assert.False(File.Exists(_store.GetSessionPath(session.EditId)));
            Assert.False(_store.Delete(session.EditId)); // Second delete returns false
        }

        [Fact]
        public void Reconcile_MatchesExactOneLiveTab_MarksRevalidating_AndUpdatesDocIdentity()
        {
            var session = SampleSession(
                docId: "doc_old_reload_gone",
                docName: "A-101.dwg",
                revision: "tdu:555;saves:2",
                fingerprint: "fp_shared_key",
                state: EditSessionState.Active);
            _store.Save(session);

            var liveTabs = new[]
            {
                new DocumentTabInfo("doc_new_id_after_restart", "A-101.dwg", "tdu:555;saves:2", "fp_shared_key")
            };

            var reconciled = _store.Reconcile(liveTabs);
            Assert.Single(reconciled);
            Assert.Equal(EditSessionState.Revalidating, reconciled[0].State);
            Assert.Equal("doc_new_id_after_restart", reconciled[0].DocumentIdentity);

            var reloadedFromDisk = _store.Get(session.EditId);
            Assert.NotNull(reloadedFromDisk);
            Assert.Equal(EditSessionState.Revalidating, reloadedFromDisk.State);
            Assert.Equal("doc_new_id_after_restart", reloadedFromDisk.DocumentIdentity);
        }

        [Fact]
        public void Reconcile_MatchesZeroOrAmbiguousTabs_MarksOrphaned()
        {
            var s1 = SampleSession("edit_zero_match_1111111111111111111", docName: "Unmatched.dwg", revision: "tdu:1;saves:0", fingerprint: "fp1");
            var s2 = SampleSession("edit_multi_match_222222222222222222", docName: "Ambiguous.dwg", revision: "tdu:2;saves:1", fingerprint: "fp2");
            _store.Save(s1);
            _store.Save(s2);

            var liveTabs = new[]
            {
                // Tab for s2 has ambiguous duplicates (two tabs with exact same name/revision/fingerprint)
                new DocumentTabInfo("doc_ambig_tab_1", "Ambiguous.dwg", "tdu:2;saves:1", "fp2"),
                new DocumentTabInfo("doc_ambig_tab_2", "Ambiguous.dwg", "tdu:2;saves:1", "fp2")
            };

            var reconciled = _store.Reconcile(liveTabs);
            var r1 = reconciled.First(s => s.EditId == s1.EditId);
            var r2 = reconciled.First(s => s.EditId == s2.EditId);

            Assert.Equal(EditSessionState.Orphaned, r1.State);
            Assert.Equal(EditSessionState.Orphaned, r2.State);
        }

        [Fact]
        public void Quota_CleansOldestCommittedWhenExceedingCap_AndNeverDeletesActiveOrRevalidating()
        {
            var docId = "doc_quota_test";
            var activeSession = SampleSession("edit_active_keep_111111111111111111", docId: docId, state: EditSessionState.Active, createdAt: DateTimeOffset.UtcNow.AddMinutes(-100));
            var revalSession = SampleSession("edit_reval_keep_2222222222222222222", docId: docId, state: EditSessionState.Revalidating, createdAt: DateTimeOffset.UtcNow.AddMinutes(-90));
            _store.Save(activeSession);
            _store.Save(revalSession);

            // Create 21 committed sessions
            var committedSessions = new List<EditSession>();
            for (int i = 0; i < 21; i++)
            {
                var s = SampleSession(
                    $"edit_committed_{i:D2}_11111111111111111111",
                    docId: docId,
                    state: EditSessionState.Committed,
                    createdAt: DateTimeOffset.UtcNow.AddMinutes(-80 + i));
                _store.Save(s);
                committedSessions.Add(s);
            }

            // Total is 23 (2 active/reval + 21 committed). Cap is 20.
            _store.EnforceQuota(docId);

            var remaining = _store.List(docId);
            Assert.True(remaining.Count <= 20);

            // Active and Revalidating must NOT be deleted
            Assert.Contains(remaining, s => s.EditId == activeSession.EditId);
            Assert.Contains(remaining, s => s.EditId == revalSession.EditId);

            // Oldest committed sessions were pruned
            Assert.DoesNotContain(remaining, s => s.EditId == committedSessions[0].EditId);
            Assert.DoesNotContain(remaining, s => s.EditId == committedSessions[1].EditId);
            Assert.DoesNotContain(remaining, s => s.EditId == committedSessions[2].EditId);
        }

        [Fact]
        public void Quota_PurgesOrphanedOlderThanSevenDays()
        {
            var oldOrphan = SampleSession("edit_old_orphan_1111111111111111111", state: EditSessionState.Orphaned, createdAt: DateTimeOffset.UtcNow.AddDays(-8));
            var freshOrphan = SampleSession("edit_fresh_orphan_22222222222222222", state: EditSessionState.Orphaned, createdAt: DateTimeOffset.UtcNow.AddDays(-1));
            var oldCommitted = SampleSession("edit_old_committed_3333333333333333", state: EditSessionState.Committed, createdAt: DateTimeOffset.UtcNow.AddDays(-8));

            _store.Save(oldOrphan);
            _store.Save(freshOrphan);
            _store.Save(oldCommitted);

            _store.EnforceQuota();

            var all = _store.List();
            Assert.DoesNotContain(all, s => s.EditId == oldOrphan.EditId); // Purged
            Assert.Contains(all, s => s.EditId == freshOrphan.EditId);      // Kept (< 7 days)
            Assert.Contains(all, s => s.EditId == oldCommitted.EditId);     // Kept (Committed is not purged by age alone)
        }

        [Fact]
        public void DependencyFingerprint_IsDeterministic_AndSensitiveToChanges()
        {
            var s = SampleSession();
            var fp1 = EditStore.ComputeDependencyFingerprint(s.PreImages, new[] { "WALLS" }, new[] { "DOOR_BLOCK" });
            var fp2 = EditStore.ComputeDependencyFingerprint(s.PreImages, new[] { "WALLS" }, new[] { "DOOR_BLOCK" });
            Assert.Equal(fp1, fp2);
            Assert.Matches("^[0-9a-f]{16}$", fp1);

            // Sensitive to layer change
            var fpDiffLayer = EditStore.ComputeDependencyFingerprint(s.PreImages, new[] { "DOORS" }, new[] { "DOOR_BLOCK" });
            Assert.NotEqual(fp1, fpDiffLayer);

            // Sensitive to block change
            var fpDiffBlock = EditStore.ComputeDependencyFingerprint(s.PreImages, new[] { "WALLS" }, new[] { "WINDOW_BLOCK" });
            Assert.NotEqual(fp1, fpDiffBlock);
        }

        [Fact]
        public void DescribeSessions_FormatsReadableOutputForCommand()
        {
            var emptyDesc = _store.DescribeSessions();
            Assert.Equal("No edit sessions found.", emptyDesc);

            var s = SampleSession();
            _store.Save(s);

            var desc = _store.DescribeSessions();
            Assert.Contains(s.EditId, desc);
            Assert.Contains(s.DocumentName, desc);
            Assert.Contains(s.CandidateLayer, desc);
            Assert.Contains("Active", desc);
        }
    }
}
