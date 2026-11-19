using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    public sealed class DrawingInfoRequest
    {
        public string? DocumentName { get; set; }
    }

    public sealed class DrawingInfoResult
    {
        public string DocumentId { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Path { get; set; }
        public int EntityCount { get; set; }
        public int LayerCount { get; set; }
        public bool? Modified { get; set; }
        /// <summary>Current CANNOSCALE name (e.g. "1:100"), <c>Database.Cannoscale</c> (#74).</summary>
        public string? AnnotationScale { get; set; }
        /// <summary>
        /// Coarse drawing revision: <c>Database.Tduupdate.Ticks</c> (AutoCAD's own "last modified"
        /// timestamp for THIS database) plus <c>NumberOfSaves</c>, so any mutation or save moves it.
        /// Unlike <see cref="Modified"/> (which reads the DBMOD system variable and so only knows
        /// about the active document), this is a per-database property and is therefore reportable
        /// for a background tab too. Aleph Cloud binds a spatial-validation record to this value:
        /// if the drawing moves while a validated batch is being committed, the record is stale and
        /// the commit is refused instead of drawing against geometry that no longer matches.
        /// </summary>
        public string Revision { get; set; } = "";
        /// <summary>
        /// <c>Database.FingerprintGuid</c> (hex, no braces) — the drawing's LINEAGE identity: it
        /// survives SAVEAS, file copy, and close/reopen, unlike <see cref="DocumentId"/> (per-tab)
        /// or <see cref="Path"/> (a moved file). The CAD State Engine keys its cross-session
        /// registry on it. Null when the AutoCAD generation doesn't expose it or the database has
        /// none yet (a brand-new unsaved drawing).
        /// </summary>
        public string? FingerprintGuid { get; set; }
    }

    public sealed class DrawingSaveRequest
    {
        public string? Path { get; set; }
        public string? DocumentName { get; set; }
        /// <summary>Required (aleph-platform#5) to replace an existing file other than the
        /// document's own current one; without it, an existing target file is a hard rejection.</summary>
        public bool? Overwrite { get; set; }
    }

    public sealed class DrawingSaveResult
    {
        public string SavedPath { get; set; } = "";
    }
    public sealed class DrawingOpenRequest
    {
        public string Path { get; set; } = "";
        public bool? ReadOnly { get; set; }
    }

    public sealed class DrawingOpenResult
    {
        public string DocumentId { get; set; } = "";
        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
    }

    public sealed class DrawingNewRequest
    {
        public string? Template { get; set; }
    }

    public sealed class DrawingNewResult
    {
        public string DocumentId { get; set; } = "";
        public string Name { get; set; } = "";
    }

    public sealed class DrawingCloseRequest
    {
        public string? DocumentName { get; set; }
        public bool? Save { get; set; }
    }

    public sealed class DrawingCloseResult
    {
        public bool Closed { get; set; }
        public string Name { get; set; } = "";
    }

    public sealed class DrawingActivateRequest
    {
        public string DocumentName { get; set; } = "";
    }

    public sealed class DrawingActivateResult
    {
        public bool Activated { get; set; }
        public string DocumentId { get; set; } = "";
        public string Name { get; set; } = "";
    }


    /// <summary>
    /// Write counterpart to <see cref="DrawingInfoRequest"/> (#62): every field is optional and
    /// independently applied to the <c>Database</c> — omitted fields are left untouched. Never a
    /// raw <c>setvar</c> escape hatch; see AGENTS.md's invariant against arbitrary system-variable
    /// / command-string injection.
    /// </summary>
    public sealed class DrawingSetupRequest
    {
        public string? InsUnits { get; set; }
        public string? LinearUnits { get; set; }
        public int? LinearPrecision { get; set; }
        public string? AngularUnits { get; set; }
        public double? LtScale { get; set; }
        public double? CeltScale { get; set; }
        public double? DimScale { get; set; }
        public bool? LwDisplay { get; set; }
        /// <summary>Convenience: sets LtScale to scale * 0.5 (ISO) and DimScale to scale, unless those are also given explicitly.</summary>
        public double? Scale { get; set; }
        /// <summary>"paper:drawing" (e.g. "1:100"); sets CANNOSCALE, adding it to the scale list first if missing (#74).</summary>
        public string? AnnotationScale { get; set; }
        public string? DocumentName { get; set; }
    }

    /// <summary>Every setting <c>drawing.setup</c> can touch, read back from the <c>Database</c> after commit.</summary>
    public sealed class DrawingSetupResult
    {
        public string InsUnits { get; set; } = "";
        public string LinearUnits { get; set; } = "";
        public int LinearPrecision { get; set; }
        public string AngularUnits { get; set; } = "";
        public double LtScale { get; set; }
        public double CeltScale { get; set; }
        public double DimScale { get; set; }
        public bool LwDisplay { get; set; }
        public string AnnotationScale { get; set; } = "";
    }

    /// <summary>
    /// Mirrors contracts/cad-types OpenDocumentInfo. <see cref="Modified"/> is only knowable for
    /// the active document (AutoCAD's DBMOD system variable reflects only the current document
    /// context) -- null, not a false "unmodified" claim, for every background document.
    /// </summary>
    public sealed class OpenDocumentInfoDto
    {
        public string DocumentId { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Path { get; set; }
        public bool IsActive { get; set; }
        public bool? Modified { get; set; }
    }

    public sealed class DrawingListOpenResult
    {
        public List<OpenDocumentInfoDto> Documents { get; set; } = new();
    }

    /// <summary>
    /// One read-only pass over model space answering "what is in this drawing?" — the cheap
    /// alternative to paging <c>entity.list</c> 1000 entities at a time on a large DWG. Mirrors
    /// wire-protocol <c>DrawingSummaryResult</c>; see docs/PROTOCOL.md.
    /// </summary>
    public sealed class DrawingSummaryRequest
    {
        public string? DocumentName { get; set; }
    }

    public sealed class DrawingSummaryResult
    {
        public string DocumentId { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Path { get; set; }
        /// <summary>Model-space entity count (paper-space layouts are not counted).</summary>
        public int EntityCount { get; set; }
        /// <summary>Every <c>LayerTable</c> layer — empty ones included — with its model-space count.</summary>
        public List<DrawingSummaryLayerDto> Layers { get; set; } = new();
        /// <summary>Model-space extents (<c>db.UpdateExt(false)</c>); null exactly when <see cref="ExtentsEmpty"/>.</summary>
        public BoundsDto? Extents { get; set; }
        /// <summary>True when the drawing has nothing to bound (Extmin &gt; Extmax) or reports non-finite extents.</summary>
        public bool ExtentsEmpty { get; set; }
        /// <summary>Same vocabulary as <c>drawing.setup</c> (<see cref="DrawingSetupResult.InsUnits"/>).</summary>
        public string InsUnits { get; set; } = "unitless";
        public string LinearUnits { get; set; } = "decimal";
        public string AnnotationScale { get; set; } = "1:1";
        public int BlockReferenceCount { get; set; }
        /// <summary>Distinct referenced block names, most-referenced first, capped (see <see cref="BlocksHasMore"/>).</summary>
        public List<DrawingSummaryBlockDto> Blocks { get; set; } = new();
        public bool BlocksHasMore { get; set; }
        /// <summary>Every <c>BlockTableRecord</c> that is an attached xref or overlay.</summary>
        public List<DrawingSummaryXrefDto> Xrefs { get; set; } = new();
        /// <summary>Up to 30 free-standing MText/DBText strings with their layer.</summary>
        public List<DrawingSummaryTextDto> Texts { get; set; } = new();
        public bool TextsHasMore { get; set; }
        /// <summary>
        /// Up to 30 non-empty attribute values read off block references, model-space AND paper
        /// layouts (title-block fields: project name, drawing number, scale, date), each tagged
        /// with its block name and, for a paper-layout source, its layout name (#434 PR 2) — a
        /// caller must use <see cref="DrawingSummaryTextDto.Layout"/> to tell which, never assume.
        /// Separate from <see cref="Texts"/> so a symbol library with many attributes can't crowd
        /// the model-space notes out of the preview budget.
        /// </summary>
        public List<DrawingSummaryTextDto> BlockTexts { get; set; } = new();
        public bool BlockTextsHasMore { get; set; }
        public List<DrawingSummaryLayoutDto> Layouts { get; set; } = new();
        /// <summary>Same coarse revision <c>drawing.info</c> reports (<c>tdu:…;saves:…</c>). The CAD
        /// State Engine binds a summary's counts to a revision, so a snapshot is verifiable without
        /// a second <c>drawing.info</c> round trip.</summary>
        public string Revision { get; set; } = "";
        /// <summary><c>Database.FingerprintGuid</c> lineage identity — see <see cref="DrawingInfoResult.FingerprintGuid"/>.</summary>
        public string? FingerprintGuid { get; set; }
    }

    public sealed class DrawingSummaryLayerDto
    {
        public string Name { get; set; } = "";
        public int Count { get; set; }
    }

    public sealed class DrawingSummaryBlockDto
    {
        public string Name { get; set; } = "";
        public int Count { get; set; }
    }

    public sealed class DrawingSummaryXrefDto
    {
        public string Name { get; set; } = "";
        /// <summary>Lower-camel <c>XrefStatus</c>: resolved/unloaded/unreferenced/fileNotFound/unresolved.</summary>
        public string Status { get; set; } = "";
        public bool Overlay { get; set; }
    }

    public sealed class DrawingSummaryTextDto
    {
        public string Text { get; set; } = "";
        public string Layer { get; set; } = "";
        /// <summary>
        /// Set when the text came from a block reference's <c>AttributeReference</c> (a title-block
        /// field, etc.) — the referenced block's name; null for a free-standing model-space
        /// MText/DBText. Lets the caller tell a title-block value from a note without guessing.
        /// </summary>
        public string? Block { get; set; }
        /// <summary>
        /// Set when the text came from a PAPER-space layout's own block table (#434 PR 2) — that
        /// layout's name. Null for model space, so a caller can never mistake a title-block value
        /// read off a sheet for model-space geometry.
        /// </summary>
        public string? Layout { get; set; }
    }

    public sealed class DrawingSummaryLayoutDto
    {
        public string Name { get; set; } = "";
        public bool IsActive { get; set; }
        public bool IsModel { get; set; }
    }

    public sealed class PluginSupportsDto
    {
        public bool BlockUniquify { get; set; } = true;
    }

    /// <summary>Wire shape for system.status. Mirrors contracts/cad-types AutoCadPluginStatus.</summary>
    public sealed class SystemStatusResult
    {
        public int ProcessId { get; set; }
        public string PluginVersion { get; set; } = "";
        public string AutocadVersion { get; set; } = "";
        public string? ActiveDocument { get; set; }
        public double PipeUptimeSeconds { get; set; }
        /// <summary>The AutoCAD managed-runtime generation this plugin was built for and was loaded
        /// from (<c>net48</c> / <c>net8.0-windows</c> / <c>net10.0-windows</c>) — the answer to
        /// "which generation did AutoCAD pick", which is otherwise invisible until a bundle that
        /// ships none of them shows up as a missing pipe (#332).</summary>
        public string RuntimeGeneration { get; set; } = "";
        public PluginSupportsDto Supports { get; set; } = new();
    }
}
