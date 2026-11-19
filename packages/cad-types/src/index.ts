/**
 * Shared geometry/entity shapes for the AutoCAD MCP local IPC layer. Mirrors `plugin/src/Dto/*.cs`
 * and `docs/PROTOCOL.md` — keep the three in sync when changing a shape.
 */

export interface Point3d {
  x: number
  y: number
  z: number
}

/** ACI (AutoCAD Color Index 0-256) or explicit true color. Exactly one set. */
export type ColorSpec = { aci: number } | { rgb: { r: number; g: number; b: number } }

export type EntityKind =
  | 'line'
  | 'circle'
  | 'arc'
  | 'polyline'
  | 'rectangle'
  | 'mtext'
  | 'blockReference'
  | 'text.singleLine'
  | 'dimension.linear'
  | 'dimension.aligned'
  | 'dimension.ordinate'
  | 'hatch'
  /**
   * Any CLR entity type `EntityKindResolver.KindOf` doesn't otherwise name (`Spline`, `Ellipse`,
   * `DBPoint`, `Leader`, `MLeader`, `Table`, `Solid3d`, `Region`, `Xline`, `Ray`,
   * `Polyline2d`/`Polyline3d`, `RadialDimension`, `DiametricDimension`, an angular/arc-length
   * dimension, `AttributeDefinition`, `Wipeout`, `RasterImage`, `Face`, …) — carries `dxfName`
   * (`ObjectId.ObjectClass.DxfName`) in its `EntityDetail.geometry` so a caller at least knows what
   * it's looking at, instead of the old "unknown" string that wasn't even part of this union.
   */
  | 'other'

export interface EntityRef {
  /** AutoCAD entity handle, hex string (e.g. "2A4"), stable across the session. */
  handle: string
  kind: EntityKind
  layer: string
}

export interface EntitySummary extends EntityRef {
  /** Bounding box in WCS, absent for entities AutoCAD can't extent (rare). */
  bounds?: { min: Point3d; max: Point3d }
}

/**
 * Common entity properties beyond `layer` (#25) — every kind has all of these.
 * `color`/`linetype`/`lineweight` are `ByLayer`/`ByBlock`-aware: AutoCAD represents "ByLayer" as
 * ACI 256 and "ByBlock" as ACI 0 for `color` (same convention `ColorSpec` already uses everywhere
 * else), the literal string `"ByLayer"`/`"ByBlock"` for `linetype`, and the
 * `LineWeight.ByLayer`/`ByBlock` enum's raw values (-1/-2) for `lineweight`.
 */
export interface EntityCommonProperties {
  color: ColorSpec
  linetype: string
  linetypeScale: number
  lineweight: number
  /**
   * 0 (fully transparent) – 100 (opaque); omitted when ByLayer (no per-entity override, the common
   * case).
   */
  transparency?: number
  visible: boolean
}

/**
 * One `polyline` vertex (#25). `bulge`/`startWidth`/`endWidth` are omitted when 0 (straight
 * segment, no width).
 */
export interface PolylineVertex {
  point: Point3d
  bulge?: number
  startWidth?: number
  endWidth?: number
}

/** `EntityDetail`'s `kind`-specific `geometry` shape — see `EntityDetail` below. */
interface EntityDetailOf<K extends EntityKind, G> extends EntityRef {
  kind: K
  /**
   * Bounding box in WCS, absent for entities AutoCAD can't extent (rare) — same as
   * `EntitySummary.bounds`.
   */
  bounds?: { min: Point3d; max: Point3d }
  properties: EntityCommonProperties
  geometry: G
}

/**
 * `entity.get`/`entity.list`'s `detail: "full"` response (#25): `EntitySummary` plus the entity's
 * actual geometry and common properties, discriminated by `kind` — mirrors `CreateEntityParams`'s
 * discriminated-union shape. A created `rectangle` always reads back as `kind: "polyline"` (no
 * native AutoCAD Rectangle entity, see `EntityKindResolver.cs`), so there is no `"rectangle"`
 * variant here. `dimension.*`'s `measurement` is `Dimension.Measurement` — the actual computed
 * value, not an echo of the create-time points.
 */
export type EntityDetail =
  | EntityDetailOf<'line', { start: Point3d; end: Point3d; length: number }>
  | EntityDetailOf<'circle', { center: Point3d; radius: number }>
  | EntityDetailOf<'arc', { center: Point3d; radius: number; startAngle: number; endAngle: number }>
  | EntityDetailOf<
      'polyline',
      { vertices: PolylineVertex[]; closed: boolean; length: number; area?: number }
    >
  | EntityDetailOf<
      'mtext',
      {
        insertion: Point3d
        text: string
        height: number
        rotation: number
        width?: number
        style: string
      }
    >
  | EntityDetailOf<
      'text.singleLine',
      {
        insertion: Point3d
        text: string
        height: number
        rotation: number
        style: string
        widthFactor?: number
      }
    >
  | EntityDetailOf<
      'blockReference',
      {
        blockName: string
        position: Point3d
        scale: Point3d
        rotation: number
        attributes?: Record<string, string>
        nestedGeometry?: {
          entities: {
            kind: string
            geometry: unknown
          }[]
          truncated: boolean
          isXref: boolean
        }
      }
    >
  | EntityDetailOf<
      'dimension.linear',
      {
        extLine1: Point3d
        extLine2: Point3d
        dimLinePoint: Point3d
        rotation: number
        measurement: number
        text: string
      }
    >
  | EntityDetailOf<
      'dimension.aligned',
      {
        extLine1: Point3d
        extLine2: Point3d
        dimLinePoint: Point3d
        measurement: number
        text: string
      }
    >
  | EntityDetailOf<
      'dimension.ordinate',
      {
        origin: Point3d
        featurePoint: Point3d
        leaderEndPoint: Point3d
        axis: 'x' | 'y'
        measurement: number
        text: string
      }
    >
  | EntityDetailOf<
      'hatch',
      {
        pattern: string
        patternScale: number
        patternAngle: number
        associative: boolean
        loopCount: number
        /**
         * `HatchLoopTypes` flags per loop (e.g. `"Outermost"`, `"Default"`), index-aligned with the
         * loops themselves — never a full vertex dump.
         */
        loopTypes: string[]
        area?: number
        boundaryLoops?: {
          loopType: string
          area?: number
          closed: boolean
          vertices: Point3d[]
        }[]
        truncated?: boolean
      }
    >
  | EntityDetailOf<'other', { dxfName: string }>

export interface LayerInfo {
  name: string
  color: ColorSpec
  linetype: string
  lineweight: number
  frozen: boolean
  locked: boolean
  plottable: boolean
  on: boolean
  isCurrent: boolean
}

export interface DrawingInfo {
  /** Stable while the tab is open (survives SAVEAS); pass it as `documentName` to pin this tab. */
  documentId: string
  name: string
  path: string | null
  entityCount: number
  layerCount: number
  /**
   * Null when this document isn't the active tab — AutoCAD's DBMOD only reflects the active
   * document's context.
   */
  modified: boolean | null
  /**
   * Current `CANNOSCALE` (`Database.Cannoscale.Name`, e.g. `"1:100"`), set via `drawing.setup`'s
   * `annotationScale` (#74).
   */
  annotationScale?: string
  /**
   * Coarse drawing revision (`Database.Tduupdate.Ticks` + `NumberOfSaves`), which moves on any
   * mutation or save. Unlike `modified` (DBMOD, active-document-only) this is a per-database
   * property, so it is reportable for a background tab too. Aleph Cloud binds a spatial-validation
   * record to it: a validated batch whose drawing revision has moved is refused rather than drawn
   * against geometry that no longer matches what was checked.
   */
  revision?: string
  /**
   * `Database.FingerprintGuid` (hex, no braces) — the drawing's LINEAGE identity: it survives
   * SAVEAS, file copy, and close/reopen, unlike `documentId` (per-tab) or `path` (a moved file).
   * The CAD State Engine keys its cross-session registry on it. Null when the AutoCAD generation
   * doesn't expose it or the database has none yet (a brand-new unsaved drawing).
   */
  fingerprintGuid?: string | null
}

/**
 * One entry from `drawing.listOpen` — every document currently open in this AutoCAD process (MDI
 * tabs), not just the active one. `modified` is only knowable for the active document (AutoCAD's
 * DBMOD system variable reflects only the current document context) — `null` for every background
 * document, not a false "unmodified" claim.
 */
export interface OpenDocumentInfo {
  /** Stable while the tab is open (survives SAVEAS); accepted anywhere `documentName` is. */
  documentId: string
  name: string
  path: string | null
  isActive: boolean
  modified: boolean | null
}

/**
 * `system.status` result. `processId` lets bridge derive this instance's `instanceId`
 * ("acad_{processId}") without a second round trip.
 */
export interface AutoCadPluginStatus {
  processId: number
  pluginVersion: string
  autocadVersion: string
  activeDocument: string | null
  pipeUptimeSeconds: number
  /**
   * The AutoCAD managed-runtime generation this instance's plugin was loaded from
   * (`net48` / `net8.0-windows` / `net10.0-windows`) — pairs with the Bridge's `health.json`
   * `bundleGenerations` to name a runtime mismatch instead of a missing pipe (aleph-platform#332).
   * Absent on a plugin built before #332, which never sends the field.
   */
  runtimeGeneration?: string
  supports?: {
    blockUniquify?: boolean
  }
}
