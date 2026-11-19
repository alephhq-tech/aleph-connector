import type {
  CadScanEntity,
  CreateEntityParams,
  DimStyleInfo,
  DrawingCheckFinding,
  DrawingCheckKind,
  DrawingCheckScope,
  DrawingCleanupApplied,
  DrawingCleanupFixKind,
  DrawingCleanupResult,
  DrawingSetupResult,
  LinetypeInfo,
  LiveViewSettings,
  RpcMethodMap,
  RpcMethodName,
  StyleDimStylesCreateParams,
  StyleTextStylesCreateParams,
  TextStyleInfo,
  EntityPreImage,
  EntityDiff,
  EditDiffResult,
  StateConflict,
  BoundaryLoop
} from '@arcdio/cad-protocol'
import {
  MAX_ARRAY_COPIES,
  sampleByCount,
  sampleBySpacing,
  segmentsFromArc,
  segmentsFromLine,
  segmentsFromPoints,
  segmentsFromPolyline
} from '@arcdio/cad-tools'
import {
  BridgeErrorCode,
  BridgeRpcError,
  DRAWING_CHECK_KINDS,
  RpcMethod
} from '@arcdio/cad-protocol'
import type {
  ColorSpec,
  EntityCommonProperties,
  EntityDetail,
  EntitySummary,
  LayerInfo,
  Point3d,
  PolylineVertex,
  EntityRef
} from '@arcdio/cad-types'
import { randomUUID } from 'node:crypto'
import { win32 as winPath } from 'node:path'
// Same canonicalization the design guard binds its validation records to, and the same one the C#
// plugin's `IdempotencyCache` mirrors — so "same parameters" has exactly one definition.
import { hashCanonical } from '@arcdio/engineering'
import type { BridgeClient, BridgeRequestOptions } from './BridgeClient.js'

/**
 * TS mirror of the plugin's `Util/SavePathValidator.cs` (aleph-platform#5) — so `bun run smoke`
 * exercises `PathNotAllowed`/`FileExists` without a real AutoCAD. `win32` explicitly: the plugin
 * always runs on Windows, and this mock otherwise runs on whatever OS CI uses.
 */
function validateSavePath(requestedPath: string, currentDrawingDirectory: string | null): string {
  if (requestedPath.startsWith('\\\\') || requestedPath.startsWith('//')) {
    throw new BridgeRpcError(
      BridgeErrorCode.PathNotAllowed,
      `Can't save to "${requestedPath}": UNC and device paths are not allowed. Pass an absolute .dwg path inside this drawing's own folder.`
    )
  }
  if (!winPath.isAbsolute(requestedPath)) {
    throw new BridgeRpcError(
      BridgeErrorCode.PathNotAllowed,
      `Can't save to "${requestedPath}": the path must be absolute. Pass an absolute .dwg path inside this drawing's own folder.`
    )
  }
  const full = winPath.normalize(requestedPath)
  if (!full.toLowerCase().endsWith('.dwg')) {
    throw new BridgeRpcError(
      BridgeErrorCode.PathNotAllowed,
      `Can't save to "${requestedPath}": the path must end in ".dwg". Pass an absolute .dwg path inside this drawing's own folder.`
    )
  }
  // No prior project folder to hold a brand-new (never-saved) drawing to — see
  // `SavePathValidator.cs`'s doc comment for why that's not itself a hole.
  if (!currentDrawingDirectory) return full

  const allowedRoot = winPath.normalize(currentDrawingDirectory).replace(/[\\/]+$/, '')
  const fullDir = winPath.dirname(full).replace(/[\\/]+$/, '')
  if (fullDir.toLowerCase() !== allowedRoot.toLowerCase()) {
    throw new BridgeRpcError(
      BridgeErrorCode.PathNotAllowed,
      `Can't save to "${requestedPath}": the path must be inside this drawing's own folder. Pass an absolute .dwg path inside this drawing's own folder.`
    )
  }
  return full
}

/** One coalesced change event — the mock's mirror of the plugin's `DocumentTracker.ChangeRecord`. */
interface MockChangeEvent {
  sequence: number
  operation: 'created' | 'modified' | 'erased' | 'metadata_changed' | 'dependency_invalidated'
  handles: string[]
  timestamp: number
  truncated: boolean
}

/** Mirrors `ChangeTracker.MaxEventsPerDocument` — past this the oldest events drop. */
const MAX_CHANGE_EVENTS = 2000

/** Mirrors `ChangeTracker.MaxHandlesPerEvent` — one event never ships more handles than this. */
const MAX_HANDLES_PER_CHANGE_EVENT = 500

/**
 * Deterministic stand-in for `Database.FingerprintGuid`: a 32-hex string derived from the file
 * name, stable across open/save/close-reopen of the same path (AutoCAD's fingerprint survives
 * SAVEAS and copy, which is why the Cloud engine treats it as the strongest identity signal).
 * Not cryptographic — it only has to be stable and distinct per drawing name.
 */
function fingerprintFor(fileName: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < fileName.length; i++) {
    const c = fileName.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return (
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0') +
    fileName.length.toString(16).padStart(8, '0')
  )
}

type MockModifiedEntity = {
  handle: string
  entity: EntitySummary
  geometry?: CreateEntityParams
  style?: { color?: ColorSpec; linetype?: string; lineweight?: number }
}

interface MockBatchEntry {
  batchId: string
  taskId?: string
  sequence: number
  entityRefs: EntitySummary[]
  createdHandles?: string[]
  erasedEntities?: EntitySummary[]
  modifiedBefore?: MockModifiedEntity[]
  modifiedAfter?: MockModifiedEntity[]
  status: 'committed' | 'undone' | 'reverted'
  /** #413 §11.5: a journaled copy_to writes a compensating-erase RECEIPT (revert-able) that is NOT
   * on the native undo stack — a cross-document clone has no undo group, and if it sat at the top it
   * would hijack operations.undo of the apply batch that follows (#388). Default true. */
  undoEligible?: boolean
}

/** Mirrors the plugin's MaxListLimit and contracts/mcp-tools's entityListParams.limit.max() (#10). */
const MAX_ENTITY_LIST_LIMIT = 1000

/** Mirrors `CadStateHandlers.DefaultScanLimit` — `cad.scan`'s page size when none is given. */
const DEFAULT_SCAN_LIMIT = 500

/**
 * Per-document, bounded, LRU idempotency-key -> result map (#9) — mirrors the real plugin's own
 * bounded per-document cache (`Journal/IdempotencyCache.cs`) closely enough that the same
 * hit/miss/eviction behavior is exercised here via `bun test`, without needing real AutoCAD.
 *
 * A key is an IDENTITY, not a label: the entry also records the digest of the payload that first
 * claimed it, so the same key presented with different parameters is refused instead of answered
 * with the first call's stored result (issue #388 §C, bullet 2). Returning that result would
 * report work that was never done — the model asked for radius 999, gets back the handle of the
 * radius-5 circle, and the drawing silently lacks what it believes it drew. The C# cache
 * (`Journal/IdempotencyCache.cs`) enforces the same rule with the same canonicalization
 * (`PreImageCanonical.HashCanonical`).
 */
const MAX_IDEMPOTENCY_ENTRIES_PER_DOCUMENT = 200

class IdempotencyStore {
  private readonly perDocument = new Map<string, Map<string, { result: unknown; digest: string }>>()

  /** `Map` insertion order doubles as LRU recency here — a hit re-inserts the key at the end.
   * A digest mismatch throws rather than falling through to a fresh dispatch: the key was already
   * used for different work, and executing the new payload under it would corrupt the ledger that
   * `operations → history` and selective revert read back. */
  get(documentName: string, key: string, digest: string): { found: boolean; result?: unknown } {
    const cache = this.perDocument.get(documentName)
    if (!cache || !cache.has(key)) return { found: false }
    const entry = cache.get(key)!
    if (entry.digest !== digest) {
      throw new BridgeRpcError(
        BridgeErrorCode.IdempotencyKeyConflict,
        `Idempotency key "${key}" already stands for a different set of parameters on document ` +
          `"${documentName}". Retrying it with changed arguments would return the first call's ` +
          `result instead of performing the new work, so it is rejected. Send the new operation ` +
          `under a fresh key, or retry the original arguments unchanged.`
      )
    }
    cache.delete(key)
    cache.set(key, entry)
    return { found: true, result: entry.result }
  }

  store(documentName: string, key: string, result: unknown, digest: string): void {
    let cache = this.perDocument.get(documentName)
    if (!cache) {
      cache = new Map()
      this.perDocument.set(documentName, cache)
    }
    cache.delete(key)
    cache.set(key, { result, digest })
    while (cache.size > MAX_IDEMPOTENCY_ENTRIES_PER_DOCUMENT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
}

/** A valid 1x1 white PNG — stands in for a rendered drawing. */
const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

/** Structural equality for `ColorSpec` — used by `layer.ensure`'s created/updated/unchanged report. */
function colorSpecEquals(a: ColorSpec, b: ColorSpec): boolean {
  if ('aci' in a && 'aci' in b) return a.aci === b.aci
  if ('rgb' in a && 'rgb' in b) {
    return a.rgb.r === b.rgb.r && a.rgb.g === b.rgb.g && a.rgb.b === b.rgb.b
  }
  return false
}

/** Bounding box of a point list, ignoring `undefined`/empty input. */
function boundsOfPoints(points: Point3d[]): { min: Point3d; max: Point3d } | undefined {
  if (points.length === 0) return undefined
  const min = { ...points[0]! }
  const max = { ...points[0]! }
  for (const p of points) {
    min.x = Math.min(min.x, p.x)
    min.y = Math.min(min.y, p.y)
    min.z = Math.min(min.z, p.z)
    max.x = Math.max(max.x, p.x)
    max.y = Math.max(max.y, p.y)
    max.z = Math.max(max.z, p.z)
  }
  return { min, max }
}

/**
 * Mock-only bounding box per entity kind, derived from the stored creation params (the mock has no
 * real AutoCAD `Entity.Bounds` to call). `arc` uses the full circle's bbox (conservative, not the
 * true swept-angle bbox) — documented simplification, see `drawing.check`'s doc comment. `hatch`
 * has no direct points (only `boundaryHandles`) so it's excluded from geometry checks.
 */
function entityBounds(geom: CreateEntityParams): { min: Point3d; max: Point3d } | undefined {
  switch (geom.kind) {
    case 'line':
      return boundsOfPoints([geom.start, geom.end])
    case 'circle':
    case 'arc':
      return {
        min: { x: geom.center.x - geom.radius, y: geom.center.y - geom.radius, z: geom.center.z },
        max: { x: geom.center.x + geom.radius, y: geom.center.y + geom.radius, z: geom.center.z }
      }
    case 'polyline':
      return boundsOfPoints(geom.points)
    case 'rectangle':
      return boundsOfPoints([geom.corner1, geom.corner2])
    case 'mtext':
    case 'text.singleLine':
      return boundsOfPoints([geom.insertion])
    case 'blockReference':
      return boundsOfPoints([geom.position])
    case 'dimension.linear':
    case 'dimension.aligned':
      return boundsOfPoints([geom.extLine1, geom.extLine2, geom.dimLinePoint])
    case 'dimension.ordinate':
      return boundsOfPoints([geom.origin, geom.featurePoint, geom.leaderEndPoint])
    case 'hatch':
      return undefined
  }
}

function distance(a: Point3d, b: Point3d): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Geometric length, where defined — used by the `zeroLength` check. */
function entityLength(geom: CreateEntityParams): number | undefined {
  switch (geom.kind) {
    case 'line':
      return distance(geom.start, geom.end)
    case 'polyline': {
      let total = 0
      for (let i = 1; i < geom.points.length; i++)
        total += distance(geom.points[i - 1]!, geom.points[i]!)
      if (geom.closed && geom.points.length > 1)
        total += distance(geom.points[geom.points.length - 1]!, geom.points[0]!)
      return total
    }
    case 'arc': {
      const span = Math.abs(geom.endAngle - geom.startAngle)
      return geom.radius * span
    }
    default:
      return undefined
  }
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

/**
 * Drawing-units-per-paper-unit factor of a "paper:drawing" annotation scale string (e.g. "1:100" -> 100)
 * — mirrors the real plugin's `Annotation.CurrentScaleFactor` (`Util/Annotation.cs`, #74). Falls
 * back to 1 for anything unparsable (the zod layer already rejects a malformed `annotationScale`
 * before it reaches `drawing.setup`).
 */
function scaleFactorOf(scale: string): number {
  const [paperRaw, drawingRaw] = scale.split(':')
  const paper = Number(paperRaw)
  const drawing = Number(drawingRaw)
  return paper > 0 && drawing > 0 ? drawing / paper : 1
}

/** Grouping key for the `duplicates` check — same kind/layer entities with an identical signature. */
function entitySignature(geom: CreateEntityParams, decimals: number): string | undefined {
  const r = (n: number) => round(n, decimals)
  const rp = (p: Point3d) => `${r(p.x)},${r(p.y)},${r(p.z)}`
  switch (geom.kind) {
    case 'line':
      return [rp(geom.start), rp(geom.end)].sort().join('|')
    case 'circle':
      return `${rp(geom.center)}@${r(geom.radius)}`
    case 'arc':
      return `${rp(geom.center)}@${r(geom.radius)}:${r(geom.startAngle)}-${r(geom.endAngle)}`
    case 'polyline':
      return geom.points.map(rp).join('|') + (geom.closed ? ':closed' : '')
    case 'rectangle':
      return [rp(geom.corner1), rp(geom.corner2)].sort().join('|')
    case 'mtext':
    case 'text.singleLine':
      return `${rp(geom.insertion)}:${geom.text}:${r(geom.height ?? 2.5)}`
    case 'blockReference':
      return `${geom.blockName}@${rp(geom.position)}`
    case 'dimension.linear':
    case 'dimension.aligned':
      return [rp(geom.extLine1), rp(geom.extLine2), rp(geom.dimLinePoint)].join('|')
    case 'dimension.ordinate':
      return [rp(geom.origin), rp(geom.featurePoint), rp(geom.leaderEndPoint)].join('|')
    // hatch has no simple point-based signature (boundaryHandles/loops describe existing
    // geometry, not new points) — excluded from duplicate detection, matching the plugin's
    // CheckHandlers.cs Signature() default case.
    case 'hatch':
      return undefined
  }
}

/**
 * Mock-only `EntityCommonProperties` (#25): `entity.create` has no per-entity color/linetype/
 * lineweight/transparency override today — every created entity is ByLayer and visible, matching a
 * freshly created real AutoCAD entity's defaults (`Entity.Color`/`Linetype`/`LineWeight` all start
 * `ByLayer`, `Transparency` `ByLayer`, `Visible` true).
 */
const MOCK_ENTITY_PROPERTIES: EntityCommonProperties = {
  color: { aci: 256 },
  linetype: 'ByLayer',
  linetypeScale: 1,
  lineweight: -1,
  visible: true
}

/**
 * One `polyline`/`rectangle` vertex, mirroring the real plugin's `AddVertexAt(i, point, bulge,
 * halfWidth, halfWidth)` (#25).
 */
function polylineVertices(
  points: Point3d[],
  bulges: number[] | undefined,
  constantWidth: number | undefined
): PolylineVertex[] {
  const halfWidth = constantWidth ? constantWidth / 2 : undefined
  return points.map((point, i) => {
    const bulge = bulges?.[i]
    const vertex: PolylineVertex = { point }
    if (bulge) vertex.bulge = bulge
    if (halfWidth) {
      vertex.startWidth = halfWidth
      vertex.endWidth = halfWidth
    }
    return vertex
  })
}

/**
 * `polyline`/`rectangle` `EntityDetail.geometry` (#25). `area` is the shoelace-formula area of the
 * straight-segment polygon — exact for a `rectangle`'s 4 corners (no bulges), an approximation for
 * an arbitrary bulged polyline (acceptable for the mock, which has no real `Polyline.Area` to
 * call).
 */
function polylineGeometry(
  points: Point3d[],
  closed: boolean,
  bulges: number[] | undefined,
  constantWidth: number | undefined
): { vertices: PolylineVertex[]; closed: boolean; length: number; area?: number } {
  let length = 0
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1]!, points[i]!)
  if (closed && points.length > 1) length += distance(points[points.length - 1]!, points[0]!)
  let area: number | undefined
  if (closed && points.length >= 3) {
    let shoelace = 0
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!
      const b = points[(i + 1) % points.length]!
      shoelace += a.x * b.y - b.x * a.y
    }
    area = Math.abs(shoelace) / 2
  }
  return { vertices: polylineVertices(points, bulges, constantWidth), closed, length, area }
}

/**
 * Deterministic stand-in for `Dimension.DimensionText` (#25) — the mock has no real AutoCAD
 * DIMSTYLE formatting to call.
 */
function formatMeasurement(value: number): string {
  return round(value, 4).toString()
}

/**
 * `mtext`/`text.singleLine`'s resolved model-space height (#25): mirrors the real plugin's
 * `paperHeight.HasValue ? paperHeight * CurrentScaleFactor(db) : height ?? 2.5` exactly
 * (`EntityHandlers.cs`'s `BuildMText`/`BuildSingleLineText`, #74).
 */
function resolvedTextHeight(
  state: MockDocumentState,
  geom: { height?: number; paperHeight?: number }
): number {
  if (geom.paperHeight !== undefined) {
    return round(geom.paperHeight * scaleFactorOf(state.drawingSettings.annotationScale), 6)
  }
  return geom.height ?? 2.5
}

/**
 * `mtext`/`text.singleLine`'s resolved `TextStyleName` (#25): the real plugin assigns the on-demand
 * `CadAI-Annotative` style when the entity resolves annotative (`annotative` field, or this
 * document's default when omitted, #74), `Standard` otherwise.
 */
function resolvedTextStyle(state: MockDocumentState, annotative: boolean | undefined): string {
  return (annotative ?? state.annotativeDefault) ? 'CadAI-Annotative' : 'Standard'
}

/**
 * Square metres per one square drawing unit — mirrors the plugin's `UnitFormat` table exactly.
 * null for `unitless` (and any unit the wire vocabulary can't name), so the mock refuses to
 * convert just as the real plugin does.
 */
const SQ_METERS_PER_UNIT_SQUARED: Record<string, number | null> = {
  mm: 1e-6,
  cm: 1e-4,
  m: 1,
  in: 0.00064516,
  ft: 0.09290304,
  unitless: null
}

/**
 * The mock's stand-in for AutoCAD's native `Area`: computed from the same `CreateEntityParams`
 * `entityGeometry` already stores (shoelace for a closed polyline/rectangle, pi-r-squared for a
 * circle, outer-loop-minus-islands for a hatch). It approximates what real AutoCAD returns —
 * enough to exercise the tool's scope/status/conversion wiring in `bun test`, never a claim that
 * it equals `Polyline.Area` for bulged curves.
 */
function mockAreaOf(
  state: MockDocumentState,
  geom: CreateEntityParams
): { area: number; perimeter?: number; loopCount?: number; holeLoopCount?: number } | null {
  switch (geom.kind) {
    case 'circle':
      return { area: Math.PI * geom.radius ** 2, perimeter: 2 * Math.PI * geom.radius }
    case 'rectangle': {
      const w = Math.abs(geom.corner2.x - geom.corner1.x)
      const h = Math.abs(geom.corner2.y - geom.corner1.y)
      return { area: w * h, perimeter: 2 * (w + h) }
    }
    case 'polyline': {
      if (!geom.closed || geom.points.length < 3) return null
      return { area: Math.abs(shoelace(geom.points)) / 2, perimeter: entityLength(geom) }
    }
    case 'hatch': {
      const loops = geom.loops ?? (geom.boundaryHandles ? [{ handles: geom.boundaryHandles }] : [])
      if (loops.length === 0) return null
      const outer = loopArea(state, loops[0]!)
      if (outer === null) return null
      let area = outer
      for (const loop of loops.slice(1)) {
        const island = loopArea(state, loop)
        if (island !== null) area -= island
      }
      return { area, loopCount: loops.length, holeLoopCount: Math.max(0, loops.length - 1) }
    }
    default:
      return null
  }
}

/** Area of one hatch loop, from its points, its circle, or (single-entity) its boundary handle. */
function loopArea(
  state: MockDocumentState,
  loop: { handles?: string[]; points?: Point3d[]; circle?: { center: Point3d; radius: number } }
): number | null {
  if (loop.circle) return Math.PI * loop.circle.radius ** 2
  if (loop.points && loop.points.length >= 3) return Math.abs(shoelace(loop.points)) / 2
  if (loop.handles && loop.handles.length === 1) {
    const geom = state.entityGeometry.get(loop.handles[0]!)
    return geom ? (mockAreaOf(state, geom)?.area ?? null) : null
  }
  return null
}

function shoelace(points: Point3d[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    sum += a.x * b.y - b.x * a.y
  }
  return sum
}

/**
 * Mock-only `EntityDetail` (#25), built from the same `CreateEntityParams` `entityGeometry` already
 * records for `drawing.check` — not a parallel structure. A `rectangle` always resolves to `kind:
 * "polyline"`, matching the real plugin's documented `EntityKindResolver.cs` behavior (no native
 * AutoCAD Rectangle entity).
 */
function toEntityDetail(
  entity: EntitySummary,
  geom: CreateEntityParams,
  state: MockDocumentState,
  includeBounds = true
): EntityDetail {
  const base = {
    handle: entity.handle,
    layer: entity.layer,
    bounds: includeBounds ? entity.bounds : undefined,
    properties: MOCK_ENTITY_PROPERTIES
  }
  switch (geom.kind) {
    case 'line':
      return {
        ...base,
        kind: 'line',
        geometry: { start: geom.start, end: geom.end, length: distance(geom.start, geom.end) }
      }
    case 'circle':
      return { ...base, kind: 'circle', geometry: { center: geom.center, radius: geom.radius } }
    case 'arc':
      return {
        ...base,
        kind: 'arc',
        geometry: {
          center: geom.center,
          radius: geom.radius,
          startAngle: geom.startAngle,
          endAngle: geom.endAngle
        }
      }
    case 'polyline':
      return {
        ...base,
        kind: 'polyline',
        geometry: polylineGeometry(
          geom.points,
          geom.closed ?? false,
          geom.bulges,
          geom.constantWidth
        )
      }
    case 'rectangle': {
      const { corner1: c1, corner2: c2 } = geom
      const points = [c1, { x: c2.x, y: c1.y, z: c1.z }, c2, { x: c1.x, y: c2.y, z: c1.z }]
      return {
        ...base,
        kind: 'polyline',
        geometry: polylineGeometry(points, true, undefined, undefined)
      }
    }
    case 'mtext':
      return {
        ...base,
        kind: 'mtext',
        geometry: {
          insertion: geom.insertion,
          text: geom.text,
          height: resolvedTextHeight(state, geom),
          rotation: 0,
          width: geom.width,
          style: resolvedTextStyle(state, geom.annotative)
        }
      }
    case 'text.singleLine':
      return {
        ...base,
        kind: 'text.singleLine',
        geometry: {
          insertion: geom.insertion,
          text: geom.text,
          height: resolvedTextHeight(state, geom),
          rotation: geom.rotation ?? 0,
          style: resolvedTextStyle(state, geom.annotative)
        }
      }
    case 'blockReference': {
      const btr = state.blockDefinitions.get(geom.blockName)
      return {
        ...base,
        kind: 'blockReference',
        geometry: {
          blockName: geom.blockName,
          position: geom.position,
          scale: geom.scale ?? { x: 1, y: 1, z: 1 },
          rotation: geom.rotation ?? 0,
          attributes: geom.attributes,
          nestedGeometry: {
            entities: [],
            truncated: false,
            isXref: btr?.isXref ?? false
          }
        }
      }
    }
    case 'dimension.linear': {
      const measurement = distance(geom.extLine1, geom.extLine2)
      return {
        ...base,
        kind: 'dimension.linear',
        geometry: {
          extLine1: geom.extLine1,
          extLine2: geom.extLine2,
          dimLinePoint: geom.dimLinePoint,
          rotation: geom.rotation ?? 0,
          measurement,
          text: geom.dimText ?? formatMeasurement(measurement)
        }
      }
    }
    case 'dimension.aligned': {
      const measurement = distance(geom.extLine1, geom.extLine2)
      return {
        ...base,
        kind: 'dimension.aligned',
        geometry: {
          extLine1: geom.extLine1,
          extLine2: geom.extLine2,
          dimLinePoint: geom.dimLinePoint,
          measurement,
          text: geom.dimText ?? formatMeasurement(measurement)
        }
      }
    }
    case 'dimension.ordinate': {
      const measurement =
        geom.axis === 'x'
          ? Math.abs(geom.featurePoint.x - geom.origin.x)
          : Math.abs(geom.featurePoint.y - geom.origin.y)
      return {
        ...base,
        kind: 'dimension.ordinate',
        geometry: {
          origin: geom.origin,
          featurePoint: geom.featurePoint,
          leaderEndPoint: geom.leaderEndPoint,
          axis: geom.axis,
          measurement,
          text: formatMeasurement(measurement)
        }
      }
    }
    case 'hatch': {
      const loopCount = geom.loops?.length ?? (geom.boundaryHandles ? 1 : 0)
      const loopTypes = geom.loops
        ? geom.loops.map((_, i) => (i === 0 ? 'Outermost' : 'Default'))
        : ['Default']
      const boundaryLoops = geom.loops
        ? geom.loops.map((loop, i) => ({
            loopType: i === 0 ? 'Outermost' : 'Default',
            area: loopArea(state, loop) ?? undefined,
            closed: true,
            vertices: 'points' in loop ? loop.points : []
          }))
        : geom.boundaryHandles
          ? geom.boundaryHandles.map((h, i) => {
              const bg = state.entityGeometry.get(h)
              const pts = bg && 'points' in bg ? (bg.points as Point3d[]) : []
              return {
                loopType: i === 0 ? 'Outermost' : 'Default',
                area: bg ? (mockAreaOf(state, bg)?.area ?? undefined) : undefined,
                closed: true,
                vertices: pts
              }
            })
          : []
      return {
        ...base,
        kind: 'hatch',
        geometry: {
          pattern: geom.pattern ?? 'SOLID',
          patternScale: geom.patternScale ?? 1,
          patternAngle: geom.patternAngle ?? 0,
          associative: geom.associative ?? false,
          loopCount,
          loopTypes,
          boundaryLoops,
          truncated: false
        }
      }
    }
  }
}

/**
 * Mock mirror of `CadStateHandlers.ToScanEntity`: identity + bounds always, searchable text when
 * the kind carries it (MText/DBText content, or a block reference's non-empty attribute values
 * joined), and geometry/properties only at `detail: "full"`. Text is bounded to 500 chars per
 * entity and 20 attributes per insert, matching the plugin's budgets.
 */
function toScanEntity(
  state: MockDocumentState,
  entity: EntitySummary,
  fullDetail: boolean
): CadScanEntity {
  const row: CadScanEntity = {
    handle: entity.handle,
    kind: entity.kind,
    layer: entity.layer
  }
  if (entity.bounds) row.bounds = entity.bounds
  const geom = state.entityGeometry.get(entity.handle)
  if (geom) {
    if (geom.kind === 'blockReference') {
      row.blockName = geom.blockName
      const parts = Object.entries(geom.attributes ?? {})
        .filter(([, value]) => value.trim() !== '')
        .slice(0, 20)
        .map(([tag, value]) => `${tag}=${value.trim()}`)
      if (parts.length > 0) row.text = parts.join('; ').slice(0, 500)
    } else if (geom.kind === 'mtext' || geom.kind === 'text.singleLine') {
      row.text = geom.text.slice(0, 500)
    }
  }
  if (fullDetail) {
    row.properties = MOCK_ENTITY_PROPERTIES
    if (geom) {
      const detail = toEntityDetail(entity, geom, state)
      row.geometry = detail.geometry as unknown as Record<string, unknown>
    }
  }
  return row
}

/**
 * Per-document model space + layer table + batch journal — one per open "document" so targeting a
 * non-active document is genuinely isolated, not simulated by ignoring the field.
 */
class MockDocumentState {
  handleCounter = 1
  currentLayer = '0'
  readonly entities = new Map<string, EntitySummary>()
  /** Creation params per handle — the mock's only source of real geometry, used by `drawing.check`. */
  readonly entityGeometry = new Map<string, CreateEntityParams>()
  /**
   * `entity.update`'s common properties per handle (#26) — not part of `EntitySummary`'s wire
   * shape, debug-only, same convention as `entityGeometry`.
   */
  readonly entityStyle = new Map<
    string,
    { color?: ColorSpec; linetype?: string; lineweight?: number }
  >()
  /** Ownership tracking: handles of entities created by CadAI in this document. */
  readonly cadAiOwned = new Set<string>()
  /** Ownership tracking: names of layers created by CadAI in this document. */
  readonly cadAiLayers = new Set<string>()
  /**
   * Saved file path, set by `drawing.open`/`drawing.save` — the plugin reports `db.Filename`, and
   * the Cloud CAD State Engine's identity ladder falls back to it when no fingerprint exists.
   * `null` = never saved (a `drawing.new` tab), exactly like a fresh unsaved AutoCAD database.
   */
  path: string | null = null
  /**
   * `Database.FingerprintGuid` lineage identity. The mock assigns a deterministic 32-hex value the
   * first time a drawing is opened from a path or saved, and keeps it null for a never-saved
   * `drawing.new` tab — so "unsaved drawing has no reusable identity" is testable offline.
   */
  fingerprintGuid: string | null = null
  /**
   * The mock's `ChangeTracker`: handles touched since the last flush, coalesced into a bounded,
   * sequence-numbered ring at the end of each RPC call (the mock's command boundary, so one
   * `operations.apply` yields ONE event like one real command). Mirrors the plugin's per-document
   * feed — oldest events drop past `MAX_CHANGE_EVENTS`, which advances `earliestSequence` and
   * forces Cloud to reconcile instead of applying a partial delta.
   * Scope: model-space entity handles only. The plugin additionally reports block-definition and
   * layer-table record touches as `dependency_invalidated`; the mock's tables have no handles to
   * report, and that path is pinned by the C# `ChangeTrackerTests` instead.
   */
  readonly pendingChanges = new Map<string, { operation: string; dependency: boolean }>()
  readonly changeEvents: MockChangeEvent[] = []
  changeSequence = 0
  readonly layers = new Map<string, LayerInfo>([
    [
      '0',
      {
        name: '0',
        color: { aci: 7 },
        linetype: 'Continuous',
        lineweight: -1,
        frozen: false,
        locked: false,
        plottable: true,
        on: true,
        isCurrent: true
      }
    ]
  ])
  readonly selectedHandles = new Set<string>()
  readonly editSessions = new Map<
    string,
    {
      editId: string
      documentName: string
      documentIdentity: string
      revisionAtCapture: string
      candidateLayer: string
      candidates: EntityRef[]
      preImages: EntityPreImage[]
      unsupportedFeatures: string[]
      state?: 'active' | 'accepted' | 'discarded' | 'orphaned' | 'revalidating'
      appliedMapping?: Record<string, string>
    }
  >()
  readonly batches: MockBatchEntry[] = []
  readonly undoneStack: string[] = []
  /**
   * Per-document `view.setLive` settings (autocad-mcp#67) — defaults match today's behavior (no
   * follow).
   */
  liveSettings: LiveViewSettings = {
    follow: 'off',
    margin: 0.25,
    minHeight: null,
    animate: true,
    progressive: false,
    paceMs: 0
  }
  batchSequence = 0
  /**
   * Mirrors the plugin's `DrawingInfoResult.Revision`: a coarse per-document counter that moves on
   * every committed mutation, so a spatial-validation record bound to one drawing state can be
   * proven stale by the mock exactly as it is by real AutoCAD (`Tduupdate` + `NumberOfSaves`).
   */
  revision = 1
  /** Mirrors `Database.NumberOfSaves`, folded into the revision string the plugin reports. */
  saveCount = 0
  drawingSettings: DrawingSetupResult = {
    insUnits: 'unitless',
    linearUnits: 'decimal',
    linearPrecision: 4,
    angularUnits: 'decimalDegrees',
    ltScale: 1,
    celtScale: 1,
    dimScale: 1,
    lwDisplay: false,
    annotationScale: '1:1'
  }
  /**
   * Whether `entity.create`'s annotative-capable kinds default their own `annotative` field to
   * `true` for this document — flips on the first `drawing.setup` call that passes
   * `annotationScale` (#74), mirroring the real plugin's `Util/Annotation.cs`.
   */
  annotativeDefault = false
  // AutoCAD's real defaults for a brand-new drawing: Continuous is always loaded, Standard always
  // exists for both text and dimension styles, and Standard starts current for both.
  readonly linetypes = new Map<string, LinetypeInfo>([
    ['Continuous', { name: 'Continuous', description: 'Solid line' }]
  ])
  readonly textStyles = new Map<string, TextStyleInfo>([
    [
      'Standard',
      {
        name: 'Standard',
        font: 'txt.shx',
        height: 0,
        widthFactor: 1,
        obliqueAngle: 0,
        isCurrent: true,
        isTrueType: false,
        bold: false,
        italic: false,
        charSet: 0,
        pitchAndFamily: 0
      }
    ]
  ])
  readonly dimStyles = new Map<string, DimStyleInfo>([
    [
      'Standard',
      {
        name: 'Standard',
        textHeight: 2.5,
        arrowSize: 2.5,
        extensionOffset: 0.625,
        extensionBeyond: 1.25,
        decimalPlaces: 4,
        unitsFormat: 'decimal',
        scale: 1,
        isCurrent: true
      }
    ]
  ])
  readonly blockDefinitions = new Map<
    string,
    {
      name: string
      explodable: boolean
      isDynamic: boolean
      isAnonymous: boolean
      isLayout: boolean
      isXref: boolean
      description?: string
    }
  >([
    [
      '*Model_Space',
      {
        name: '*Model_Space',
        explodable: false,
        isDynamic: false,
        isAnonymous: false,
        isLayout: true,
        isXref: false
      }
    ],
    [
      '*Paper_Space',
      {
        name: '*Paper_Space',
        explodable: false,
        isDynamic: false,
        isAnonymous: false,
        isLayout: true,
        isXref: false
      }
    ]
  ])
}

/**
 * In-process fake of the AutoCAD bridge: two in-memory "documents" good enough to exercise every
 * MCP tool, including `documentName` targeting and cross-document isolation, without a Windows host
 * or AutoCAD license. Used by `src/smoke.ts` and can back local development against an MCP
 * Inspector session before the real bridge plugin is wired up.
 *
 * "Drawing2.dwg" is pre-seeded (empty) rather than opened via an RPC — there is no `drawing.open`
 * method (AutoCAD's own taxonomy has none either; the plugin only ever sees documents the user
 * already opened by hand), so a fixed second document is the only way to test targeting offline.
 */
/** Capture all mock model-space state: dry-run and failed update batches must be reversible. */
function snapshotMockState(state: MockDocumentState): () => void {
  const entities = new Map([...state.entities].map(([h, e]) => [h, structuredClone(e)] as const))
  const geometry = new Map(
    [...state.entityGeometry].map(([h, g]) => [h, structuredClone(g)] as const)
  )
  const styles = new Map([...state.entityStyle].map(([h, v]) => [h, structuredClone(v)] as const))
  const cadAiOwned = new Set(state.cadAiOwned)
  const cadAiLayers = new Set(state.cadAiLayers)
  const pending = new Map([...state.pendingChanges].map(([h, v]) => [h, { ...v }] as const))
  const events = structuredClone(state.changeEvents)
  const revision = state.revision
  const handleCounter = state.handleCounter
  const changeSequence = state.changeSequence
  return () => {
    state.entities.clear()
    for (const [h, e] of entities) state.entities.set(h, e)
    state.entityGeometry.clear()
    for (const [h, g] of geometry) state.entityGeometry.set(h, g)
    state.entityStyle.clear()
    for (const [h, v] of styles) state.entityStyle.set(h, v)
    state.cadAiOwned.clear()
    for (const h of cadAiOwned) state.cadAiOwned.add(h)
    state.cadAiLayers.clear()
    for (const l of cadAiLayers) state.cadAiLayers.add(l)
    state.pendingChanges.clear()
    for (const [h, v] of pending) state.pendingChanges.set(h, v)
    state.changeEvents.splice(0, state.changeEvents.length, ...events)
    state.changeSequence = changeSequence
    state.revision = revision
    state.handleCounter = handleCounter
  }
}

/**
 * #413 phase B mirror of the plugin's PreImageCanonical.HashDetail over the entity's BOUNDS-FREE
 * detail: the same value operations.apply's expectedState re-checks, and what entity.get
 * (detail:"full") reports as stateDigest. Canonical (sorted keys, 1e-6 rounding) via hashCanonical.
 */
function mockStateDigest(state: MockDocumentState, handle: string): string | null {
  const entity = state.entities.get(handle)
  const geom = state.entityGeometry.get(handle)
  if (!entity || !geom) return null
  return hashCanonical(toEntityDetail(entity, geom, state, false))
}

/** #413 phase B mirror of the plugin's ExpectedStateFor: absent map/entry = opted out; handle
 * hex matches case-insensitively. */
function mockExpectedStateFor(
  expectedState: Record<string, string> | undefined,
  handle: string
): string | undefined {
  if (!expectedState) return undefined
  if (handle in expectedState) return expectedState[handle]
  const lower = handle.toLowerCase()
  for (const [k, v] of Object.entries(expectedState)) if (k.toLowerCase() === lower) return v
  return undefined
}

/** #413 phase B mirror of the plugin's PruneStateConflicts: stale handles are dropped from THIS
 * step and recorded; everything else proceeds. Unresolvable (gone) handles pass through unreported,
 * exactly like the plugin. */
function mockPruneStateConflicts(
  state: MockDocumentState,
  handles: string[],
  expectedState: Record<string, string> | undefined,
  conflicts: StateConflict[]
): string[] {
  if (!expectedState || Object.keys(expectedState).length === 0) return handles
  const kept: string[] = []
  for (const handle of handles) {
    const expected = mockExpectedStateFor(expectedState, handle)
    if (expected !== undefined) {
      const actual = mockStateDigest(state, handle)
      if (actual !== null && expected !== actual) {
        conflicts.push({ handle, expected, actual, reason: 'state_conflict' })
        continue
      }
    }
    kept.push(handle)
  }
  return kept
}

function mockModifiedEntity(state: MockDocumentState, handle: string): MockModifiedEntity | null {
  const entity = state.entities.get(handle)
  if (!entity) return null
  const geometry = state.entityGeometry.get(handle)
  const style = state.entityStyle.get(handle)
  return {
    handle,
    entity: structuredClone(entity),
    ...(geometry && { geometry: structuredClone(geometry) }),
    ...(style && { style: structuredClone(style) })
  }
}

export class MockBridgeClient implements BridgeClient {
  private readonly documents = new Map<string, MockDocumentState>([
    ['Drawing1.dwg', new MockDocumentState()],
    ['Drawing2.dwg', new MockDocumentState()]
  ])
  private activeDocumentName = 'Drawing1.dwg'
  /**
   * Closed tabs that have a real path: their content "lives on disk", so `drawing.open` of that
   * path reads it back rather than starting empty. Only `drawing.open`-created tabs qualify —
   * an unsaved `drawing.new` tab has no file to reopen from, exactly as in AutoCAD.
   */
  private readonly onDiskByPath = new Map<string, MockDocumentState>()
  /** Full paths (lowercased) a `drawing.save` has already written in this mock session — the
   * `FileExists`-without-`overwrite` guard needs *some* notion of "a file is already there", and
   * the mock has no real filesystem to check. */
  private readonly savedFilePaths = new Set<string>()
  /**
   * Idempotency-key dedupe map for mutating calls (#9); `signal` is accepted (interface parity with
   * the real transport) but ignored — the mock has no network hop to cancel.
   */
  private readonly idempotency = new IdempotencyStore()

  /**
   * Same lookup tiers as the plugin's `DocumentContext.Resolve`: exact name, then case-insensitive,
   * then ignoring a missing ".dwg" — so "drawing2" finds "Drawing2.dwg".
   */
  private idOf(name: string): string {
    return `doc_mock_${name.toLowerCase().replace(/\.dwg$/, '')}`
  }

  private resolveDoc(documentName?: string): { name: string; state: MockDocumentState } {
    const wanted = documentName ?? this.activeDocumentName
    if (wanted.startsWith('doc_')) {
      // Like the plugin: an id names one tab or none, never falls through to name matching.
      const byId = [...this.documents.entries()].find(([n]) => this.idOf(n) === wanted)
      if (!byId)
        throw new BridgeRpcError(
          BridgeErrorCode.DocumentNotFound,
          `Document "${wanted}" is not open in this AutoCAD process. Open: ${[...this.documents.keys()].join(', ')}.`
        )
      return { name: byId[0], state: byId[1] }
    }
    const bare = (n: string) => n.toLowerCase().replace(/\.dwg$/, '')
    const name =
      [...this.documents.keys()].find((n) => n === wanted) ??
      [...this.documents.keys()].find((n) => n.toLowerCase() === wanted.toLowerCase()) ??
      [...this.documents.keys()].find((n) => bare(n) === bare(wanted))
    const state = name === undefined ? undefined : this.documents.get(name)
    if (name === undefined || !state)
      throw new BridgeRpcError(
        BridgeErrorCode.DocumentNotFound,
        `Document "${wanted}" is not open in this AutoCAD process. Open: ${[...this.documents.keys()].join(', ')}.`
      )
    return { name, state }
  }

  /**
   * Checks the idempotency-key cache before dispatching, and records a successful dispatch's result
   * under it afterward (#9) — mirrors the real plugin's `IdempotencyCache.Execute`: a thrown error
   * is never cached, so a failed call is always safe to retry with the same key.
   */
  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    _options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    // Every mutating RpcMethodMap params type carries these two optional fields (methods.ts);
    // `M` being generic here is what forces the cast — one, named, for both reads.
    const envelope = params as { idempotencyKey?: string; documentName?: string }
    if (!envelope.idempotencyKey) {
      const result = await this.dispatchRequest(method, params)
      this.flushAllPendingChanges()
      return result
    }
    const { name } = this.resolveDoc(envelope.documentName)
    // Digest of what will actually be dispatched, not of the caller's key: the canonicalizer drops
    // the volatile envelope fields (`idempotencyKey`/`view`/`result`/`dryRun`/`progressive`/
    // `ensureLayer`/`timeoutMs`), so a genuine retry — same work, maybe a different view — still
    // matches, while one changed coordinate does not.
    const digest = hashCanonical(params)
    const cached = this.idempotency.get(name, envelope.idempotencyKey, digest)
    if (cached.found) return cached.result as RpcMethodMap[M]['result']
    const result = await this.dispatchRequest(method, params)
    this.flushAllPendingChanges()
    this.idempotency.store(name, envelope.idempotencyKey, result, digest)
    return result
  }

  /** Sets the mock's implied selection for selection: "implied" calls. */
  setImpliedSelection(handles: string[], documentName?: string): void {
    const { state } = this.resolveDoc(documentName)
    state.selectedHandles.clear()
    for (const h of handles) state.selectedHandles.add(h)
  }

  /** Test-only helper to inspect internal document state for unit tests. */
  inspectState(documentName?: string): MockDocumentState {
    return this.resolveDoc(documentName).state
  }
  private async dispatchRequest<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params']
  ): Promise<RpcMethodMap[M]['result']> {
    switch (method) {
      case RpcMethod.SystemStatus:
        return {
          processId: 18244,
          pluginVersion: '0.1.0-mock',
          autocadVersion: 'mock',
          activeDocument: this.activeDocumentName,
          pipeUptimeSeconds: 0,
          runtimeGeneration: 'net8.0-windows',
          supports: {
            blockUniquify: true
          }
        } satisfies RpcMethodMap[typeof RpcMethod.SystemStatus]['result'] as RpcMethodMap[M]['result']

      case RpcMethod.DrawingInfo: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingInfo]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        const isActive = name === this.activeDocumentName
        return {
          documentId: this.idOf(name),
          name,
          path: state.path,
          entityCount: state.entities.size,
          layerCount: state.layers.size,
          modified: isActive ? state.entities.size > 0 : null,
          annotationScale: state.drawingSettings.annotationScale,
          revision: `tdu:${state.revision};saves:${state.saveCount}`,
          fingerprintGuid: state.fingerprintGuid
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingInfo]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingInspectFloorplan: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingInspectFloorplan]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        const revision = `tdu:${state.revision};saves:${state.saveCount}`
        return {
          found: true,
          matchedName: p.name,
          availableFloorplans: ['MẶT BẰNG TẦNG HẦM', 'MẶT BẰNG TẦNG 1'],
          bounds: [9.08, 99339.6, 32529.21, 122878],
          dimensions: { width: 32.52, height: 23.54, units: 'm' },
          data:
            p.capture !== false
              ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
              : undefined,
          mimeType: p.capture !== false ? 'image/png' : undefined,
          layers: ['A-WALL', 'S-COLS', 'A-DOOR'],
          rooms: [{ name: 'GARA ĐỂ XE TẦNG HẦM', labelPosition: [10000, 105000] }],
          // Identity + units, reported from the same locked document the region walk reads — the
          // same fields the plugin emits, so the tool can feed the CAD State reconcile without a
          // separate drawing.info probe.
          documentId: this.idOf(name),
          revision,
          fingerprintGuid: state.fingerprintGuid,
          units: state.drawingSettings.insUnits,
          capture: p.capture !== false ? { status: 'ok', source: 'offscreen' } : undefined
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingInspectFloorplan]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingSummary: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingSummary]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        // Mirrors the plugin's one-pass summary: per-layer counts (empty layers included),
        // block-reference inventory, text preview (free-standing text + block attributes), extents
        // from the mock's stored bounds, and the drawingSettings units. The mock has no xrefs and
        // one Model layout, same as its documents.
        const layerCounts = new Map<string, number>()
        for (const layer of state.layers.keys()) layerCounts.set(layer, 0)
        const blockCounts = new Map<string, number>()
        const texts: { text: string; layer: string }[] = []
        const blockTexts: { text: string; layer: string; block: string }[] = []
        let blockReferenceCount = 0
        let textEntitiesSeen = 0
        let blockTextsSeen = 0
        const attributeBlocksSeen = new Set<string>()
        let min: Point3d | undefined
        let max: Point3d | undefined
        for (const entity of state.entities.values()) {
          layerCounts.set(entity.layer, (layerCounts.get(entity.layer) ?? 0) + 1)
          if (entity.bounds) {
            min = min
              ? {
                  x: Math.min(min.x, entity.bounds.min.x),
                  y: Math.min(min.y, entity.bounds.min.y),
                  z: Math.min(min.z, entity.bounds.min.z)
                }
              : entity.bounds.min
            max = max
              ? {
                  x: Math.max(max.x, entity.bounds.max.x),
                  y: Math.max(max.y, entity.bounds.max.y),
                  z: Math.max(max.z, entity.bounds.max.z)
                }
              : entity.bounds.max
          }
          if (entity.kind === 'blockReference') {
            blockReferenceCount++
            const geom = state.entityGeometry.get(entity.handle)
            const blockName = geom?.kind === 'blockReference' ? geom.blockName : entity.handle
            blockCounts.set(blockName, (blockCounts.get(blockName) ?? 0) + 1)
            // Same dedupe-by-block-name + non-empty-value rule as the plugin's attribute pass:
            // title-block data lives in the block reference's attributes, not in model-space text.
            if (geom?.kind === 'blockReference' && !attributeBlocksSeen.has(blockName)) {
              attributeBlocksSeen.add(blockName)
              for (const [tag, value] of Object.entries(geom.attributes ?? {})) {
                if (value.trim() === '') continue
                blockTextsSeen++
                if (blockTexts.length < 30) {
                  blockTexts.push({
                    text: value.trim().slice(0, 120),
                    layer: entity.layer,
                    block: blockName
                  })
                }
              }
            }
          }
          if (entity.kind === 'mtext' || entity.kind === 'text.singleLine') {
            textEntitiesSeen++
            if (texts.length < 30) {
              const geom = state.entityGeometry.get(entity.handle)
              const raw =
                geom && (geom.kind === 'mtext' || geom.kind === 'text.singleLine') ? geom.text : ''
              texts.push({ text: raw.trim().slice(0, 120), layer: entity.layer })
            }
          }
        }
        const layers = [...layerCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([layer, count]) => ({ name: layer, count }))
        const blocksAll = [...blockCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([blockName, count]) => ({ name: blockName, count }))
        const blocksHasMore = blocksAll.length > 50
        return {
          documentId: this.idOf(name),
          name,
          path: state.path,
          entityCount: state.entities.size,
          layers,
          extents: min && max ? { min, max } : null,
          extentsEmpty: !(min && max),
          insUnits: state.drawingSettings.insUnits,
          linearUnits: state.drawingSettings.linearUnits,
          annotationScale: state.drawingSettings.annotationScale,
          blockReferenceCount,
          blocks: blocksHasMore ? blocksAll.slice(0, 50) : blocksAll,
          blocksHasMore,
          xrefs: [],
          texts,
          textsHasMore: textEntitiesSeen > 30,
          blockTexts,
          blockTextsHasMore: blockTextsSeen > 30,
          layouts: [{ name: 'Model', isActive: true, isModel: true }],
          revision: `tdu:${state.revision};saves:${state.saveCount}`,
          fingerprintGuid: state.fingerprintGuid
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingSummary]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingListOpen:
        return {
          documents: [...this.documents.entries()].map(([name, state]) => {
            const isActive = name === this.activeDocumentName
            return {
              documentId: this.idOf(name),
              name,
              path: state.path,
              isActive,
              modified: isActive ? state.entities.size > 0 : null
            }
          })
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingListOpen]['result'] as RpcMethodMap[M]['result']
      case RpcMethod.DrawingOpen: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingOpen]['params']
        const path = p.path
        if (!path || path.trim().length === 0) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'Path is required to open a drawing.'
          )
        }
        const fileName = path.replace(/^.*[\\/]/, '')
        // Reopening a path reads the file: a tab closed earlier left its content on disk, so the
        // same state comes back (a real reopen of a closed DWG does not start empty).
        const onDisk = this.onDiskByPath.get(path.toLowerCase())
        this.onDiskByPath.delete(path.toLowerCase())
        const state = this.documents.get(fileName) ?? onDisk ?? new MockDocumentState()
        this.documents.set(fileName, state)
        // Opening from a path gives the drawing both identity signals the Cloud engine keys on:
        // the file path and a stable fingerprint (the mock derives one from the file name, so a
        // reopen of the same path yields the same lineage id, as `FingerprintGuid` does in AutoCAD).
        state.path = path
        state.fingerprintGuid ??= fingerprintFor(fileName)
        return {
          documentId: this.idOf(fileName),
          name: fileName,
          path
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingOpen]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingNew: {
        let index = this.documents.size + 1
        let name = `Drawing${index}.dwg`
        while (this.documents.has(name)) {
          index++
          name = `Drawing${index}.dwg`
        }
        this.documents.set(name, new MockDocumentState())
        return {
          documentId: this.idOf(name),
          name
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingNew]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingClose: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingClose]['params']
        const { name } = this.resolveDoc(p.documentName)
        const closing = this.documents.get(name)
        // A tab backed by a real path keeps its content "on disk" once closed: reopening that path
        // reads it back. An unsaved drawing.new tab has no file, so it is simply gone.
        if (closing?.path) this.onDiskByPath.set(closing.path.toLowerCase(), closing)
        this.documents.delete(name)
        if (this.activeDocumentName === name) {
          const next = this.documents.keys().next().value
          this.activeDocumentName = next ?? ''
        }
        return {
          closed: true,
          name
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingClose]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingActivate: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingActivate]['params']
        const { name } = this.resolveDoc(p.documentName)
        this.activeDocumentName = name
        return {
          activated: true,
          documentId: this.idOf(name),
          name
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingActivate]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingSave: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingSave]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        const neverSaved = state.path === null

        let savedPath: string
        if (p.path === undefined) {
          // aleph-platform#5: a never-saved drawing has no file of its own to save "in place" —
          // ask for a path instead of guessing one.
          if (neverSaved) {
            throw new BridgeRpcError(
              BridgeErrorCode.InvalidOperation,
              `This drawing has never been saved and has no file of its own yet. Pass a path.`
            )
          }
          savedPath = state.path!
        } else {
          const currentDir = neverSaved ? null : winPath.dirname(state.path!)
          const target = validateSavePath(p.path, currentDir)
          const isCurrentFile =
            !neverSaved && target.toLowerCase() === winPath.normalize(state.path!).toLowerCase()
          if (
            !isCurrentFile &&
            p.overwrite !== true &&
            this.savedFilePaths.has(target.toLowerCase())
          ) {
            throw new BridgeRpcError(
              BridgeErrorCode.FileExists,
              `"${target}" already exists. Pass overwrite: true to replace it.`
            )
          }
          savedPath = target
        }

        // Mirrors `Database.NumberOfSaves`, which the plugin folds into its revision string.
        state.saveCount += 1
        // Saving establishes identity the same way opening does: `NumberOfSaves` moves, and a
        // first save gives a never-saved drawing its fingerprint.
        state.path = savedPath
        this.savedFilePaths.add(savedPath.toLowerCase())
        state.fingerprintGuid ??= fingerprintFor(savedPath.replace(/^.*[\\/]/, ''))
        return {
          savedPath
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingSave]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingSetup: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingSetup]['params']
        const { state } = this.resolveDoc(p.documentName)
        const s = state.drawingSettings
        if (p.insUnits !== undefined) s.insUnits = p.insUnits
        if (p.linearUnits !== undefined) s.linearUnits = p.linearUnits
        if (p.linearPrecision !== undefined) s.linearPrecision = p.linearPrecision
        if (p.angularUnits !== undefined) s.angularUnits = p.angularUnits
        if (p.ltScale !== undefined) s.ltScale = p.ltScale
        if (p.celtScale !== undefined) s.celtScale = p.celtScale
        if (p.dimScale !== undefined) s.dimScale = p.dimScale
        if (p.lwDisplay !== undefined) s.lwDisplay = p.lwDisplay
        // `scale` convenience — applied after explicit ltScale/dimScale so those win when both given.
        if (p.scale !== undefined) {
          if (p.ltScale === undefined) s.ltScale = p.scale * 0.5
          if (p.dimScale === undefined) s.dimScale = p.scale
        }
        // annotationScale (#74): sets CANNOSCALE and flips this document's annotative default on.
        if (p.annotationScale !== undefined) {
          s.annotationScale = p.annotationScale
          state.annotativeDefault = true
        }
        return {
          ...s
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingSetup]['result'] as RpcMethodMap[M]['result']
      }
      case RpcMethod.DrawingCheck: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingCheck]['params']
        const { state } = this.resolveDoc(p.documentName)
        return {
          findings: this.checkDrawing(state, p.scope, p.checks ?? DRAWING_CHECK_KINDS)
        } satisfies RpcMethodMap[typeof RpcMethod.DrawingCheck]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.DrawingCleanup: {
        const p = params as RpcMethodMap[typeof RpcMethod.DrawingCleanup]['params']
        const { state } = this.resolveDoc(p.documentName)
        return this.cleanupDrawing(
          state,
          p.fixes,
          p.dryRun ?? true
        ) satisfies DrawingCleanupResult as RpcMethodMap[M]['result']
      }

      case RpcMethod.LayerList: {
        const p = params as RpcMethodMap[typeof RpcMethod.LayerList]['params']
        const { state } = this.resolveDoc(p.documentName)
        return {
          layers: [...state.layers.values()]
        } satisfies RpcMethodMap[typeof RpcMethod.LayerList]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.LayerCreate: {
        const p = params as RpcMethodMap[typeof RpcMethod.LayerCreate]['params']
        const { state } = this.resolveDoc(p.documentName)
        const existing = state.layers.get(p.name)
        if (existing) {
          return {
            layer: existing,
            created: false
          } satisfies RpcMethodMap[typeof RpcMethod.LayerCreate]['result'] as RpcMethodMap[M]['result']
        }
        const layer: LayerInfo = {
          name: p.name,
          color: p.color ?? { aci: 7 },
          linetype: 'Continuous',
          lineweight: -1,
          frozen: false,
          locked: false,
          plottable: true,
          on: true,
          isCurrent: false
        }
        state.layers.set(p.name, layer)
        state.cadAiLayers.add(p.name)
        return {
          layer,
          created: true
        } satisfies RpcMethodMap[typeof RpcMethod.LayerCreate]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.LayerSetCurrent: {
        const p = params as RpcMethodMap[typeof RpcMethod.LayerSetCurrent]['params']
        const { state } = this.resolveDoc(p.documentName)
        if (!state.layers.has(p.name)) {
          throw new BridgeRpcError(
            BridgeErrorCode.LayerNotFound,
            `Layer "${p.name}" does not exist`
          )
        }
        for (const layer of state.layers.values()) layer.isCurrent = layer.name === p.name
        state.currentLayer = p.name
        return {} satisfies RpcMethodMap[typeof RpcMethod.LayerSetCurrent]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.LayerSetProperties: {
        const p = params as RpcMethodMap[typeof RpcMethod.LayerSetProperties]['params']
        const { state } = this.resolveDoc(p.documentName)
        const layer = state.layers.get(p.name)
        if (!layer)
          throw new BridgeRpcError(
            BridgeErrorCode.LayerNotFound,
            `Layer "${p.name}" does not exist`
          )
        if (p.color) layer.color = p.color
        if (p.linetype) {
          if (!state.linetypes.has(p.linetype)) {
            throw new BridgeRpcError(
              BridgeErrorCode.InvalidGeometry,
              `Linetype "${p.linetype}" is not loaded into this drawing.`
            )
          }
          layer.linetype = p.linetype
        }
        if (p.lineweight !== undefined) layer.lineweight = p.lineweight
        if (p.frozen !== undefined) layer.frozen = p.frozen
        if (p.locked !== undefined) layer.locked = p.locked
        if (p.plottable !== undefined) layer.plottable = p.plottable
        if (p.on !== undefined) layer.on = p.on
        return {
          layer
        } satisfies RpcMethodMap[typeof RpcMethod.LayerSetProperties]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.LayerEnsure: {
        const p = params as RpcMethodMap[typeof RpcMethod.LayerEnsure]['params']
        const { state } = this.resolveDoc(p.documentName)
        if (
          p.setCurrent &&
          !state.layers.has(p.setCurrent) &&
          !p.layers.some((e) => e.name === p.setCurrent)
        ) {
          throw new BridgeRpcError(
            BridgeErrorCode.LayerNotFound,
            `Layer "${p.setCurrent}" does not exist`
          )
        }
        const results = p.layers.map((entry) => {
          const existing = state.layers.get(entry.name)
          if (existing) {
            let changed = false
            if (entry.color && !colorSpecEquals(existing.color, entry.color)) {
              existing.color = entry.color
              changed = true
            }
            if (entry.linetype !== undefined && existing.linetype !== entry.linetype) {
              existing.linetype = entry.linetype
              changed = true
            }
            if (entry.lineweight !== undefined && existing.lineweight !== entry.lineweight) {
              existing.lineweight = entry.lineweight
              changed = true
            }
            if (entry.plottable !== undefined && existing.plottable !== entry.plottable) {
              existing.plottable = entry.plottable
              changed = true
            }
            if (entry.on !== undefined && existing.on !== entry.on) {
              existing.on = entry.on
              changed = true
            }
            if (entry.frozen !== undefined && existing.frozen !== entry.frozen) {
              existing.frozen = entry.frozen
              changed = true
            }
            if (entry.locked !== undefined && existing.locked !== entry.locked) {
              existing.locked = entry.locked
              changed = true
            }
            return { ...existing, action: changed ? 'updated' : 'unchanged' } as const
          }
          const layer: LayerInfo = {
            name: entry.name,
            color: entry.color ?? { aci: 7 },
            linetype: entry.linetype ?? 'Continuous',
            lineweight: entry.lineweight ?? -1,
            frozen: entry.frozen ?? false,
            locked: entry.locked ?? false,
            plottable: entry.plottable ?? true,
            on: entry.on ?? true,
            isCurrent: false
          }
          state.layers.set(entry.name, layer)
          return { ...layer, action: 'created' as const }
        })
        if (p.setCurrent) {
          for (const layer of state.layers.values()) layer.isCurrent = layer.name === p.setCurrent
          state.currentLayer = p.setCurrent
        }
        return {
          layers: results
        } satisfies RpcMethodMap[typeof RpcMethod.LayerEnsure]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.LayerRename: {
        const p = params as RpcMethodMap[typeof RpcMethod.LayerRename]['params']
        const { state } = this.resolveDoc(p.documentName)
        const layer = state.layers.get(p.from)
        if (!layer) {
          throw new BridgeRpcError(
            BridgeErrorCode.LayerNotFound,
            `Layer "${p.from}" does not exist`
          )
        }
        if (state.layers.has(p.to)) {
          throw new BridgeRpcError(
            BridgeErrorCode.LayerNameConflict,
            `A layer named "${p.to}" already exists`
          )
        }
        state.layers.delete(p.from)
        layer.name = p.to
        state.layers.set(p.to, layer)
        if (state.currentLayer === p.from) state.currentLayer = p.to
        return {} satisfies RpcMethodMap[typeof RpcMethod.LayerRename]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.LayerDelete: {
        const p = params as RpcMethodMap[typeof RpcMethod.LayerDelete]['params']
        const { state } = this.resolveDoc(p.documentName)
        const layer = state.layers.get(p.name)
        if (!layer) {
          throw new BridgeRpcError(
            BridgeErrorCode.LayerNotFound,
            `Layer "${p.name}" does not exist`
          )
        }
        if (p.name === '0' || p.name === 'Defpoints' || layer.isCurrent) {
          throw new BridgeRpcError(
            BridgeErrorCode.LayerProtected,
            `Layer "${p.name}" is protected and can't be deleted`
          )
        }
        if ([...state.entities.values()].some((e) => e.layer === p.name)) {
          throw new BridgeRpcError(
            BridgeErrorCode.LayerInUse,
            `Layer "${p.name}" has entities on it and can't be deleted`
          )
        }
        state.layers.delete(p.name)
        return {} satisfies RpcMethodMap[typeof RpcMethod.LayerDelete]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityCreate: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityCreate]['params']
        const { state } = this.resolveDoc(p.documentName)
        const entity = this.createEntity(state, p)
        return {
          entity
        } satisfies RpcMethodMap[typeof RpcMethod.EntityCreate]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityList: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityList]['params']
        const { state } = this.resolveDoc(p.documentName)
        const limit = p.limit ?? 100
        if (limit > MAX_ENTITY_LIST_LIMIT) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidGeometry,
            `entity.list accepts a limit of at most ${MAX_ENTITY_LIST_LIMIT} entities per call (got ${limit}).`
          )
        }
        const offset = p.offset ?? 0
        const includeBounds = p.includeBounds ?? true
        const fullDetail = p.detail === 'full'
        // Mirrors the plugin's entity.list (#10): one pass counts every match, but only
        // entities landing on the returned page are materialized, and bounds is included per
        // includeBounds rather than always.
        const page: (EntitySummary | EntityDetail)[] = []
        let total = 0
        for (const entity of state.entities.values()) {
          if (p.layer && entity.layer !== p.layer) continue
          if (p.kind && entity.kind !== p.kind) continue
          // Mirrors the plugin's entity.list `window` filter: bounds-miss skips before counting,
          // an entity with no computable bounds is INCLUDED (never silently dropped).
          if (p.window && entity.bounds) {
            const b = entity.bounds
            const w = p.window
            const intersects =
              b.min.x <= w.max.x && b.max.x >= w.min.x && b.min.y <= w.max.y && b.max.y >= w.min.y
            if (!intersects) continue
          }
          const matchIndex = total
          total++
          if (matchIndex >= offset && page.length < limit) {
            if (fullDetail) {
              const geom = state.entityGeometry.get(entity.handle)!
              page.push(toEntityDetail(entity, geom, state, includeBounds))
            } else {
              page.push(
                includeBounds
                  ? entity
                  : { handle: entity.handle, kind: entity.kind, layer: entity.layer }
              )
            }
          }
        }
        return {
          entities: page,
          total
        } satisfies RpcMethodMap[typeof RpcMethod.EntityList]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityGet: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityGet]['params']
        const { state } = this.resolveDoc(p.documentName)
        const entity = state.entities.get(p.handle)
        if (!entity)
          throw new BridgeRpcError(BridgeErrorCode.EntityNotFound, `Entity "${p.handle}" not found`)
        const full = p.detail === 'full'
        const result: EntitySummary | EntityDetail = full
          ? toEntityDetail(entity, state.entityGeometry.get(p.handle)!, state)
          : entity
        return {
          entity: result,
          // #413 phase B: the bounds-free digest expectedState re-checks (mirrors the plugin's
          // PreImageCanonical.HashDetail on the same payload).
          ...(full && { stateDigest: mockStateDigest(state, p.handle) ?? undefined })
        } satisfies RpcMethodMap[typeof RpcMethod.EntityGet]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityAreaMeasure: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityAreaMeasure]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        const hasScope =
          (p.handles?.length ?? 0) > 0 || p.selection !== undefined || p.window !== undefined
        if (!hasScope)
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidGeometry,
            'entity.areaMeasure needs a scope: handles, selection:"implied", or window.'
          )

        const insUnits = state.drawingSettings.insUnits
        const sqMeters = SQ_METERS_PER_UNIT_SQUARED[insUnits] ?? null
        const wantM2 = p.outputUnit === 'm2'
        const convertedToM2 = wantM2 && sqMeters !== null

        // Scope resolution mirrors the plugin: handles (fast path) > implied > window. The mock has
        // no live selection, so "implied" matches nothing — same empty result the plugin returns
        // when the user has picked nothing.
        let scoped: EntitySummary[]
        if (p.handles?.length) {
          scoped = p.handles.map((handle) => {
            const entity = state.entities.get(handle)
            if (!entity)
              throw new BridgeRpcError(
                BridgeErrorCode.EntityNotFound,
                `Entity "${handle}" not found`
              )
            return entity
          })
        } else if (p.selection === 'implied') {
          scoped = []
        } else {
          const w = p.window!
          scoped = [...state.entities.values()].filter((e) => {
            if (!e.bounds) return true // unmeasurable bounds: include, never silently drop
            return (
              e.bounds.min.x <= w.max.x &&
              e.bounds.max.x >= w.min.x &&
              e.bounds.min.y <= w.max.y &&
              e.bounds.max.y >= w.min.y
            )
          })
        }

        // A closed polyline that is some measured hatch's own boundary is the same region twice —
        // flag it (boundaryOfHandle) rather than dropping it, exactly as the plugin does.
        const boundaryOfHatch = new Map<string, string>()
        for (const e of scoped) {
          const geom = state.entityGeometry.get(e.handle)
          if (geom?.kind !== 'hatch') continue
          for (const h of geom.boundaryHandles ?? []) {
            if (scoped.some((s) => s.handle === h)) boundaryOfHatch.set(h, e.handle)
          }
        }

        const regions: RpcMethodMap[typeof RpcMethod.EntityAreaMeasure]['result']['regions'] = []
        let skippedNonAreaCount = 0
        const regionScope = !p.handles?.length // window/implied → ambiguous for open curves
        for (const e of scoped) {
          const geom = state.entityGeometry.get(e.handle)
          const measured = geom ? mockAreaOf(state, geom) : null
          if (measured) {
            const boundaryOfHandle = boundaryOfHatch.get(e.handle)
            regions.push({
              handle: e.handle,
              kind: e.kind,
              layer: e.layer,
              status: 'measured',
              method:
                e.kind === 'circle'
                  ? 'circle-area'
                  : e.kind === 'hatch'
                    ? 'hatch-area'
                    : 'polyline-area',
              areaDrawingUnits2: measured.area,
              ...(convertedToM2 && { areaM2: measured.area * sqMeters! }),
              ...(measured.perimeter !== undefined && {
                perimeterDrawingUnits: measured.perimeter
              }),
              ...(measured.loopCount !== undefined && { loopCount: measured.loopCount }),
              ...(measured.holeLoopCount !== undefined && {
                holeLoopCount: measured.holeLoopCount
              }),
              ...(boundaryOfHandle && {
                boundaryOfHandle,
                message: `boundary of hatch ${boundaryOfHandle} — its area is the same region; do not add it to the hatch's total.`
              })
            })
            continue
          }
          // No area. Mirrors the plugin's type dispatch: every Curve-derived kind that isn't closed
          // (line, arc, an open polyline) is open_boundary (handle scope) or ambiguous_region
          // (window/implied scope) — a curve that could enclose something but doesn't. Only a
          // genuinely non-curve entity (text, dimension, block reference, point, …) is counted
          // skipped, never emitted as a region.
          const isCurveKind =
            geom &&
            (geom.kind === 'line' ||
              geom.kind === 'arc' ||
              geom.kind === 'polyline' ||
              geom.kind === 'rectangle')
          if (isCurveKind) {
            regions.push({
              handle: e.handle,
              kind: e.kind,
              layer: e.layer,
              status: regionScope ? 'ambiguous_region' : 'open_boundary',
              message: regionScope
                ? 'a region query matched this entity but it carries no area of its own; which enclosed region was meant is ambiguous.'
                : 'this curve is not closed, so it encloses no area — close it or hatch it to measure a region.'
            })
          } else {
            skippedNonAreaCount++
          }
        }

        return {
          documentId: this.idOf(name),
          documentName: name,
          revision: `tdu:${state.revision};saves:${state.saveCount}`,
          insUnits,
          convertedToM2,
          regions,
          skippedNonAreaCount
        } satisfies RpcMethodMap[typeof RpcMethod.EntityAreaMeasure]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityTraceBoundary: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityTraceBoundary]['params']
        // The plugin refuses a non-active document: boundary tracing evaluates the visible view.
        if (p.documentName && p.documentName !== this.activeDocumentName) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'entity.traceBoundary needs the active document — activate the drawing first.'
          )
        }
        const { state } = this.resolveDoc(p.documentName)
        const pt = p.point
        if (!pt) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidGeometry,
            'entity.traceBoundary requires point.'
          )
        }

        const candidates: Array<{ loop: BoundaryLoop; area: number }> = []

        for (const ent of state.entities.values()) {
          const geom = state.entityGeometry.get(ent.handle)
          if (!geom) continue

          let points: Point3d[] = []
          let isClosed = false

          if (geom.kind === 'polyline' && geom.points) {
            points = geom.points.map((vtx) => ({ x: vtx.x, y: vtx.y, z: vtx.z ?? 0 }))
            isClosed = Boolean(geom.closed)
          }

          if (!isClosed || points.length < 3) continue

          // Point-in-polygon ray-casting test
          let inside = false
          for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const a = points[i]!
            const b = points[j]!
            const intersect =
              a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
            if (intersect) inside = !inside
          }

          if (inside) {
            let area = 0
            for (let i = 0; i < points.length; i++) {
              const p = points[i]!
              const q = points[(i + 1) % points.length]!
              area += p.x * q.y
              area -= q.x * p.y
            }
            area = Math.abs(area) / 2

            candidates.push({
              loop: {
                kind: 'outer',
                points,
                area,
                isClosed: true
              },
              area
            })
          }
        }

        if (candidates.length === 0) {
          return {
            found: false,
            boundaries: [],
            netArea: 0,
            coordinateSystem: 'WCS',
            ucsWithWorld: true,
            reason: `No closed polyline in this drawing contains [${pt.x}, ${pt.y}].`
          } satisfies RpcMethodMap[typeof RpcMethod.EntityTraceBoundary]['result'] as RpcMethodMap[M]['result']
        }

        // Innermost containing boundary wins
        candidates.sort((a, b) => a.area - b.area)
        const best = candidates[0]!

        return {
          found: true,
          boundaries: [best.loop],
          netArea: best.area,
          // The mock has no active-UCS frame: it traces World-coordinate polylines directly, matching
          // the plugin's World-UCS path. coordinateSystem is always 'WCS' on the wire.
          coordinateSystem: 'WCS',
          ucsWithWorld: true,
          reason:
            'Traced from closed polylines held by the mock (outer ring only; no island detection).'
        } satisfies RpcMethodMap[typeof RpcMethod.EntityTraceBoundary]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityErase: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityErase]['params']
        const { state } = this.resolveDoc(p.documentName)
        this.guardOwnership(state, p.handles, 'erase')
        const erased = this.eraseEntities(state, p.handles).map((e) => e.handle)
        return {
          erased
        } satisfies RpcMethodMap[typeof RpcMethod.EntityErase]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityCopyTo: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityCopyTo]['params']
        const source = this.resolveDoc(p.documentName)
        const target = this.resolveDoc(p.targetDocumentName)
        if (source.state === target.state)
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidGeometry,
            'Source and target are the same document; use entity transform copy instead.'
          )
        const sources = p.handles.map((handle) => {
          const entity = source.state.entities.get(handle)
          if (!entity)
            throw new BridgeRpcError(BridgeErrorCode.EntityNotFound, `Entity "${handle}" not found`)
          return entity
        })
        const copied = sources.map((entity) => {
          // Like WblockCloneObjects: a layer the target lacks is created by the clone.
          const layer = target.state.layers.get(entity.layer) ?? {
            ...source.state.layers.get(entity.layer)!,
            isCurrent: false
          }
          target.state.layers.set(layer.name, layer)
          target.state.cadAiLayers.add(layer.name)
          const handle = (target.state.handleCounter++).toString(16).toUpperCase()
          const clone: EntitySummary = { handle, kind: entity.kind, layer: entity.layer }
          target.state.entities.set(handle, clone)
          target.state.cadAiOwned.add(handle)
          // Shallow clone, same simplification as `clone`'s missing `bounds` above (#25): the
          // copy's `entityGeometry` is the source's as-is, not re-derived at `delta`'s offset — a
          // `detail: "full"` read of the copy reports the source's original coordinates, not the
          // copy's actual (possibly offset) position. Good enough to keep `detail: "full"` from
          // throwing on a copied entity; real `delta`-aware geometry tracking is future work.
          const sourceGeom = source.state.entityGeometry.get(entity.handle)
          if (sourceGeom) target.state.entityGeometry.set(handle, sourceGeom)
          // WblockCloneObjects deep-clones the full block definition (plus dependent
          // layers/styles) when the entity is a BlockReference — the whole point of the
          // approved symbol-import path (#413 §14 B/C): mirror that here so a copied
          // reference makes the block a DEFINITION in the target, visible to block.list/inspect.
          if (sourceGeom?.kind === 'blockReference') {
            const btr = source.state.blockDefinitions.get(sourceGeom.blockName)
            if (btr && !target.state.blockDefinitions.has(btr.name)) {
              target.state.blockDefinitions.set(btr.name, { ...btr })
            }
          }
          // WblockCloneObjects appends into the TARGET database, so the target's reactors fire
          // created and its revision moves — the source tab is untouched.
          this.recordChange(target.state, handle, 'created')
          return clone
        })
        this.touch(target.state)
        // #413 §11.5: a taskId-tagged copy writes a durable compensating-erase receipt so the whole
        // symbol import rolls back as one operations.revert unit. It sits in the batch ledger
        // (revert reads createdHandles) but is NOT undo-eligible — a cross-document clone has no undo
        // group and must not hijack the apply batch that follows it (#388).
        let receiptBatchId: string | undefined
        if (p.taskId) {
          target.state.batchSequence += 1
          receiptBatchId = `copy_${target.state.batchSequence.toString(16)}`
          target.state.batches.push({
            batchId: receiptBatchId,
            taskId: p.taskId,
            sequence: target.state.batchSequence,
            entityRefs: copied,
            createdHandles: copied.map((c) => c.handle),
            status: 'committed',
            undoEligible: false
          })
        }
        return {
          copied,
          targetDocumentName: target.name,
          ...(receiptBatchId ? { receiptBatchId } : {})
        } satisfies RpcMethodMap[typeof RpcMethod.EntityCopyTo]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityTransform: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityTransform]['params']
        const { state } = this.resolveDoc(p.documentName)
        const affected = this.transformEntities(state, p)
        return {
          affected
        } satisfies RpcMethodMap[typeof RpcMethod.EntityTransform]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EntityUpdate: {
        const p = params as RpcMethodMap[typeof RpcMethod.EntityUpdate]['params']
        const { state } = this.resolveDoc(p.documentName)
        const entity = this.updateEntity(state, p)
        return {
          entity
        } satisfies RpcMethodMap[typeof RpcMethod.EntityUpdate]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.ViewZoomExtents: {
        const p = params as RpcMethodMap[typeof RpcMethod.ViewZoomExtents]['params']
        this.resolveDoc(p.documentName) // validates the target exists; nothing else to simulate
        return {} satisfies RpcMethodMap[typeof RpcMethod.ViewZoomExtents]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.ViewCapture: {
        const p = params as RpcMethodMap[typeof RpcMethod.ViewCapture]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        // The mock can't render; it returns a valid 1x1 PNG so the tool wiring (image block,
        // metadata, error path) is exercised, and frames the window the way the plugin would.
        const wanted = p.handles?.flatMap((h) => state.entities.get(h) ?? []) ?? []
        const framed = p.window ? [] : wanted.length > 0 ? wanted : [...state.entities.values()]
        const boxes = framed.flatMap((e) => e.bounds ?? [])
        if (!p.window && state.entities.size === 0) {
          throw new BridgeRpcError(
            BridgeErrorCode.CaptureFailed,
            'Could not capture the drawing: The drawing has no entities to capture.'
          )
        }
        // The mock keeps no geometry (entities have no bounds), so fall back to a unit window.
        const window = p.window ?? {
          min:
            boxes.length === 0
              ? { x: 0, y: 0, z: 0 }
              : {
                  x: Math.min(...boxes.map((b) => b.min.x)),
                  y: Math.min(...boxes.map((b) => b.min.y)),
                  z: 0
                },
          max:
            boxes.length === 0
              ? { x: 1, y: 1, z: 0 }
              : {
                  x: Math.max(...boxes.map((b) => b.max.x)),
                  y: Math.max(...boxes.map((b) => b.max.y)),
                  z: 0
                }
        }
        return {
          documentName: name,
          mimeType: 'image/png',
          width: p.width ?? 1024,
          height: p.height ?? 768,
          data: MOCK_PNG_BASE64,
          fittedTo: p.window ? 'window' : wanted.length > 0 ? 'entities' : 'drawing',
          window
        } satisfies RpcMethodMap[typeof RpcMethod.ViewCapture]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.ViewSetLive: {
        const p = params as RpcMethodMap[typeof RpcMethod.ViewSetLive]['params']
        const { state } = this.resolveDoc(p.documentName)
        // Merges the given fields over the current (or default) settings and returns the
        // effective result — matches the plugin's LiveView.Set.
        state.liveSettings = {
          follow: p.follow ?? state.liveSettings.follow,
          margin: p.margin ?? state.liveSettings.margin,
          minHeight: p.minHeight ?? state.liveSettings.minHeight,
          animate: p.animate ?? state.liveSettings.animate,
          progressive: p.progressive ?? state.liveSettings.progressive,
          paceMs: p.paceMs ?? state.liveSettings.paceMs
        }
        return {
          ...state.liveSettings
        } satisfies RpcMethodMap[typeof RpcMethod.ViewSetLive]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.ViewGetLive: {
        const p = params as RpcMethodMap[typeof RpcMethod.ViewGetLive]['params']
        const { state } = this.resolveDoc(p.documentName)
        return {
          ...state.liveSettings
        } satisfies RpcMethodMap[typeof RpcMethod.ViewGetLive]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.ViewZoom: {
        const p = params as RpcMethodMap[typeof RpcMethod.ViewZoom]['params']
        const { state } = this.resolveDoc(p.documentName)
        if (p.handles) {
          for (const h of p.handles) {
            if (!state.entities.has(h)) {
              throw new BridgeRpcError(BridgeErrorCode.EntityNotFound, `Entity "${h}" not found`)
            }
          }
        }
        if (p.window) {
          return {
            center: {
              x: (p.window.min.x + p.window.max.x) / 2,
              y: (p.window.min.y + p.window.max.y) / 2,
              z: 0
            },
            height: p.window.max.y - p.window.min.y
          } satisfies RpcMethodMap[typeof RpcMethod.ViewZoom]['result'] as RpcMethodMap[M]['result']
        }
        if (p.center && p.viewHeight) {
          return {
            center: p.center,
            height: p.viewHeight
          } satisfies RpcMethodMap[typeof RpcMethod.ViewZoom]['result'] as RpcMethodMap[M]['result']
        }
        // handles-only, or nothing: the mock keeps no geometry bounds (see view.capture above),
        // so fall back to a unit window the same way.
        return {
          center: { x: 0.5, y: 0.5, z: 0 },
          height: 1
        } satisfies RpcMethodMap[typeof RpcMethod.ViewZoom]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.OperationsApply: {
        const p = params as RpcMethodMap[typeof RpcMethod.OperationsApply]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        // Native revision precondition (#413 phase A): checked before anything else in this call,
        // mirroring the plugin's check before its transaction opens -- zero side effects on a
        // mismatch (nothing in `state` has been touched yet).
        if (p.expectedRevision) {
          const liveRevision = `tdu:${state.revision};saves:${state.saveCount}`
          if (liveRevision !== p.expectedRevision) {
            return {
              executionId: p.idempotencyKey ?? `exec_mock_${state.batchSequence + 1}`,
              status: 'requires_revalidation',
              partial: false,
              entityRefs: [],
              committedBatchIds: [],
              completedPhases: 0,
              totalPhases: 1,
              phases: [],
              error: {
                code: BridgeErrorCode.RevisionConflict,
                message: `Drawing "${name}" changed since the caller's revision was captured (expected ${p.expectedRevision}, now ${liveRevision}) -- re-read and retry.`,
                failedStep: 0
              }
            } satisfies RpcMethodMap[typeof RpcMethod.OperationsApply]['result'] as RpcMethodMap[M]['result']
          }
        }
        const refs: EntitySummary[] = []
        const createdHandles: string[] = []
        const erasedEntities: EntitySummary[] = []
        const modifiedBefore: MockModifiedEntity[] = []
        const modifiedAfter: MockModifiedEntity[] = []
        // #413 phase B: handles skipped for a stale expectedState digest; the batch continues.
        const conflicts: StateConflict[] = []
        // Like the real plugin's single transaction: a failing step rolls back the whole batch.
        const restore = snapshotMockState(state)
        let step = 0
        const stepIdMap = new Map<string, string[]>()
        try {
          for (; step < p.operations.length; step++) {
            const op = p.operations[step]!
            if (op.op === 'create') {
              const created = this.createEntity(state, op.entity)
              refs.push(created)
              createdHandles.push(created.handle)
              if (op.id) stepIdMap.set(op.id, [created.handle])
            } else if (op.op === 'erase') {
              // #413 phase B: stale-digest handles are dropped from this step only.
              const handles = mockPruneStateConflicts(
                state,
                op.handles.flatMap((h) =>
                  h.startsWith('@') ? (stepIdMap.get(h.slice(1)) ?? [h]) : [h]
                ),
                p.expectedState,
                conflicts
              )
              this.guardOwnership(state, handles, 'erase')
              for (const h of handles) {
                const ent = state.entities.get(h)
                if (ent) erasedEntities.push({ ...ent })
              }
              refs.push(...this.eraseEntities(state, handles))
            } else if (op.op === 'transform') {
              // #413 phase B: stale-digest handles stay where the concurrent editor put them.
              const handles = mockPruneStateConflicts(
                state,
                op.transform.handles.flatMap((h) =>
                  h.startsWith('@') ? (stepIdMap.get(h.slice(1)) ?? [h]) : [h]
                ),
                p.expectedState,
                conflicts
              )
              for (const h of handles) {
                const ent = state.entities.get(h)
                if (ent) {
                  const before = mockModifiedEntity(state, h)
                  if (before) modifiedBefore.push(before)
                }
              }
              const transform = {
                ...op.transform,
                handles
              }
              const transformed = this.transformEntities(state, transform)
              refs.push(...transformed)
              for (const t of transformed) {
                const after = mockModifiedEntity(state, t.handle)
                if (after) modifiedAfter.push(after)
              }
            } else if (op.op === 'update') {
              const handle = op.update.handle.startsWith('@')
                ? (stepIdMap.get(op.update.handle.slice(1))?.[0] ?? op.update.handle)
                : op.update.handle
              // #413 phase B: a stale expectedState skips only this update step.
              const expected = mockExpectedStateFor(p.expectedState, handle)
              const actual = expected !== undefined ? mockStateDigest(state, handle) : null
              if (expected !== undefined && actual !== null && expected !== actual) {
                conflicts.push({ handle, expected, actual, reason: 'state_conflict' })
              } else {
                const prior = mockModifiedEntity(state, handle)
                if (prior) modifiedBefore.push(prior)
                const updated = this.updateEntity(state, { ...op.update, handle })
                refs.push({ ...updated })
                const after = mockModifiedEntity(state, handle)
                if (after) modifiedAfter.push(after)
              }
            }
          }
        } catch (err) {
          restore()
          if (err instanceof BridgeRpcError && err.code === BridgeErrorCode.ProtectedEntity) {
            throw err
          }
          // The whole single transaction rolled back, skip decisions included: nothing is reported.
          return {
            status: 'aborted',
            partial: false,
            entityRefs: [],
            committedBatchIds: [],
            error: {
              code: BridgeErrorCode.TransactionFailed,
              message: err instanceof Error ? err.message : String(err),
              failedStep: step,
              ...(err instanceof BridgeRpcError && { causeCode: err.code })
            }
          } satisfies RpcMethodMap[typeof RpcMethod.OperationsApply]['result'] as RpcMethodMap[M]['result']
        }
        state.batchSequence += 1
        const batchId = `batch_${state.batchSequence.toString(16)}`
        state.batches.push({
          batchId,
          taskId: p.taskId,
          sequence: state.batchSequence,
          entityRefs: refs,
          createdHandles,
          erasedEntities,
          modifiedBefore,
          modifiedAfter,
          status: 'committed'
        })
        state.undoneStack.length = 0 // a new action clears the redo stack, matching the real plugin
        return {
          batchId,
          taskId: p.taskId,
          sequence: state.batchSequence,
          status: 'committed',
          partial: false,
          committedBatchIds: [batchId],
          completedPhases: 1,
          totalPhases: 1,
          entityRefs: refs,
          // #413 phase B: handles skipped for a stale fingerprint; everything else committed.
          ...(conflicts.length > 0 && { conflicts }),
          // Like the plugin: a background tab gets no native undo group.
          undo:
            name === this.activeDocumentName
              ? { supported: true, mode: 'native-lifo', state: 'top' }
              : { supported: false, mode: 'unsupported-background', state: 'none' }
        } satisfies RpcMethodMap[typeof RpcMethod.OperationsApply]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.OperationsPreview: {
        const p = params as RpcMethodMap[typeof RpcMethod.OperationsPreview]['params']
        const { state } = this.resolveDoc(p.documentName)
        const refs: EntitySummary[] = []
        const restore = snapshotMockState(state)
        let step = 0
        const stepIdMap = new Map<string, string[]>()
        try {
          for (; step < p.operations.length; step++) {
            const op = p.operations[step]!
            if (op.op === 'create') {
              const created = this.createEntity(state, op.entity)
              refs.push(created)
              if (op.id) stepIdMap.set(op.id, [created.handle])
            } else if (op.op === 'erase') {
              const handles = op.handles.flatMap((h) =>
                h.startsWith('@') ? (stepIdMap.get(h.slice(1)) ?? [h]) : [h]
              )
              this.guardOwnership(state, handles, 'erase')
              refs.push(...this.eraseEntities(state, handles))
            } else if (op.op === 'transform') {
              const transform = {
                ...op.transform,
                handles: op.transform.handles.flatMap((h) =>
                  h.startsWith('@') ? (stepIdMap.get(h.slice(1)) ?? [h]) : [h]
                )
              }
              refs.push(...this.transformEntities(state, transform))
            } else if (op.op === 'update') {
              const handle = op.update.handle.startsWith('@')
                ? (stepIdMap.get(op.update.handle.slice(1))?.[0] ?? op.update.handle)
                : op.update.handle
              refs.push({ ...this.updateEntity(state, { ...op.update, handle }) })
            }
          }

          // Always restore state — preview is a truly read-only dry run.
          restore()

          // Mirror the plugin's combined-extents contract using the mock's per-entity bounds. A mock
          // blockReference bound is only its insertion anchor (the mock does not load block geometry);
          // transformed-footprint regressions therefore use explicit native-preview stubs.
          let extents: { min: Point3d; max: Point3d } | undefined
          for (const ref of refs) {
            if (!ref.bounds) continue
            extents = extents
              ? {
                  min: {
                    x: Math.min(extents.min.x, ref.bounds.min.x),
                    y: Math.min(extents.min.y, ref.bounds.min.y),
                    z: Math.min(extents.min.z, ref.bounds.min.z)
                  },
                  max: {
                    x: Math.max(extents.max.x, ref.bounds.max.x),
                    y: Math.max(extents.max.y, ref.bounds.max.y),
                    z: Math.max(extents.max.z, ref.bounds.max.z)
                  }
                }
              : structuredClone(ref.bounds)
          }

          return {
            valid: true,
            operationCount: p.operations.length,
            entityRefs: refs,
            extents
          } satisfies RpcMethodMap[typeof RpcMethod.OperationsPreview]['result'] as RpcMethodMap[M]['result']
        } catch (err) {
          restore()
          if (err instanceof BridgeRpcError && err.code === BridgeErrorCode.ProtectedEntity) {
            throw err
          }
          return {
            valid: false,
            operationCount: p.operations.length,
            entityRefs: [],
            error: {
              code: BridgeErrorCode.TransactionFailed,
              message: err instanceof Error ? err.message : String(err),
              failedStep: step,
              ...(err instanceof BridgeRpcError && { causeCode: err.code })
            }
          } satisfies RpcMethodMap[typeof RpcMethod.OperationsPreview]['result'] as RpcMethodMap[M]['result']
        }
      }
      case RpcMethod.OperationsRevert: {
        const p = params as RpcMethodMap[typeof RpcMethod.OperationsRevert]['params']
        const { state } = this.resolveDoc(p.documentName)

        if (!p.batchId && !p.taskId) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'Either batchId or taskId must be specified for operations.revert.'
          )
        }

        let targets: MockBatchEntry[] = []
        if (p.batchId) {
          const entry = state.batches.find((b) => b.batchId === p.batchId)
          if (!entry)
            throw new BridgeRpcError(
              BridgeErrorCode.BatchNotFound,
              `Batch "${p.batchId}" not found.`
            )
          if (entry.status === 'reverted') {
            throw new BridgeRpcError(
              BridgeErrorCode.RevertConflict,
              `Batch "${p.batchId}" has already been reverted.`
            )
          }
          targets = [entry]
        } else if (p.taskId) {
          const matching = state.batches.filter((b) => b.taskId === p.taskId)
          if (matching.length === 0) {
            throw new BridgeRpcError(BridgeErrorCode.BatchNotFound, `Task "${p.taskId}" not found.`)
          }
          targets = matching.filter((b) => b.status !== 'reverted').reverse()
          if (targets.length === 0) {
            throw new BridgeRpcError(
              BridgeErrorCode.RevertConflict,
              `All change sets for task "${p.taskId}" have already been reverted.`
            )
          }
        }

        // Step 1: Conflict Check
        for (const target of targets) {
          if (target.createdHandles) {
            for (const h of target.createdHandles) {
              if (!state.entities.has(h)) {
                throw new BridgeRpcError(
                  BridgeErrorCode.RevertConflict,
                  `Entity "${h}" created in batch "${target.batchId}" has since been deleted.`
                )
              }
            }
          }
          if (target.modifiedAfter) {
            for (const {
              handle,
              entity: expectedAfter,
              geometry: expectedGeometry,
              style: expectedStyle
            } of target.modifiedAfter) {
              const current = state.entities.get(handle)
              if (!current) {
                throw new BridgeRpcError(
                  BridgeErrorCode.RevertConflict,
                  `Entity "${handle}" modified in batch "${target.batchId}" has since been deleted.`
                )
              }
              const currentGeometry = state.entityGeometry.get(handle)
              const currentStyle = state.entityStyle.get(handle)
              if (
                JSON.stringify(current) !== JSON.stringify(expectedAfter) ||
                JSON.stringify(currentGeometry) !== JSON.stringify(expectedGeometry) ||
                JSON.stringify(currentStyle) !== JSON.stringify(expectedStyle)
              ) {
                throw new BridgeRpcError(
                  BridgeErrorCode.RevertConflict,
                  `Entity "${handle}" has been modified since batch "${target.batchId}" was committed.`
                )
              }
            }
          }
        }

        // Step 2: Compensating Revert
        const erasedHandles: string[] = []
        const recreatedHandles: string[] = []
        const restoredHandles: string[] = []

        for (const target of targets) {
          if (target.createdHandles) {
            for (const h of target.createdHandles) {
              if (state.entities.delete(h)) {
                state.entityGeometry.delete(h)
                state.entityStyle.delete(h)
                erasedHandles.push(h)
              }
            }
          }

          if (target.erasedEntities) {
            for (const ent of target.erasedEntities) {
              state.entities.set(ent.handle, { ...ent })
              recreatedHandles.push(ent.handle)
            }
          }

          if (target.modifiedBefore) {
            for (const { handle, entity: before, geometry, style } of target.modifiedBefore) {
              const current = state.entities.get(handle)
              if (current) {
                Object.assign(current, before)
                if (geometry) state.entityGeometry.set(handle, structuredClone(geometry))
                if (style) state.entityStyle.set(handle, structuredClone(style))
                else state.entityStyle.delete(handle)
                restoredHandles.push(handle)
              }
            }
          }

          target.status = 'reverted'
        }

        this.touch(state)

        return {
          status: 'reverted',
          batchId: p.batchId,
          taskId: p.taskId,
          revertedChangeSetsCount: targets.length,
          erasedHandles,
          recreatedHandles,
          restoredHandles
        } satisfies RpcMethodMap[typeof RpcMethod.OperationsRevert]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.OperationsUndo: {
        const p = params as RpcMethodMap[typeof RpcMethod.OperationsUndo]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        if (name !== this.activeDocumentName)
          throw new BridgeRpcError(
            BridgeErrorCode.UndoUnsupported,
            `Batch "${p.batchId}" can't be undone or redone here: native undo only works on the active tab`
          )
        const top = this.topBatch(state)
        if (!top)
          throw new BridgeRpcError(
            BridgeErrorCode.BatchNotFound,
            `Batch "${p.batchId}" is unknown to this document's journal`
          )
        if (top.batchId !== p.batchId) {
          throw new BridgeRpcError(
            BridgeErrorCode.UndoNotTop,
            `Batch "${p.batchId}" is not the top of this document's MCP undo journal`
          )
        }
        top.status = 'undone'
        state.undoneStack.push(top.batchId)
        return {
          batchId: p.batchId,
          status: 'undone'
        } satisfies RpcMethodMap[typeof RpcMethod.OperationsUndo]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.OperationsRedo: {
        const p = params as RpcMethodMap[typeof RpcMethod.OperationsRedo]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        if (name !== this.activeDocumentName)
          throw new BridgeRpcError(
            BridgeErrorCode.UndoUnsupported,
            `Batch "${p.batchId}" can't be undone or redone here: native undo only works on the active tab`
          )
        const candidateId = state.undoneStack[state.undoneStack.length - 1]
        const entry = state.batches.find((b) => b.batchId === p.batchId)
        if (!entry)
          throw new BridgeRpcError(
            BridgeErrorCode.BatchNotFound,
            `Batch "${p.batchId}" is unknown to this document's journal`
          )
        if (candidateId !== p.batchId) {
          throw new BridgeRpcError(
            BridgeErrorCode.UndoNotTop,
            `Batch "${p.batchId}" is not the most recently undone MCP batch`
          )
        }
        entry.status = 'committed'
        state.undoneStack.pop()
        return {
          batchId: p.batchId,
          status: 'redone'
        } satisfies RpcMethodMap[typeof RpcMethod.OperationsRedo]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.OperationsHistory: {
        const p = params as RpcMethodMap[typeof RpcMethod.OperationsHistory]['params']
        const { state } = this.resolveDoc(p.documentName)
        const limit = p.limit ?? 20
        const filtered = p.taskId
          ? state.batches.filter((b) => b.taskId === p.taskId)
          : state.batches
        const batches = [...filtered]
          .reverse()
          .slice(0, limit)
          .map((b) => ({
            batchId: b.batchId,
            taskId: b.taskId,
            sequence: b.sequence,
            operationCount: b.entityRefs.length,
            entityRefs: b.entityRefs,
            status: b.status
          }))
        return {
          batches
        } satisfies RpcMethodMap[typeof RpcMethod.OperationsHistory]['result'] as RpcMethodMap[M]['result']
      }
      case RpcMethod.StyleLinetypesList: {
        const p = params as RpcMethodMap[typeof RpcMethod.StyleLinetypesList]['params']
        const { state } = this.resolveDoc(p.documentName)
        return {
          linetypes: [...state.linetypes.values()]
        } satisfies RpcMethodMap[typeof RpcMethod.StyleLinetypesList]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.StyleLinetypesLoad: {
        const p = params as RpcMethodMap[typeof RpcMethod.StyleLinetypesLoad]['params']
        const { state } = this.resolveDoc(p.documentName)
        const loaded: string[] = []
        const alreadyLoaded: string[] = []
        for (const name of p.names) {
          if (state.linetypes.has(name)) {
            alreadyLoaded.push(name)
            continue
          }
          // The mock has no real .lin file to parse — any not-yet-loaded name "loads" successfully,
          // matching Database.LoadLineTypeFile's own idempotent, name-only contract.
          state.linetypes.set(name, {
            name,
            description: `Loaded from ${p.file ?? 'acadiso.lin'}`
          })
          loaded.push(name)
        }
        return {
          loaded,
          alreadyLoaded
        } satisfies RpcMethodMap[typeof RpcMethod.StyleLinetypesLoad]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.StyleTextStylesList: {
        const p = params as RpcMethodMap[typeof RpcMethod.StyleTextStylesList]['params']
        const { state } = this.resolveDoc(p.documentName)
        return {
          textStyles: [...state.textStyles.values()]
        } satisfies RpcMethodMap[typeof RpcMethod.StyleTextStylesList]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.StyleTextStylesCreate: {
        const p = params as StyleTextStylesCreateParams
        const { state } = this.resolveDoc(p.documentName)
        const existing = state.textStyles.get(p.name)
        if (existing && !p.update) {
          throw new BridgeRpcError(
            BridgeErrorCode.StyleNameConflict,
            `A text style named "${p.name}" already exists`
          )
        }
        const textStyle: TextStyleInfo = {
          name: p.name,
          font: p.trueTypeFace ? '' : p.font,
          height: p.height,
          widthFactor: p.widthFactor,
          obliqueAngle: p.obliqueAngle,
          isCurrent: existing?.isCurrent ?? false,
          isTrueType: Boolean(p.trueTypeFace),
          typeface: p.trueTypeFace,
          bold: p.bold ?? false,
          italic: p.italic ?? false,
          charSet: p.charSet ?? 0,
          pitchAndFamily: p.pitchAndFamily ?? 34
        }
        state.textStyles.set(p.name, textStyle)
        return {
          textStyle,
          created: !existing
        } satisfies RpcMethodMap[typeof RpcMethod.StyleTextStylesCreate]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.StyleTextStylesSetCurrent: {
        const p = params as RpcMethodMap[typeof RpcMethod.StyleTextStylesSetCurrent]['params']
        const { state } = this.resolveDoc(p.documentName)
        if (!state.textStyles.has(p.name)) {
          throw new BridgeRpcError(
            BridgeErrorCode.StyleNotFound,
            `Text style "${p.name}" not found`
          )
        }
        for (const style of state.textStyles.values()) style.isCurrent = style.name === p.name
        return {} satisfies RpcMethodMap[typeof RpcMethod.StyleTextStylesSetCurrent]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.StyleDimStylesList: {
        const p = params as RpcMethodMap[typeof RpcMethod.StyleDimStylesList]['params']
        const { state } = this.resolveDoc(p.documentName)
        return {
          dimStyles: [...state.dimStyles.values()]
        } satisfies RpcMethodMap[typeof RpcMethod.StyleDimStylesList]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.StyleDimStylesCreate: {
        const p = params as StyleDimStylesCreateParams
        const { state } = this.resolveDoc(p.documentName)
        const existing = state.dimStyles.get(p.name)
        if (existing && !p.update) {
          throw new BridgeRpcError(
            BridgeErrorCode.StyleNameConflict,
            `A dimension style named "${p.name}" already exists`
          )
        }
        if (p.basedOn && !state.dimStyles.has(p.basedOn)) {
          throw new BridgeRpcError(
            BridgeErrorCode.StyleNotFound,
            `Dimension style "${p.basedOn}" (basedOn) not found`
          )
        }
        const dimStyle: DimStyleInfo = {
          name: p.name,
          textHeight: p.textHeight,
          arrowSize: p.arrowSize,
          extensionOffset: p.extensionOffset,
          extensionBeyond: p.extensionBeyond,
          decimalPlaces: p.decimalPlaces,
          unitsFormat: p.unitsFormat,
          scale: p.scale,
          isCurrent: existing?.isCurrent ?? false
        }
        state.dimStyles.set(p.name, dimStyle)
        return {
          dimStyle,
          created: !existing
        } satisfies RpcMethodMap[typeof RpcMethod.StyleDimStylesCreate]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.StyleDimStylesSetCurrent: {
        const p = params as RpcMethodMap[typeof RpcMethod.StyleDimStylesSetCurrent]['params']
        const { state } = this.resolveDoc(p.documentName)
        if (!state.dimStyles.has(p.name)) {
          throw new BridgeRpcError(
            BridgeErrorCode.StyleNotFound,
            `Dimension style "${p.name}" not found`
          )
        }
        for (const style of state.dimStyles.values()) style.isCurrent = style.name === p.name
        return {} satisfies RpcMethodMap[typeof RpcMethod.StyleDimStylesSetCurrent]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.BlockInspect: {
        const p = params as RpcMethodMap[typeof RpcMethod.BlockInspect]['params']
        const { state } = this.resolveDoc(p.documentName)
        let blockName = p.blockName
        let handle: string | undefined
        let layer: string | undefined
        let layerLocked: boolean | undefined

        if (p.handle) {
          const entity = state.entities.get(p.handle)
          if (!entity) {
            throw new BridgeRpcError(
              BridgeErrorCode.EntityNotFound,
              `Entity "${p.handle}" not found`
            )
          }
          if (entity.kind !== 'blockReference') {
            throw new BridgeRpcError(
              BridgeErrorCode.InvalidOperation,
              `Entity "${p.handle}" is a ${entity.kind}, not a blockReference`
            )
          }
          const geom = state.entityGeometry.get(p.handle)
          blockName = geom?.kind === 'blockReference' ? geom.blockName : undefined
          handle = p.handle
          layer = entity.layer
          const layerInfo = state.layers.get(entity.layer)
          layerLocked = layerInfo?.locked ?? false
        }

        if (!blockName) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'Either blockName or handle must be provided'
          )
        }

        const btr = state.blockDefinitions.get(blockName)
        if (!btr) {
          throw new BridgeRpcError(
            BridgeErrorCode.BlockNotFound,
            `Block "${blockName}" not found in this drawing`
          )
        }

        let referenceCount = 0
        for (const ent of state.entities.values()) {
          if (ent.kind === 'blockReference') {
            const geom = state.entityGeometry.get(ent.handle)
            if (geom?.kind === 'blockReference' && geom.blockName === blockName) {
              referenceCount++
            }
          }
        }

        return {
          name: btr.name,
          explodable: btr.explodable,
          isDynamic: btr.isDynamic,
          isAnonymous: btr.isAnonymous,
          isLayout: btr.isLayout,
          isXref: btr.isXref,
          description: btr.description,
          referenceCount,
          handle,
          layer,
          layerLocked,
          // The mock's definitions carry only their flags (entity.create does not populate a
          // BlockTableRecord), so an honest census is empty — never a fabricated contents list.
          contents: p.includeContents
            ? { entityCount: 0, kinds: [], texts: [], nestedBlocks: [], truncated: false }
            : undefined,
          instanceAttributes: p.includeContents && handle ? [] : undefined
        } satisfies RpcMethodMap[typeof RpcMethod.BlockInspect]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.BlockSetExplodable: {
        const p = params as RpcMethodMap[typeof RpcMethod.BlockSetExplodable]['params']
        const { state } = this.resolveDoc(p.documentName)
        let blockName = p.blockName

        if (p.handle) {
          const entity = state.entities.get(p.handle)
          if (!entity) {
            throw new BridgeRpcError(
              BridgeErrorCode.EntityNotFound,
              `Entity "${p.handle}" not found`
            )
          }
          if (entity.kind !== 'blockReference') {
            throw new BridgeRpcError(
              BridgeErrorCode.InvalidOperation,
              `Entity "${p.handle}" is a ${entity.kind}, not a blockReference`
            )
          }
          const geom = state.entityGeometry.get(p.handle)
          blockName = geom?.kind === 'blockReference' ? geom.blockName : undefined
        }

        if (!blockName) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'Either blockName or handle must be provided'
          )
        }

        const btr = state.blockDefinitions.get(blockName)
        if (!btr) {
          throw new BridgeRpcError(
            BridgeErrorCode.BlockNotFound,
            `Block "${blockName}" not found in this drawing`
          )
        }

        if (btr.isLayout || btr.isXref) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'This block definition cannot be modified.'
          )
        }

        let referenceCount = 0
        for (const ent of state.entities.values()) {
          if (ent.kind === 'blockReference') {
            const geom = state.entityGeometry.get(ent.handle)
            if (geom?.kind === 'blockReference' && geom.blockName === btr.name) {
              referenceCount++
            }
          }
        }

        if (!p.sharedScope) {
          throw new BridgeRpcError(
            BridgeErrorCode.SharedDefinitionScopeRequired,
            `Block "${btr.name}" has ${referenceCount} reference(s). Mutating its definition requires explicit sharedScope: true.`,
            { blockName: btr.name, referenceCount }
          )
        }

        const previousExplodable = btr.explodable
        const changed = previousExplodable !== p.explodable
        if (changed) {
          btr.explodable = p.explodable
          this.touch(state)
        }

        return {
          success: true,
          blockName: btr.name,
          previousExplodable,
          explodable: btr.explodable,
          changed,
          affectedReferenceCount: referenceCount
        } satisfies RpcMethodMap[typeof RpcMethod.BlockSetExplodable]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.BlockList: {
        const p = params as RpcMethodMap[typeof RpcMethod.BlockList]['params']
        const { state } = this.resolveDoc(p.documentName)
        const blocks: RpcMethodMap[typeof RpcMethod.BlockInspect]['result'][] = []

        for (const btr of state.blockDefinitions.values()) {
          if (!p.includeLayouts && btr.isLayout) continue
          if (!p.includeAnonymous && btr.isAnonymous) continue
          if (!p.includeXrefs && btr.isXref) continue

          let referenceCount = 0
          for (const ent of state.entities.values()) {
            if (ent.kind === 'blockReference') {
              const geom = state.entityGeometry.get(ent.handle)
              if (geom?.kind === 'blockReference' && geom.blockName === btr.name) {
                referenceCount++
              }
            }
          }

          blocks.push({
            name: btr.name,
            explodable: btr.explodable,
            isDynamic: btr.isDynamic,
            isAnonymous: btr.isAnonymous,
            isLayout: btr.isLayout,
            isXref: btr.isXref,
            description: btr.description,
            referenceCount
          })
        }

        return {
          blocks
        } satisfies RpcMethodMap[typeof RpcMethod.BlockList]['result'] as RpcMethodMap[M]['result']
      }
      case RpcMethod.BlockExplode: {
        const p = params as RpcMethodMap[typeof RpcMethod.BlockExplode]['params']
        const { state } = this.resolveDoc(p.documentName)
        const ent = state.entities.get(p.handle)
        if (!ent || ent.kind !== 'blockReference') {
          throw new BridgeRpcError(
            BridgeErrorCode.EntityNotFound,
            `Entity "${p.handle}" is not a BlockReference`
          )
        }
        const geom = state.entityGeometry.get(p.handle)
        const blockName = geom?.kind === 'blockReference' ? geom.blockName : 'mock_block'
        const btr = state.blockDefinitions.get(blockName)

        if (btr && !btr.explodable) {
          if (btr.name.includes('__CadAI_')) {
            btr.explodable = true
          } else {
            let referenceCount = 0
            for (const otherEnt of state.entities.values()) {
              if (otherEnt.kind === 'blockReference') {
                const otherGeom = state.entityGeometry.get(otherEnt.handle)
                if (otherGeom?.kind === 'blockReference' && otherGeom.blockName === btr.name) {
                  referenceCount++
                }
              }
            }
            throw new BridgeRpcError(
              BridgeErrorCode.SharedDefinitionScopeRequired,
              `The block definition "${btr.name}" is marked not explodable. Modifying Explodable would affect all references. Use block.uniquify to isolate this instance or setExplodable with sharedScope: true.`,
              { blockName: btr.name, referenceCount }
            )
          }
        }

        if (!state.cadAiOwned.has(p.handle)) {
          throw new BridgeRpcError(
            BridgeErrorCode.ProtectedEntity,
            `Cannot explode protected block reference "${p.handle}": user geometry not created by CadAI is protected. Use the human-approved edit flow (edit.begin → edit.accept) or ask the user to delete it in AutoCAD.`,
            { handles: [p.handle], count: 1 }
          )
        }
        state.entities.delete(p.handle)
        state.entityGeometry.delete(p.handle)
        state.entityStyle.delete(p.handle)
        state.cadAiOwned.delete(p.handle)
        this.recordChange(state, p.handle, 'erased')
        this.touch(state)
        this.flushChanges(state)
        return {
          success: true,
          handle: p.handle,
          blockName,
          explodedCount: 0,
          explodedHandles: []
        } satisfies RpcMethodMap[typeof RpcMethod.BlockExplode]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.BlockUniquify: {
        const p = params as RpcMethodMap[typeof RpcMethod.BlockUniquify]['params']
        const { state } = this.resolveDoc(p.documentName)
        const ent = state.entities.get(p.handle)
        if (!ent || ent.kind !== 'blockReference') {
          throw new BridgeRpcError(
            BridgeErrorCode.EntityNotFound,
            `Entity "${p.handle}" is not a BlockReference`
          )
        }

        const layer = state.layers.get(ent.layer)
        if (layer?.locked) {
          throw new BridgeRpcError(
            BridgeErrorCode.BlockUniquifyUnsupported,
            `The block reference is on locked layer "${ent.layer}".`,
            { blockName: ent.handle, reason: 'layer locked' }
          )
        }

        const geom = state.entityGeometry.get(p.handle)
        if (geom?.kind !== 'blockReference') {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidGeometry,
            `Entity "${p.handle}" has invalid geometry for blockReference`
          )
        }

        const origName = geom.blockName
        const btr = state.blockDefinitions.get(origName)
        if (!btr) {
          throw new BridgeRpcError(
            BridgeErrorCode.BlockNotFound,
            `Block "${origName}" not found in this drawing`
          )
        }

        if (btr.isLayout || btr.isXref) {
          throw new BridgeRpcError(
            BridgeErrorCode.BlockUniquifyUnsupported,
            'Layout, Xref, and Overlay definitions cannot be uniquified.',
            { blockName: origName, reason: 'layout or xref' }
          )
        }

        if (btr.isAnonymous || btr.isDynamic || origName.startsWith('*U')) {
          throw new BridgeRpcError(
            BridgeErrorCode.BlockUniquifyUnsupported,
            'Dynamic or anonymous block definitions cannot be safely uniquified.',
            { blockName: origName, reason: 'dynamic or anonymous' }
          )
        }

        let refCountBefore = 0
        for (const otherEnt of state.entities.values()) {
          if (otherEnt.kind === 'blockReference') {
            const otherGeom = state.entityGeometry.get(otherEnt.handle)
            if (otherGeom?.kind === 'blockReference' && otherGeom.blockName === origName) {
              refCountBefore++
            }
          }
        }

        let newName = p.newName?.trim()
        if (newName) {
          if (state.blockDefinitions.has(newName)) {
            throw new BridgeRpcError(
              BridgeErrorCode.InvalidOperation,
              `Block definition "${newName}" already exists.`
            )
          }
        } else {
          const suffix = Math.random().toString(36).substring(2, 8).toUpperCase()
          newName = `${origName}__CadAI_${suffix}`
        }

        state.blockDefinitions.set(newName, {
          name: newName,
          explodable: btr.explodable,
          isDynamic: false,
          isAnonymous: false,
          isLayout: false,
          isXref: false,
          description: `CadAI isolated clone of ${origName}`
        })

        geom.blockName = newName
        this.recordChange(state, p.handle, 'modified')
        this.touch(state)
        this.flushChanges(state)

        const refCountAfter = Math.max(0, refCountBefore - 1)

        return {
          success: true,
          handle: p.handle,
          originalDefinitionName: origName,
          newDefinitionName: newName,
          referenceCountBefore: refCountBefore,
          referenceCountAfter: refCountAfter
        } satisfies RpcMethodMap[typeof RpcMethod.BlockUniquify]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.BlockEnsureDefinition: {
        const p = params as RpcMethodMap[typeof RpcMethod.BlockEnsureDefinition]['params']
        const { state } = this.resolveDoc(p.documentName)
        const existing = state.blockDefinitions.get(p.blockName)
        if (existing) {
          return {
            created: false,
            handle: (state.handleCounter - 1).toString(16).toUpperCase()
          } satisfies RpcMethodMap[typeof RpcMethod.BlockEnsureDefinition]['result'] as RpcMethodMap[M]['result']
        }
        const handle = (state.handleCounter++).toString(16).toUpperCase()
        state.blockDefinitions.set(p.blockName, {
          name: p.blockName,
          explodable: true,
          isDynamic: false,
          isAnonymous: false,
          isLayout: false,
          isXref: false,
          description: `Aleph-built definition (${p.entities.length} entities)`
        })
        this.touch(state)
        return {
          created: true,
          handle
        } satisfies RpcMethodMap[typeof RpcMethod.BlockEnsureDefinition]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.CadScan: {
        const p = params as RpcMethodMap[typeof RpcMethod.CadScan]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        // Mirrors CadStateHandlers.Scan: default 500/page, hard cap 2000, offset clamped to >= 0.
        const limit = p.limit && p.limit > 0 ? Math.min(p.limit, 2000) : DEFAULT_SCAN_LIMIT
        const offset = p.offset && p.offset > 0 ? p.offset : 0
        const fullDetail = p.detail === 'full'
        // One pass counts every match; only entities landing on the page are materialized —
        // same posture as entity.list (#10).
        const entities: RpcMethodMap[typeof RpcMethod.CadScan]['result']['entities'] = []
        let total = 0
        const handlesSet = p.handles && p.handles.length > 0 ? new Set(p.handles) : null
        for (const entity of state.entities.values()) {
          if (handlesSet && !handlesSet.has(entity.handle)) continue
          if (p.layer && entity.layer !== p.layer) continue
          if (p.kind && entity.kind !== p.kind) continue
          const matchIndex = total
          total++
          if (matchIndex >= offset && entities.length < limit) {
            entities.push(toScanEntity(state, entity, fullDetail))
          }
        }
        // Manifest scopes ride on the FIRST page only, exactly like the plugin: a scan that pages
        // through a 100k-entity drawing pays for the inventory once, not once per page.
        let layers: { name: string; count: number }[] | undefined
        let xrefs:
          | Array<{
              name: string
              status: 'resolved' | 'unloaded' | 'unreferenced' | 'fileNotFound' | 'unresolved'
            }>
          | undefined
        let layouts: Array<{ name: string; isModel: boolean }> | undefined
        if (offset === 0) {
          const layerCounts = new Map<string, number>()
          for (const layer of state.layers.keys()) layerCounts.set(layer, 0)
          for (const entity of state.entities.values())
            layerCounts.set(entity.layer, (layerCounts.get(entity.layer) ?? 0) + 1)
          layers = [...layerCounts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([lname, count]) => ({ name: lname, count }))
          // The mock has no xrefs and one Model layout, same as its documents (see DrawingSummary).
          xrefs = []
          layouts = [{ name: 'Model', isModel: true }]
        }
        const revision = `tdu:${state.revision};saves:${state.saveCount}`
        return {
          documentId: this.idOf(name),
          name,
          path: state.path,
          fingerprintGuid: state.fingerprintGuid,
          // The mock has no concurrent editor, so the page always brackets equal revisions — the
          // mid-scan-edit discard path is exercised in the cloud tests by mutating between pages.
          revisionBefore: revision,
          revisionAfter: revision,
          insUnits: state.drawingSettings.insUnits,
          total,
          offset,
          hasMore: offset + entities.length < total,
          entities,
          layers,
          xrefs,
          layouts
        } satisfies RpcMethodMap[typeof RpcMethod.CadScan]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.CadChanges: {
        const p = params as RpcMethodMap[typeof RpcMethod.CadChanges]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        const after = p.afterSequence ?? 0
        const limit = p.limit && p.limit > 0 ? p.limit : 200
        // Since() flushes pending handles first so a read never reports a stale watermark.
        this.flushChanges(state)
        const changes: RpcMethodMap[typeof RpcMethod.CadChanges]['result']['changes'] = []
        let hasMore = false
        for (const record of state.changeEvents) {
          if (record.sequence <= after) continue
          if (changes.length >= limit) {
            hasMore = true
            break
          }
          const dto: RpcMethodMap[typeof RpcMethod.CadChanges]['result']['changes'][number] = {
            sequence: record.sequence,
            operation: record.operation,
            handles: record.handles,
            timestamp: record.timestamp,
            truncated: record.truncated
          }
          // A single-handle create/modify carries its re-read row inline (full detail), so Cloud
          // indexes the delta without a second entity.get per handle. Multi-handle batches up to
          // 200 handles populate entities inline.
          if (record.operation === 'created' || record.operation === 'modified') {
            if (record.handles.length === 1) {
              const entity = state.entities.get(record.handles[0]!)
              if (entity) dto.entity = toScanEntity(state, entity, true)
            } else if (record.handles.length > 1 && record.handles.length <= 200) {
              const entities: RpcMethodMap[typeof RpcMethod.CadScan]['result']['entities'] = []
              for (const h of record.handles) {
                const entity = state.entities.get(h)
                if (entity) entities.push(toScanEntity(state, entity, true))
              }
              if (entities.length > 0) dto.entities = entities
            }
          }
          changes.push(dto)
        }
        return {
          documentId: this.idOf(name),
          revision: `tdu:${state.revision};saves:${state.saveCount}`,
          generation: `mock:${this.idOf(name)}`,
          earliestSequence: state.changeEvents[0]?.sequence ?? 0,
          latestSequence: state.changeSequence,
          changes,
          hasMore
        } satisfies RpcMethodMap[typeof RpcMethod.CadChanges]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EditBegin: {
        const p = params as RpcMethodMap[typeof RpcMethod.EditBegin]['params']
        const { name, state } = this.resolveDoc(p.documentName)

        let handles: string[]
        if (p.handles && p.handles.length > 0) {
          handles = p.handles
        } else if (p.selection === 'implied') {
          handles = [...state.selectedHandles]
        } else {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'Either handles or selection: "implied" must be provided.'
          )
        }

        if (handles.length === 0) {
          throw new BridgeRpcError(
            BridgeErrorCode.InvalidOperation,
            'No entities resolved for edit.begin.'
          )
        }

        const sourceEntities: EntitySummary[] = []
        const sourceGeoms: CreateEntityParams[] = []

        for (const handle of handles) {
          const entity = state.entities.get(handle)
          if (!entity) {
            throw new BridgeRpcError(BridgeErrorCode.EntityNotFound, `Entity "${handle}" not found`)
          }

          const layer = state.layers.get(entity.layer)
          if (layer?.locked) {
            throw new BridgeRpcError(
              BridgeErrorCode.LayerProtected,
              `Layer "${entity.layer}" is protected and can't be deleted or modified.`
            )
          }

          const geom = state.entityGeometry.get(handle)
          if (!geom) {
            throw new BridgeRpcError(
              BridgeErrorCode.EditNotRestorable,
              `Entity "${handle}" has no geometry recorded and cannot be edited.`
            )
          }

          if (geom.kind === 'blockReference') {
            const btr = state.blockDefinitions.get(geom.blockName)
            if (btr?.isXref) {
              throw new BridgeRpcError(
                BridgeErrorCode.InvalidOperation,
                `Entity "${handle}" is an external reference and cannot be edited.`
              )
            }
            if (btr?.isAnonymous) {
              throw new BridgeRpcError(
                BridgeErrorCode.InvalidOperation,
                `Entity "${handle}" is an anonymous block reference and cannot be edited.`
              )
            }
          }

          if (entity.kind === 'hatch' || geom.kind === 'hatch') {
            throw new BridgeRpcError(
              BridgeErrorCode.EditNotRestorable,
              `Entity "${handle}" of kind "hatch" is not restorable: entity.get reads a hatch's boundary as loop count/types only (no vertices, no boundary handles), but entity.create requires boundaryHandles or loops — the captured pre-image can never re-establish the boundary.`
            )
          }
          if (entity.kind === 'other') {
            throw new BridgeRpcError(
              BridgeErrorCode.EditNotRestorable,
              `Entity "${handle}" of kind "other" is not restorable: geometry.dxfName is the only thing read back, and entity.create rejects that kind outright.`
            )
          }
          const rawGeom = geom as Record<string, unknown>
          if (
            geom.kind === 'mtext' &&
            typeof rawGeom.rotation === 'number' &&
            Math.abs(rawGeom.rotation) > 1e-9
          ) {
            throw new BridgeRpcError(
              BridgeErrorCode.EditNotRestorable,
              `Entity "${handle}" of kind "mtext" is not restorable: entity.get reads MText rotation but entity.create and entity.update never set it — a rotated MText cannot be rebuilt at its original angle.`
            )
          }
          if (
            geom.kind === 'dimension.ordinate' &&
            typeof rawGeom.text === 'string' &&
            rawGeom.text.length > 0
          ) {
            throw new BridgeRpcError(
              BridgeErrorCode.EditNotRestorable,
              `Entity "${handle}" of kind "dimension.ordinate" is not restorable: entity.get reads an ordinate dimension's text override but entity.create passes null text, so the override is lost.`
            )
          }

          sourceEntities.push(entity)
          sourceGeoms.push(geom)
        }

        const editId = `edit_${randomUUID().replace(/-/g, '')}`
        const candidateLayer = `CadAI-Candidate-${editId}`

        if (!state.layers.has(candidateLayer)) {
          state.layers.set(candidateLayer, {
            name: candidateLayer,
            color: { aci: 30 },
            linetype: 'Continuous',
            lineweight: -1,
            frozen: false,
            locked: false,
            plottable: true,
            on: true,
            isCurrent: false
          })
        }

        let revisionAtCapture = ''
        const candidates: EntityRef[] = []
        const preImages: EntityPreImage[] = []
        const unsupportedFeatures: string[] = []

        for (let i = 0; i < sourceEntities.length; i++) {
          const entity = sourceEntities[i]!
          const geom = sourceGeoms[i]!

          const detail = toEntityDetail(entity, geom, state, true)
          preImages.push({
            detail,
            revisionAtCapture,
            document: {
              documentId: this.idOf(name),
              fingerprintGuid: state.fingerprintGuid,
              path: state.path
            },
            capturedAtUtc: new Date().toISOString()
          })

          if (geom.kind === 'blockReference') {
            unsupportedFeatures.push(
              'blockReference.definition',
              'blockReference.attributeGeometry'
            )
          } else if (geom.kind.startsWith('dimension.')) {
            unsupportedFeatures.push('dimension.dimStyle')
          }

          const candidateHandle = (state.handleCounter++).toString(16).toUpperCase()
          const candidateSummary: EntitySummary = {
            handle: candidateHandle,
            kind: entity.kind,
            layer: candidateLayer,
            bounds: entity.bounds ? structuredClone(entity.bounds) : undefined
          }
          state.entities.set(candidateHandle, candidateSummary)
          state.entityGeometry.set(candidateHandle, structuredClone(geom))
          state.cadAiOwned.add(candidateHandle)

          candidates.push({
            handle: candidateHandle,
            kind: entity.kind,
            layer: candidateLayer
          })

          this.recordChange(state, candidateHandle, 'created')
        }

        this.touch(state)
        this.flushChanges(state)

        revisionAtCapture = `tdu:${state.revision};saves:${state.saveCount}`
        for (const pi of preImages) {
          pi.revisionAtCapture = revisionAtCapture
        }

        const distinctUnsupported = [...new Set(unsupportedFeatures)]

        state.editSessions.set(editId, {
          editId,
          documentName: name,
          documentIdentity: this.idOf(name),
          revisionAtCapture,
          candidateLayer,
          candidates,
          preImages,
          unsupportedFeatures: distinctUnsupported
        })

        return {
          editId,
          documentIdentity: this.idOf(name),
          revisionAtCapture,
          preImages,
          candidates,
          candidateLayer,
          unsupportedFeatures: distinctUnsupported
        } satisfies RpcMethodMap[typeof RpcMethod.EditBegin]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EditApply: {
        const p = params as RpcMethodMap[typeof RpcMethod.EditApply]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        const session = state.editSessions.get(p.editId)
        if (!session) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditNotFound,
            `Edit session "${p.editId}" was not found.`
          )
        }

        // Confinement check: every modified/erased handle must be a candidate in this session;
        // create operations must target candidateLayer.
        const candidateHandles = new Set(session.candidates.map((c) => c.handle))

        for (const op of p.operations) {
          if (op.op === 'create') {
            if (op.entity) {
              if (!op.entity.layer) {
                op.entity.layer = session.candidateLayer
              } else if (op.entity.layer !== session.candidateLayer) {
                throw new BridgeRpcError(
                  BridgeErrorCode.EditConflict,
                  `Create operation must target candidate layer "${session.candidateLayer}", got "${op.entity.layer}".`
                )
              }
            }
          } else if (op.op === 'erase') {
            if (op.handles) {
              for (const h of op.handles) {
                if (h.startsWith('@')) continue
                if (!candidateHandles.has(h)) {
                  throw new BridgeRpcError(
                    BridgeErrorCode.EditConflict,
                    `Operation targets handle "${h}" which is not a candidate in edit session "${session.editId}".`
                  )
                }
              }
            }
          } else if (op.op === 'transform') {
            if (op.transform?.handles) {
              for (const h of op.transform.handles) {
                if (h.startsWith('@')) continue
                if (!candidateHandles.has(h)) {
                  throw new BridgeRpcError(
                    BridgeErrorCode.EditConflict,
                    `Transform targets handle "${h}" which is not a candidate in edit session "${session.editId}".`
                  )
                }
              }
            }
          } else if (op.op === 'update') {
            if (!candidateHandles.has(op.update.handle)) {
              throw new BridgeRpcError(
                BridgeErrorCode.EditConflict,
                `Update targets handle "${op.update.handle}" which is not a candidate in edit session "${session.editId}".`
              )
            }
          }
        }

        // Dispatch via OperationsApply logic
        const applyResult = (await this.dispatchRequest(RpcMethod.OperationsApply, {
          operations: p.operations,
          documentName: p.documentName,
          idempotencyKey: p.idempotencyKey,
          view: p.view,
          progressive: p.progressive,
          paceMs: p.paceMs
        })) as RpcMethodMap[typeof RpcMethod.OperationsApply]['result']

        // Add newly created entities to candidate set
        for (const ref of applyResult.entityRefs) {
          if (!candidateHandles.has(ref.handle)) {
            session.candidates.push({ handle: ref.handle, kind: ref.kind, layer: ref.layer })
            candidateHandles.add(ref.handle)
          }
        }

        const revisionNow = `tdu:${state.revision};saves:${state.saveCount}`
        const staleSince = revisionNow !== session.revisionAtCapture ? revisionNow : null

        return {
          ...applyResult,
          staleSince
        } satisfies RpcMethodMap[typeof RpcMethod.EditApply]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EditPreview: {
        const p = params as RpcMethodMap[typeof RpcMethod.EditPreview]['params']
        const { name, state } = this.resolveDoc(p.documentName)
        const session = state.editSessions.get(p.editId)
        if (!session) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditNotFound,
            `Edit session "${p.editId}" was not found.`
          )
        }

        const revisionNow = `tdu:${state.revision};saves:${state.saveCount}`
        const warnings: string[] = []
        if (revisionNow !== session.revisionAtCapture) {
          warnings.push(
            `Drawing revision moved from ${session.revisionAtCapture} to ${revisionNow}.`
          )
        }
        if (session.unsupportedFeatures?.length) {
          for (const f of session.unsupportedFeatures) {
            warnings.push(`Source feature "${f}" will not round-trip.`)
          }
        }

        const entities: EntityDiff[] = []
        const candidateMap = new Map<string, EntitySummary>()
        for (const c of session.candidates) {
          const ent = state.entities.get(c.handle)
          if (ent) candidateMap.set(c.handle, ent)
        }

        const matchedCandidateHandles = new Set<string>()

        // 1. Compare pre-images with corresponding candidate
        for (let i = 0; i < session.preImages.length; i++) {
          const pre = session.preImages[i]!
          const sourceHandle = pre.detail.handle
          const candHandle = session.candidates[i]?.handle ?? ''
          const cand = candidateMap.get(candHandle)

          if (!cand) {
            warnings.push(`Candidate for source "${sourceHandle}" was removed.`)
            entities.push({
              handle: sourceHandle,
              candidateHandle: candHandle,
              kind: pre.detail.kind,
              changedProperties: [],
              beforeGeometry: pre.detail.geometry,
              afterGeometry: null,
              status: 'removed'
            })
            continue
          }

          matchedCandidateHandles.add(candHandle)
          const candGeom = state.entityGeometry.get(candHandle)
          const candDetail = toEntityDetail(cand, candGeom!, state, true)

          const changedProps: string[] = []
          if (cand.layer !== session.candidateLayer) {
            changedProps.push('layer')
            warnings.push(
              `Candidate "${cand.handle}" was moved to layer "${cand.layer}" outside candidate layer "${session.candidateLayer}".`
            )
          }
          if (
            JSON.stringify(pre.detail.properties.color) !==
            JSON.stringify(candDetail.properties.color)
          )
            changedProps.push('color')
          if (pre.detail.properties.linetype !== candDetail.properties.linetype)
            changedProps.push('linetype')
          if (pre.detail.properties.lineweight !== candDetail.properties.lineweight)
            changedProps.push('lineweight')
          if (pre.detail.properties.transparency !== candDetail.properties.transparency)
            changedProps.push('transparency')

          const beforeGeomStr = JSON.stringify(pre.detail.geometry)
          const afterGeomStr = JSON.stringify(candDetail.geometry)
          const geomChanged = beforeGeomStr !== afterGeomStr
          const status = geomChanged || changedProps.length > 0 ? 'modified' : 'unchanged'

          entities.push({
            handle: sourceHandle,
            candidateHandle: cand.handle,
            kind: pre.detail.kind,
            changedProperties: changedProps,
            beforeGeometry: pre.detail.geometry,
            afterGeometry: candDetail.geometry,
            status
          })
        }

        // 2. Newly added candidates
        for (const [candHandle, cand] of candidateMap.entries()) {
          if (matchedCandidateHandles.has(candHandle)) continue
          const candGeom = state.entityGeometry.get(candHandle)
          const candDetail = toEntityDetail(cand, candGeom!, state, true)
          entities.push({
            handle: '',
            candidateHandle: candHandle,
            kind: cand.kind,
            changedProperties: [],
            beforeGeometry: null,
            afterGeometry: candDetail.geometry,
            status: 'added'
          })
        }

        const diffDigest = fingerprintFor(
          JSON.stringify({ editId: session.editId, revisionNow, entities })
        )

        const diff: EditDiffResult = {
          editId: session.editId,
          documentIdentity: session.documentIdentity,
          revisionAtCapture: session.revisionAtCapture,
          revisionNow,
          entities,
          warnings,
          diffDigest
        }

        const beforePng = p.capture ? MOCK_PNG_BASE64 : undefined
        const afterPng = p.capture ? MOCK_PNG_BASE64 : undefined

        return {
          diff,
          beforePng,
          afterPng
        } satisfies RpcMethodMap[typeof RpcMethod.EditPreview]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EditStatus: {
        const p = params as RpcMethodMap[typeof RpcMethod.EditStatus]['params']
        const { state } = this.resolveDoc(p.documentName)
        const session = state.editSessions.get(p.editId)
        if (!session) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditNotFound,
            `Edit session "${p.editId}" was not found.`
          )
        }

        return {
          editId: session.editId,
          status: session.state ?? 'active',
          candidateLayer: session.candidateLayer,
          candidateHandles: session.candidates.map((c) => c.handle),
          sourceHandles: session.preImages.map((pi) => pi.detail.handle),
          preImageCount: session.preImages.length,
          revisionAtCapture: session.revisionAtCapture,
          appliedMapping: session.appliedMapping
        } satisfies RpcMethodMap[typeof RpcMethod.EditStatus]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EditDiscard: {
        const p = params as RpcMethodMap[typeof RpcMethod.EditDiscard]['params']
        const { state } = this.resolveDoc(p.documentName)
        const session = state.editSessions.get(p.editId)
        if (!session) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditNotFound,
            `Edit session "${p.editId}" was not found.`
          )
        }

        if (session.state === 'accepted') {
          throw new BridgeRpcError(
            BridgeErrorCode.EditConflict,
            'Cannot discard an edit session that has already been accepted.'
          )
        }

        const removedCandidates: string[] = []
        for (const cand of session.candidates) {
          if (state.entities.has(cand.handle)) {
            state.entities.delete(cand.handle)
            state.entityGeometry.delete(cand.handle)
            removedCandidates.push(cand.handle)
            this.recordChange(state, cand.handle, 'erased')
          }
        }

        if (state.layers.has(session.candidateLayer)) {
          state.layers.delete(session.candidateLayer)
        }

        session.state = 'discarded'
        this.touch(state)
        this.flushChanges(state)

        return {
          status: 'discarded',
          removedCandidates
        } satisfies RpcMethodMap[typeof RpcMethod.EditDiscard]['result'] as RpcMethodMap[M]['result']
      }

      case RpcMethod.EditAccept: {
        const p = params as RpcMethodMap[typeof RpcMethod.EditAccept]['params']
        const { state } = this.resolveDoc(p.documentName)
        const session = state.editSessions.get(p.editId)
        if (!session) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditNotFound,
            `Edit session "${p.editId}" was not found.`
          )
        }

        if (session.state === 'accepted') {
          throw new BridgeRpcError(
            BridgeErrorCode.EditAlreadyApplied,
            `Edit session "${session.editId}" has already been accepted.`
          )
        }
        if (session.state === 'discarded' || session.state === 'orphaned') {
          throw new BridgeRpcError(
            BridgeErrorCode.EditConflict,
            `Cannot accept an edit session in ${session.state} state.`
          )
        }

        // Human-approver interlock: requires approvalToken
        if (!p.approvalToken) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditRequiresHumanApproval,
            `Edit "${session.editId}" requires human approval before accept.`
          )
        }

        // Step 1: re-resolve every source handle
        for (const pre of session.preImages) {
          if (!state.entities.has(pre.detail.handle)) {
            throw new BridgeRpcError(
              BridgeErrorCode.EditStalePreImage,
              `Source entity "${pre.detail.handle}" was erased or missing.`
            )
          }
        }

        // Step 2: re-read document revision
        const revisionNow = `tdu:${state.revision};saves:${state.saveCount}`
        const expectedRev = p.expectedRevision ?? session.revisionAtCapture
        if (revisionNow !== expectedRev) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditStalePreImage,
            `Pre-image for edit "${session.editId}" is stale (captured at ${expectedRev}, current is ${revisionNow}).`
          )
        }

        // Step 3: recompute diff
        const candidateMap = new Map<string, EntitySummary>()
        for (const c of session.candidates) {
          const ent = state.entities.get(c.handle)
          if (ent) candidateMap.set(c.handle, ent)
        }
        const entities: EntityDiff[] = []
        const matchedCandidateHandles = new Set<string>()

        for (let i = 0; i < session.preImages.length; i++) {
          const pre = session.preImages[i]!
          const sourceHandle = pre.detail.handle
          const candHandle = session.candidates[i]?.handle ?? ''
          const cand = candidateMap.get(candHandle)

          if (!cand) {
            entities.push({
              handle: sourceHandle,
              candidateHandle: candHandle,
              kind: pre.detail.kind,
              changedProperties: [],
              beforeGeometry: pre.detail.geometry,
              afterGeometry: null,
              status: 'removed'
            })
            continue
          }

          matchedCandidateHandles.add(candHandle)
          const candGeom = state.entityGeometry.get(candHandle)
          const candDetail = toEntityDetail(cand, candGeom!, state, true)

          const beforeGeomStr = JSON.stringify(pre.detail.geometry)
          const afterGeomStr = JSON.stringify(candDetail.geometry)
          const geomChanged = beforeGeomStr !== afterGeomStr
          const status = geomChanged ? 'modified' : 'unchanged'

          entities.push({
            handle: sourceHandle,
            candidateHandle: cand.handle,
            kind: pre.detail.kind,
            changedProperties: [],
            beforeGeometry: pre.detail.geometry,
            afterGeometry: candDetail.geometry,
            status
          })
        }

        for (const [candHandle, cand] of candidateMap.entries()) {
          if (matchedCandidateHandles.has(candHandle)) continue
          const candGeom = state.entityGeometry.get(candHandle)
          const candDetail = toEntityDetail(cand, candGeom!, state, true)
          entities.push({
            handle: '',
            candidateHandle: candHandle,
            kind: cand.kind,
            changedProperties: [],
            beforeGeometry: null,
            afterGeometry: candDetail.geometry,
            status: 'added'
          })
        }

        const diffDigest = fingerprintFor(
          JSON.stringify({ editId: session.editId, revisionNow, entities })
        )

        if (p.expectedDiffDigest && p.expectedDiffDigest !== diffDigest) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditConflict,
            'The candidate changed since you reviewed it (diff digest mismatch).'
          )
        }

        // Step 4: unsupported features check
        if (session.unsupportedFeatures.length > 0 && !p.allowUnknownFeatures) {
          throw new BridgeRpcError(
            BridgeErrorCode.EditConflict,
            `Session carries unsupported features (${session.unsupportedFeatures.join(', ')}). Pass allowUnknownFeatures: true to accept lossy changes.`
          )
        }

        // Step 5 & 6: Promote candidates and erase sources
        const appliedMapping: Record<string, string> = {}
        for (const diff of entities) {
          if (diff.status === 'modified' || diff.status === 'unchanged') {
            state.entities.delete(diff.handle)
            state.entityGeometry.delete(diff.handle)
            this.recordChange(state, diff.handle, 'erased')

            const cand = state.entities.get(diff.candidateHandle)
            const sourcePre = session.preImages.find((pi) => pi.detail.handle === diff.handle)
            const targetLayer = sourcePre?.detail.layer ?? '0'
            if (cand) {
              cand.layer = targetLayer
              this.recordChange(state, cand.handle, 'modified')
            }
            appliedMapping[diff.handle] = diff.candidateHandle
          } else if (diff.status === 'removed') {
            state.entities.delete(diff.handle)
            state.entityGeometry.delete(diff.handle)
            this.recordChange(state, diff.handle, 'erased')
            appliedMapping[diff.handle] = ''
          } else if (diff.status === 'added') {
            const cand = state.entities.get(diff.candidateHandle)
            const targetLayer = session.preImages[0]?.detail.layer ?? '0'
            if (cand) {
              cand.layer = targetLayer
              this.recordChange(state, cand.handle, 'modified')
            }
            appliedMapping[''] = diff.candidateHandle
          }
        }

        if (state.layers.has(session.candidateLayer)) {
          state.layers.delete(session.candidateLayer)
        }

        session.state = 'accepted'
        session.appliedMapping = appliedMapping

        this.touch(state)
        this.flushChanges(state)

        return {
          status: 'accepted',
          editId: session.editId,
          appliedMapping,
          diffDigest
        } satisfies RpcMethodMap[typeof RpcMethod.EditAccept]['result'] as RpcMethodMap[M]['result']
      }
      default:
        throw new Error(`Mock bridge has no handler for method "${method satisfies never}"`)
    }
  }

  private createEntity(
    state: MockDocumentState,
    p: RpcMethodMap[typeof RpcMethod.EntityCreate]['params']
  ): EntitySummary {
    const layer = p.layer ?? state.currentLayer
    if (!state.layers.has(layer))
      throw new BridgeRpcError(BridgeErrorCode.LayerNotFound, `Layer "${layer}" does not exist`)
    const handle = (state.handleCounter++).toString(16).toUpperCase()
    const entity: EntitySummary = { handle, kind: p.kind, layer, bounds: entityBounds(p) }
    // Annotative text/dimensions/hatch (#74): not wire/EntitySummary fields — extra debug-only
    // properties, same convention as hatch's own debug fields below, so bun test/smoke.ts can
    // assert the paperHeight -> model-height math without a real AutoCAD Annotative/CANNOSCALE to
    // check against.
    switch (p.kind) {
      case 'mtext':
      case 'text.singleLine': {
        const extra: Record<string, unknown> = {
          annotative: p.annotative ?? state.annotativeDefault
        }
        if (p.paperHeight !== undefined) {
          extra.paperHeight = p.paperHeight
          extra.height = round(
            p.paperHeight * scaleFactorOf(state.drawingSettings.annotationScale),
            6
          )
        }
        Object.assign(entity, extra)
        break
      }
      case 'dimension.linear':
      case 'dimension.aligned':
      case 'dimension.ordinate':
        Object.assign(entity, { annotative: p.annotative ?? state.annotativeDefault })
        break
    }
    if (p.kind === 'hatch') {
      // Not a wire/EntitySummary field (docs/PROTOCOL.md, contracts/cad-types) — extra debug-only
      // properties so bun test/smoke.ts can assert what entity.create(hatch) actually recorded
      // (loop count/kind, pattern) without a real AutoCAD Hatch.Area to check against (#58).
      Object.assign(entity, {
        boundaryHandles: p.boundaryHandles,
        loops: p.loops?.map((loop, i) => ({
          loopType: i === 0 ? 'Outermost' : 'Default',
          source: 'handles' in loop ? 'handles' : 'circle' in loop ? 'circle' : 'points'
        })),
        pattern: p.pattern,
        patternScale: p.patternScale,
        patternAngle: p.patternAngle,
        style: p.style,
        associative: p.associative,
        annotative: p.annotative ?? state.annotativeDefault
      })
    }
    if (p.kind === 'blockReference' && !state.blockDefinitions.has(p.blockName)) {
      state.blockDefinitions.set(p.blockName, {
        name: p.blockName,
        explodable: true,
        isDynamic: false,
        isAnonymous: false,
        isLayout: false,
        isXref: false
      })
    }
    state.entities.set(handle, entity)
    state.entityGeometry.set(handle, structuredClone(p))
    state.cadAiOwned.add(handle)
    this.recordChange(state, handle, 'created')
    this.touch(state)
    return entity
  }

  /**
   * Moves the document's revision, mirroring AutoCAD bumping `Tduupdate` on any committed change.
   * Called from every mutation helper so `entity.*` and `operations.apply` (which reuses them) both
   * invalidate a spatial-validation record bound to the pre-mutation state.
   */
  private touch(state: MockDocumentState): void {
    state.revision += 1
  }

  /**
   * Flushes every document's pending change handles at the end of one RPC call — the mock's
   * command boundary. `operations.apply` runs several helpers inside one call, so its handles
   * coalesce into ONE event (mixed operations labeled "modified"), exactly as one real AutoCAD
   * command does; reads leave the pending sets empty and cost nothing.
   */
  private flushAllPendingChanges(): void {
    for (const state of this.documents.values()) this.flushChanges(state)
  }

  /**
   * Mock mirror of `DocumentTracker.RecordHandle`: per-handle coalescing with the plugin's
   * precedence — erased wins (create-then-erase in one command nets to "gone"), otherwise the
   * first operation recorded stands; a dependency flag sticks once set.
   */
  private recordChange(
    state: MockDocumentState,
    handle: string,
    operation: MockChangeEvent['operation'],
    dependency = false
  ): void {
    const existing = state.pendingChanges.get(handle)
    if (!existing) {
      state.pendingChanges.set(handle, { operation, dependency })
      return
    }
    existing.dependency ||= dependency
    if (operation === 'erased') existing.operation = 'erased'
    else if (existing.operation.length === 0) existing.operation = operation
  }

  /**
   * Mock mirror of `DocumentTracker.Flush`/`AppendBatchLocked`: entity handles coalesce into one
   * event (labeled "modified" unless every handle shares one operation), dependency touches get
   * their own `dependency_invalidated` event, handles truncate at 500, and the ring drops oldest
   * past 2000 — which is what advances `earliestSequence` and forces Cloud to reconcile.
   */
  private flushChanges(state: MockDocumentState): void {
    if (state.pendingChanges.size === 0) return
    const batch = [...state.pendingChanges.entries()]
    state.pendingChanges.clear()
    const entityHandles: string[] = []
    const dependencyHandles: string[] = []
    let entityOperation: MockChangeEvent['operation'] = 'modified'
    let entityOperationUniform = true
    for (const [handle, entry] of batch) {
      if (entry.dependency) {
        dependencyHandles.push(handle)
        continue
      }
      if (entityHandles.length === 0)
        entityOperation = entry.operation as MockChangeEvent['operation']
      else if (entityOperation !== entry.operation) entityOperationUniform = false
      entityHandles.push(handle)
    }
    const append = (operation: MockChangeEvent['operation'], handles: string[]): void => {
      state.changeEvents.push({
        sequence: ++state.changeSequence,
        operation,
        handles: handles.slice(0, MAX_HANDLES_PER_CHANGE_EVENT),
        timestamp: Date.now(),
        truncated: handles.length > MAX_HANDLES_PER_CHANGE_EVENT
      })
      while (state.changeEvents.length > MAX_CHANGE_EVENTS) state.changeEvents.shift()
    }
    if (entityHandles.length > 0)
      append(entityOperationUniform ? entityOperation : 'modified', entityHandles)
    if (dependencyHandles.length > 0) append('dependency_invalidated', dependencyHandles)
  }

  /**
   * `entity.update` (#26): common properties (layer/color/linetype/lineweight) apply to any kind;
   * `geometry`'s `kind` must match the handle's actual stored kind (checked here, never trusted
   * from the caller) — a mismatch is a typed error and nothing changes. Only the fields actually
   * given are applied; everything else keeps its current value, mirroring the real plugin's
   * `EntityHandlers.Update`.
   */
  private updateEntity(
    state: MockDocumentState,
    p: RpcMethodMap[typeof RpcMethod.EntityUpdate]['params']
  ): EntitySummary {
    const entity = state.entities.get(p.handle)
    if (!entity) {
      throw new BridgeRpcError(BridgeErrorCode.EntityNotFound, `Entity "${p.handle}" not found`)
    }

    if (p.layer !== undefined) {
      if (!state.layers.has(p.layer)) {
        throw new BridgeRpcError(BridgeErrorCode.LayerNotFound, `Layer "${p.layer}" does not exist`)
      }
      entity.layer = p.layer
    }

    const style = state.entityStyle.get(p.handle) ?? {}
    if (p.color !== undefined) style.color = p.color
    if (p.linetype !== undefined) {
      if (!state.linetypes.has(p.linetype)) {
        throw new BridgeRpcError(
          BridgeErrorCode.InvalidGeometry,
          `Linetype "${p.linetype}" is not loaded into this drawing.`
        )
      }
      style.linetype = p.linetype
    }
    if (p.lineweight !== undefined) style.lineweight = p.lineweight
    state.entityStyle.set(p.handle, style)
    // Not wire/EntitySummary fields (EntitySummary has no color/linetype/lineweight) — extra
    // debug-only properties, same convention as entityGeometry's debug extras below, so bun
    // test/smoke.ts can assert a common-property update actually landed.
    Object.assign(entity, style)

    if (p.geometry) {
      if (p.geometry.kind !== entity.kind) {
        throw new BridgeRpcError(
          BridgeErrorCode.InvalidGeometry,
          `geometry.kind "${p.geometry.kind}" does not match entity "${p.handle}"'s actual kind ` +
            `"${entity.kind}".`
        )
      }
      const current = state.entityGeometry.get(p.handle)
      const merged = { ...current, ...p.geometry } as CreateEntityParams
      state.entityGeometry.set(p.handle, merged)
      entity.bounds = entityBounds(merged)
      const {
        kind: _kind,
        layer: _layer,
        documentName: _doc,
        view: _view,
        ...extras
      } = merged as Record<string, unknown>
      Object.assign(entity, extras)
    }
    this.recordChange(state, p.handle, 'modified')
    this.touch(state)
    return entity
  }

  private guardOwnership(state: MockDocumentState, handles: string[], action = 'erase'): void {
    const protectedHandles: string[] = []
    for (const h of handles) {
      const ent = state.entities.get(h)
      if (ent && !state.cadAiOwned.has(h)) {
        protectedHandles.push(h)
      }
    }
    if (protectedHandles.length > 0) {
      const shown = protectedHandles.slice(0, 8).join(', ')
      const more = protectedHandles.length > 8 ? ` and ${protectedHandles.length - 8} more` : ''
      throw new BridgeRpcError(
        BridgeErrorCode.ProtectedEntity,
        `Cannot ${action} ${protectedHandles.length} protected entity/entities (${shown}${more}): user geometry not created by CadAI is protected. Use the human-approved edit flow (edit.begin → edit.accept) or ask the user to delete it in AutoCAD.`,
        { handles: protectedHandles, count: protectedHandles.length }
      )
    }
  }

  private eraseEntities(state: MockDocumentState, handles: string[]): EntitySummary[] {
    const erased: EntitySummary[] = []
    for (const handle of handles) {
      const entity = state.entities.get(handle)
      if (entity && state.entities.delete(handle)) {
        state.entityGeometry.delete(handle)
        state.entityStyle.delete(handle)
        state.cadAiOwned.delete(handle)
        erased.push(entity)
        this.recordChange(state, handle, 'erased')
      }
    }
    if (erased.length > 0) this.touch(state)
    return erased
  }

  /** Entities matching `drawing.check`'s scope: `handles`, else `layer`, else `window`, else all. */
  private scopedEntities(
    state: MockDocumentState,
    scope: DrawingCheckScope | undefined
  ): EntitySummary[] {
    const all = [...state.entities.values()]
    if (scope?.handles) {
      const wanted = new Set(scope.handles)
      return all.filter((e) => wanted.has(e.handle))
    }
    if (scope?.layer) return all.filter((e) => e.layer === scope.layer)
    if (scope?.window) {
      const { min, max } = scope.window
      return all.filter((e) => {
        if (!e.bounds) return false
        return (
          e.bounds.min.x <= max.x &&
          e.bounds.max.x >= min.x &&
          e.bounds.min.y <= max.y &&
          e.bounds.max.y >= min.y
        )
      })
    }
    return all
  }

  /**
   * Read-only quality pass against the mock's in-memory geometry — see `DrawingCheckKind`'s doc
   * comment for the `textSize` simplification. Tolerance is `1e-6` of the whole drawing's extents
   * diagonal (not just the scoped subset), computed once, matching the plugin-side contract.
   */
  private checkDrawing(
    state: MockDocumentState,
    scope: DrawingCheckScope | undefined,
    checks: readonly DrawingCheckKind[]
  ): DrawingCheckFinding[] {
    const allBounds = [...state.entities.values()]
      .map((e) => e.bounds)
      .filter((b): b is { min: Point3d; max: Point3d } => b !== undefined)
    const extentsDiagonal = allBounds.length
      ? distance(
          {
            x: Math.min(...allBounds.map((b) => b.min.x)),
            y: Math.min(...allBounds.map((b) => b.min.y)),
            z: 0
          },
          {
            x: Math.max(...allBounds.map((b) => b.max.x)),
            y: Math.max(...allBounds.map((b) => b.max.y)),
            z: 0
          }
        )
      : 0
    const tolerance = Math.max(extentsDiagonal * 1e-6, 1e-9)
    const decimals = Math.max(0, Math.min(6, Math.round(-Math.log10(tolerance))))
    const scoped = this.scopedEntities(state, scope)
    const findings: DrawingCheckFinding[] = []
    const wants = (kind: DrawingCheckKind) => checks.includes(kind)

    if (wants('duplicates')) {
      const groups = new Map<string, string[]>()
      for (const e of scoped) {
        const geom = state.entityGeometry.get(e.handle)
        if (!geom) continue
        const sig = entitySignature(geom, decimals)
        if (sig === undefined) continue
        const key = `${e.kind}\0${e.layer}\0${sig}`
        ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(e.handle)
      }
      for (const handles of groups.values()) {
        if (handles.length < 2) continue
        findings.push({
          check: 'duplicates',
          severity: 'warning',
          handles,
          message: `${handles.length} entities share identical geometry on the same layer`,
          fix: 'duplicates'
        })
      }
    }

    if (wants('overlaps')) {
      const lines = scoped
        .map((e) => ({ e, geom: state.entityGeometry.get(e.handle) }))
        .filter(
          (x): x is { e: EntitySummary; geom: Extract<CreateEntityParams, { kind: 'line' }> } =>
            x.geom?.kind === 'line'
        )
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const a = lines[i]!
          const b = lines[j]!
          if (a.e.layer !== b.e.layer) continue
          const d = { x: a.geom.end.x - a.geom.start.x, y: a.geom.end.y - a.geom.start.y }
          const len = Math.hypot(d.x, d.y)
          if (len < tolerance) continue
          const cross = (p: Point3d) =>
            Math.abs(d.x * (p.y - a.geom.start.y) - d.y * (p.x - a.geom.start.x))
          if (cross(b.geom.start) > tolerance * len || cross(b.geom.end) > tolerance * len) continue
          const param = (p: Point3d) =>
            (d.x * (p.x - a.geom.start.x) + d.y * (p.y - a.geom.start.y)) / len
          const aMin = 0
          const aMax = len
          const bStart = param(b.geom.start)
          const bEnd = param(b.geom.end)
          const bMin = Math.min(bStart, bEnd)
          const bMax = Math.max(bStart, bEnd)
          const overlapLen = Math.min(aMax, bMax) - Math.max(aMin, bMin)
          if (overlapLen > tolerance) {
            findings.push({
              check: 'overlaps',
              severity: 'warning',
              handles: [a.e.handle, b.e.handle],
              message: `Collinear lines overlap by ${overlapLen.toFixed(4)} drawing units`
            })
          }
        }
      }
    }

    if (wants('zeroLength')) {
      const handles: string[] = []
      for (const e of scoped) {
        const geom = state.entityGeometry.get(e.handle)
        if (!geom) continue
        const length = entityLength(geom)
        if (length !== undefined && length < tolerance) handles.push(e.handle)
        else if (
          (geom.kind === 'mtext' || geom.kind === 'text.singleLine') &&
          geom.text.trim() === ''
        )
          handles.push(e.handle)
      }
      if (handles.length) {
        findings.push({
          check: 'zeroLength',
          severity: 'error',
          handles,
          message: `${handles.length} entities have zero length or empty text`,
          fix: 'zeroLength'
        })
      }
    }

    if (wants('openOutlines')) {
      const patterns = ['*-WALL', '*-OUTL', '*OUTLINE*'].map(
        (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
      )
      const handles = scoped
        .filter((e) => e.kind === 'polyline' && patterns.some((re) => re.test(e.layer)))
        .filter((e) => {
          const geom = state.entityGeometry.get(e.handle)
          return geom?.kind === 'polyline' && !geom.closed
        })
        .map((e) => e.handle)
      if (handles.length) {
        findings.push({
          check: 'openOutlines',
          severity: 'warning',
          handles,
          message: `${handles.length} outline-layer polylines are not closed`
        })
      }
    }

    if (wants('layerZero')) {
      const handles = scoped
        .filter((e) => e.layer === '0' || e.layer === 'Defpoints')
        .map((e) => e.handle)
      if (handles.length) {
        findings.push({
          check: 'layerZero',
          severity: 'info',
          handles,
          message: `${handles.length} entities are on layer "0" or "Defpoints"`
        })
      }
    }

    if (wants('textSize')) {
      const texts = scoped.filter((e) => e.kind === 'mtext' || e.kind === 'text.singleLine')
      const groupOf = (e: EntitySummary) => {
        const geom = state.entityGeometry.get(e.handle)
        const height = geom && 'height' in geom ? (geom.height ?? undefined) : undefined
        return `${e.layer}\0${height === undefined ? 'variable' : round(height, 2)}`
      }
      const counts = new Map<string, number>()
      for (const e of texts) counts.set(groupOf(e), (counts.get(groupOf(e)) ?? 0) + 1)
      const handles = texts
        .filter((e) => (counts.get(groupOf(e)) ?? 0) - 1 < 2)
        .map((e) => e.handle)
      if (handles.length) {
        findings.push({
          check: 'textSize',
          severity: 'warning',
          handles,
          message: `${handles.length} text entities use a height inconsistent with the rest of their layer`
        })
      }
    }

    if (wants('dimOverride')) {
      const handles: string[] = []
      for (const e of scoped) {
        const geom = state.entityGeometry.get(e.handle)
        if (geom?.kind !== 'dimension.linear' && geom?.kind !== 'dimension.aligned') continue
        if (!geom.dimText || geom.dimText.trim() === '') continue
        const parsed = Number(geom.dimText)
        if (!Number.isFinite(parsed)) continue
        const measured =
          geom.kind === 'dimension.aligned' || !('rotation' in geom) || !geom.rotation
            ? distance(geom.extLine1, geom.extLine2)
            : Math.abs(geom.extLine2.x - geom.extLine1.x)
        if (Math.abs(parsed - measured) > Math.max(tolerance, 1e-4)) handles.push(e.handle)
      }
      if (handles.length) {
        findings.push({
          check: 'dimOverride',
          severity: 'warning',
          handles,
          message: `${handles.length} dimensions have a text override that doesn't match the measured value`
        })
      }
    }

    if (wants('offExtents')) {
      const withCenters = scoped
        .filter((e) => e.bounds)
        .map((e) => ({
          handle: e.handle,
          dist: distance(
            {
              x: (e.bounds!.min.x + e.bounds!.max.x) / 2,
              y: (e.bounds!.min.y + e.bounds!.max.y) / 2,
              z: (e.bounds!.min.z + e.bounds!.max.z) / 2
            },
            { x: 0, y: 0, z: 0 }
          )
        }))
      if (withCenters.length >= 3) {
        const sorted = withCenters.map((w) => w.dist).sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]!
        if (median > tolerance) {
          const handles = withCenters.filter((w) => w.dist > median * 10).map((w) => w.handle)
          if (handles.length) {
            findings.push({
              check: 'offExtents',
              severity: 'warning',
              handles,
              message: `${handles.length} entities sit far outside where the rest of the drawing is (possible typo)`
            })
          }
        }
      }
    }

    return findings
  }

  /**
   * `duplicates`/`zeroLength` erase entities found by `checkDrawing`; `purge` removes layers with
   * no referencing entity (never `0`/`Defpoints`/the current layer); `audit` has no mock or real
   * implementation (see `DrawingCleanupParams`'s doc comment) and fails the whole call, matching
   * the plugin's contract. `dryRun` (default handled by the caller) computes without mutating.
   */
  private cleanupDrawing(
    state: MockDocumentState,
    fixes: DrawingCleanupFixKind[],
    dryRun: boolean
  ): DrawingCleanupResult {
    if (fixes.includes('audit')) {
      throw new BridgeRpcError(
        BridgeErrorCode.AuditUnsupported,
        'drawing.cleanup\'s "audit" fix is not implemented — no general Database.Audit(fix) entry point on AutoCAD\'s public managed API.'
      )
    }
    const applied: DrawingCleanupApplied[] = []
    for (const fix of fixes) {
      if (fix === 'duplicates') {
        const candidateHandles = this.checkDrawing(state, undefined, ['duplicates']).flatMap((f) =>
          f.handles.slice(1)
        )
        const handles = candidateHandles.filter((h) => state.cadAiOwned.has(h))
        const skippedProtected = candidateHandles.length - handles.length
        if (!dryRun) this.eraseEntities(state, handles)
        applied.push({ fix: 'duplicates', count: handles.length, handles, skippedProtected })
      } else if (fix === 'zeroLength') {
        const candidateHandles = this.checkDrawing(state, undefined, ['zeroLength']).flatMap(
          (f) => f.handles
        )
        const handles = candidateHandles.filter((h) => state.cadAiOwned.has(h))
        const skippedProtected = candidateHandles.length - handles.length
        if (!dryRun) this.eraseEntities(state, handles)
        applied.push({ fix: 'zeroLength', count: handles.length, handles, skippedProtected })
      } else if (fix === 'purge') {
        const referenced = new Set([...state.entities.values()].map((e) => e.layer))
        referenced.add(state.currentLayer).add('0').add('Defpoints')
        const allUnused = [...state.layers.keys()].filter((name) => !referenced.has(name))
        const unused = allUnused.filter((name) => state.cadAiLayers.has(name))
        const skippedProtected = allUnused.length - unused.length
        if (!dryRun)
          for (const name of unused) {
            state.layers.delete(name)
            state.cadAiLayers.delete(name)
          }
        applied.push({ fix: 'purge', count: unused.length, skippedProtected })
      }
    }
    return { dryRun, applied }
  }
  /**
   * Resolves `arrayPath`'s `count`/`spacing` into a copy-per-source count via the same pure
   * arc-length math `@arcdio/cad-tools`'s `arrayPath` module unit-tests directly — real math,
   * not a stub, since it has no AutoCAD dependency either. Unlike arrayRect/arrayPolar (capped
   * pre-wire in `server/src/tools/normalize.ts`'s `arrayCopyCount` check), a `path: { handle }`'s
   * length is only known once resolved against the drawing, so that case's cap is enforced here
   * instead (`path: { points }` is already capped pre-wire when computable).
   */
  private arrayPathPositions(
    state: MockDocumentState,
    p: Extract<RpcMethodMap[typeof RpcMethod.EntityTransform]['params'], { op: 'arrayPath' }>,
    sourceCount: number
  ): number {
    let segments
    if ('handle' in p.path) {
      const geom = state.entityGeometry.get(p.path.handle)
      if (!geom)
        throw new BridgeRpcError(
          BridgeErrorCode.EntityNotFound,
          `Entity "${p.path.handle}" not found`
        )
      if (geom.kind === 'line') segments = segmentsFromLine(geom.start, geom.end)
      else if (geom.kind === 'arc')
        segments = segmentsFromArc(geom.center, geom.radius, geom.startAngle, geom.endAngle)
      else if (geom.kind === 'polyline')
        segments = segmentsFromPolyline(geom.points, geom.closed ?? false)
      else
        throw new BridgeRpcError(
          BridgeErrorCode.InvalidGeometry,
          `arrayPath path handle "${p.path.handle}" must be a line, arc, or polyline (was "${geom.kind}")`
        )
    } else {
      segments = segmentsFromPoints(p.path.points)
    }
    const samples =
      p.count != null ? sampleByCount(segments, p.count) : sampleBySpacing(segments, p.spacing!)
    const copies = (samples.length - 1) * sourceCount
    if (copies > MAX_ARRAY_COPIES) {
      throw new BridgeRpcError(
        BridgeErrorCode.InvalidGeometry,
        `arrayPath would create ${copies} copies (limit ${MAX_ARRAY_COPIES}); use a larger spacing or fewer items, or split it`
      )
    }
    return samples.length - 1
  }

  private transformEntities(
    state: MockDocumentState,
    p: RpcMethodMap[typeof RpcMethod.EntityTransform]['params']
  ): EntitySummary[] {
    const sources = p.handles.map((handle) => {
      const entity = state.entities.get(handle)
      if (!entity)
        throw new BridgeRpcError(BridgeErrorCode.EntityNotFound, `Entity "${handle}" not found`)
      return entity
    })
    // Like the plugin: copy/mirror/arrays return new clones (one per source per position).
    const positions =
      p.op === 'copy' || p.op === 'mirror'
        ? 1
        : p.op === 'arrayRect'
          ? p.rows * p.columns - 1
          : p.op === 'arrayPolar'
            ? p.count - 1
            : p.op === 'arrayPath'
              ? this.arrayPathPositions(state, p, sources.length)
              : 0
    // A transform is a mutation even when it produces no clones (`move`), so the revision moves
    // before the early return below. In-place ops modify the sources; clone-producing ops create
    // new handles (and erase the sources only for `mirror` with `erase`), matching the reactors.
    const inPlace = p.op === 'move' || p.op === 'rotate' || p.op === 'scale'
    if (inPlace) for (const source of sources) this.recordChange(state, source.handle, 'modified')
    if (p.op === 'move') {
      const d = p.delta
      for (const source of sources) {
        const geom = state.entityGeometry.get(source.handle)
        if (geom) {
          if (geom.kind === 'line') {
            geom.start = {
              x: geom.start.x + d.x,
              y: geom.start.y + d.y,
              z: geom.start.z + (d.z ?? 0)
            }
            geom.end = { x: geom.end.x + d.x, y: geom.end.y + d.y, z: geom.end.z + (d.z ?? 0) }
          } else if (geom.kind === 'circle' || geom.kind === 'arc') {
            geom.center = {
              x: geom.center.x + d.x,
              y: geom.center.y + d.y,
              z: geom.center.z + (d.z ?? 0)
            }
          } else if (geom.kind === 'polyline') {
            geom.points = geom.points.map((pt) => ({
              x: pt.x + d.x,
              y: pt.y + d.y,
              z: pt.z + (d.z ?? 0)
            }))
          } else if (geom.kind === 'blockReference') {
            geom.position = {
              x: geom.position.x + d.x,
              y: geom.position.y + d.y,
              z: geom.position.z + (d.z ?? 0)
            }
          } else if (geom.kind === 'mtext' || geom.kind === 'text.singleLine') {
            geom.insertion = {
              x: geom.insertion.x + d.x,
              y: geom.insertion.y + d.y,
              z: geom.insertion.z + (d.z ?? 0)
            }
          }
        }
      }
    }
    this.touch(state)
    if (positions === 0) return sources
    const clones: EntitySummary[] = []
    for (let i = 0; i < positions; i++) {
      for (const source of sources) {
        const clone = { ...source, handle: (state.handleCounter++).toString(16).toUpperCase() }
        state.entities.set(clone.handle, clone)
        state.cadAiOwned.add(clone.handle)
        // Shallow clone, same simplification as `clone`'s unrecomputed `bounds` above (#25):
        // `entityGeometry` follows the source as-is — a `detail: "full"` read of a copy/mirror/
        // array clone reports the source's pre-transform coordinates, not the clone's actual
        // (moved/rotated/mirrored/arrayed) position. Good enough to keep `detail: "full"` from
        // throwing on a clone; this mock already doesn't recompute `bounds` on any transform.
        const sourceGeom = state.entityGeometry.get(source.handle)
        if (sourceGeom) state.entityGeometry.set(clone.handle, sourceGeom)
        clones.push(clone)
        this.recordChange(state, clone.handle, 'created')
      }
    }
    if (p.op === 'mirror' && p.erase) {
      this.guardOwnership(
        state,
        sources.map((s) => s.handle),
        'erase'
      )
      for (const source of sources) {
        state.entities.delete(source.handle)
        state.entityGeometry.delete(source.handle)
        state.entityStyle.delete(source.handle)
        state.cadAiOwned.delete(source.handle)
        this.recordChange(state, source.handle, 'erased')
      }
    }
    return clones
  }

  /**
   * Scans from the most recent batch for the top of this document's undo journal (skips
   * already-undone entries).
   */
  private topBatch(state: MockDocumentState): MockBatchEntry | undefined {
    for (let i = state.batches.length - 1; i >= 0; i--) {
      const entry = state.batches[i]
      // #413 §11.5: a copy_to receipt is not on the undo stack (undoEligible:false) — the native
      // undo must skip it and reach the apply batch underneath, never hijack that batch's undo.
      if (entry && entry.status === 'committed' && entry.undoEligible !== false) return entry
    }
    return undefined
  }

  /**
   * Test-only helper: seeds a pre-existing user entity (not created by CadAI),
   * so tests can verify ownership guards without spinning up real AutoCAD.
   */
  seedUserEntity(
    params: CreateEntityParams,
    options?: { documentName?: string; handle?: string }
  ): EntitySummary {
    const { state } = this.resolveDoc(options?.documentName)
    const layer = params.layer ?? state.currentLayer
    if (!state.layers.has(layer)) {
      state.layers.set(layer, {
        name: layer,
        color: { aci: 7 },
        linetype: 'Continuous',
        lineweight: -1,
        frozen: false,
        locked: false,
        plottable: true,
        on: true,
        isCurrent: false
      })
    }
    const handle = options?.handle ?? (state.handleCounter++).toString(16).toUpperCase()
    const entity: EntitySummary = {
      handle,
      kind: params.kind,
      layer,
      bounds: entityBounds(params)
    }
    state.entities.set(handle, entity)
    state.entityGeometry.set(handle, structuredClone(params))
    return entity
  }

  /**
   * Test-only helper: seeds a pre-existing user layer (not created by CadAI).
   */
  seedUserLayer(name: string, options?: { documentName?: string; color?: ColorSpec }): LayerInfo {
    const { state } = this.resolveDoc(options?.documentName)
    const layer: LayerInfo = {
      name,
      color: options?.color ?? { aci: 7 },
      linetype: 'Continuous',
      lineweight: -1,
      frozen: false,
      locked: false,
      plottable: true,
      on: true,
      isCurrent: false
    }
    state.layers.set(name, layer)
    return layer
  }

  /**
   * Queries whether an entity handle is tracked as CadAI-created.
   */
  isCadAiOwned(handle: string, documentName?: string): boolean {
    const { state } = this.resolveDoc(documentName)
    return state.cadAiOwned.has(handle)
  }

  async close(): Promise<void> {
    // no transport to release
  }
}
