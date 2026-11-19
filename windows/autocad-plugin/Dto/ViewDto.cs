using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    public sealed class ViewZoomExtentsRequest
    {
        public string? DocumentName { get; set; }
    }

    /// <summary>
    /// Mirrors contracts/protocol ViewCaptureParams. At most one framing input is honored, in this
    /// order: <see cref="Window"/>, <see cref="Handles"/>, else the whole drawing's extents.
    /// </summary>
    public sealed class ViewCaptureRequest
    {
        public string? DocumentName { get; set; }
        public int? Width { get; set; }
        public int? Height { get; set; }
        /// <summary>"white" (default) or "black".</summary>
        public string? Background { get; set; }
        public CaptureWindowDto? Window { get; set; }
        public List<string>? Handles { get; set; }
        public string? Source { get; set; }
    }

    public sealed class CaptureWindowDto
    {
        public Point3dDto Min { get; set; } = new Point3dDto();
        public Point3dDto Max { get; set; } = new Point3dDto();
    }

    public sealed class ViewCaptureResult
    {
        public string DocumentName { get; set; } = "";
        public string MimeType { get; set; } = "image/png";
        public int Width { get; set; }
        public int Height { get; set; }
        /// <summary>Base64 PNG.</summary>
        public string Data { get; set; } = "";
        /// <summary>"window", "entities" or "drawing" — what the picture is framed on.</summary>
        public string FittedTo { get; set; } = "drawing";
        /// <summary>The world-space XY rectangle the image shows, so pixels can be mapped back to coordinates.</summary>
        public CaptureWindowDto Window { get; set; } = new CaptureWindowDto();
        public string Source { get; set; } = "drawing";
        public List<string>? InvalidHandles { get; set; }
    }

    /// <summary>
    /// Per-call override of the document's <c>view.setLive</c> follow setting — every mutating
    /// RPC accepts an optional <c>view</c> of this shape (autocad-mcp#67).
    /// </summary>
    public sealed class ViewOverrideDto
    {
        /// <summary>"off" | "fit" | "pan"; null means "use the document's live setting".</summary>
        public string? Follow { get; set; }
    }

    /// <summary>
    /// Live drafting mode (autocad-mcp#67): partial update — only non-null fields are applied,
    /// unset fields keep whatever <see cref="Util.LiveView"/> already had for this document (or
    /// its default, the first time). Mirrors contracts/protocol ViewSetLiveParams.
    /// </summary>
    public sealed class ViewSetLiveRequest
    {
        public string? Follow { get; set; }
        public double? Margin { get; set; }
        public double? MinHeight { get; set; }
        public bool? Animate { get; set; }
        public bool? Progressive { get; set; }
        public double? PaceMs { get; set; }
        public string? DocumentName { get; set; }
    }

    /// <summary>Effective per-document live-view settings, after defaults are applied. Mirrors contracts/protocol LiveViewSettings.</summary>
    public sealed class LiveViewSettingsDto
    {
        public string Follow { get; set; } = "off";
        public double Margin { get; set; } = 0.25;
        public double? MinHeight { get; set; }
        public bool Animate { get; set; } = true;
        public bool Progressive { get; set; } = true;
        public double PaceMs { get; set; } = 35;
    }

    public sealed class ViewGetLiveRequest
    {
        public string? DocumentName { get; set; }
    }

    /// <summary>
    /// Explicit "look here" (autocad-mcp#67/#27/#63). First match wins: <see cref="Window"/>, else
    /// the union of <see cref="Handles"/>' extents, else <see cref="Center"/> + <see cref="Height"/>.
    /// </summary>
    public sealed class ViewZoomRequest
    {
        public CaptureWindowDto? Window { get; set; }
        public List<string>? Handles { get; set; }
        public string? Source { get; set; }
        public Point3dDto? Center { get; set; }
        /// <summary>
        /// View height in world/drawing units for <see cref="Center"/> (not pixels — deliberately
        /// not named "Height" like <see cref="ViewCaptureRequest"/>'s pixel size, since the MCP
        /// tool's portable JSON Schema flattens every operation's fields into one object and a
        /// shared name across operations with different meanings/bounds caused a validation bug).
        /// </summary>
        public double? ViewHeight { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class ViewZoomResult
    {
        /// <summary>World-space center of the framed box.</summary>
        public Point3dDto Center { get; set; } = new Point3dDto();
        /// <summary>The view's resulting height (drawing units).</summary>
        public double Height { get; set; }
    }
}
