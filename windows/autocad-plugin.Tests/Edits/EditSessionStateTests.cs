using System;
using System.Collections.Generic;
using System.IO;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using StreamJsonRpc;
using Xunit;

namespace CadAI.AutoCAD.Tests.Edits
{
    public sealed class EditSessionStateTests : IDisposable
    {
        private readonly string _testDir;
        private readonly EditStore _store;

        public EditSessionStateTests()
        {
            _testDir = Path.Combine(Path.GetTempPath(), "cadai_state_test_" + Guid.NewGuid().ToString("N"));
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
                // Best effort temp cleanup
            }
        }

        private static EditSession SampleSession(
            string editId = "edit_statetest1234567890abcdef123456",
            EditSessionState state = EditSessionState.Active)
        {
            return new EditSession(
                EditId: editId,
                DocumentIdentity: "doc_test123",
                DocumentName: "Drawing1.dwg",
                RevisionAtCapture: "tdu:100;saves:1",
                DependencyFingerprint: "fp1234567890abcdef",
                PreImages: new List<EntityPreImage>
                {
                    new()
                    {
                        Detail = new EntityDetailDto
                        {
                            Handle = "10",
                            Kind = "line",
                            Layer = "WALLS",
                            Geometry = new LineGeometryDto { Length = 10 }
                        },
                        RevisionAtCapture = "tdu:100;saves:1",
                        Document = new DocumentIdentityDto { DocumentId = "doc_test123" },
                        CapturedAtUtc = DateTime.UtcNow.ToString("O")
                    }
                },
                CandidateRefs: new List<EntityRefDto>
                {
                    new() { Handle = "C10", Kind = "line", Layer = $"CadAI-Candidate-{editId}" }
                },
                CandidateLayer: $"CadAI-Candidate-{editId}",
                CreatedAtUtc: DateTimeOffset.UtcNow,
                UnsupportedFeatures: Array.Empty<string>(),
                State: state,
                Version: 1
            );
        }

        [Fact]
        public void Captured_To_Discarded_TransitionsCleanly_AndIsIdempotent()
        {
            var session = SampleSession("edit_discard_11111111111111111111");
            _store.Save(session);

            var discarded = _store.TransitionToDiscarded(session.EditId);
            Assert.Equal(EditSessionState.Discarded, discarded.State);

            var onDisk = _store.Get(session.EditId);
            Assert.NotNull(onDisk);
            Assert.Equal(EditSessionState.Discarded, onDisk.State);

            // Idempotent retry: discarding again returns cleanly without error
            var retry = _store.TransitionToDiscarded(session.EditId);
            Assert.Equal(EditSessionState.Discarded, retry.State);
        }

        [Fact]
        public void Captured_To_Accepted_TransitionsCleanly_AndRecordsMapping()
        {
            var session = SampleSession("edit_accept_22222222222222222222");
            _store.Save(session);

            var mapping = new Dictionary<string, string> { ["10"] = "C10" };
            var accepted = _store.TransitionToAccepted(session.EditId, mapping);

            Assert.Equal(EditSessionState.Accepted, accepted.State);
            Assert.NotNull(accepted.AppliedMapping);
            Assert.Equal("C10", accepted.AppliedMapping["10"]);

            var onDisk = _store.Get(session.EditId);
            Assert.NotNull(onDisk);
            Assert.Equal(EditSessionState.Accepted, onDisk.State);
            Assert.NotNull(onDisk.AppliedMapping);
            Assert.Equal("C10", onDisk.AppliedMapping["10"]);
        }

        [Fact]
        public void Accepted_To_Accept_Refused_WithEditAlreadyApplied()
        {
            var session = SampleSession("edit_reaccept_333333333333333333");
            _store.Save(session);

            var mapping = new Dictionary<string, string> { ["10"] = "C10" };
            _store.TransitionToAccepted(session.EditId, mapping);

            // Second accept attempt throws EditAlreadyApplied (-32033)
            var ex = Assert.Throws<LocalRpcException>(() => _store.TransitionToAccepted(session.EditId, mapping));
            Assert.Equal(PluginErrorCodes.EditAlreadyApplied, ex.ErrorCode);
            Assert.Equal(-32033, ex.ErrorCode);
        }

        [Fact]
        public void Accepted_To_Discard_Refused_WithEditConflict()
        {
            var session = SampleSession("edit_accdisc_4444444444444444444");
            _store.Save(session);

            var mapping = new Dictionary<string, string> { ["10"] = "C10" };
            _store.TransitionToAccepted(session.EditId, mapping);

            // Cannot discard an already-accepted session
            var ex = Assert.Throws<LocalRpcException>(() => _store.TransitionToDiscarded(session.EditId));
            Assert.Equal(PluginErrorCodes.EditConflict, ex.ErrorCode);
            Assert.Equal(-32031, ex.ErrorCode);
        }

        [Fact]
        public void Orphaned_To_Accept_Refused_WithEditConflict()
        {
            var session = SampleSession("edit_orphan_5555555555555555555", state: EditSessionState.Orphaned);
            _store.Save(session);

            var mapping = new Dictionary<string, string> { ["10"] = "C10" };
            var ex = Assert.Throws<LocalRpcException>(() => _store.TransitionToAccepted(session.EditId, mapping));
            Assert.Equal(PluginErrorCodes.EditConflict, ex.ErrorCode);
            Assert.Contains("orphaned", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Revalidating_To_Accept_Refused_WithEditConflict()
        {
            var session = SampleSession("edit_reval_66666666666666666666", state: EditSessionState.Revalidating);
            _store.Save(session);

            var mapping = new Dictionary<string, string> { ["10"] = "C10" };
            var ex = Assert.Throws<LocalRpcException>(() => _store.TransitionToAccepted(session.EditId, mapping));
            Assert.Equal(PluginErrorCodes.EditConflict, ex.ErrorCode);
            Assert.Contains("revalidating", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Discarded_To_Accept_Refused_WithEditConflict()
        {
            var session = SampleSession("edit_disctoacc_77777777777777777", state: EditSessionState.Discarded);
            _store.Save(session);

            var mapping = new Dictionary<string, string> { ["10"] = "C10" };
            var ex = Assert.Throws<LocalRpcException>(() => _store.TransitionToAccepted(session.EditId, mapping));
            Assert.Equal(PluginErrorCodes.EditConflict, ex.ErrorCode);
            Assert.Contains("discarded", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
