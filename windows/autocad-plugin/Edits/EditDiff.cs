using System;
using System.Collections.Generic;
using System.Linq;
using CadAI.AutoCAD.Dto;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

namespace CadAI.AutoCAD.Edits
{
    public sealed record EntityDiff(
        string Handle,
        string CandidateHandle,
        string Kind,
        IReadOnlyList<string> ChangedProperties,
        object? BeforeGeometry,
        object? AfterGeometry,
        string Status
    );

    public sealed record EditDiffResult(
        string EditId,
        string DocumentIdentity,
        string RevisionAtCapture,
        string RevisionNow,
        IReadOnlyList<EntityDiff> Entities,
        IReadOnlyList<string> Warnings,
        string DiffDigest
    );

    public static class EditDiff
    {
        private static readonly JsonSerializer WireSerializer = JsonSerializer.Create(new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            NullValueHandling = NullValueHandling.Ignore,
        });

        public static EditDiffResult Compute(
            EditSession session,
            string currentRevision,
            IReadOnlyList<EntityDetailDto> currentCandidates)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            if (currentCandidates == null) throw new ArgumentNullException(nameof(currentCandidates));

            var warnings = new List<string>();
            var entities = new List<EntityDiff>();

            if (!string.Equals(session.RevisionAtCapture, currentRevision, StringComparison.Ordinal))
            {
                warnings.Add($"Drawing revision moved from {session.RevisionAtCapture} to {currentRevision}.");
            }

            if (session.UnsupportedFeatures != null && session.UnsupportedFeatures.Count > 0)
            {
                foreach (var f in session.UnsupportedFeatures)
                {
                    warnings.Add($"Source feature \"{f}\" will not round-trip.");
                }
            }

            var candidateMap = currentCandidates.ToDictionary(c => c.Handle, StringComparer.Ordinal);
            var matchedCandidateHandles = new HashSet<string>(StringComparer.Ordinal);

            // 1. Compare each pre-image with its corresponding candidate
            for (int i = 0; i < session.PreImages.Count; i++)
            {
                var pre = session.PreImages[i];
                var sourceHandle = pre.Detail.Handle;
                var initialCandidateHandle = (i < session.CandidateRefs.Count) ? session.CandidateRefs[i].Handle : "";

                if (string.IsNullOrEmpty(initialCandidateHandle) || !candidateMap.TryGetValue(initialCandidateHandle, out var cand))
                {
                    // Candidate was removed
                    warnings.Add($"Candidate for source \"{sourceHandle}\" was removed.");
                    entities.Add(new EntityDiff(
                        Handle: sourceHandle,
                        CandidateHandle: initialCandidateHandle,
                        Kind: pre.Detail.Kind,
                        ChangedProperties: Array.Empty<string>(),
                        BeforeGeometry: pre.Detail.Geometry,
                        AfterGeometry: null,
                        Status: "removed"
                    ));
                    continue;
                }

                matchedCandidateHandles.Add(initialCandidateHandle);

                // Property comparisons
                var changedProps = new List<string>();
                if (!string.Equals(cand.Layer, session.CandidateLayer, StringComparison.OrdinalIgnoreCase))
                {
                    changedProps.Add("layer");
                    warnings.Add($"Candidate \"{cand.Handle}\" was moved to layer \"{cand.Layer}\" outside candidate layer \"{session.CandidateLayer}\".");
                }
                if (!ColorEquals(pre.Detail.Properties.Color, cand.Properties.Color)) changedProps.Add("color");
                if (!string.Equals(pre.Detail.Properties.Linetype, cand.Properties.Linetype, StringComparison.OrdinalIgnoreCase)) changedProps.Add("linetype");
                if (pre.Detail.Properties.Lineweight != cand.Properties.Lineweight) changedProps.Add("lineweight");
                if (pre.Detail.Properties.Transparency != cand.Properties.Transparency) changedProps.Add("transparency");

                // Geometry comparison via canonical hash
                var beforeDigest = HashGeometry(pre.Detail.Geometry);
                var afterDigest = HashGeometry(cand.Geometry);
                bool geomChanged = !string.Equals(beforeDigest, afterDigest, StringComparison.Ordinal);

                string status = (geomChanged || changedProps.Count > 0) ? "modified" : "unchanged";

                entities.Add(new EntityDiff(
                    Handle: sourceHandle,
                    CandidateHandle: cand.Handle,
                    Kind: pre.Detail.Kind,
                    ChangedProperties: changedProps,
                    BeforeGeometry: pre.Detail.Geometry,
                    AfterGeometry: cand.Geometry,
                    Status: status
                ));
            }

            // 2. Any additional candidates in currentCandidates (created during session)
            foreach (var cand in currentCandidates)
            {
                if (matchedCandidateHandles.Contains(cand.Handle)) continue;

                entities.Add(new EntityDiff(
                    Handle: "",
                    CandidateHandle: cand.Handle,
                    Kind: cand.Kind,
                    ChangedProperties: Array.Empty<string>(),
                    BeforeGeometry: null,
                    AfterGeometry: cand.Geometry,
                    Status: "added"
                ));
            }

            // 3. Compute DiffDigest over the normalized diff payload
            var diffDigest = ComputeDiffDigest(session.EditId, session.DocumentIdentity, session.RevisionAtCapture, currentRevision, entities, warnings);

            return new EditDiffResult(
                EditId: session.EditId,
                DocumentIdentity: session.DocumentIdentity,
                RevisionAtCapture: session.RevisionAtCapture,
                RevisionNow: currentRevision,
                Entities: entities,
                Warnings: warnings,
                DiffDigest: diffDigest
            );
        }

        private static string HashGeometry(object? geometry)
        {
            if (geometry == null) return "null";
            var token = JToken.FromObject(geometry, WireSerializer);
            return PreImageCanonical.HashCanonical(token);
        }

        private static string ComputeDiffDigest(
            string editId,
            string docId,
            string revCapture,
            string revNow,
            IReadOnlyList<EntityDiff> entities,
            IReadOnlyList<string> warnings)
        {
            var raw = new JObject
            {
                ["editId"] = editId,
                ["documentIdentity"] = docId,
                ["revisionAtCapture"] = revCapture,
                ["revisionNow"] = revNow,
                ["entities"] = JArray.FromObject(entities, WireSerializer),
                ["warnings"] = new JArray(warnings.OrderBy(w => w, StringComparer.Ordinal))
            };
            return PreImageCanonical.HashCanonical(raw);
        }

        private static bool ColorEquals(ColorSpecDto? a, ColorSpecDto? b)
        {
            if (a == null || b == null) return a == b;
            if (a.Aci != b.Aci) return false;
            if (a.Rgb != null || b.Rgb != null)
            {
                if (a.Rgb == null || b.Rgb == null) return false;
                return a.Rgb.R == b.Rgb.R && a.Rgb.G == b.Rgb.G && a.Rgb.B == b.Rgb.B;
            }
            return true;
        }
    }
}
