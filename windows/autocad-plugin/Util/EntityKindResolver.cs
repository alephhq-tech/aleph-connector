using System.Collections.Generic;
using Autodesk.AutoCAD.DatabaseServices;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Maps AutoCAD's concrete entity types to the wire-level "kind" strings
    /// from docs/PROTOCOL.md. AutoCAD has no native Rectangle entity — one is
    /// created as a closed Polyline, so a rectangle reported back by
    /// entity.list/entity.get after creation surfaces as kind "polyline".
    /// entity.create still echoes "rectangle" at creation time, since the
    /// caller's intent is still known there.
    /// </summary>
    public static class EntityKindResolver
    {
        public static string KindOf(Entity entity) => entity switch
        {
            Line => "line",
            Circle => "circle",
            Arc => "arc",
            Polyline => "polyline",
            MText => "mtext",
            DBText => "text.singleLine",
            BlockReference => "blockReference",
            RotatedDimension => "dimension.linear",
            AlignedDimension => "dimension.aligned",
            OrdinateDimension => "dimension.ordinate",
            Hatch => "hatch",
            // Everything else (Spline, Ellipse, DBPoint, Leader, MLeader, Table, Solid3d, Region,
            // Xline, Ray, Polyline2d/3d, RadialDimension, DiametricDimension, an angular/arc-length
            // dimension, AttributeDefinition, Wipeout, RasterImage, Face, …) — "other" is a real
            // member of the TS EntityKind union (#25), unlike the old "unknown" string. Pair with
            // DxfNameOf for entity.get/list's EntityDetail.geometry.dxfName.
            _ => "other",
        };

        /// <summary>DXF class name (<c>ObjectId.ObjectClass.DxfName</c>) — populates `EntityDetail.geometry.dxfName` for kind "other" (#25).</summary>
        public static string DxfNameOf(Entity entity) => entity.GetRXClass().DxfName;

        /// <summary>
        /// DXF class names (<c>ObjectId.ObjectClass.DxfName</c>) that could possibly resolve to
        /// <paramref name="kind"/> via <see cref="KindOf"/> — a cheap pre-filter entity.list (#10)
        /// uses to skip opening (<c>TransactionManager.GetObject</c>) entities that can't match a
        /// requested <c>kind</c>, without computing anything as expensive as <c>Entity.Bounds</c>.
        /// A hit here is necessary but not sufficient: the three dimension kinds all share the
        /// "DIMENSION" DXF name (the subtype lives in the object, not the class), so callers must
        /// still open the entity and re-check via <see cref="KindOf"/> before trusting it. Returns
        /// null for kinds with no safe finite DXF-name set (e.g. "other", or an unrecognized
        /// string) — the caller must open every entity in that case, same as before this filter
        /// existed.
        /// </summary>
        public static string[]? DxfNameCandidates(string kind) =>
            DxfNameCandidatesByKind.TryGetValue(kind, out var names) ? names : null;

        private static readonly Dictionary<string, string[]> DxfNameCandidatesByKind = new()
        {
            ["line"] = new[] { "LINE" },
            ["circle"] = new[] { "CIRCLE" },
            ["arc"] = new[] { "ARC" },
            ["polyline"] = new[] { "LWPOLYLINE" },
            ["mtext"] = new[] { "MTEXT" },
            ["text.singleLine"] = new[] { "TEXT" },
            ["blockReference"] = new[] { "INSERT" },
            ["dimension.linear"] = new[] { "DIMENSION" },
            ["dimension.aligned"] = new[] { "DIMENSION" },
            ["dimension.ordinate"] = new[] { "DIMENSION" },
            ["hatch"] = new[] { "HATCH" },
        };
    }
}
