using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    /// <summary>
    /// <c>cad.scan</c> — a bounded, paginated read-only inventory pass the Cloud CAD State Engine
    /// drives to build a drawing snapshot in ONE coordinated scan instead of the model paging
    /// <c>entity.list</c>/<c>entity.get</c> dozens of times. Mirrors wire-protocol
    /// <c>CadScanParams</c>/<c>CadScanResult</c>; see docs/PROTOCOL.md.
    ///
    /// Read-only, never activates a tab (autocad-mcp#68 invariant). <see cref="RevisionBefore"/>/
    /// <see cref="RevisionAfter"/> bracket the page walk so Cloud can detect a mid-scan edit and
    /// discard an inconsistent snapshot rather than commit it.
    /// </summary>
    public sealed class CadScanRequest
    {
        public string? DocumentName { get; set; }
        /// <summary>Optional exact layout tab to scan; omitted or "Model" scans model space.</summary>
        public string? LayoutName { get; set; }
        public int Offset { get; set; }
        public int Limit { get; set; }
        /// <summary>"summary" (default): handle/kind/layer/bounds. "full": + geometry + properties.</summary>
        public string? Detail { get; set; }
        public string? Layer { get; set; }
        public string? Kind { get; set; }
        public List<string>? Handles { get; set; }
    }

    /// <summary>One scanned entity row — the shape the Cloud entity index stores.</summary>
    public sealed class CadScanEntityDto
    {
        public string Handle { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Layer { get; set; } = "";
        /// <summary>Set for a blockReference: the referenced block's name.</summary>
        public string? BlockName { get; set; }
        /// <summary>MTEXT/DBText content, or a block reference's non-empty attribute values joined.
        /// Bounded by the plugin (<see cref="MaxScanTextChars"/>).</summary>
        public string? Text { get; set; }
        public BoundsDto? Bounds { get; set; }
        /// <summary>Present only when <c>detail: "full"</c> — the same per-kind geometry object
        /// <c>entity.list</c> full returns (serialized by its concrete runtime type).</summary>
        public object? Geometry { get; set; }
        public EntityPropertiesDto? Properties { get; set; }
    }

    public sealed class CadScanLayerDto
    {
        public string Name { get; set; } = "";
        public int Count { get; set; }
    }

    public sealed class CadScanXrefDto
    {
        public string Name { get; set; } = "";
        public string Status { get; set; } = "";
    }

    public sealed class CadScanLayoutDto
    {
        public string Name { get; set; } = "";
        public bool IsModel { get; set; }
    }

    public sealed class CadScanResult
    {
        public string DocumentId { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Path { get; set; }
        /// <summary>The model or paper-space layout whose entities were scanned.</summary>
        public string LayoutName { get; set; } = "Model";
        /// <summary><c>Database.FingerprintGuid</c> (hex, no braces) when available — the drawing's
        /// lineage identity. Null on builds/paths where it is unavailable.</summary>
        public string? FingerprintGuid { get; set; }
        public string RevisionBefore { get; set; } = "";
        public string RevisionAfter { get; set; } = "";
        public string InsUnits { get; set; } = "unitless";
        /// <summary>Total entities in the selected space matching the scope (the page-count denominator).</summary>
        public int Total { get; set; }
        public int Offset { get; set; }
        public bool HasMore { get; set; }
        public List<CadScanEntityDto> Entities { get; set; } = new();
        /// <summary>Layer inventory (name + selected-space count), first page only.</summary>
        public List<CadScanLayerDto>? Layers { get; set; }
        /// <summary>Attached xref/overlay inventory, first page only.</summary>
        public List<CadScanXrefDto>? Xrefs { get; set; }
        /// <summary>Layout inventory, first page only (names; contents not scanned).</summary>
        public List<CadScanLayoutDto>? Layouts { get; set; }
    }

    /// <summary>
    /// <c>cad.changes</c> — the incremental-sync feed. <see cref="CadAI.AutoCAD.CadState.ChangeTracker"/>
    /// records entity handles touched by AutoCAD's own database events, coalesced per document into a
    /// monotonic sequence. Cloud asks for everything after its cursor; <see cref="EarliestSequence"/>
    /// &gt; afterSequence + 1 tells Cloud events were dropped, so it reconciles rather than applying
    /// a partial delta. Mirrors wire-protocol <c>CadChangesParams</c>/<c>CadChangesResult</c>.
    /// </summary>
    public sealed class CadChangesRequest
    {
        public string? DocumentName { get; set; }
        public long AfterSequence { get; set; }
        public int Limit { get; set; }
    }

    public sealed class CadChangeEventDto
    {
        public long Sequence { get; set; }
        /// <summary>created | modified | erased | metadata_changed | dependency_invalidated.</summary>
        public string Operation { get; set; } = "";
        public List<string> Handles { get; set; } = new();
        /// <summary>Full re-read row for a created/modified handle (bounded), so Cloud can index the
        /// delta without a second <c>entity.get</c> per handle. Absent for erased.</summary>
        public CadScanEntityDto? Entity { get; set; }
        public List<CadScanEntityDto>? Entities { get; set; }
        public long Timestamp { get; set; }
        /// <summary>
        /// True when the command touched more handles than <c>MaxHandlesPerEvent</c>: the list is
        /// the first N only. Cloud MUST treat the affected scope as unverified and reconcile it —
        /// a truncated batch is never a complete change set.
        /// </summary>
        public bool Truncated { get; set; }
    }

    public sealed class CadChangesResult
    {
        public string DocumentId { get; set; } = "";
        public string Revision { get; set; } = "";
        /// <summary>
        /// Feed epoch. Changes on plugin reload and on close/reopen while the sequence restarts.
        /// Cloud uses it to tell a reset from a normal continuation; a cursor above
        /// <see cref="LatestSequence"/> is only safe to interpret once the generation is compared.
        /// </summary>
        public string Generation { get; set; } = "";
        /// <summary>Lowest sequence the plugin still holds (0 when it has none).</summary>
        public long EarliestSequence { get; set; }
        /// <summary>Highest sequence the plugin has recorded.</summary>
        public long LatestSequence { get; set; }
        public List<CadChangeEventDto> Changes { get; set; } = new();
        public bool HasMore { get; set; }
    }
}
