using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    /// <summary>Mirrors contracts/cad-types EntityRef/EntitySummary.</summary>
    public class EntityRefDto
    {
        public string Handle { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Layer { get; set; } = "";
    }

    public sealed class BoundsDto
    {
        public Point3dDto Min { get; set; } = new Point3dDto();
        public Point3dDto Max { get; set; } = new Point3dDto();
    }

    public class EntitySummaryDto : EntityRefDto
    {
        public BoundsDto? Bounds { get; set; }
    }

    /// <summary>Mirrors contracts/cad-types EntityCommonProperties (#25).</summary>
    public sealed class EntityPropertiesDto
    {
        public ColorSpecDto Color { get; set; } = new ColorSpecDto();
        public string Linetype { get; set; } = "";
        public double LinetypeScale { get; set; }
        public int Lineweight { get; set; }
        public int? Transparency { get; set; }
        public bool Visible { get; set; }
    }

    /// <summary>
    /// `entity.get`/`entity.list`'s `detail: "full"` response (#25): <see cref="EntitySummaryDto"/>
    /// plus common properties and kind-specific geometry. <see cref="Geometry"/>'s concrete runtime
    /// type (one of the `*GeometryDto` classes below, chosen by <see cref="EntityRefDto.Kind"/>)
    /// mirrors contracts/cad-types's EntityDetail discriminated union — the camel-case wire contract
    /// (`PipeServer`'s `CamelCasePropertyNamesContractResolver`) serializes whatever concrete object
    /// is assigned, regardless of this property's declared `object` type.
    /// </summary>
    public sealed class EntityDetailDto : EntitySummaryDto
    {
        public EntityPropertiesDto Properties { get; set; } = new EntityPropertiesDto();
        public object Geometry { get; set; } = new object();
    }

    public sealed class LineGeometryDto
    {
        public Point3dDto Start { get; set; } = new Point3dDto();
        public Point3dDto End { get; set; } = new Point3dDto();
        public double Length { get; set; }
    }

    public sealed class CircleGeometryDto
    {
        public Point3dDto Center { get; set; } = new Point3dDto();
        public double Radius { get; set; }
    }

    public sealed class ArcGeometryDto
    {
        public Point3dDto Center { get; set; } = new Point3dDto();
        public double Radius { get; set; }
        public double StartAngle { get; set; }
        public double EndAngle { get; set; }
    }

    /// <summary>One `polyline` vertex (#25). Mirrors contracts/cad-types PolylineVertex.</summary>
    public sealed class PolylineVertexDto
    {
        public Point3dDto Point { get; set; } = new Point3dDto();
        public double? Bulge { get; set; }
        public double? StartWidth { get; set; }
        public double? EndWidth { get; set; }
    }

    public sealed class PolylineGeometryDto
    {
        public List<PolylineVertexDto> Vertices { get; set; } = new List<PolylineVertexDto>();
        public bool Closed { get; set; }
        public double Length { get; set; }
        public double? Area { get; set; }
    }

    public sealed class MTextGeometryDto
    {
        public Point3dDto Insertion { get; set; } = new Point3dDto();
        public string Text { get; set; } = "";
        public double Height { get; set; }
        public double Rotation { get; set; }
        public double? Width { get; set; }
        public string Style { get; set; } = "";
    }

    public sealed class SingleLineTextGeometryDto
    {
        public Point3dDto Insertion { get; set; } = new Point3dDto();
        public string Text { get; set; } = "";
        public double Height { get; set; }
        public double Rotation { get; set; }
        public string Style { get; set; } = "";
        public double? WidthFactor { get; set; }
    }

    public sealed class NestedGeometryEntryDto
    {
        public string Kind { get; set; } = "";
        public object Geometry { get; set; } = new object();
    }

    public sealed class NestedGeometryDto
    {
        public List<NestedGeometryEntryDto> Entities { get; set; } = new List<NestedGeometryEntryDto>();
        public bool Truncated { get; set; }
        public bool IsXref { get; set; }
    }

    public sealed class BlockReferenceGeometryDto
    {
        public string BlockName { get; set; } = "";
        public Point3dDto Position { get; set; } = new Point3dDto();
        public Point3dDto Scale { get; set; } = new Point3dDto();
        public double Rotation { get; set; }
        public Dictionary<string, string>? Attributes { get; set; }
        public NestedGeometryDto? NestedGeometry { get; set; }
    }

    public sealed class LinearDimensionGeometryDto
    {
        public Point3dDto ExtLine1 { get; set; } = new Point3dDto();
        public Point3dDto ExtLine2 { get; set; } = new Point3dDto();
        public Point3dDto DimLinePoint { get; set; } = new Point3dDto();
        public double Rotation { get; set; }
        public double Measurement { get; set; }
        public string Text { get; set; } = "";
    }

    public sealed class AlignedDimensionGeometryDto
    {
        public Point3dDto ExtLine1 { get; set; } = new Point3dDto();
        public Point3dDto ExtLine2 { get; set; } = new Point3dDto();
        public Point3dDto DimLinePoint { get; set; } = new Point3dDto();
        public double Measurement { get; set; }
        public string Text { get; set; } = "";
    }

    public sealed class OrdinateDimensionGeometryDto
    {
        public Point3dDto Origin { get; set; } = new Point3dDto();
        public Point3dDto FeaturePoint { get; set; } = new Point3dDto();
        public Point3dDto LeaderEndPoint { get; set; } = new Point3dDto();
        public string Axis { get; set; } = "";
        public double Measurement { get; set; }
        public string Text { get; set; } = "";
    }

    public sealed class HatchBoundaryLoopDto
    {
        public string LoopType { get; set; } = "";
        public double? Area { get; set; }
        public bool Closed { get; set; }
        public List<Point3dDto> Vertices { get; set; } = new List<Point3dDto>();
    }

    /// <summary>Hatch geometry with loop types and optional tessellated boundary loops.</summary>
    public sealed class HatchGeometryDto
    {
        public string Pattern { get; set; } = "";
        public double PatternScale { get; set; }
        public double PatternAngle { get; set; }
        public bool Associative { get; set; }
        public int LoopCount { get; set; }
        public List<string> LoopTypes { get; set; } = new List<string>();
        public double? Area { get; set; }
        public List<HatchBoundaryLoopDto>? BoundaryLoops { get; set; }
        public bool? Truncated { get; set; }
    }

    /// <summary>`kind: "other"` (#25) — any CLR entity type <see cref="Util.EntityKindResolver"/> doesn't otherwise name.</summary>
    public sealed class OtherGeometryDto
    {
        public string DxfName { get; set; } = "";
    }

    /// <summary>
    /// Wire shape for the entity.create discriminated union (docs/PROTOCOL.md).
    /// Flat and lenient by design: only the fields relevant to <see cref="Kind"/>
    /// are populated; EntityHandlers.Create validates per kind before touching
    /// the database.
    /// </summary>
    public sealed class CreateEntityRequest
    {
        public string Kind { get; set; } = "";
        public string? Layer { get; set; }
        public string? DocumentName { get; set; }
        /// <summary>Repeat this key on retry to get the original result back instead of re-executing (autocad-mcp#9).</summary>
        public string? IdempotencyKey { get; set; }
        /// <summary>Per-call override of the document's view.setLive follow setting (autocad-mcp#67).</summary>
        public ViewOverrideDto? View { get; set; }

        // line
        public Point3dDto? Start { get; set; }
        public Point3dDto? End { get; set; }

        // circle / arc
        public Point3dDto? Center { get; set; }
        public double? Radius { get; set; }
        public double? StartAngle { get; set; }
        public double? EndAngle { get; set; }

        // polyline
        public List<Point3dDto>? Points { get; set; }
        public bool? Closed { get; set; }

        // polyline bulge/width (server-computed presets only: rectangle.fillet, donut). Named
        // ConstantWidth, not Width, to avoid colliding with mtext's Width (text-box wrap width)
        // above — AutoCAD's own PEDIT calls this a polyline's "constant width".
        public List<double>? Bulges { get; set; }
        public double? ConstantWidth { get; set; }

        // rectangle
        public Point3dDto? Corner1 { get; set; }
        public Point3dDto? Corner2 { get; set; }

        // mtext / text.singleLine
        public Point3dDto? Insertion { get; set; }
        public string? Text { get; set; }
        public double? Height { get; set; }
        public double? Width { get; set; }
        /// <summary>Millimetres on paper (#74): overrides <see cref="Height"/> with paperHeight * the current CANNOSCALE's drawing-units-per-paper-unit factor.</summary>
        public double? PaperHeight { get; set; }

        // text.singleLine / blockReference (shared)
        public double? Rotation { get; set; }

        // blockReference
        public string? BlockName { get; set; }
        public Point3dDto? Position { get; set; }
        public Point3dDto? Scale { get; set; }
        public Dictionary<string, string>? Attributes { get; set; }

        // dimension.linear / dimension.aligned
        public Point3dDto? ExtLine1 { get; set; }
        public Point3dDto? ExtLine2 { get; set; }
        public Point3dDto? DimLinePoint { get; set; }
        public string? DimText { get; set; }

        // dimension.ordinate
        public Point3dDto? Origin { get; set; }
        public Point3dDto? FeaturePoint { get; set; }
        public Point3dDto? LeaderEndPoint { get; set; }
        public string? Axis { get; set; }

        // hatch
        public List<string>? BoundaryHandles { get; set; }
        public List<HatchLoopDto>? Loops { get; set; }
        public string? Pattern { get; set; }
        public double? PatternScale { get; set; }
        public double? PatternAngle { get; set; }
        public string? Style { get; set; }
        public bool? Associative { get; set; }
        /// <summary>
        /// Annotative text/dimensions/hatch + annotation scale (#74): mtext, text.singleLine,
        /// dimension.linear/aligned/ordinate, hatch only. Null defaults to the document's own
        /// annotative-default (set by <c>drawing.setup</c>'s <c>annotationScale</c>) — see
        /// <c>Util/Annotation.cs</c>.
        /// </summary>
        public bool? Annotative { get; set; }
    }

    /// <summary>
    /// One `hatch.loops[i]` entry (#58). Exactly one of <see cref="Handles"/>, <see cref="Points"/>,
    /// or <see cref="Circle"/> is populated; <see cref="EntityHandlers"/> validates which.
    /// </summary>
    public sealed class HatchLoopDto
    {
        public List<string>? Handles { get; set; }
        public List<Point3dDto>? Points { get; set; }
        public List<double>? Bulges { get; set; }
        public HatchLoopCircleDto? Circle { get; set; }
    }

    public sealed class HatchLoopCircleDto
    {
        public Point3dDto Center { get; set; } = new Point3dDto();
        public double Radius { get; set; }
    }

    public sealed class EntityCreateResult
    {
        public EntityRefDto Entity { get; set; } = new EntityRefDto();
    }

    public sealed class EntityListRequest
    {
        public string? Layer { get; set; }
        public string? Kind { get; set; }
        public int Limit { get; set; } = 100;
        public int Offset { get; set; } = 0;
        public string? DocumentName { get; set; }
        /// <summary>
        /// Opt-out (#10): false skips <c>Entity.Bounds</c> entirely for the returned page —
        /// every entity's <see cref="EntitySummaryDto.Bounds"/> is null. Default/omitted/true
        /// preserves prior behavior. Callers that only need handle/kind/layer (e.g. counting,
        /// bulk erase-by-filter) should set this to avoid the plugin's most expensive per-entity
        /// computation.
        /// </summary>
        public bool? IncludeBounds { get; set; }
        /// <summary>"full" (#25) returns an <see cref="EntityDetailDto"/> per entity instead of <see cref="EntitySummaryDto"/>. Default/omitted: "summary".</summary>
        public string? Detail { get; set; }
        /// <summary>
        /// World XY rectangle filter: only entities whose bounds intersect it count/page. An entity
        /// whose bounds AutoCAD can't compute is INCLUDED (never silently dropped). Same
        /// <c>{min,max}</c> shape as <see cref="DrawingCheckScopeDto.Window"/>.
        /// </summary>
        public WindowDto? Window { get; set; }
    }

    public sealed class EntityListResult
    {
        /// <summary>Each element is an <see cref="EntitySummaryDto"/> or, when <see cref="EntityListRequest.Detail"/> is "full", an <see cref="EntityDetailDto"/> (#25).</summary>
        public List<object> Entities { get; set; } = new List<object>();
        public int Total { get; set; }
    }

    public sealed class EntityGetRequest
    {
        public string Handle { get; set; } = "";
        public string? DocumentName { get; set; }
        /// <summary>See <see cref="EntityListRequest.Detail"/> (#25). Default/omitted: "summary".</summary>
        public string? Detail { get; set; }
    }

    public sealed class EntityGetResult
    {
        /// <summary>An <see cref="EntitySummaryDto"/> or, when <see cref="EntityGetRequest.Detail"/> is "full", an <see cref="EntityDetailDto"/> (#25).</summary>
        public object Entity { get; set; } = new EntitySummaryDto();
        /// <summary>
        /// #413 phase B: present with <c>detail: "full"</c> — the PreImageCanonical digest of this
        /// entity's BOUNDS-FREE detail, the exact value <c>operations.apply</c>'s
        /// <c>expectedState</c> re-checks (bounds are excluded because view-dependent extents drift
        /// without any real edit). On the result wrapper, never inside the detail object, so the
        /// digest can never hash itself.
        /// </summary>
        public string? StateDigest { get; set; }
    }

    /// <summary>Mirrors contracts/protocol EntityCopyToParams.</summary>
    public sealed class EntityCopyToRequest
    {
        public List<string> Handles { get; set; } = new List<string>();
        /// <summary>The open document to copy into (required).</summary>
        public string TargetDocumentName { get; set; } = "";
        /// <summary>Offset applied to the copies; omitted → same coordinates as the source.</summary>
        public Point3dDto? Delta { get; set; }
        /// <summary>The source document; omitted → the active one.</summary>
        public string? DocumentName { get; set; }
        /// <summary>Groups the copy into a journaled task so it reverts as a unit (#413 §11.5).</summary>
        public string? TaskId { get; set; }
    }

    public sealed class EntityCopyToResult
    {
        /// <summary>The new entities, as they exist in the target document.</summary>
        public List<EntityRefDto> Copied { get; set; } = new List<EntityRefDto>();
        public string TargetDocumentName { get; set; } = "";
        /// <summary>Present only when TaskId journaled the copy: the durable receipt's batch id.</summary>
        public string? ReceiptBatchId { get; set; }
    }

    /// <summary>
    /// Wire shape for <c>entity.areaMeasure</c> (docs/PROTOCOL.md). Mirrors
    /// contracts/protocol's <c>EntityAreaMeasureParams</c>. Scope resolution is first-match-wins:
    /// <see cref="Handles"/>, else <see cref="Selection"/> == "implied", else <see cref="Window"/>.
    /// </summary>
    public sealed class EntityAreaMeasureRequest
    {
        /// <summary>Area-bearing entities to measure, by handle — the fast path: no model-space scan.</summary>
        public List<string> Handles { get; set; } = new List<string>();
        /// <summary>"implied": whatever the user has currently picked in this drawing (<c>Editor.SelectImplied</c>).</summary>
        public string? Selection { get; set; }
        /// <summary>World XY rectangle: measures the area-bearing entities inside it.</summary>
        public WindowDto? Window { get; set; }
        /// <summary>"m2": convert to square metres when INSUNITS are known; anything else/omitted: drawing units squared only.</summary>
        public string? OutputUnit { get; set; }
        public string? DocumentName { get; set; }
    }

    /// <summary>One measured (or truthfully refused) entity. Mirrors contracts/protocol <c>AreaMeasureRegion</c>.</summary>
    public sealed class AreaMeasureRegionDto
    {
        public string Handle { get; set; } = "";
        /// <summary><see cref="EntityKindResolver.KindOf"/> — "polyline", "hatch", "region", …</summary>
        public string Kind { get; set; } = "";
        public string Layer { get; set; } = "";
        /// <summary>"measured" | "open_boundary" | "ambiguous_region" | "unsupported_geometry".</summary>
        public string Status { get; set; } = "";
        /// <summary>Which native AutoCAD property produced the number: "polyline-area" | "hatch-area" | "region-area" | "circle-area".</summary>
        public string? Method { get; set; }
        /// <summary>Square drawing units, straight from AutoCAD. Present iff Status == "measured".</summary>
        public double? AreaDrawingUnits2 { get; set; }
        /// <summary>Square metres — only when INSUNITS are known AND outputUnit "m2" was requested.</summary>
        public double? AreaM2 { get; set; }
        /// <summary>Linear drawing units, where AutoCAD reports a perimeter (closed polyline, region, circle).</summary>
        public double? PerimeterDrawingUnits { get; set; }
        /// <summary>Hatch only: boundary loops this area covers, so a caller can see holes were netted out.</summary>
        public int? LoopCount { get; set; }
        public int? HoleLoopCount { get; set; }
        /// <summary>
        /// Set on a closed polyline that is the associative boundary of a measured hatch in the same
        /// scope: its area is reported for reference but must NOT be added to the hatch's — the
        /// overlap is the same region counted twice.
        /// </summary>
        public string? BoundaryOfHandle { get; set; }
        /// <summary>Why a non-"measured" status was returned, in plain words.</summary>
        public string? Message { get; set; }
    }

    public sealed class EntityAreaMeasureResult
    {
        public string DocumentId { get; set; } = "";
        public string DocumentName { get; set; } = "";
        /// <summary>Same <c>tdu:…;saves:…</c> string <c>drawing.info</c> reports — binds the measurement to a drawing state.</summary>
        public string Revision { get; set; } = "";
        /// <summary>The INSUNITS the conversion (or refusal to convert) was based on.</summary>
        public string InsUnits { get; set; } = "unitless";
        /// <summary>True when AreaM2 values are present (known units + outputUnit "m2").</summary>
        public bool ConvertedToM2 { get; set; }
        public List<AreaMeasureRegionDto> Regions { get; set; } = new List<AreaMeasureRegionDto>();
        /// <summary>Scope-matched entities that carry no area at all (line/arc/text/…) — counted, not guessed.</summary>
        public int SkippedNonAreaCount { get; set; }
    }

    /// <summary>
    /// `entity.transform` `arrayPath`'s `path` (#20): exactly one of <see cref="Handle"/> (an
    /// existing line/arc/polyline/other curve entity) or <see cref="Points"/> (>= 2, built as a
    /// transient non-database-resident straight-segment <see cref="Polyline"/> so both forms
    /// resolve through the same `Curve` arc-length API) is populated; <see cref="EntityHandlers"/>
    /// validates which.
    /// </summary>
    public sealed class ArrayPathDto
    {
        public string? Handle { get; set; }
        public List<Point3dDto>? Points { get; set; }
    }

    public sealed class EntityEraseRequest
    {
        public List<string> Handles { get; set; } = new List<string>();
        public string? DocumentName { get; set; }
        public ViewOverrideDto? View { get; set; }
    }

    public sealed class EntityEraseResult
    {
        public List<string> Erased { get; set; } = new List<string>();
    }

    /// <summary>
    /// Wire shape for the entity.transform discriminated union (docs/PROTOCOL.md).
    /// </summary>
    public sealed class EntityTransformRequest
    {
        public string Op { get; set; } = "";
        public List<string> Handles { get; set; } = new List<string>();
        public Point3dDto? Delta { get; set; }
        public Point3dDto? Center { get; set; }
        public double? Angle { get; set; }
        public double? Factor { get; set; }
        public Point3dDto? AxisStart { get; set; }
        public Point3dDto? AxisEnd { get; set; }
        public bool? Erase { get; set; }

        // arrayRect / arrayPolar (#20)
        public int? Rows { get; set; }
        public int? Columns { get; set; }
        public double? RowSpacing { get; set; }
        public double? ColumnSpacing { get; set; }
        public int? Count { get; set; }
        public double? FillAngle { get; set; }
        public bool? RotateItems { get; set; }

        // arrayPath (#20)
        public ArrayPathDto? Path { get; set; }
        public double? Spacing { get; set; }
        public bool? Align { get; set; }

        public string? DocumentName { get; set; }
        public ViewOverrideDto? View { get; set; }
    }

    public sealed class EntityTransformResult
    {
        public List<EntityRefDto> Affected { get; set; } = new List<EntityRefDto>();
    }

    /// <summary>
    /// Wire shape for `entity.update`'s `geometry` patch (#26, docs/PROTOCOL.md). Flat and
    /// lenient like <see cref="CreateEntityRequest"/>: only the fields relevant to
    /// <see cref="Kind"/> are populated. <see cref="EntityHandlers.Update"/> checks
    /// <see cref="Kind"/> against the handle's actual current kind before applying anything.
    /// </summary>
    public sealed class EntityUpdateGeometryDto
    {
        public string Kind { get; set; } = "";

        // line
        public Point3dDto? Start { get; set; }
        public Point3dDto? End { get; set; }

        // circle / arc
        public Point3dDto? Center { get; set; }
        public double? Radius { get; set; }
        public double? StartAngle { get; set; }
        public double? EndAngle { get; set; }

        // polyline (closed only — vertex-count changes are still erase+recreate territory)
        public bool? Closed { get; set; }

        // mtext / text.singleLine
        public Point3dDto? Insertion { get; set; }
        public string? Text { get; set; }
        public double? Height { get; set; }
        public double? Width { get; set; }
        public double? Rotation { get; set; }

        // blockReference
        public Point3dDto? Position { get; set; }
        public Point3dDto? Scale { get; set; }
        public Dictionary<string, string>? Attributes { get; set; }

        // dimension.linear / dimension.aligned
        public Point3dDto? ExtLine1 { get; set; }
        public Point3dDto? ExtLine2 { get; set; }
        public Point3dDto? DimLinePoint { get; set; }
        public string? DimText { get; set; }

        // dimension.ordinate
        public Point3dDto? Origin { get; set; }
        public Point3dDto? FeaturePoint { get; set; }
        public Point3dDto? LeaderEndPoint { get; set; }

        // hatch
        public string? Pattern { get; set; }
        public double? PatternScale { get; set; }
        public double? PatternAngle { get; set; }
    }

    /// <summary>Wire shape for `entity.update` (#26, docs/PROTOCOL.md).</summary>
    public sealed class EntityUpdateRequest
    {
        public string Handle { get; set; } = "";
        public string? DocumentName { get; set; }
        public ViewOverrideDto? View { get; set; }

        // Common properties — apply to any kind via the entity's base Entity/DBObject properties.
        public string? Layer { get; set; }
        public ColorSpecDto? Color { get; set; }
        public string? Linetype { get; set; }
        public int? Lineweight { get; set; }

        public EntityUpdateGeometryDto? Geometry { get; set; }
    }

    public sealed class EntityUpdateResult
    {
        public EntitySummaryDto Entity { get; set; } = new EntitySummaryDto();
    }

    public sealed class EntityTraceBoundaryRequest
    {
        public string? DocumentName { get; set; }
        public Point3dDto Point { get; set; } = new Point3dDto();
        public bool? DetectIslands { get; set; }
    }

    public sealed class BoundaryLoopDto
    {
        public string Kind { get; set; } = "outer";
        public List<Point3dDto> Points { get; set; } = new List<Point3dDto>();
        public double Area { get; set; }
        public double Perimeter { get; set; }
        public bool IsClosed { get; set; }
    }

    public sealed class EntityTraceBoundaryResult
    {
        public bool Found { get; set; }
        public List<BoundaryLoopDto> Boundaries { get; set; } = new List<BoundaryLoopDto>();
        public double NetArea { get; set; }
        /// <summary>Why nothing was traced, or what was skipped. Never a substitute for geometry.</summary>
        public string? Reason { get; set; }
        /// <summary>
        /// Always "WCS": every ring vertex and NetArea is expressed in world coordinates — the wire
        /// contract (docs/PROTOCOL.md) — regardless of the document's active UCS at trace time.
        /// </summary>
        public string CoordinateSystem { get; set; } = "WCS";
        /// <summary>
        /// True when the document's active UCS was NOT World when the trace ran (spec E1). The raw
        /// engine evaluates in that UCS frame; the vertices above are mapped back to WCS, so this flag
        /// is an honesty signal for the Cloud — it records that a rotated/dilated frame was involved
        /// rather than letting a caller assume the seed was interpreted as WCS.
        /// </summary>
        public bool UcsWithWorld { get; set; }
    }
}
