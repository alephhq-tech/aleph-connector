using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using Xunit;

namespace CadAI.AutoCAD.Tests.Edits
{
    public class EditDiffTests
    {
        private static Point3dDto P(double x, double y) => new() { X = x, Y = y, Z = 0 };

        private static EntityDetailDto CreateDetail(
            string handle,
            string kind,
            string layer,
            object geometry,
            EntityPropertiesDto? properties = null) => new()
        {
            Handle = handle,
            Kind = kind,
            Layer = layer,
            Geometry = geometry,
            Properties = properties ?? new EntityPropertiesDto
            {
                Color = new ColorSpecDto { Aci = 256 },
                Linetype = "ByLayer",
                Lineweight = -1,
                LinetypeScale = 1.0,
                Visible = true
            }
        };

        private static EditSession CreateSession(
            string editId,
            string candidateLayer,
            string revisionAtCapture,
            List<EntityPreImage> preImages,
            List<EntityRefDto> candidateRefs,
            IReadOnlyList<string>? unsupportedFeatures = null) => new(
            EditId: editId,
            DocumentIdentity: "doc_test123",
            DocumentName: "Drawing1.dwg",
            RevisionAtCapture: revisionAtCapture,
            DependencyFingerprint: "fp1234567890abcdef",
            PreImages: preImages,
            CandidateRefs: candidateRefs,
            CandidateLayer: candidateLayer,
            CreatedAtUtc: DateTimeOffset.UtcNow,
            UnsupportedFeatures: unsupportedFeatures ?? Array.Empty<string>(),
            State: EditSessionState.Active,
            Version: 1
        );

        [Fact]
        public void UnchangedCandidate_ReportsStatusUnchanged_WithNoWarnings()
        {
            var editId = "edit_test1";
            var candidateLayer = $"CadAI-Candidate-{editId}";
            var revision = "tdu:100;saves:1";

            var sourceDetail = CreateDetail("10", "line", "WALLS", new LineGeometryDto { Start = P(0, 0), End = P(10, 0), Length = 10 });
            var preImage = new EntityPreImage
            {
                Detail = sourceDetail,
                RevisionAtCapture = revision,
                Document = new DocumentIdentityDto { DocumentId = "doc_test123" },
                CapturedAtUtc = DateTime.UtcNow.ToString("O")
            };

            var session = CreateSession(
                editId,
                candidateLayer,
                revision,
                new List<EntityPreImage> { preImage },
                new List<EntityRefDto> { new() { Handle = "C10", Kind = "line", Layer = candidateLayer } }
            );

            // Candidate in model space with identical geometry and properties
            var candidateDetail = CreateDetail("C10", "line", candidateLayer, new LineGeometryDto { Start = P(0, 0), End = P(10, 0), Length = 10 });

            var result = EditDiff.Compute(session, revision, new[] { candidateDetail });

            Assert.Equal(editId, result.EditId);
            Assert.Equal(revision, result.RevisionNow);
            Assert.Empty(result.Warnings);
            Assert.Single(result.Entities);

            var diff = result.Entities[0];
            Assert.Equal("10", diff.Handle);
            Assert.Equal("C10", diff.CandidateHandle);
            Assert.Equal("line", diff.Kind);
            Assert.Equal("unchanged", diff.Status);
            Assert.Empty(diff.ChangedProperties);
            Assert.Matches("^[0-9a-f]{16}$", result.DiffDigest);
        }

        [Fact]
        public void ModifiedGeometry_ReportsStatusModified_AndDiffDigestChanges()
        {
            var editId = "edit_test2";
            var candidateLayer = $"CadAI-Candidate-{editId}";
            var revision = "tdu:100;saves:1";

            var sourceDetail = CreateDetail("10", "line", "WALLS", new LineGeometryDto { Start = P(0, 0), End = P(10, 0), Length = 10 });
            var preImage = new EntityPreImage { Detail = sourceDetail, RevisionAtCapture = revision };

            var session = CreateSession(
                editId,
                candidateLayer,
                revision,
                new List<EntityPreImage> { preImage },
                new List<EntityRefDto> { new() { Handle = "C10", Kind = "line", Layer = candidateLayer } }
            );

            // Unchanged candidate
            var candUnchanged = CreateDetail("C10", "line", candidateLayer, new LineGeometryDto { Start = P(0, 0), End = P(10, 0), Length = 10 });
            var diffUnchanged = EditDiff.Compute(session, revision, new[] { candUnchanged });

            // Modified candidate geometry (endpoint moved)
            var candModified = CreateDetail("C10", "line", candidateLayer, new LineGeometryDto { Start = P(0, 0), End = P(10, 5), Length = 11.18 });
            var diffModified = EditDiff.Compute(session, revision, new[] { candModified });

            Assert.Single(diffModified.Entities);
            var entityDiff = diffModified.Entities[0];
            Assert.Equal("modified", entityDiff.Status);
            Assert.NotNull(entityDiff.BeforeGeometry);
            Assert.NotNull(entityDiff.AfterGeometry);
            Assert.NotEqual(diffUnchanged.DiffDigest, diffModified.DiffDigest);
        }

        [Fact]
        public void PropertyOnlyChange_ReportsStatusModified_WithChangedProperties()
        {
            var editId = "edit_test3";
            var candidateLayer = $"CadAI-Candidate-{editId}";
            var revision = "tdu:100;saves:1";

            var sourceDetail = CreateDetail("10", "line", "WALLS", new LineGeometryDto { Start = P(0, 0), End = P(10, 0) });
            var session = CreateSession(
                editId,
                candidateLayer,
                revision,
                new List<EntityPreImage> { new() { Detail = sourceDetail, RevisionAtCapture = revision } },
                new List<EntityRefDto> { new() { Handle = "C10", Kind = "line", Layer = candidateLayer } }
            );

            // Same geometry, but modified color and lineweight
            var candProps = new EntityPropertiesDto
            {
                Color = new ColorSpecDto { Aci = 1 }, // Changed from 256
                Linetype = "ByLayer",
                Lineweight = 50, // Changed from -1
                LinetypeScale = 1.0,
                Visible = true
            };
            var candModified = CreateDetail("C10", "line", candidateLayer, new LineGeometryDto { Start = P(0, 0), End = P(10, 0) }, candProps);

            var result = EditDiff.Compute(session, revision, new[] { candModified });
            Assert.Single(result.Entities);
            var diff = result.Entities[0];
            Assert.Equal("modified", diff.Status);
            Assert.Contains("color", diff.ChangedProperties);
            Assert.Contains("lineweight", diff.ChangedProperties);
            Assert.DoesNotContain("linetype", diff.ChangedProperties);
        }

        [Fact]
        public void CandidateErasedMidSession_ReportsStatusRemoved_AndAddsWarning()
        {
            var editId = "edit_test4";
            var candidateLayer = $"CadAI-Candidate-{editId}";
            var revision = "tdu:100;saves:1";

            var sourceDetail = CreateDetail("10", "line", "WALLS", new LineGeometryDto { Start = P(0, 0), End = P(10, 0) });
            var session = CreateSession(
                editId,
                candidateLayer,
                revision,
                new List<EntityPreImage> { new() { Detail = sourceDetail, RevisionAtCapture = revision } },
                new List<EntityRefDto> { new() { Handle = "C10", Kind = "line", Layer = candidateLayer } }
            );

            // Candidate was deleted by user or command; currentCandidates is empty
            var result = EditDiff.Compute(session, revision, Array.Empty<EntityDetailDto>());

            Assert.Single(result.Entities);
            var diff = result.Entities[0];
            Assert.Equal("10", diff.Handle);
            Assert.Equal("C10", diff.CandidateHandle);
            Assert.Equal("removed", diff.Status);
            Assert.NotNull(diff.BeforeGeometry);
            Assert.Null(diff.AfterGeometry);
            Assert.Contains(result.Warnings, w => w.Contains("removed"));
        }

        [Fact]
        public void NewCandidateAddedDuringSession_ReportsStatusAdded()
        {
            var editId = "edit_test5";
            var candidateLayer = $"CadAI-Candidate-{editId}";
            var revision = "tdu:100;saves:1";

            var session = CreateSession(
                editId,
                candidateLayer,
                revision,
                new List<EntityPreImage>(),
                new List<EntityRefDto>()
            );

            // A candidate was created during edit.apply
            var newCand = CreateDetail("C99", "circle", candidateLayer, new CircleGeometryDto { Center = P(5, 5), Radius = 2 });

            var result = EditDiff.Compute(session, revision, new[] { newCand });

            Assert.Single(result.Entities);
            var diff = result.Entities[0];
            Assert.Equal("", diff.Handle);
            Assert.Equal("C99", diff.CandidateHandle);
            Assert.Equal("circle", diff.Kind);
            Assert.Equal("added", diff.Status);
            Assert.Null(diff.BeforeGeometry);
            Assert.NotNull(diff.AfterGeometry);
        }

        [Fact]
        public void DrawingRevisionAdvanced_AndSharedLayerMove_EmitWarnings()
        {
            var editId = "edit_test6";
            var candidateLayer = $"CadAI-Candidate-{editId}";
            var captureRev = "tdu:100;saves:1";
            var nowRev = "tdu:200;saves:2";

            var sourceDetail = CreateDetail("10", "line", "WALLS", new LineGeometryDto { Start = P(0, 0), End = P(10, 0) });
            var session = CreateSession(
                editId,
                candidateLayer,
                captureRev,
                new List<EntityPreImage> { new() { Detail = sourceDetail, RevisionAtCapture = captureRev } },
                new List<EntityRefDto> { new() { Handle = "C10", Kind = "line", Layer = candidateLayer } },
                unsupportedFeatures: new[] { "properties.transparency" }
            );

            // Candidate moved to layer "0"
            var candMoved = CreateDetail("C10", "line", "0", new LineGeometryDto { Start = P(0, 0), End = P(10, 0) });

            var result = EditDiff.Compute(session, nowRev, new[] { candMoved });

            Assert.Contains(result.Warnings, w => w.Contains("revision moved"));
            Assert.Contains(result.Warnings, w => w.Contains("properties.transparency"));
            Assert.Contains(result.Warnings, w => w.Contains("outside candidate layer"));

            var diff = result.Entities[0];
            Assert.Equal("modified", diff.Status);
            Assert.Contains("layer", diff.ChangedProperties);
        }

        [Fact]
        public void DiffDigest_IsDeterministic_AcrossRuns()
        {
            var editId = "edit_test7";
            var candidateLayer = $"CadAI-Candidate-{editId}";
            var revision = "tdu:100;saves:1";

            var sourceDetail = CreateDetail("10", "line", "WALLS", new LineGeometryDto { Start = P(0, 0), End = P(10, 0), Length = 10 });
            var session = CreateSession(
                editId,
                candidateLayer,
                revision,
                new List<EntityPreImage> { new() { Detail = sourceDetail, RevisionAtCapture = revision } },
                new List<EntityRefDto> { new() { Handle = "C10", Kind = "line", Layer = candidateLayer } }
            );

            var candidateDetail = CreateDetail("C10", "line", candidateLayer, new LineGeometryDto { Start = P(0, 0), End = P(10, 0), Length = 10 });

            var r1 = EditDiff.Compute(session, revision, new[] { candidateDetail });
            var r2 = EditDiff.Compute(session, revision, new[] { candidateDetail });

            Assert.Equal(r1.DiffDigest, r2.DiffDigest);
            Assert.Matches("^[0-9a-f]{16}$", r1.DiffDigest);
        }
    }
}
