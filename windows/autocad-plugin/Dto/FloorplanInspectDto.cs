using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    public sealed class FloorplanInspectRequest
    {
        public string Name { get; set; } = "";
        public string? DocumentName { get; set; }
        /// <summary>Optional exact layout tab to inspect; omitted preserves the model-space default.</summary>
        public string? LayoutName { get; set; }
        public bool Capture { get; set; } = true;
        public int? Width { get; set; }
        public int? Height { get; set; }
        /// <summary>
        /// Picks one of the candidate frames a repeated plan title produced (0-based, in the order
        /// <c>regionCandidates</c> reports them). Used after an <c>ambiguous</c> verdict that came
        /// with candidates — the sheet really does hold several copies of that plan, so choosing is
        /// the caller's decision and re-inspecting with different wording would not help.
        /// </summary>
        public int CandidateIndex { get; set; } = -1;
    }

    public sealed class FloorplanDimensionsDto
    {
        public double Width { get; set; }
        public double Height { get; set; }
        public string Units { get; set; } = "m";
    }

    public sealed class FloorplanRoomDto
    {
        public string Name { get; set; } = "";
        // The label's position only; the plugin never computes a room outline. CamelCasePropertyNames-
        // ContractResolver serializes this to `labelPosition` (Slice 02 rename from `position`).
        public double[] LabelPosition { get; set; } = new double[2];
    }

    /// <summary>
    /// Outcome of the inline off-screen capture Slice 02 attaches to an inspect. A failed capture is
    /// reported here, never thrown, so one PNG problem cannot take down the CAD data the same pass
    /// already read (and cannot send the caller reworded-re-inspecting the sheet).
    /// </summary>
    public sealed class FloorplanCaptureDto
    {
        public string Status { get; set; } = "ok"; // ok | failed
        public string Source { get; set; } = "offscreen"; // inspect always renders off-screen
        public string? Error { get; set; }
    }

    public sealed class FloorplanInspectResult
    {
        public bool Found { get; set; }
        public string? MatchedName { get; set; }
        /// <summary>The model or paper-space layout whose entities were inspected.</summary>
        public string? LayoutName { get; set; }
        public List<string> AvailableFloorplans { get; set; } = new();
        public double[]? Bounds { get; set; }
        public FloorplanDimensionsDto? Dimensions { get; set; }
        public string? Data { get; set; }
        public string? MimeType { get; set; }
        public List<string> Layers { get; set; } = new();
        public List<FloorplanRoomDto> Rooms { get; set; } = new();
        public string? Note { get; set; }
        /// <summary>
        /// How <see cref="Bounds"/> was justified: <c>title-frame</c> (a closed frame contains the
        /// title and no other plan's title), <c>connected-geometry</c> (the stroke cluster the title
        /// belongs to), <c>ambiguous</c> (something contains the title but cannot be attributed to
        /// one plan), or <c>unresolved</c> (no evidence supports any rectangle). Only the first two
        /// come with bounds.
        /// </summary>
        public string? RegionBasis { get; set; }
        /// <summary>
        /// Set with <c>regionBasis: "ambiguous"</c> when the ambiguity is that this plan title
        /// appears several times on the sheet: every copy's frame, in drawing units, ordered
        /// top-to-bottom then left-to-right. The caller selects one by passing <c>candidateIndex</c>
        /// back — the copies are real places in the drawing, so this is a choice, not missing
        /// information. Frames that hold another plan's title, or that the caption is too far from,
        /// are excluded here and never selectable.
        /// </summary>
        public List<double[]>? RegionCandidates { get; set; }
        /// <summary>
        /// Structured outcome of the inline capture, so a capture failure travels as data instead of
        /// as an RPC error. Null when capture was not requested.
        /// </summary>
        public FloorplanCaptureDto? Capture { get; set; }
        /// <summary>
        /// Per-tab document id (<c>DocumentContext.IdOf</c>), reported so the caller can bind the
        /// read to this exact tab without a second <c>drawing.info</c> round trip.
        /// </summary>
        public string? DocumentId { get; set; }
        /// <summary>
        /// Coarse revision (<c>tdu:{Ticks};saves:{NumberOfSaves}</c>) read from the same locked
        /// document the region walk already held. This is what makes Slice 02's CAD State reuse cost
        /// zero extra RPCs: the caller passes it as the reconcile identity, skipping the probe.
        /// </summary>
        public string? Revision { get; set; }
        /// <summary>
        /// <c>Database.FingerprintGuid</c> lineage identity (hex, no braces), same source as
        /// <c>drawing.info</c>. Null on an unsaved or identity-less database.
        /// </summary>
        public string? FingerprintGuid { get; set; }
        /// <summary>
        /// Drawing units (<c>INSUNITS</c>), formatted like <c>cad.scan</c>/<c>drawing.summary</c>
        /// ("mm"/"m"/…). Reported so geometry areas can be converted to m² without a units probe.
        /// </summary>
        public string? Units { get; set; }
        /// <summary>
        /// Set when the inspect stopped for a reason that is NOT evidence about the drawing — today
        /// only <c>budget</c>: the region walk ran out of its own time on a very large sheet. It pairs
        /// with <c>regionBasis: "unresolved"</c> and NO bounds, so a caller never confuses "we could
        /// not finish reading" with "this sheet has no such plan".
        /// </summary>
        public string? StoppedReason { get; set; }
    }
}
