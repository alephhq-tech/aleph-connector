using System;
using System.Collections.Generic;
using System.Linq;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Edits
{
    /// <summary>
    /// Whether a captured entity can be put back exactly. Coarse gate; the per-field detail lives in
    /// <see cref="Restorability.UnsupportedFeatures"/>.
    ///
    /// Slice 01 computes this in-process only — no RPC method carries it yet. When Slice 02 exposes
    /// it on the wire it must go as a camelCase string (the plugin's contract resolver), never an
    /// ordinal, so inserting a member cannot silently renumber stored verdicts.
    /// </summary>
    public enum RestoreVerdict
    {
        /// <summary>The wire pre-image carries everything <c>entity.create</c>/<c>entity.update</c> needs to rebuild the geometry.</summary>
        Supported,

        /// <summary>The pre-image is missing a field a rebuild would need, so restoring would be a lie.</summary>
        NotSupported,

        /// <summary>A kind <see cref="Util.EntityKindResolver.KindOf"/> can emit but this table has no row for.</summary>
        UnknownKind,
    }

    /// <summary>
    /// Per-kind AND per-property restorability verdict for one captured entity. Pure logic: reads the
    /// wire DTOs, touches no AutoCAD type, so it unit-tests and can be reused by Cloud (the diff
    /// header) and PR C (compensation planning).
    ///
    /// "Restorable" here means rebuild-equivalent, never byte-equal: no reader for XData, extension
    /// dictionaries, reactors or the entity↔<c>DimStyle</c>/<c>BlockTableRecord</c> ownership exists in
    /// the plugin, so a DTO pre-image can never be proven byte-complete. <see cref="UnsupportedFeatures"/>
    /// names every field that will not round-trip even when <see cref="Verdict"/> is
    /// <see cref="RestoreVerdict.Supported"/>, so an accept gate downstream can refuse or require an
    /// explicit override instead of silently shipping a partial restore.
    /// </summary>
    public sealed record Restorability(
        RestoreVerdict Verdict,
        string Kind,
        string? Reason,
        string[] UnsupportedFeatures)
    {
        /// <summary>The coarse gate a caller acts on: <c>Verdict == Supported</c>. Excluded from the wire shape, which carries exactly verdict/kind/reason/unsupportedFeatures.</summary>
        [Newtonsoft.Json.JsonIgnore]
        public bool IsRestorable => Verdict == RestoreVerdict.Supported;

        /// <summary>
        /// Every kind <see cref="Util.EntityKindResolver.KindOf"/> can emit, in table order — the
        /// drift test iterates this so a new <c>KindOf</c> branch with no row here fails loudly.
        /// </summary>
        public static IReadOnlyList<string> KnownWireKinds { get; } = new[]
        {
            "line", "circle", "arc", "polyline", "mtext", "text.singleLine", "blockReference",
            "dimension.linear", "dimension.aligned", "dimension.ordinate", "hatch", "other",
        };

        /// <summary>
        /// Verdict for one captured entity. Reads the whole <see cref="EntityDetailDto"/> (not just
        /// properties) because the unrestorable fields — MText rotation, an ordinate dimension-text
        /// override, per-vertex polyline widths, and read-only transparency/linetypeScale/visible —
        /// live in the geometry and common-property payloads, not the kind alone.
        /// </summary>
        public static Restorability Of(EntityDetailDto detail)
        {
            if (detail is null) throw new ArgumentNullException(nameof(detail));

            var features = new List<string>();
            AddReadOnlyPropertyFeatures(detail.Properties, features);

            return detail.Kind switch
            {
                "line" => SupportedWithFeatures("line", features),
                "circle" => SupportedWithFeatures("circle", features),
                "arc" => SupportedWithFeatures("arc", features),
                "mtext" => MText(detail, features),
                "polyline" => Polyline(detail, features),
                "text.singleLine" => SingleLineText(detail, features),
                "blockReference" => BlockReference(features),
                "dimension.linear" => Dimension("dimension.linear", features),
                "dimension.aligned" => Dimension("dimension.aligned", features),
                "dimension.ordinate" => OrdinateDimension(detail, features),
                "hatch" => new Restorability(
                    RestoreVerdict.NotSupported,
                    "hatch",
                    "entity.get reads a hatch's boundary as loop count/types only (no vertices, no "
                        + "boundary handles), but entity.create requires boundaryHandles or loops — the "
                        + "captured pre-image can never re-establish the boundary.",
                    features.ToArray()),
                "other" => new Restorability(
                    RestoreVerdict.NotSupported,
                    "other",
                    "geometry.dxfName is the only thing read back for kind \"other\", and entity.create "
                        + "rejects that kind outright — no geometry was captured, so nothing can be rebuilt.",
                    features.ToArray()),
                var unknown => new Restorability(
                    RestoreVerdict.UnknownKind,
                    unknown ?? "",
                    $"No restorability row for kind \"{unknown}\".",
                    features.ToArray()),
            };
        }

        // color/linetype/lineweight are writable via entity.update; these three are read by ToProperties
        // (EntityHandlers.cs:1525-1530) but assigned by NO handler, so a non-default value is lost.
        private static void AddReadOnlyPropertyFeatures(EntityPropertiesDto? properties, List<string> features)
        {
            if (properties is null) return;
            if (properties.Transparency is int t && t != 0) features.Add("properties.transparency");
            if (properties.LinetypeScale != 0 && Math.Abs(properties.LinetypeScale - 1.0) > 1e-9)
                features.Add("properties.linetypeScale");
            if (!properties.Visible) features.Add("properties.visible");
        }

        private static Restorability SupportedWithFeatures(string kind, List<string> features)
            => new Restorability(RestoreVerdict.Supported, kind, null, features.ToArray());

        // entity.create's polyline builder writes ONE constant width to both edges of every segment
        // (EntityHandlers.cs:929-942), so a source polyline with per-vertex or asymmetric widths is not
        // rebuild-equivalent. bulge/closed round-trip; length/area are recomputed by AutoCAD (faithful).
        private static Restorability Polyline(EntityDetailDto detail, List<string> features)
        {
            var widths = new HashSet<double>();
            if (detail.Geometry is PolylineGeometryDto pl)
            {
                foreach (var v in pl.Vertices)
                {
                    var sw = v.StartWidth ?? 0;
                    var ew = v.EndWidth ?? 0;
                    if (Math.Abs(sw - ew) > 1e-9) return NotRestorable("polyline",
                        "polyline vertex start/end widths differ; entity.create sets a single constant width "
                            + "per polyline, so an asymmetric edge cannot be rebuilt.");
                    widths.Add(Math.Round(sw, 6));
                }
            }
            if (widths.Count > 1) return NotRestorable("polyline",
                "polyline has vertices of differing widths; entity.create sets one constant width per polyline.");
            return SupportedWithFeatures("polyline", features);
        }

        // entity.get reads MText.Rotation (:1613) but neither BuildMText (:956-973) nor entity.update's
        // mtext branch (:776-783) ever writes it — a rotated MText cannot be restored. Style is read but
        // only the annotative branch sets a style, so a named non-default style is a loss too.
        private static Restorability MText(EntityDetailDto detail, List<string> features)
        {
            if (detail.Geometry is MTextGeometryDto mt)
            {
                if (Math.Abs(mt.Rotation) > 1e-9) return NotRestorable("mtext",
                    "entity.get reads MText rotation but entity.create and entity.update never set it — a "
                        + "rotated MText cannot be rebuilt at its original angle.");
                if (IsNamedStyle(mt.Style)) features.Add("mtext.textStyle");
            }
            return SupportedWithFeatures("mtext", features);
        }

        // DBText rotation IS writable (:791, :985) unlike MText, but Style and WidthFactor are read-only
        // (:1624-1625): create only sets a style through the annotative branch and never sets a width factor.
        private static Restorability SingleLineText(EntityDetailDto detail, List<string> features)
        {
            if (detail.Geometry is SingleLineTextGeometryDto t)
            {
                if (IsNamedStyle(t.Style)) features.Add("text.singleLine.style");
                if (t.WidthFactor is double wf && Math.Abs(wf - 1.0) > 1e-9) features.Add("text.singleLine.widthFactor");
            }
            return SupportedWithFeatures("text.singleLine", features);
        }

        // A block REFERENCE instance rebuilds from BlockName/Position/Scale/Rotation/Attributes, but the
        // block DEFINITION is shared state never captured, and attributes are re-created from the block's
        // AttributeDefinitions (only Tag→text survives), so exactness depends on the BlockTableRecord.
        // The instance-vs-definition gate itself is Slice 05.
        private static Restorability BlockReference(List<string> features)
        {
            features.Add("blockReference.definition");
            features.Add("blockReference.attributeGeometry");
            return SupportedWithFeatures("blockReference", features);
        }

        // linear/aligned dimension points, rotation and override text are writable; the source's active
        // DIMSTYLE is never read back (create re-resolves ambient db.Dimstyle, :1066-1067).
        private static Restorability Dimension(string kind, List<string> features)
        {
            features.Add("dimension.dimStyle");
            return SupportedWithFeatures(kind, features);
        }

        // BuildOrdinateDimension passes a literal null for the dimension text (:1057), so an ordinate's
        // override text is silently dropped on restore. With no override the loss is only the dimStyle.
        private static Restorability OrdinateDimension(EntityDetailDto detail, List<string> features)
        {
            if (detail.Geometry is OrdinateDimensionGeometryDto od && !string.IsNullOrEmpty(od.Text))
                return NotRestorable("dimension.ordinate",
                    "entity.get reads an ordinate dimension's text override but entity.create passes null text, "
                        + "so the override is lost.");
            return Dimension("dimension.ordinate", features);
        }

        private static Restorability NotRestorable(string kind, string reason)
            => new Restorability(RestoreVerdict.NotSupported, kind, reason, Array.Empty<string>());

        private static bool IsNamedStyle(string? style)
            => !string.IsNullOrEmpty(style) && !string.Equals(style, "Standard", StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Payload-level check: does this <see cref="CreateEntityRequest"/> carry every field the
        /// create path would <c>Require()</c> for its kind (EntityHandlers.cs:895-909, builders :911-1141)?
        /// A hand-built pre-image→create mapping can be validated without touching AutoCAD.
        /// </summary>
        public static bool IsRoundTripPayload(CreateEntityRequest r)
        {
            if (r is null || string.IsNullOrEmpty(r.Kind)) return false;
            switch (r.Kind)
            {
                case "line": return r.Start != null && r.End != null;
                case "circle": return r.Center != null && Positive(r.Radius);
                case "arc":
                    return r.Center != null && Positive(r.Radius) && r.StartAngle.HasValue && r.EndAngle.HasValue;
                case "polyline": return r.Points is { Count: >= 2 };
                case "rectangle": return r.Corner1 != null && r.Corner2 != null;
                case "mtext": return r.Insertion != null && r.Text != null;
                case "text.singleLine": return r.Insertion != null && r.Text != null;
                case "blockReference": return r.BlockName != null && r.Position != null;
                case "dimension.linear":
                case "dimension.aligned":
                    return r.ExtLine1 != null && r.ExtLine2 != null && r.DimLinePoint != null;
                case "dimension.ordinate":
                    return r.Origin != null && r.FeaturePoint != null && r.LeaderEndPoint != null
                        && (r.Axis == "x" || r.Axis == "y");
                case "hatch":
                    var hasHandles = r.BoundaryHandles is { Count: > 0 };
                    var hasLoops = r.Loops is { Count: > 0 };
                    return hasHandles ^ hasLoops;
                default: return false;
            }
        }

        private static bool Positive(double? v) => v.HasValue && v.Value > 0;
    }
}
