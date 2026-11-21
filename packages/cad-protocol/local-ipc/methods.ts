import type {
  AutoCadPluginStatus,
  ColorSpec,
  DrawingInfo,
  EntityCommonProperties,
  EntityDetail,
  EntityKind,
  EntityRef,
  EntitySummary,
  LayerInfo,
  OpenDocumentInfo,
  Point3d
} from '@aleph-connector/cad-types'

/**
 * Local IPC method catalog: the JSON-RPC contract between bridge (C#, routes by instanceId) and
 * plugin (C#, runs inside AutoCAD) over the named pipe. The Remote MCP Server never calls these
 * directly — it builds a `CapabilityOperation` (see @aleph-connector/cad-protocol's device/ layer) with
 * `type` set to one of these method names, and the Device Gateway/Bridge relay it unchanged. Must
 * match plugin's RpcHandlers routing. See docs/PROTOCOL.md.
 */
export const RpcMethod = {
  SystemStatus: 'system.status',
  DrawingInspectFloorplan: 'drawing.inspect_floorplan',
  DrawingInfo: 'drawing.info',
  DrawingSummary: 'drawing.summary',
  DrawingSave: 'drawing.save',
  DrawingListOpen: 'drawing.listOpen',
  DrawingOpen: 'drawing.open',
  DrawingNew: 'drawing.new',
  DrawingClose: 'drawing.close',
  DrawingActivate: 'drawing.activate',
  DrawingSetup: 'drawing.setup',
  DrawingCheck: 'drawing.check',
  DrawingCleanup: 'drawing.cleanup',
  LayerList: 'layer.list',
  LayerCreate: 'layer.create',
  LayerSetCurrent: 'layer.setCurrent',
  LayerSetProperties: 'layer.setProperties',
  LayerEnsure: 'layer.ensure',
  LayerRename: 'layer.rename',
  LayerDelete: 'layer.delete',
  EntityCreate: 'entity.create',
  EntityList: 'entity.list',
  EntityGet: 'entity.get',
  EntityAreaMeasure: 'entity.areaMeasure',
  EntityTraceBoundary: 'entity.traceBoundary',
  EntityErase: 'entity.erase',
  EntityTransform: 'entity.transform',
  EntityUpdate: 'entity.update',
  EntityCopyTo: 'entity.copyTo',
  ViewZoomExtents: 'view.zoomExtents',
  ViewCapture: 'view.capture',
  ViewSetLive: 'view.setLive',
  ViewGetLive: 'view.getLive',
  ViewZoom: 'view.zoom',
  OperationsApply: 'operations.apply',
  OperationsPreview: 'operations.preview',
  OperationsRevert: 'operations.revert',
  OperationsUndo: 'operations.undo',
  OperationsRedo: 'operations.redo',
  OperationsHistory: 'operations.history',
  StyleLinetypesList: 'style.linetypes.list',
  StyleLinetypesLoad: 'style.linetypes.load',
  StyleTextStylesList: 'style.textStyles.list',
  StyleTextStylesCreate: 'style.textStyles.create',
  StyleTextStylesSetCurrent: 'style.textStyles.setCurrent',
  StyleDimStylesList: 'style.dimStyles.list',
  StyleDimStylesCreate: 'style.dimStyles.create',
  StyleDimStylesSetCurrent: 'style.dimStyles.setCurrent',
  BlockInspect: 'block.inspect',
  BlockSetExplodable: 'block.setExplodable',
  BlockList: 'block.list',
  BlockExplode: 'block.explode',
  BlockUniquify: 'block.uniquify',
  /** Slice 06 of specs/pccc-cad-drawing-truth/ — builds a block definition directly from inline
   * entity geometry (no source DWG ever opens). Idempotent: an existing name is a no-op. */
  BlockEnsureDefinition: 'block.ensureDefinition',
  CadScan: 'cad.scan',
  CadChanges: 'cad.changes',
  EditBegin: 'edit.begin',
  EditApply: 'edit.apply',
  EditPreview: 'edit.preview',
  EditStatus: 'edit.status',
  EditDiscard: 'edit.discard',
  EditAccept: 'edit.accept'
} as const

export type RpcMethodName = (typeof RpcMethod)[keyof typeof RpcMethod]

// ---- system --------------------------------------------------------------

export type SystemStatusParams = Record<string, never>
export type SystemStatusResult = AutoCadPluginStatus

// ---- drawing ---------------------------------------------------------------

export interface InspectFloorplanParams {
  name: string
  documentName?: string
  /** Exact layout tab to inspect; omitted preserves the model-space default. */
  layoutName?: string
  capture?: boolean
  width?: number
  height?: number
  /**
   * Selects one of the frames an earlier inspect reported in `regionCandidates` (0-based). Only
   * meaningful after `regionBasis: 'ambiguous'` with candidates, i.e. when the same plan title
   * really does appear several times on the sheet.
   */
  candidateIndex?: number
}

export interface FloorplanDimensions {
  width: number
  height: number
  units: string
}

export interface FloorplanRoom {
  name: string
  // The label's own position, not the room's outline. Slice 02 renames this from `position`
  // because the plan geometry the design needs is the room `boundary`, assembled cloud-side.
  labelPosition: [number, number]
  // ---- Attached by the Cloud tool from the CAD State snapshot; the plugin never emits these. ----
  /** Stable handle for this room within one document revision, referenced by the drawing executor. */
  ref?: string
  /** Closed outline in WCS, counter-clockwise. Present only when `boundaryStatus === 'verified'`. */
  boundary?: [number, number][]
  boundaryStatus?: 'verified' | 'unresolved' | 'ambiguous'
  boundaryEvidence?: string
  areaM2?: number
}

/**
 * Outcome of the inline off-screen capture the plugin attaches to an inspect. A failed capture is
 * reported here rather than thrown, so one bad PNG cannot invalidate the CAD the same pass read.
 */
export interface FloorplanCapture {
  status: 'ok' | 'failed'
  source: 'viewport' | 'offscreen'
  error?: string
}

export interface InspectFloorplanResult {
  found: boolean
  matchedName?: string
  /** The model or paper-space layout whose entities were inspected. */
  layoutName?: string
  availableFloorplans: string[]
  bounds?: [number, number, number, number]
  dimensions?: FloorplanDimensions
  data?: string
  mimeType?: string
  layers: string[]
  rooms: FloorplanRoom[]
  note?: string
  /**
   * How `bounds` was justified: `title-frame` (a closed frame contains this title and no other
   * plan's title), `block-frame` (the extents AutoCAD reports for the block reference named after
   * this plan — the CAD author's own grouping), `connected-geometry` (the stroke cluster the title
   * belongs to), `ambiguous` (something contains the title but cannot be attributed to one plan),
   * `unresolved` (no evidence supports any rectangle). Only the first three come with bounds — the
   * plugin no longer falls back to the whole drawing's extents, so a multi-plan sheet cannot
   * silently inspect the wrong frame.
   */
  regionBasis?: string
  /**
   * Frames the drawing does support, when one title matches several of them: the same plan laid
   * out in several copies on one sheet. Present with `regionBasis: 'ambiguous'`; pass
   * `candidateIndex` (0-based) back to read the copy you want. This is a choice between real
   * places, not missing information — re-inspecting with different wording changes nothing.
   */
  regionCandidates?: [number, number, number, number][]
  /** Structured outcome of the inline capture; null when capture was not requested. */
  capture?: FloorplanCapture
  /**
   * Set when the inspect stopped for a reason that is NOT evidence about the drawing — today only
   * `'budget'`: the region walk ran out of its own time on a very large sheet. Pairs with
   * `regionBasis: 'unresolved'` and no bounds, so a caller never mistakes "we could not finish
   * reading" for "this sheet has no such plan".
   */
  stoppedReason?: 'budget'
  /**
   * Identity + revision of the exact tab this inspect read, reported from the same locked database
   * as the region walk (no separate `drawing.info` round trip). The Cloud tool feeds this to the CAD
   * State reconcile as the drawing identity, which is what lets a region read reuse an existing
   * snapshot instead of re-scanning — the RPC budget of Slice 02.
   */
  documentId?: string
  revision?: string
  fingerprintGuid?: string | null
  /** Drawing `INSUNITS` (mm/m/…), formatted like cad.scan/drawing.summary. */
  units?: string
  /** Every room boundary was resolved against a current, verified snapshot. */
  geometryComplete?: boolean
  /** All returned geometry is in World coordinates (Slice 01 WCS contract). */
  coordinateSystem?: 'WCS'
}

export interface DrawingInfoParams {
  documentName?: string
}
export type DrawingInfoResult = DrawingInfo

/**
 * One read-only pass over model space answering "what is in this drawing?" — the cheap
 * alternative to paging `entity.list` (capped at 1000/call) on a large DWG. Mirrors the plugin's
 * `DrawingSummaryResult` (Dto/DrawingDto.cs); see docs/PROTOCOL.md.
 */
export interface DrawingSummaryParams {
  documentName?: string
}
export interface DrawingSummaryLayer {
  name: string
  /** Model-space entity count on this layer; 0 for a layer nothing is drawn on. */
  count: number
}
export interface DrawingSummaryBlock {
  name: string
  count: number
}
export interface DrawingSummaryXref {
  name: string
  status: 'resolved' | 'unloaded' | 'unreferenced' | 'fileNotFound' | 'unresolved'
  /** True for an attached overlay (`IsFromOverlayReference`), false for a bound-style xref. */
  overlay: boolean
}
export interface DrawingSummaryText {
  /** Trimmed, capped at 120 chars; MText formatting codes stripped (`MText.Text`). */
  text: string
  layer: string
  /**
   * Set only for a `blockTexts` entry: the referenced block's name, so the caller can tell a
   * title-block field from a free-standing note. Null/absent for a model-space MText/DBText.
   */
  block?: string
  /**
   * Set only for a `blockTexts` entry read off a PAPER layout's own block table (#434 PR 2) — that
   * layout's name. Absent for model space, so this field alone tells a title-block value apart
   * from model-space geometry; never assume absence means model space without checking it.
   */
  layout?: string
}
export interface DrawingSummaryLayout {
  name: string
  /**
   * Only knowable for the active document without activating another tab — always false for a
   * background document's layouts, same honesty rule as `DrawingInfo.modified`.
   */
  isActive: boolean
  isModel: boolean
}
export interface DrawingSummaryResult {
  documentId: string
  name: string
  path: string | null
  /** Model-space entity count (paper-space layouts are not counted). */
  entityCount: number
  /** Every `LayerTable` layer — empty ones included — most entities first. */
  layers: DrawingSummaryLayer[]
  /** Model-space extents (`db.UpdateExt(false)`); null exactly when `extentsEmpty`. */
  extents: { min: Point3d; max: Point3d } | null
  /** True when the drawing has nothing to bound (Extmin > Extmax) or reports non-finite extents. */
  extentsEmpty: boolean
  /** Same vocabulary as `DrawingSetupResult.insUnits`/`linearUnits`. */
  insUnits: InsUnits
  linearUnits: LinearUnits
  annotationScale: string
  blockReferenceCount: number
  /** Distinct referenced block names, most-referenced first, capped at 50 (see `blocksHasMore`). */
  blocks: DrawingSummaryBlock[]
  blocksHasMore: boolean
  /** Every `BlockTableRecord` that is an attached xref or overlay. */
  xrefs: DrawingSummaryXref[]
  /** Up to 30 free-standing MText/DBText strings with their layer. */
  texts: DrawingSummaryText[]
  textsHasMore: boolean
  /**
   * Up to 30 non-empty attribute values read off block references — model space AND every paper
   * layout's own block table (#434 PR 2, tagged with `layout` for the latter) — this is where a
   * title block's project name / drawing number / scale / date actually lives. Its own budget so
   * a note-heavy drawing can't crowd the title block out of `texts`. Model-space reads are
   * deduplicated by block name (20k identical door inserts cost one attribute walk); paper-layout
   * reads are NOT deduplicated, because the same title-block definition routinely carries a
   * different value per sheet.
   */
  blockTexts: DrawingSummaryText[]
  blockTextsHasMore: boolean
  layouts: DrawingSummaryLayout[]
  /** Same coarse revision `drawing.info` reports (`tdu:…;saves:…`). The CAD State Engine needs it
   * on the summary too: a summary is the first call on an unseen drawing, and binding its counts to
   * a revision is what makes the snapshot verifiable without a second `drawing.info` round trip. */
  revision?: string
  /** `Database.FingerprintGuid` lineage identity — see `DrawingInfo.fingerprintGuid`. */
  fingerprintGuid?: string | null
}

export interface DrawingSaveParams {
  path?: string
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
  /** Required to replace an existing file other than the document's own current file
   * (aleph-platform#5) — mirrors `DrawingSaveRequest.Overwrite` (plugin/Dto/DrawingDto.cs). */
  overwrite?: boolean
}
export interface DrawingSaveResult {
  savedPath: string
}

export type DrawingListOpenParams = Record<string, never>
export interface DrawingListOpenResult {
  documents: OpenDocumentInfo[]
}
export interface DrawingOpenParams {
  path: string
  readOnly?: boolean
}
export interface DrawingOpenResult {
  documentId: string
  name: string
  path: string
}

export interface DrawingNewParams {
  template?: string
}
export interface DrawingNewResult {
  documentId: string
  name: string
}

export interface DrawingCloseParams {
  documentName?: string
  save?: boolean
}
export interface DrawingCloseResult {
  closed: boolean
  name: string
}

export interface DrawingActivateParams {
  documentName: string
}
export interface DrawingActivateResult {
  activated: boolean
  documentId: string
  name: string
}

export type InsUnits = 'unitless' | 'mm' | 'cm' | 'm' | 'in' | 'ft'
export type LinearUnits = 'decimal' | 'architectural' | 'engineering'
export type AngularUnits = 'decimalDegrees' | 'radians'

/**
 * Write counterpart to `DrawingInfoParams` (#62): the handful of drawing-scope settings the
 * `UN`/`LTSCALE`/`LW` commands change, applied via typed `Database` properties in one transaction
 * (never `SetSystemVariable`, never a command string — see AGENTS.md). Every field is optional and
 * independently applied; omitted fields are left untouched. `scale` is a convenience that also sets
 * `ltScale` (`scale * 0.5`, the ISO linetype-scale convention) and `dimScale` (`scale`) — pass it
 * alongside explicit `ltScale`/`dimScale` and the explicit values win. `annotationScale` (#74,
 * `"paper:drawing"`, e.g. `"1:100"`) sets `CANNOSCALE`, adding it to the drawing's scale list first
 * if it isn't already there; from that call on, `entity.create`'s annotative-capable kinds
 * (`mtext`, `text.singleLine`, `dimension.linear`/`aligned`/`ordinate`, `hatch`) default their own
 * `annotative` field to `true` for this document.
 */
export interface DrawingSetupParams {
  insUnits?: InsUnits
  linearUnits?: LinearUnits
  linearPrecision?: number
  angularUnits?: AngularUnits
  ltScale?: number
  celtScale?: number
  dimScale?: number
  lwDisplay?: boolean
  scale?: number
  annotationScale?: string
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}

/** Every setting this call can touch, read back from the `Database` after commit. */
export interface DrawingSetupResult {
  insUnits: InsUnits
  linearUnits: LinearUnits
  linearPrecision: number
  angularUnits: AngularUnits
  ltScale: number
  celtScale: number
  dimScale: number
  lwDisplay: boolean
  /**
   * Current `CANNOSCALE` name (e.g. `"1:1"` on a brand-new drawing that never called
   * `annotationScale`).
   */
  annotationScale: string
}

/**
 * Every finding kind `drawing.check` can report. `textSize` is a simplification until annotative
 * text exists (a separate feature): it flags a text/mtext entity whose height matches no height
 * used by two or more _other_ text entities on the same layer, instead of validating against the
 * true paper-height x annotation-scale rule.
 */
export type DrawingCheckKind =
  | 'duplicates'
  | 'overlaps'
  | 'zeroLength'
  | 'openOutlines'
  | 'layerZero'
  | 'textSize'
  | 'dimOverride'
  | 'offExtents'

export const DRAWING_CHECK_KINDS: readonly DrawingCheckKind[] = [
  'duplicates',
  'overlaps',
  'zeroLength',
  'openOutlines',
  'layerZero',
  'textSize',
  'dimOverride',
  'offExtents'
]

/**
 * First match wins, like `ViewCaptureParams`: `handles`, else `layer`, else `window`, else the
 * whole drawing.
 */
export interface DrawingCheckScope {
  handles?: string[]
  layer?: string
  window?: { min: Point3d; max: Point3d }
}

export interface DrawingCheckParams {
  scope?: DrawingCheckScope
  /** Defaults to every kind in `DRAWING_CHECK_KINDS`. */
  checks?: DrawingCheckKind[]
  documentName?: string
}

export type DrawingCheckSeverity = 'info' | 'warning' | 'error'

/** The `drawing.cleanup` fix a finding maps to, when one of the four safe fixes applies to it. */
export type DrawingCleanupFixKind = 'duplicates' | 'zeroLength' | 'purge' | 'audit'

export interface DrawingCheckFinding {
  check: DrawingCheckKind
  severity: DrawingCheckSeverity
  handles: string[]
  message: string
  fix?: DrawingCleanupFixKind
}

export interface DrawingCheckResult {
  findings: DrawingCheckFinding[]
}

/**
 * The equivalents of `OVERKILL` (`duplicates`), `PURGE` (`purge`) and `AUDIT` (`audit`), plus
 * erasing zero-length geometry. Runs in one transaction and one native undo group; `dryRun`
 * (default `true`) computes `applied` without committing. `audit` is not implemented in the real
 * plugin — see `plugin/RpcHandlers/CheckHandlers.cs` and `docs/IMPLEMENTATION_STATUS.md` for why —
 * and fails every call that includes it, whole-batch, rather than silently dropping it or faking
 * success.
 */
/**
 * Automatically cleans up drawing issues. Only touches entities and layers CadAI created;
 * user geometry and user layers are protected.
 */
export interface DrawingCleanupParams {
  fixes: DrawingCleanupFixKind[]
  dryRun?: boolean
  documentName?: string
}

export interface DrawingCleanupApplied {
  fix: DrawingCleanupFixKind
  count: number
  /**
   * Entity handles affected, when the fix acts on entities (`duplicates`, `zeroLength`) rather than
   * symbol-table records (`purge`).
   */
  handles?: string[]
  /**
   * Candidates the sweep skipped because they are pre-existing user geometry (no `CADAI` ownership
   * stamp) — `duplicates`/`zeroLength` entities, or `purge` layers the user created. They are never
   * removed; the count tells the caller how much of the finding was protected rather than silently
   * ignored.
   */
  skippedProtected?: number
}

export interface DrawingCleanupResult {
  dryRun: boolean
  applied: DrawingCleanupApplied[]
}

// ---- layer -----------------------------------------------------------------

export interface LayerListParams {
  documentName?: string
}
export interface LayerListResult {
  layers: LayerInfo[]
}

export interface LayerCreateParams {
  name: string
  color?: ColorSpec
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}
export interface LayerCreateResult {
  layer: LayerInfo
  created: boolean
}

export interface LayerSetCurrentParams {
  name: string
  documentName?: string
}
export type LayerSetCurrentResult = Record<string, never>

export interface LayerSetPropertiesParams {
  name: string
  color?: ColorSpec
  linetype?: string
  lineweight?: number
  frozen?: boolean
  locked?: boolean
  plottable?: boolean
  on?: boolean
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}
export interface LayerSetPropertiesResult {
  layer: LayerInfo
}

export interface LayerEnsureEntry {
  name: string
  color?: ColorSpec
  linetype?: string
  lineweight?: number
  plottable?: boolean
  on?: boolean
  frozen?: boolean
  locked?: boolean
  description?: string
}
export interface LayerEnsureParams {
  layers: LayerEnsureEntry[]
  setCurrent?: string
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}
export interface LayerEnsureResultEntry extends LayerInfo {
  action: 'created' | 'updated' | 'unchanged'
}
export interface LayerEnsureResult {
  layers: LayerEnsureResultEntry[]
}

export interface LayerRenameParams {
  from: string
  to: string
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}
export type LayerRenameResult = Record<string, never>

export interface LayerDeleteParams {
  name: string
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}
export type LayerDeleteResult = Record<string, never>

// ---- entity ------------------------------------------------------------

/**
 * One `hatch` loop (#58). `handles` reuses an existing closed-curve entity; `points`/`bulges`
 * builds a polyline loop with no boundary entity created in the drawing; `circle` builds a circular
 * loop the same way, with no boundary entity created either.
 */
export type HatchLoop =
  | { handles: string[] }
  | { points: Point3d[]; bulges?: number[] }
  | { circle: { center: Point3d; radius: number } }

/**
 * Per-call override of the document's `view.setLive` follow setting — every mutating RPC accepts it
 * (autocad-mcp#67). `{ follow: "off" }` skips the camera move for this one call (e.g. hidden helper
 * geometry) even when the document default is "fit"/"pan"; omitting `view` entirely uses the
 * document default.
 */
export interface ViewOverride {
  follow?: 'off' | 'fit' | 'pan'
}

export type CreateEntityParams = (
  | { kind: 'line'; layer?: string; start: Point3d; end: Point3d }
  | { kind: 'circle'; layer?: string; center: Point3d; radius: number }
  | {
      kind: 'arc'
      layer?: string
      center: Point3d
      radius: number
      startAngle: number
      endAngle: number
    }
  | {
      kind: 'polyline'
      layer?: string
      points: Point3d[]
      closed?: boolean
      /**
       * Parallel to `points`; a rounded-corner preset (rectangle `fillet`, `donut`) sets this — not
       * exposed as a raw caller input.
       */
      bulges?: number[]
      /** Every vertex's width (AutoCAD's polyline "constant width"); a `donut` preset sets this. */
      constantWidth?: number
    }
  | { kind: 'rectangle'; layer?: string; corner1: Point3d; corner2: Point3d }
  | {
      kind: 'mtext'
      layer?: string
      insertion: Point3d
      text: string
      height?: number
      width?: number
      /**
       * Millimetres on paper; when given, overrides `height` with `paperHeight * the current
       * CANNOSCALE's drawing-units-per-paper-unit factor` (#74).
       */
      paperHeight?: number
      /**
       * Marks this entity annotative (`ObjectContextManager`/`ACDB_ANNOTATIONSCALES`, #74).
       * Defaults to this document's annotative-default (set by `drawing.setup`'s `annotationScale`)
       * when omitted.
       */
      annotative?: boolean
    }
  | {
      kind: 'text.singleLine'
      layer?: string
      insertion: Point3d
      text: string
      height?: number
      rotation?: number
      /**
       * Millimetres on paper; when given, overrides `height` with `paperHeight * the current
       * CANNOSCALE's drawing-units-per-paper-unit factor` (#74).
       */
      paperHeight?: number
      /**
       * Marks this entity annotative (`ObjectContextManager`/`ACDB_ANNOTATIONSCALES`, #74).
       * Defaults to this document's annotative-default (set by `drawing.setup`'s `annotationScale`)
       * when omitted.
       */
      annotative?: boolean
    }
  | {
      kind: 'blockReference'
      layer?: string
      blockName: string
      position: Point3d
      scale?: Point3d
      rotation?: number
      attributes?: Record<string, string>
    }
  | {
      kind: 'dimension.linear'
      layer?: string
      extLine1: Point3d
      extLine2: Point3d
      dimLinePoint: Point3d
      dimText?: string
      /** Dimension line angle in radians: 0 horizontal (default), PI/2 vertical. */
      rotation?: number
      /**
       * Marks this entity annotative — assigned the on-demand `CadAI-Annotative` dim style instead
       * of `Database.Dimstyle` (#74). Defaults to this document's annotative-default (set by
       * `drawing.setup`'s `annotationScale`) when omitted.
       */
      annotative?: boolean
    }
  | {
      kind: 'dimension.aligned'
      layer?: string
      extLine1: Point3d
      extLine2: Point3d
      dimLinePoint: Point3d
      dimText?: string
      /**
       * Marks this entity annotative — assigned the on-demand `CadAI-Annotative` dim style instead
       * of `Database.Dimstyle` (#74). Defaults to this document's annotative-default (set by
       * `drawing.setup`'s `annotationScale`) when omitted.
       */
      annotative?: boolean
    }
  | {
      kind: 'dimension.ordinate'
      layer?: string
      origin: Point3d
      featurePoint: Point3d
      leaderEndPoint: Point3d
      axis: 'x' | 'y'
      /**
       * Marks this entity annotative — assigned the on-demand `CadAI-Annotative` dim style instead
       * of `Database.Dimstyle` (#74). Defaults to this document's annotative-default (set by
       * `drawing.setup`'s `annotationScale`) when omitted.
       */
      annotative?: boolean
    }
  | {
      kind: 'hatch'
      layer?: string
      /** Existing single-loop form (unchanged): all handles joined into one `Default` loop. */
      boundaryHandles?: string[]
      /**
       * Multi-loop form (#58): `loops[0]` is the outer boundary (`HatchLoopTypes.Outermost`), every
       * later entry is an island (`HatchLoopTypes.Default`). Mutually exclusive with
       * `boundaryHandles` — exactly one of the two must be present.
       */
      loops?: HatchLoop[]
      pattern?: string
      patternScale?: number
      patternAngle?: number
      /** Maps to `Autodesk.AutoCAD.DatabaseServices.HatchStyle`. Default `normal`. */
      style?: 'normal' | 'outer' | 'ignore'
      /**
       * Only meaningful for `handles`-loops — a point/circle loop never creates a boundary curve to
       * associate with.
       */
      associative?: boolean
      /**
       * Marks this entity annotative (`ObjectContextManager`/`ACDB_ANNOTATIONSCALES`, #74).
       * Defaults to this document's annotative-default (set by `drawing.setup`'s `annotationScale`)
       * when omitted.
       */
      annotative?: boolean
    }
) & { documentName?: string; view?: ViewOverride; idempotencyKey?: string }

export interface EntityCreateResult {
  entity: EntityRef
}

export interface EntityListParams {
  layer?: string
  kind?: EntityKind
  limit?: number
  offset?: number
  documentName?: string
  /**
   * False skips Entity.Bounds for every returned entity (#10) — bounds is omitted on each.
   * Default/omitted: true.
   */
  includeBounds?: boolean
  /**
   * `"full"` (#25) returns an `EntityDetail` per entity — geometry + common properties beyond
   * `layer` — instead of the default `EntitySummary`. Default/omitted: `"summary"`, byte-for-byte
   * today's shape.
   */
  detail?: 'summary' | 'full'
  /**
   * World XY rectangle region filter: only entities whose bounds intersect it count/page, so
   * `total` means "matches the filters" — a region query reads as its own count. An entity whose
   * bounds AutoCAD can't compute is INCLUDED, never silently dropped. Same `{min,max}` shape as
   * `DrawingCheckScope.window`.
   */
  window?: { min: Point3d; max: Point3d }
}
export interface EntityListResult {
  entities: (EntitySummary | EntityDetail)[]
  total: number
}

export interface EntityGetParams {
  handle: string
  documentName?: string
  /**
   * See `EntityListParams.detail` (#25). Default/omitted: `"summary"`, today's `EntitySummary`
   * shape.
   */
  detail?: 'summary' | 'full'
}
export interface EntityGetResult {
  entity: EntitySummary | EntityDetail
  /**
   * #413 phase B: with `detail: "full"`, the PreImageCanonical digest of the entity's BOUNDS-FREE
   * detail — exactly what `operations.apply`'s `expectedState` re-checks, so a caller captures it
   * from one read and guards a later write without resending the payload. On the result wrapper
   * (never inside `entity`) so the digest can't hash itself.
   */
  stateDigest?: string
}
/**
 * Restorability verdict for one captured entity (PR B slice 01) — mirrors
 * `plugin/Edits/Restorability.cs`. Computed in the plugin today; it reaches the wire when slice 02
 * adds `entity.preimage`/`edit.begin`, and slice 04 puts it in the diff header. Sent as camelCase
 * strings, never an ordinal, so inserting a member cannot silently renumber stored verdicts.
 */
export const RESTORE_VERDICT_VALUES = ['supported', 'notSupported', 'unknownKind'] as const
export type RestoreVerdict = (typeof RESTORE_VERDICT_VALUES)[number]

export interface Restorability {
  verdict: RestoreVerdict
  /**
   * The wire kind the verdict was computed for. `string`, not `EntityKind`: `unknownKind` verdicts
   * exist precisely because `EntityKindResolver.KindOf` can emit a name the union does not contain
   * (e.g. an encrased proxy object), and the C# record types it as `string Kind`.
   */
  kind: string
  /** Populated whenever `verdict` is not `'supported'`; names the field that cannot be rebuilt. */
  reason: string | null
  /**
   * Fields that will NOT round-trip even when `verdict` is `'supported'` — e.g.
   * `properties.transparency`, `blockReference.definition`. `entity.get` reads them but no handler
   * writes them back, so an accept gate must refuse or demand an explicit override rather than
   * silently shipping a partial restore.
   */
  unsupportedFeatures: string[]
}

/** Which DWG a pre-image came from; mirrors `plugin/Edits/DocumentIdentityDto`. Never a second identity authority — the same fields `drawing.info` already surfaces. */
export interface PreImageDocumentIdentity {
  documentId: string
  /** `Database.FingerprintGuid` hex (no braces); null on an unsaved new drawing. */
  fingerprintGuid: string | null
  path: string | null
}

/**
 * One immutable pre-image: an `EntityDetail` plus capture context — mirrors
 * `plugin/Edits/EntityPreImage`. Deliberately a thin wrapper, not a third geometry model. Stored
 * LOCALLY on the user's machine; Cloud keeps only the editId, the digest and the handles, and fails
 * closed if the local copy is gone. The stored shape has no `restorability` field: the plugin
 * derives it on read from `detail` (C# `EntityPreImage.Restorability()`), so it can never drift
 * from the geometry it describes — a persisted verdict is a stale verdict.
 */
export interface EntityPreImage {
  detail: EntityDetail
  /** Coarse drawing revision (`Database.Tduupdate.Ticks` + `NumberOfSaves`) at capture. */
  revisionAtCapture: string | null
  document: PreImageDocumentIdentity
  /** ISO-8601 UTC; excluded from the digest, which covers `detail` alone. */
  capturedAtUtc: string
}

/**
 * `edit.begin` — captures an immutable pre-image of target entities, clones them to an isolated
 * preview layer (`CadAI-Candidate-<editId>`), and persists a durable local session file (PR B slice 02).
 */
export interface EditBeginParams {
  /** Target entity handles to edit. Either `handles` or `selection: "implied"` must be provided. */
  handles?: string[]
  /** Use the user's current pick in the active document (`doc.Editor.SelectImplied()`). */
  selection?: 'implied'
  documentName?: string
  includeDependencies?: boolean
}

export interface EditBeginResult {
  editId: string
  documentIdentity: string
  revisionAtCapture: string
  preImages: EntityPreImage[]
  candidates: EntityRef[]
  candidateLayer: string
  unsupportedFeatures: string[]
}

export interface EntityDiff {
  handle: string
  candidateHandle: string
  kind: string
  changedProperties: string[]
  beforeGeometry: unknown | null
  afterGeometry: unknown | null
  status: 'added' | 'modified' | 'removed' | 'unchanged'
}

export interface EditDiffResult {
  editId: string
  documentIdentity: string
  revisionAtCapture: string
  revisionNow: string
  entities: EntityDiff[]
  warnings: string[]
  diffDigest: string
}

export interface EditApplyParams {
  editId: string
  operations: EntityOperation[]
  documentName?: string
  idempotencyKey?: string
  view?: ViewOverride
  progressive?: boolean
  paceMs?: number
}

export interface EditApplyResult extends OperationsApplyResult {
  staleSince?: string | null
}

export interface EditPreviewParams {
  editId: string
  documentName?: string
  capture?: {
    width?: number
    height?: number
  }
}

export interface EditPreviewResult {
  diff: EditDiffResult
  beforePng?: string
  afterPng?: string
}

export interface EditDiscardParams {
  editId: string
  approvalToken?: string
  documentName?: string
}

export interface EditDiscardResult {
  status: 'discarded'
  removedCandidates: string[]
}

export interface EditAcceptParams {
  editId: string
  approvalToken?: string
  expectedDiffDigest?: string
  expectedRevision?: string
  allowUnknownFeatures?: boolean
  idempotencyKey?: string
  documentName?: string
}

export interface EditAcceptResult {
  status: 'accepted'
  editId: string
  appliedMapping: Record<string, string>
  diffDigest: string
}

export interface EditStatusParams {
  editId: string
  documentName?: string
}

export interface EditStatusResult {
  editId: string
  status: string
  candidateLayer: string
  candidateHandles: string[]
  sourceHandles: string[]
  preImageCount: number
  revisionAtCapture: string
  appliedMapping?: Record<string, string>
}
/**
 * `entity.areaMeasure` — read-only native area/perimeter measurement, computed by AutoCAD's own
 * geometry engine (`Curve.Area`/`Hatch.Area`/`Region.Area`), never by arithmetic over a text dump.
 * First match wins: `handles`, else `selection: "implied"` (the user's current pick), else
 * `window`. A handle-scoped call is the fast path: it opens exactly those entities, never scans
 * model space, so a follow-up "what's that room's area?" costs one RPC and one entity read.
 */
export interface BoundaryLoop {
  /** Outer boundary loop or inner island loop */
  kind: 'outer' | 'island'
  /** Boundary vertices in WCS coordinates */
  points: Point3d[]
  /** Enclosed area in drawing units squared */
  area: number
  /** Perimeter/length in drawing units */
  perimeter?: number
  /** Whether the detected boundary forms a closed polygon */
  isClosed: boolean
}

export interface EntityTraceBoundaryParams {
  /** Must resolve to the ACTIVE document — boundary tracing evaluates the visible view. */
  documentName?: string
  /** Interior point (WCS) of the region whose real boundary should be traced. */
  point: Point3d
  /** Also trace nested inner rings (columns/voids). Defaults to true. */
  detectIslands?: boolean
}

export interface EntityTraceBoundaryResult {
  /** True only when at least one readable closed ring came back from AutoCAD's own boundary engine. */
  found: boolean
  /** Outer ring first, then island rings. Empty exactly when `found` is false. */
  boundaries: BoundaryLoop[]
  /** Outer area minus island areas, in drawing units squared. */
  netArea: number
  /**
   * Why nothing was traced (an open gap, a point on a line, a non-active document is an RPC error not
   * a `found: false`), or which curve types were skipped. Geometry is never estimated: a caller that
   * gets `found: false` must ask for a polygon or a different point.
   */
  reason?: string
  /**
   * Always `'WCS'`: every ring vertex and `netArea` is expressed in world coordinates (the wire
   * contract), even though `Editor.TraceBoundary` evaluates in the document's active UCS (spec E1).
   * The plugin maps the WCS seed into UCS and the returned rings back to WCS.
   */
  coordinateSystem: 'WCS'
  /**
   * True when the document's active UCS was NOT World at trace time (rotated/dilated by the user, a
   * layout, or an active viewport). An honesty signal, not a transform the caller must redo — the
   * rings are already WCS — but it lets the Cloud prove which frames were involved instead of
   * assuming the seed was read as WCS.
   */
  ucsWithWorld: boolean
}

export interface EntityAreaMeasureParams {
  /** Area-bearing entities to measure, by handle. */
  handles?: string[]
  /**
   * `"implied"`: measure whatever the user has currently selected in this drawing
   * (`Editor.SelectImplied`) — empty when nothing is picked. Only honored for the active document.
   */
  selection?: 'implied'
  /** World XY rectangle: measures the area-bearing entities inside it. */
  window?: { min: Point3d; max: Point3d }
  /**
   * Convert to square metres only when the drawing's INSUNITS are known; `unitless`/`unknown`
   * reports `UNKNOWN_UNITS` and returns drawing-units-squared only.
   */
  outputUnit?: 'm2'
  documentName?: string
}

/** How one measurement was obtained — always AutoCAD's own engine, named so a caller can audit it. */
export type AreaMeasureMethod = 'polyline-area' | 'hatch-area' | 'region-area' | 'circle-area'

/**
 * Per-entity diagnostic. `measured` carries an area; the rest are truthful refusals — the tool
 * never substitutes a bounding-box or shoelace estimate for a measurement AutoCAD can't make.
 */
export type AreaMeasureStatus =
  | 'measured'
  /** Closed=false (or an open curve): there is no enclosed region to measure. */
  | 'open_boundary'
  /** A line/arc/polyline soup with no single area-bearing entity: which region was meant is ambiguous. */
  | 'ambiguous_region'
  /** A curve whose Area property AutoCAD refuses (self-intersecting, unevaluable). */
  | 'unsupported_geometry'

export interface AreaMeasureRegion {
  handle: string
  kind: string
  layer: string
  status: AreaMeasureStatus
  method?: AreaMeasureMethod
  /** Square drawing units, straight from AutoCAD. Present iff `status: "measured"`. */
  areaDrawingUnits2?: number
  /** Square metres — present only when INSUNITS are known AND `outputUnit: "m2"` was requested. */
  areaM2?: number
  /** Linear drawing units; `Region`/closed `Polyline` perimeter where AutoCAD reports one. */
  perimeterDrawingUnits?: number
  /** Hatch only: the boundary loops this area covers, so a caller can see holes were netted out. */
  loopCount?: number
  holeLoopCount?: number
  /**
   * Set on a closed polyline that is the associative boundary of a measured hatch in the same
   * scope: its area is the same region as the hatch's, reported for reference but NOT to be added
   * to the hatch's total (the overlap is a double-count).
   */
  boundaryOfHandle?: string
  /** Why a non-`measured` status was returned, in plain words. */
  message?: string
}

export interface EntityAreaMeasureResult {
  documentId: string
  documentName: string
  /** Same `tdu:…;saves:…` string `drawing.info` reports — binds this measurement to a drawing state. */
  revision: string
  /** The INSUNITS the conversion (or refusal to convert) was based on. */
  insUnits: InsUnits
  /** True when `areaM2` values are present (known units + `outputUnit: "m2"`). */
  convertedToM2: boolean
  regions: AreaMeasureRegion[]
  /** Entities the scope matched that carry no area at all (line/arc/text/…), counted not guessed. */
  skippedNonAreaCount: number
}

/** Parameters for `entity.erase`. Erases CadAI-created entities; user geometry is protected. */
export interface EntityEraseParams {
  handles: string[]
  documentName?: string
  view?: ViewOverride
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}
export interface EntityEraseResult {
  erased: string[]
}

/**
 * Copies entities from one open document's model space into another's, the way copy/paste between
 * tabs does: layers, text styles and blocks they depend on that the target lacks are created there.
 * Neither document is activated. Reverse path depends on `taskId` (#413 §11.5): a bare copy is not
 * journaled (erase the returned handles); a `taskId`-tagged copy (approved symbol-library import)
 * also writes a durable compensating-erase receipt to the task ledger so `operations.revert` rolls
 * the whole import back as a unit. The receipt stays OUT of the native undo stack — a cross-document
 * clone has no undo group, and journaling it would hijack `operations.undo` of the apply that
 * follows it (#388).
 */
export interface EntityCopyToParams {
  /** Handles in the source document. */
  handles: string[]
  /** The open document to copy into. */
  targetDocumentName: string
  /** Offset applied to the copies; omitted → the same coordinates as the source. */
  delta?: Point3d
  /** The source document; omitted → the active one. */
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9); keyed against the source document. */
  idempotencyKey?: string
  /** Groups the copy into a journaled task so it reverts as a unit (#413 §11.5). Omitted → no
   *  receipt; reverse by erasing the returned handles. */
  taskId?: string
}
export interface EntityCopyToResult {
  /** The new entities, with their handles in the target document. */
  copied: EntityRef[]
  /** The target's full name. */
  targetDocumentName: string
  /** Present only when `taskId` journaled the copy: the receipt's batch id, the unit
   *  `operations.revert(batchId)` rolls back. */
  receiptBatchId?: string
}

export type EntityTransformParams = (
  | { op: 'move'; handles: string[]; delta: Point3d }
  | { op: 'rotate'; handles: string[]; center: Point3d; angle: number }
  | { op: 'scale'; handles: string[]; center: Point3d; factor: number }
  | { op: 'mirror'; handles: string[]; axisStart: Point3d; axisEnd: Point3d; erase?: boolean }
  | { op: 'copy'; handles: string[]; delta: Point3d }
  | {
      op: 'arrayRect'
      handles: string[]
      rows: number
      columns: number
      rowSpacing: number
      columnSpacing: number
      angle?: number
    }
  | {
      op: 'arrayPolar'
      handles: string[]
      center: Point3d
      count: number
      fillAngle?: number
      rotateItems?: boolean
    }
  | {
      op: 'arrayPath'
      handles: string[]
      path: { handle: string } | { points: Point3d[] }
      count?: number
      spacing?: number
      align?: boolean
    }
) & { documentName?: string; view?: ViewOverride; idempotencyKey?: string }

export interface EntityTransformResult {
  affected: EntityRef[]
}

/**
 * Per-kind partial patch for `entity.update`'s `geometry` — every field optional (only given fields
 * change). Field names mirror `CreateEntityParams`'s matching kind exactly, minus whatever that
 * kind can't change in place: no vertex-count changes for `polyline` (only `closed` can flip —
 * adding/removing vertices is still erase+recreate territory), and no `rectangle` entry at all — a
 * created `rectangle` is reported back (entity.get/list/create's own result) as kind `"polyline"`
 * (AutoCAD has no native Rectangle entity), so there is never a stored entity whose real kind is
 * `rectangle` to patch. Changing an entity's `kind` itself is not supported — that's still
 * erase+recreate territory.
 */
export type EntityUpdateGeometry =
  | { kind: 'line'; start?: Point3d; end?: Point3d }
  | { kind: 'circle'; center?: Point3d; radius?: number }
  | { kind: 'arc'; center?: Point3d; radius?: number; startAngle?: number; endAngle?: number }
  | { kind: 'polyline'; closed?: boolean }
  | { kind: 'mtext'; insertion?: Point3d; text?: string; height?: number; width?: number }
  | {
      kind: 'text.singleLine'
      insertion?: Point3d
      text?: string
      height?: number
      rotation?: number
    }
  | {
      kind: 'blockReference'
      position?: Point3d
      scale?: Point3d
      rotation?: number
      attributes?: Record<string, string>
    }
  | {
      kind: 'dimension.linear'
      extLine1?: Point3d
      extLine2?: Point3d
      dimLinePoint?: Point3d
      dimText?: string
      rotation?: number
    }
  | {
      kind: 'dimension.aligned'
      extLine1?: Point3d
      extLine2?: Point3d
      dimLinePoint?: Point3d
      dimText?: string
    }
  | {
      kind: 'dimension.ordinate'
      origin?: Point3d
      featurePoint?: Point3d
      leaderEndPoint?: Point3d
    }
  | { kind: 'hatch'; pattern?: string; patternScale?: number; patternAngle?: number }

/**
 * `entity.update` (#26): in-place edit of an existing entity's common properties and/or
 * kind-specific geometry/content, keeping its handle stable — the alternative to erase+recreate for
 * everything short of changing an entity's kind. Common properties (`layer`/`color`
 * /`linetype`/`lineweight`) apply to any kind via the entity's base `Entity`/`DBObject` properties;
 * `geometry`'s `kind` must match the handle's actual current kind (read from the drawing, not
 * trusted from the caller) or the call fails with `InvalidGeometry` and the drawing is unchanged.
 * Every field — common and `geometry`'s — is optional; omitted fields keep their current value.
 */
export interface EntityUpdateParams {
  handle: string
  documentName?: string
  view?: ViewOverride
  layer?: string
  color?: ColorSpec
  linetype?: string
  lineweight?: number
  geometry?: EntityUpdateGeometry
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}

export interface EntityUpdateResult {
  entity: EntitySummary
}

// ---- view ------------------------------------------------------------------

export interface ViewZoomExtentsParams {
  documentName?: string
}
export type ViewZoomExtentsResult = Record<string, never>

/**
 * Renders a document's model space to a PNG off-screen so a caller can look at it. Read-only: the
 * on-screen view is untouched and a background tab is never activated. Framing, first match wins:
 * `window`, else the `handles`' extents, else the whole drawing.
 */
export interface ViewCaptureParams {
  /** Pixels; clamped to 64..2048 by the plugin. Default 1024x768. */
  width?: number
  height?: number
  /** Paper color — "white" (default; ACI 7 draws black on it) or "black". */
  background?: 'white' | 'black'
  /** World XY rectangle to show. */
  window?: { min: Point3d; max: Point3d }
  /** Frame on these entities (unresolvable handles are skipped). */
  handles?: string[]
  documentName?: string
}
export interface ViewCaptureResult {
  /** The document that was rendered (its full name), even when `documentName` was a short name. */
  documentName: string
  mimeType: 'image/png'
  width: number
  height: number
  /** Base64 PNG. */
  data: string
  fittedTo: 'window' | 'entities' | 'drawing'
  /** The world XY rectangle the image shows, so image pixels can be mapped back to coordinates. */
  window: { min: Point3d; max: Point3d }
}

/**
 * Live drafting mode (autocad-mcp#67): after each mutating call, when `follow != "off"`, the view
 * pans/fits toward whatever the call just drew/moved. Stored per document (plugin memory, like the
 * batch journal) — `view.getLive` reads it back, `view.setLive` merges the given fields over the
 * current (or default) settings and returns the effective result.
 */
export interface LiveViewSettings {
  /** "off" (today's behavior, default) | "fit" (frame with margin) | "pan" (keep height, recenter). */
  follow: 'off' | 'fit' | 'pan'
  /** Fraction of the affected extents added around it when fitting. Default 0.25. */
  margin: number
  /**
   * Never zoom the view closer than this height (drawing units) — avoids zooming into a tiny
   * detail.
   */
  minHeight: number | null
  /** Interpolate the view over ~8 frames (<=200ms) instead of jumping. Default true. */
  animate: boolean
  /** `operations.apply` repaints partway through a batch instead of only at the end. Default false. */
  progressive: boolean
  /** Extra delay (ms, 0..100) between progressive repaints. Default 0. */
  paceMs: number
}
export interface ViewSetLiveParams {
  follow?: 'off' | 'fit' | 'pan'
  margin?: number
  minHeight?: number
  animate?: boolean
  progressive?: boolean
  paceMs?: number
  documentName?: string
}
export type ViewSetLiveResult = LiveViewSettings

export interface ViewGetLiveParams {
  documentName?: string
}
export type ViewGetLiveResult = LiveViewSettings

/**
 * Explicit "look here" (autocad-mcp#67/#27/#63): first match wins — `window`, else the union of
 * `handles`' extents, else `center` + `height`. Always moves the view (no inside-with-margin no-op
 * check — that's `view.setLive` `follow`'s job after a mutation, not this).
 */
export interface ViewZoomParams {
  window?: { min: Point3d; max: Point3d }
  handles?: string[]
  center?: Point3d
  /**
   * View height in world/drawing units for `center` (e.g. millimetres). Deliberately not named
   * `height` — that name is also used elsewhere in this file for pixel image sizes (e.g.
   * `ViewCaptureParams.height`), and the MCP tool's portable JSON Schema flattens every
   * operation's fields into one object (see `portableSchema.ts`), so two operations sharing a
   * field name must share the same meaning/bounds or validation silently uses whichever
   * operation's schema it saw first.
   */
  viewHeight?: number
  documentName?: string
}
export interface ViewZoomResult {
  /** World-space center of the framed box. */
  center: Point3d
  /** The view's resulting height (drawing units). */
  height: number
}

// ---- operations --------------------------------------------------------

/**
 * One step of an `operations.apply` batch — reuses the same per-kind shapes entity.* uses. `id`
 * (#19) is a batch-local label other steps reference as `@id` wherever a handle is accepted
 * (`erase.handles`, `transform` handles/path, hatch `boundaryHandles`/`loops`); resolved entirely
 * server-side in `server` before the wire — the plugin only ever receives real handles, so this
 * field is never present in what's actually sent over JSON-RPC.
 */
export type EntityOperation =
  | { op: 'create'; entity: CreateEntityParams; id?: string }
  /** Erases CadAI-created entities by handle. User geometry is protected (ProtectedEntity). */
  | { op: 'erase'; handles: string[]; id?: string }
  | { op: 'transform'; transform: EntityTransformParams; id?: string }
  | {
      op: 'update'
      update: Omit<EntityUpdateParams, 'documentName' | 'idempotencyKey' | 'view'>
      id?: string
    }

export interface OperationsApplyParams {
  operations: EntityOperation[]
  documentName?: string
  taskId?: string
  /**
   * Fallback fields (#19) merged under each `create` step's own explicit fields, by `server` —
   * never sent as-is; every step in the wire payload already carries its effective `layer`.
   */
  defaults?: { layer?: string }
  view?: ViewOverride
  /**
   * Repaint partway through the batch instead of only at the end (autocad-mcp#67). Still one
   * transaction + one native undo group — atomicity is unchanged. Default false.
   */
  progressive?: boolean
  /**
   * Extra delay (ms, 0..100) between progressive repaints; hard-capped so the batch never adds more
   * than 3s total.
   */
  paceMs?: number
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
  /**
   * Native revision precondition (#413 phase A). When set, checked atomically against the
   * document's live revision before the FIRST phase's transaction starts — never on later phases
   * of the same call, since the batch's own earlier phases legitimately advance it. A mismatch
   * aborts with zero side effects: `status: 'requires_revalidation'`,
   * `error.code: RevisionConflict`. Optional and caller-supplied from a prior read (e.g.
   * `drawing.info`'s `revision`) — never a mandatory round trip or a model-facing ticket.
   */
  expectedRevision?: string
  /**
   * Per-entity write-set precondition (#413 phase B). Maps a handle this batch mutates
   * (erase/transform/update) to that entity's state digest from a prior read —
   * `entity.get` `detail: "full"`'s `stateDigest` (the PreImageCanonical digest of its
   * bounds-free detail). Inside the batch's transaction, each mapped handle's live digest is
   * recomputed; a mismatch SKIPS only that handle (zero mutation for it) and reports it in
   * `conflicts` — every other handle proceeds. Deliberately finer-grained than `expectedRevision`'s
   * all-or-nothing whole-document gate: a concurrent edit to one entity must not veto unrelated
   * writes elsewhere. Absent entry (or absent map) = caller opted out for that handle.
   */
  expectedState?: Record<string, string>
}
/**
 * One #413 phase B per-entity precondition miss: this handle was NOT mutated because its live
 * state digest differed from the caller's captured `expected` (`actual` is the live one).
 */
export interface StateConflict {
  handle: string
  expected: string
  actual: string
  reason: 'state_conflict'
}
export interface PhaseExecutionInfo {
  phase: number
  status: string
  batchId?: string
  entityCount: number
  error?: string
}

export interface OperationsApplyResult {
  /** Absent when status is "aborted" — nothing was recorded, 0 entities changed. */
  batchId?: string
  taskId?: string
  sequence?: number
  status:
    | 'committed'
    | 'aborted'
    | 'partial'
    | 'cancelled'
    | 'failed'
    | 'busy'
    | 'requires_revalidation'
    | 'outcome_unknown'
  entityRefs: EntityRef[]
  /**
   * Set when `status` is not committed. `code` is TransactionFailed or plugin error; `failedStep`
   * is the zero-based index of the step that threw and `causeCode` that step's own error code.
   */
  error?: { code: number; message: string; failedStep?: number | null; causeCode?: number | null }
  undo?:
    | { supported: true; mode: 'native-lifo'; state: 'top' }
    /** The batch ran on a non-active tab: atomic, but operations.undo/redo refuse it. */
    | { supported: false; mode: 'unsupported-background'; state: 'none' }
  executionId?: string
  partial?: boolean
  committedBatchIds?: string[]
  completedPhases?: number
  totalPhases?: number
  phases?: PhaseExecutionInfo[]
  /**
   * #413 phase B: handles SKIPPED because their live state digest didn't match the caller's
   * `expectedState` entry. Empty/absent when nothing was skipped. The batch still committed
   * everything else — `status` stays 'committed'; this reports the truthful partial skip.
   */
  conflicts?: StateConflict[]
}

export interface OperationsPreviewParams {
  operations: EntityOperation[]
  documentName?: string
  taskId?: string
  defaults?: { layer?: string }
}

export interface OperationsPreviewResult {
  valid: boolean
  operationCount: number
  entityRefs: EntityRef[]
  extents?: {
    min: { x: number; y: number; z: number }
    max: { x: number; y: number; z: number }
  }
  error?: { code: number; message: string; failedStep?: number | null; causeCode?: number | null }
}
export interface OperationsRevertParams {
  batchId?: string
  taskId?: string
  documentName?: string
}

export interface OperationsRevertResult {
  status: 'reverted'
  batchId?: string
  taskId?: string
  revertedChangeSetsCount: number
  erasedHandles: string[]
  recreatedHandles: string[]
  restoredHandles: string[]
}
export interface OperationsUndoParams {
  batchId: string
  documentName?: string
  /**
   * See `CreateEntityParams`'s field of the same name (#9). Shared by
   * `operations.undo`/`operations.redo`.
   */
  idempotencyKey?: string
}
export interface OperationsUndoResult {
  batchId: string
  status: 'undone' | 'redone'
}

export interface OperationsHistoryParams {
  limit?: number
  documentName?: string
  taskId?: string
}
export interface BatchJournalEntrySummary {
  batchId: string
  taskId?: string
  sequence: number
  operationCount: number
  entityRefs: EntityRef[]
  status: string
}
export interface OperationsHistoryResult {
  batches: BatchJournalEntrySummary[]
}
// ---- style -----------------------------------------------------------------

export interface LinetypeInfo {
  name: string
  description: string
}

export interface StyleLinetypesListParams {
  documentName?: string
}
export interface StyleLinetypesListResult {
  linetypes: LinetypeInfo[]
}

export interface StyleLinetypesLoadParams {
  names: string[]
  /** Defaults to "acadiso.lin". */
  file?: string
  documentName?: string
}
export interface StyleLinetypesLoadResult {
  /** Names actually loaded by this call (were not already present). */
  loaded: string[]
  /** Names that were already loaded — a no-op, not an error. */
  alreadyLoaded: string[]
}

export interface TextStyleInfo {
  name: string
  font: string
  /** 0 = variable height. */
  height: number
  widthFactor: number
  /** Radians. */
  obliqueAngle: number
  isCurrent: boolean
  /** True when created/read as a real TrueType face rather than an SHX file. */
  isTrueType: boolean
  /** TrueType typeface name (e.g. "Arial"); undefined for SHX-based styles. */
  typeface?: string
  bold: boolean
  italic: boolean
  /** Windows LOGFONT charset; 163 = Vietnamese, 0 = ANSI (default). */
  charSet: number
  pitchAndFamily: number
}

export interface StyleTextStylesListParams {
  documentName?: string
}
export interface StyleTextStylesListResult {
  textStyles: TextStyleInfo[]
}

export interface StyleTextStylesCreateParams {
  name: string
  font: string
  height: number
  widthFactor: number
  obliqueAngle: number
  /** Update the existing style instead of erroring when `name` is already taken. */
  update?: boolean
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
  /**
   * Real TrueType typeface name (e.g. "Arial"). When set, `font` is ignored and the style is
   * created via `TextStyleTableRecord.Font` instead of an SHX file path — required for reliable
   * Vietnamese/Unicode rendering (#1 in source-limitations.md).
   */
  trueTypeFace?: string
  bold?: boolean
  italic?: boolean
  /** Windows LOGFONT charset; 163 = Vietnamese, 0 = ANSI (default). */
  charSet?: number
  /** Windows LOGFONT pitch-and-family; defaults to 34 (VARIABLE_PITCH | FF_SWISS). */
  pitchAndFamily?: number
}
export interface StyleTextStylesCreateResult {
  textStyle: TextStyleInfo
  created: boolean
}

export interface StyleTextStylesSetCurrentParams {
  name: string
  documentName?: string
}
export type StyleTextStylesSetCurrentResult = Record<string, never>

/**
 * A small, documented subset of DIMxxx variables — set on the style record itself, not as a
 * database override.
 */
export interface DimStyleInfo {
  name: string
  textHeight: number
  arrowSize: number
  extensionOffset: number
  extensionBeyond: number
  decimalPlaces: number
  unitsFormat: 'decimal' | 'architectural' | 'engineering'
  scale: number
  isCurrent: boolean
}

export interface StyleDimStylesListParams {
  documentName?: string
}
export interface StyleDimStylesListResult {
  dimStyles: DimStyleInfo[]
}

export interface StyleDimStylesCreateParams {
  name: string
  /** Seeds unset fields from this existing style; defaults to "Standard" when absent. */
  basedOn?: string
  textHeight: number
  arrowSize: number
  extensionOffset: number
  extensionBeyond: number
  decimalPlaces: number
  unitsFormat: 'decimal' | 'architectural' | 'engineering'
  scale: number
  /** Update the existing style instead of erroring when `name` is already taken. */
  update?: boolean
  documentName?: string
  /** See `CreateEntityParams`'s field of the same name (#9). */
  idempotencyKey?: string
}
export interface StyleDimStylesCreateResult {
  dimStyle: DimStyleInfo
  created: boolean
}

export interface StyleDimStylesSetCurrentParams {
  name: string
  documentName?: string
}
export type StyleDimStylesSetCurrentResult = Record<string, never>

// ---- block -----------------------------------------------------------------

export interface BlockInspectParams {
  blockName?: string
  handle?: string
  documentName?: string
  /**
   * Census the definition's own entities. Off by default so `block.list` (one result per
   * definition) does not walk every definition's contents.
   */
  includeContents?: boolean
}

/** One text-bearing entity inside a block definition, in the definition's local coordinates. */
export interface BlockText {
  text: string
  kind: 'dbText' | 'mtext' | 'attributeDefinition' | 'attributeReference'
  layer: string
  localPosition: [number, number]
}

/**
 * What a block definition actually holds: entity-kind counts, the text inside it, and the definitions
 * it references one level down. This is the read that settles whether a plan's room labels live inside
 * the merged block at all, and in which entity type — instead of guessing from the instance bbox.
 */
export interface BlockContents {
  entityCount: number
  kinds: string[]
  texts: BlockText[]
  nestedBlocks: string[]
  truncated: boolean
}

export interface BlockInspectResult {
  name: string
  explodable: boolean
  isDynamic: boolean
  isAnonymous: boolean
  isLayout: boolean
  isXref: boolean
  description?: string
  referenceCount?: number
  handle?: string
  layer?: string
  layerLocked?: boolean
  contents?: BlockContents
  /**
   * ATTRIB entities attached to the resolved insertion, in WORLD coordinates — a definition walk can
   * never see these. Only present with `includeContents` and only for a handle-resolved request.
   */
  instanceAttributes?: BlockText[]
}

export interface BlockSetExplodableParams {
  blockName?: string
  handle?: string
  explodable: boolean
  sharedScope?: boolean
  documentName?: string
  idempotencyKey?: string
}

export interface BlockSetExplodableResult {
  success: boolean
  blockName: string
  previousExplodable: boolean
  explodable: boolean
  changed: boolean
  affectedReferenceCount: number
}
export interface BlockListParams {
  documentName?: string
  includeAnonymous?: boolean
  includeLayouts?: boolean
  includeXrefs?: boolean
}

export interface BlockListResult {
  blocks: BlockInspectResult[]
}
export interface BlockExplodeParams {
  handle: string
  documentName?: string
}

export interface BlockExplodeResult {
  success: boolean
  handle: string
  blockName: string
  explodedCount: number
  explodedHandles: string[]
}

export interface BlockUniquifyParams {
  handle: string
  newName?: string
  documentName?: string
  idempotencyKey?: string
}

export interface BlockUniquifyResult {
  success: boolean
  handle: string
  originalDefinitionName: string
  newDefinitionName: string
  referenceCountBefore: number
  referenceCountAfter: number
}

/**
 * `block.ensureDefinition` (Slice 06 of specs/pccc-cad-drawing-truth/) — builds a `BlockTableRecord`
 * directly from `entities` when `blockName` does not already exist in this drawing. No source DWG
 * ever opens: this is the zero-config path a workspace with no symbol library file gets by default,
 * and the path a `cad_symbol_catalog` row with `geometryJson` resolves through. Idempotent: an
 * existing definition of that name is left untouched and its handle is returned as-is.
 */
export interface BlockEnsureDefinitionParams {
  documentName?: string
  blockName: string
  /** Entities in the block's own local coordinates — the same per-kind shapes `entity.create`
   * accepts (`CreateEntityParams`), minus the wrapper fields that only make sense in model space
   * (`documentName`/`view`/`idempotencyKey` are ignored if present on an entry). */
  entities: CreateEntityParams[]
}
export interface BlockEnsureDefinitionResult {
  /** `false` when `blockName` already existed — `entities` was never applied. */
  created: boolean
  handle: string
}
// ---- CAD State Engine (cad.scan / cad.changes) ----------------------------

/**
 * `cad.scan` — a bounded, paginated read-only inventory pass the Cloud CAD State Engine drives to
 * build a drawing snapshot in ONE coordinated scan instead of the model paging `entity.list`/
 * `entity.get` dozens of times. The plugin walks the selected space once per page (offset/limit), returning
 * compact per-entity rows plus a manifest; `revisionBefore`/`revisionAfter` bracket the page so the
 * Cloud side can detect a mid-scan edit and discard an inconsistent snapshot rather than commit it.
 *
 * Read-only, never activates a tab (autocad-mcp#68 invariant). `detail` mirrors `entity.list`'s
 * summary/full choice: `summary` is handle/kind/layer/bounds (cheap, the default for a whole-drawing
 * scan); `full` adds geometry + common properties for the entities in that page.
 */
export interface CadScanParams {
  documentName?: string
  /** Exact layout tab to scan; omitted or "Model" scans model space. */
  layoutName?: string
  /** Page window over the selected space. First page: offset 0. */
  offset?: number
  limit?: number
  detail?: 'summary' | 'full'
  /** Optional scope: only entities on these layers / of these kinds are counted and paged. */
  layer?: string
  kind?: EntityKind
  handles?: string[]
}

/** One scanned entity row — the shape the Cloud entity index stores. */
export interface CadScanEntity {
  handle: string
  kind: EntityKind
  layer: string
  /** Set for a blockReference: the referenced block's name. */
  blockName?: string
  /** MTEXT/DBText content, or a block reference's non-empty attribute values joined — the text
   * the index makes searchable. Bounded by the plugin (capped length). */
  text?: string
  bounds?: { min: Point3d; max: Point3d }
  /** Present only when `detail: "full"` — the same per-kind geometry `entity.list` full returns. */
  geometry?: Record<string, unknown>
  properties?: EntityCommonProperties
}

export interface CadScanResult {
  documentId: string
  name: string
  path: string | null
  /** Model or paper-space layout whose entities were scanned. */
  layoutName?: string
  /** `Database.FingerprintGuid` (hex, no braces) when the AutoCAD version exposes it — the
   * drawing's lineage identity. Null on builds/paths where it is unavailable; the Cloud side then
   * falls back to path/name identity and marks the drawing ephemeral. */
  fingerprintGuid: string | null
  /** Revision read BEFORE the page was walked (`tdu:…;saves:…`). */
  revisionBefore: string
  /** Revision read AFTER the page was walked. Equal to `revisionBefore` ⇒ the page is internally
   * consistent; different ⇒ the drawing moved mid-page and the Cloud side must not commit it. */
  revisionAfter: string
  insUnits: InsUnits
  /** Total selected-space entities matching the scope (the page-count denominator). */
  total: number
  offset: number
  /** True when more pages follow after this one. */
  hasMore: boolean
  entities: CadScanEntity[]
  /** Layer inventory (name + selected-space count), returned on the first page only (offset 0) —
   * the coverage manifest's `layers` scope. */
  layers?: Array<{ name: string; count: number }>
  /** Attached xref/overlay inventory, first page only — the `xrefs` coverage scope. */
  xrefs?: Array<{
    name: string
    status: 'resolved' | 'unloaded' | 'unreferenced' | 'fileNotFound' | 'unresolved'
  }>
  /** Layout inventory, first page only — the `paperSpace` coverage scope (names; contents not scanned). */
  layouts?: Array<{ name: string; isModel: boolean }>
}

/**
 * `cad.changes` — the incremental-sync feed. The plugin's ChangeTracker records entity handles
 * touched by AutoCAD's own database events (append/modify/erase) and command boundaries, coalesced
 * per document into a monotonic sequence. Cloud asks for everything after its cursor; a gap
 * (`earliestSequence > cursor + 1`) tells Cloud the plugin dropped events, so it reconciles rather
 * than trusting a partial delta. Read-only; never performs the network work inside the event
 * handler itself (the tracker only enqueues handles).
 */
export interface CadChangesParams {
  documentName?: string
  /** Return changes with sequence strictly greater than this. */
  afterSequence: number
  limit?: number
}

export type CadChangeOperation =
  'created' | 'modified' | 'erased' | 'metadata_changed' | 'dependency_invalidated'

export interface CadChangeEvent {
  sequence: number
  operation: CadChangeOperation
  handles: string[]
  /** The full re-read row for a created/modified handle (bounded), so Cloud can index the delta
   * without a second `entity.get` per handle. Absent for erased. */
  entity?: CadScanEntity
  entities?: CadScanEntity[]
  timestamp: number
  /** The command touched more handles than the event may carry; `handles` is the first N only.
   * Cloud MUST treat the affected scope as unverified and reconcile — never a complete batch. */
  truncated?: boolean
}

export interface CadChangesResult {
  documentId: string
  /** The plugin's current revision for this document. */
  revision: string
  /** Feed epoch: changes on plugin reload / close-reopen while the sequence restarts. A cursor
   * above `latestSequence` is a reset only when the generation changed; without it, a coincidental
   * sequence number could look like a normal continuation. */
  generation?: string
  /** Lowest sequence the plugin still holds (0 when it has none). `earliestSequence > afterSequence + 1`
   * ⇒ events were dropped: Cloud must reconcile, not apply a partial delta. */
  earliestSequence: number
  /** Highest sequence the plugin has recorded. */
  latestSequence: number
  changes: CadChangeEvent[]
  hasMore: boolean
}

/** Maps each method name to its params/result pair, for a typed RPC client. */
export interface RpcMethodMap {
  [RpcMethod.SystemStatus]: { params: SystemStatusParams; result: SystemStatusResult }
  [RpcMethod.DrawingInspectFloorplan]: {
    params: InspectFloorplanParams
    result: InspectFloorplanResult
  }
  [RpcMethod.DrawingInfo]: { params: DrawingInfoParams; result: DrawingInfoResult }
  [RpcMethod.DrawingSummary]: { params: DrawingSummaryParams; result: DrawingSummaryResult }
  [RpcMethod.DrawingSave]: { params: DrawingSaveParams; result: DrawingSaveResult }
  [RpcMethod.DrawingListOpen]: { params: DrawingListOpenParams; result: DrawingListOpenResult }
  [RpcMethod.DrawingOpen]: { params: DrawingOpenParams; result: DrawingOpenResult }
  [RpcMethod.DrawingNew]: { params: DrawingNewParams; result: DrawingNewResult }
  [RpcMethod.DrawingClose]: { params: DrawingCloseParams; result: DrawingCloseResult }
  [RpcMethod.DrawingActivate]: { params: DrawingActivateParams; result: DrawingActivateResult }
  [RpcMethod.DrawingSetup]: { params: DrawingSetupParams; result: DrawingSetupResult }
  [RpcMethod.DrawingCheck]: { params: DrawingCheckParams; result: DrawingCheckResult }
  [RpcMethod.DrawingCleanup]: { params: DrawingCleanupParams; result: DrawingCleanupResult }
  [RpcMethod.LayerList]: { params: LayerListParams; result: LayerListResult }
  [RpcMethod.LayerCreate]: { params: LayerCreateParams; result: LayerCreateResult }
  [RpcMethod.LayerSetCurrent]: { params: LayerSetCurrentParams; result: LayerSetCurrentResult }
  [RpcMethod.LayerSetProperties]: {
    params: LayerSetPropertiesParams
    result: LayerSetPropertiesResult
  }
  [RpcMethod.LayerEnsure]: { params: LayerEnsureParams; result: LayerEnsureResult }
  [RpcMethod.LayerRename]: { params: LayerRenameParams; result: LayerRenameResult }
  [RpcMethod.LayerDelete]: { params: LayerDeleteParams; result: LayerDeleteResult }
  [RpcMethod.EntityCreate]: { params: CreateEntityParams; result: EntityCreateResult }
  [RpcMethod.EntityList]: { params: EntityListParams; result: EntityListResult }
  [RpcMethod.EntityGet]: { params: EntityGetParams; result: EntityGetResult }
  [RpcMethod.EntityAreaMeasure]: {
    params: EntityAreaMeasureParams
    result: EntityAreaMeasureResult
  }
  [RpcMethod.EntityTraceBoundary]: {
    params: EntityTraceBoundaryParams
    result: EntityTraceBoundaryResult
  }
  [RpcMethod.EntityErase]: { params: EntityEraseParams; result: EntityEraseResult }
  [RpcMethod.EntityCopyTo]: { params: EntityCopyToParams; result: EntityCopyToResult }
  [RpcMethod.EntityTransform]: { params: EntityTransformParams; result: EntityTransformResult }
  [RpcMethod.EntityUpdate]: { params: EntityUpdateParams; result: EntityUpdateResult }
  [RpcMethod.ViewZoomExtents]: { params: ViewZoomExtentsParams; result: ViewZoomExtentsResult }
  [RpcMethod.ViewCapture]: { params: ViewCaptureParams; result: ViewCaptureResult }
  [RpcMethod.ViewSetLive]: { params: ViewSetLiveParams; result: ViewSetLiveResult }
  [RpcMethod.ViewGetLive]: { params: ViewGetLiveParams; result: ViewGetLiveResult }
  [RpcMethod.ViewZoom]: { params: ViewZoomParams; result: ViewZoomResult }
  [RpcMethod.OperationsApply]: { params: OperationsApplyParams; result: OperationsApplyResult }
  [RpcMethod.OperationsPreview]: {
    params: OperationsPreviewParams
    result: OperationsPreviewResult
  }
  [RpcMethod.OperationsRevert]: {
    params: OperationsRevertParams
    result: OperationsRevertResult
  }
  [RpcMethod.OperationsUndo]: { params: OperationsUndoParams; result: OperationsUndoResult }
  [RpcMethod.OperationsRedo]: { params: OperationsUndoParams; result: OperationsUndoResult }
  [RpcMethod.OperationsHistory]: {
    params: OperationsHistoryParams
    result: OperationsHistoryResult
  }
  [RpcMethod.StyleLinetypesList]: {
    params: StyleLinetypesListParams
    result: StyleLinetypesListResult
  }
  [RpcMethod.StyleLinetypesLoad]: {
    params: StyleLinetypesLoadParams
    result: StyleLinetypesLoadResult
  }
  [RpcMethod.StyleTextStylesList]: {
    params: StyleTextStylesListParams
    result: StyleTextStylesListResult
  }
  [RpcMethod.StyleTextStylesCreate]: {
    params: StyleTextStylesCreateParams
    result: StyleTextStylesCreateResult
  }
  [RpcMethod.StyleTextStylesSetCurrent]: {
    params: StyleTextStylesSetCurrentParams
    result: StyleTextStylesSetCurrentResult
  }
  [RpcMethod.StyleDimStylesList]: {
    params: StyleDimStylesListParams
    result: StyleDimStylesListResult
  }
  [RpcMethod.StyleDimStylesCreate]: {
    params: StyleDimStylesCreateParams
    result: StyleDimStylesCreateResult
  }
  [RpcMethod.StyleDimStylesSetCurrent]: {
    params: StyleDimStylesSetCurrentParams
    result: StyleDimStylesSetCurrentResult
  }
  [RpcMethod.BlockInspect]: { params: BlockInspectParams; result: BlockInspectResult }
  [RpcMethod.BlockSetExplodable]: {
    params: BlockSetExplodableParams
    result: BlockSetExplodableResult
  }
  [RpcMethod.BlockList]: { params: BlockListParams; result: BlockListResult }
  [RpcMethod.BlockExplode]: { params: BlockExplodeParams; result: BlockExplodeResult }
  [RpcMethod.BlockUniquify]: { params: BlockUniquifyParams; result: BlockUniquifyResult }
  [RpcMethod.BlockEnsureDefinition]: {
    params: BlockEnsureDefinitionParams
    result: BlockEnsureDefinitionResult
  }
  [RpcMethod.CadScan]: { params: CadScanParams; result: CadScanResult }
  [RpcMethod.CadChanges]: { params: CadChangesParams; result: CadChangesResult }
  [RpcMethod.EditBegin]: { params: EditBeginParams; result: EditBeginResult }
  [RpcMethod.EditApply]: { params: EditApplyParams; result: EditApplyResult }
  [RpcMethod.EditPreview]: { params: EditPreviewParams; result: EditPreviewResult }
  [RpcMethod.EditStatus]: { params: EditStatusParams; result: EditStatusResult }
  [RpcMethod.EditDiscard]: { params: EditDiscardParams; result: EditDiscardResult }
  [RpcMethod.EditAccept]: { params: EditAcceptParams; result: EditAcceptResult }
}
