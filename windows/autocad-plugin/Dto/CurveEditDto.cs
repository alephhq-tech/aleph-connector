using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    /// <summary>OFFSET — parallel curve(s) from an existing curve handle (#23).</summary>
    public sealed class EntityOffsetRequest
    {
        public string Handle { get; set; } = "";
        /// <summary>Signed offset distance in drawing units (positive = left of direction).</summary>
        public double Distance { get; set; }
        /// <summary>When true, erase the source after creating offsets (CadAI-owned only).</summary>
        public bool Replace { get; set; }
        public string? Layer { get; set; }
    }

    /// <summary>BREAK — split a curve at one or two points (#23).</summary>
    public sealed class EntityBreakRequest
    {
        public string Handle { get; set; } = "";
        /// <summary>World points on/near the curve where it should split (1 or 2).</summary>
        public List<Point3dDto> Points { get; set; } = new();
        /// <summary>When true (default), erase the original and keep all split pieces.</summary>
        public bool Replace { get; set; } = true;
    }

    /// <summary>TRIM — keep the portion of a curve on one side of a cutting point (#23).</summary>
    public sealed class EntityTrimRequest
    {
        public string Handle { get; set; } = "";
        /// <summary>Point on/near the curve that defines the cut.</summary>
        public Point3dDto CutPoint { get; set; } = new();
        /// <summary>Point on the side of the curve to keep (closest segment after split).</summary>
        public Point3dDto KeepPoint { get; set; } = new();
    }

    /// <summary>EXTEND — lengthen a curve to meet a boundary curve (#23).</summary>
    public sealed class EntityExtendRequest
    {
        public string Handle { get; set; } = "";
        public string BoundaryHandle { get; set; } = "";
        /// <summary>"start" | "end" | "both" — which end(s) to extend. Default "end".</summary>
        public string End { get; set; } = "end";
    }

    /// <summary>FILLET — round a corner between two curves or a polyline vertex (#23).</summary>
    public sealed class EntityFilletRequest
    {
        /// <summary>Fillet radius in drawing units.</summary>
        public double Radius { get; set; }
        /// <summary>Two curve handles (line/arc/polyline). Mutually exclusive with <see cref="PolylineHandle"/>.</summary>
        public List<string>? Handles { get; set; }
        /// <summary>Single lightweight polyline to fillet at <see cref="VertexIndex"/>.</summary>
        public string? PolylineHandle { get; set; }
        /// <summary>Vertex index (0-based) when filleting a polyline corner.</summary>
        public int? VertexIndex { get; set; }
    }
}
