import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { EntityOperation, OperationsPreviewResult } from '@aleph-connector/cad-protocol'
import {
  bboxOf,
  pointInPolygon,
  ringsBoundaryIntersect,
  type BBox,
  type Point2D
} from '@aleph-connector/engineering'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import {
  assembleFloorplanGeometry,
  emptyGeometrySource,
  type RegionGeometrySource,
  type SnapshotRow
} from './floorplanCadState.js'
import type { RoomWithBoundary } from './floorplanBoundary.js'

/**
 * The floor-plan half of the PCCC overlay executors, shared by `pccc_fire_alarm_overlay` and
 * `pccc_overlay` on purpose: both draw a designed system onto a sheet, and both fail the same way
 * when the geometry under the design is a polygon the caller typed rather than one the drawing has.
 * Keeping one implementation is what stops the two tools disagreeing about whether a region or a
 * room outline is trustworthy.
 */

const REGION_TTL_MS = 2 * 60 * 1000
const MAX_STORED_REGIONS = 12
// Measuring every planned block is a native CAD transaction, so override the gateway's 15 s default.
const FOOTPRINT_PREVIEW_TIMEOUT_MS = 45_000

/**
 * The CAD-backed region a preview designs inside: its frame, how that frame was justified, and the
 * room outlines the same read assembled.
 *
 * Room boundaries used to arrive as coordinates the caller typed. Every observed failure of an
 * overlay on a real sheet starts there: a polygon copied off a container's bounding box, a
 * 1000x1000 placeholder, or a plan placed beside the floor it belongs to. Nothing downstream can
 * detect that — the grid, the router and the schedule are all internally consistent with whatever
 * box they were given — so the geometry has to come from the drawing. `drawing.inspect_floorplan`
 * resolves a region from real CAD evidence (a title frame, a block's extents, a connected stroke
 * cluster) and reports `regionBasis`; only an attributed region constrains the design, and the same
 * read assembles each labelled room's closed outline from the CAD State snapshot, which is what lets
 * a preview name rooms by `ref` instead of retyping their vertices.
 */
export interface DesignRegion {
  bounds: [number, number, number, number]
  basis: string
  rooms: RoomWithBoundary[]
  geometryComplete: boolean
  /** Current-revision CAD evidence inside the attributed frame, never caller-authored geometry. */
  evidenceRows: SnapshotRow[]
  geometryNote?: string
}

/**
 * Regions already read from the sheet, keyed by instance + resolved document name + revision.
 * A `preview` that fixes its input and retries would otherwise re-walk the whole floor plan on
 * AutoCAD every time: `inspect_floorplan` scans every text and polyline, the call measured at over
 * 15 s on a ~2400-text drawing. The region is a property of the sheet at that revision, not of the
 * caller's room polygons, so one read per revision answers every retry. Any committed mutation
 * moves the revision and forces a fresh read; failures are never cached, so a retry with a
 * different title can still find one.
 */
export type RegionCache = Map<string, { at: number } & DesignRegion>

/** Scoped to one tool registration so a cache can never outlive the server that owns the drawing. */
export function createRegionCache(): RegionCache {
  return new Map()
}

/**
 * Stable key shared by `drawing.inspect_floorplan` and the PCCC overlays so a successful inspect
 * answers the next preview without a second AutoCAD walk of the same revision + copy.
 */
export function designRegionCacheKey(parts: {
  instanceId?: string
  documentName: string
  floorplanName: string
  revision: string
  layoutName?: string
  candidateIndex?: number
}): string {
  const layout = parts.layoutName?.trim().toLowerCase() || 'model'
  const cand =
    typeof parts.candidateIndex === 'number' && parts.candidateIndex >= 0
      ? String(parts.candidateIndex)
      : 'auto'
  return `${parts.instanceId ?? '(default)'}|${parts.documentName}|${parts.floorplanName}|${parts.revision}|${layout}|cand:${cand}`
}

/** Publish an attributed region so overlays reuse the inspect that just paid for it. */
export function rememberDesignRegion(
  regionCache: RegionCache,
  cacheKey: string,
  region: DesignRegion
): void {
  if (regionCache.size >= MAX_STORED_REGIONS) regionCache.delete(regionCache.keys().next().value!)
  regionCache.set(cacheKey, { at: Date.now(), ...region })
}

export type ResolveDesignRegionOptions = {
  /** 0-based copy on a multi-copy sheet — same contract as `drawing.inspect_floorplan`. */
  candidateIndex?: number
}

/**
 * Resolve the region for `floorplanName`, or explain in `problem` why the sheet cannot support one.
 */
export async function resolveDesignRegion(
  bridge: BridgeClient,
  cadState: RegionGeometrySource | undefined,
  regionCache: RegionCache,
  cacheKey: string | null,
  floorplanName: string,
  documentName: string | undefined,
  layoutName?: string,
  options?: ResolveDesignRegionOptions
): Promise<DesignRegion | { problem: string }> {
  const candidateIndex =
    typeof options?.candidateIndex === 'number' && options.candidateIndex >= 0
      ? options.candidateIndex
      : undefined
  // `cacheKey` is null whenever there is nothing safe to key on (the revision could not be read), so
  // caching can never serve one drawing's frame as another's. Callers that already know revision
  // should pass `designRegionCacheKey(...)` so inspect and overlay share one entry.
  if (cacheKey) {
    const hit = regionCache.get(cacheKey)
    if (hit && Date.now() - hit.at < REGION_TTL_MS) return { ...hit }
  }

  const inspected = await bridge.request(RpcMethod.DrawingInspectFloorplan, {
    name: floorplanName,
    documentName,
    layoutName,
    capture: false,
    ...(candidateIndex !== undefined ? { candidateIndex } : {})
  })
  if (layoutName && inspected.layoutName?.toLowerCase() !== layoutName.trim().toLowerCase()) {
    return {
      problem:
        `AutoCAD did not confirm the requested layout "${layoutName}" (reported: ${inspected.layoutName ?? 'none'}); ` +
        `no region from another space was used.`
    }
  }
  // Slice 01's contract: the plugin returns `bounds` exactly when it attributed the region to real
  // CAD evidence (a title frame, a block's own extents, a connected stroke cluster). It no longer
  // falls back to the whole drawing, so `bounds` present means "this rectangle is that plan".
  if (inspected.found && inspected.bounds) {
    const attributed =
      inspected.regionBasis === 'title-frame' ||
      inspected.regionBasis === 'block-frame' ||
      inspected.regionBasis === 'connected-geometry'
    // Boundaries only assemble for an attributed region — the same gate `drawing.inspect_floorplan`
    // applies, so the tools cannot disagree about whether a room's outline is trustworthy.
    const assembly = attributed
      ? await assembleFloorplanGeometry(
          cadState ?? emptyGeometrySource,
          {
            documentId: inspected.documentId,
            fingerprintGuid: inspected.fingerprintGuid,
            revision: inspected.revision,
            documentName,
            layoutName: inspected.layoutName ?? layoutName ?? 'Model',
            units: inspected.units
          },
          inspected.rooms,
          inspected.bounds
        )
      : {
          rooms: [] as RoomWithBoundary[],
          geometryComplete: false,
          evidenceRows: [] as SnapshotRow[],
          geometryNote: `region was not attributed to CAD evidence (regionBasis: ${inspected.regionBasis ?? 'unresolved'})`
        }

    const region: DesignRegion = {
      bounds: inspected.bounds,
      basis: inspected.regionBasis ?? 'attributed',
      rooms: assembly.rooms,
      geometryComplete: assembly.geometryComplete,
      evidenceRows: assembly.evidenceRows,
      ...(assembly.geometryNote ? { geometryNote: assembly.geometryNote } : {})
    }
    if (cacheKey) rememberDesignRegion(regionCache, cacheKey, region)
    return region
  }
  const candidates = inspected.regionCandidates ?? []
  if (candidates.length > 0) {
    return {
      problem:
        `"${floorplanName}" has ${candidates.length} separate copies on this sheet, so the design ` +
        `region is ambiguous — pass candidateIndex (0-based) on this overlay (or re-inspect with ` +
        `candidateIndex) for the copy you mean. Frames: ${candidates.map((b) => `[${b.join(', ')}]`).join(' ')}.`
    }
  }
  return {
    problem:
      `could not attribute a floor-plan region to "${floorplanName}" in this drawing ` +
      `(regionBasis: ${inspected.regionBasis ?? 'unresolved'}). Plans this sheet reports: ` +
      `${inspected.availableFloorplans.join(', ') || '(none)'}. Nothing is drawn without a real ` +
      `region: use one of those titles, and take room polygons from CAD geometry the sheet exposes ` +
      `rather than coordinates written from the brief.`
  }
}

/**
 * Find the sheet's own record for a room the caller addressed by `ref` or by `name`.
 *
 * `ref` wins and is exact: it already carries the revision, so a stale handle simply misses instead
 * of silently binding to a different room. A bare `name` only resolves when it is unambiguous on
 * this region — one label, or several labels that all resolved to the same outline — because guessing
 * between two rooms is exactly the error the ref exists to prevent.
 */
export function locateRoom(
  rooms: readonly RoomWithBoundary[],
  want: { ref?: string; name?: string }
): RoomWithBoundary | undefined {
  if (want.ref) {
    const byRef = rooms.find((r) => r.ref === want.ref)
    if (byRef) return byRef
  }
  if (!want.name) return undefined
  const folded = want.name.trim().replace(/\s+/g, ' ').toLowerCase()
  const named = rooms.filter((r) => r.name.trim().replace(/\s+/g, ' ').toLowerCase() === folded)
  if (named.length === 0) return undefined
  if (named.length === 1) return named[0]
  // Same label twice on one sheet with different outlines: refuse to choose.
  const outlines = new Set(
    named.map((r) => (r.boundary ? JSON.stringify(r.boundary) : r.boundaryStatus))
  )
  return outlines.size === 1 ? named[0] : undefined
}

/** The handles a corrected request can copy, shown when one failed to resolve. */
export function resolvedRoomSummary(rooms: readonly RoomWithBoundary[]): string {
  const verified = rooms.filter((r) => r.boundaryStatus === 'verified')
  const shown = verified.slice(0, 12)
  // Only the handle and label: `areaM2` is trustworthy only for a drawing that declares INSUNITS, so
  // printing it here would put an unconverted number next to an "m2" suffix.
  return shown
    .map((r) => `${r.ref ?? r.name}`)
    .join(', ')
    .concat(verified.length > shown.length ? ` (+${verified.length - shown.length} more)` : '')
}

/**
 * Turn "skip these spaces" into closed rings, preferring the outlines the drawing already gave.
 *
 * An excluded zone is where a design must NOT put anything — a server room on gas suppression, a
 * stair void, a shaft. A typed box around such a space is easier to get wrong than a room polygon:
 * slightly too small leaves heads inside the forbidden zone, slightly too large silently deletes
 * coverage the standard requires, and both read as a valid plan downstream. So each entry is
 * resolved by ref/label against the same read that resolved the protected room, and only a space the
 * drawing could not bind falls back to a caller-supplied ring.
 *
 * Every ring — resolved or supplied — must take some part of `protectedBoundary`. The layout planner
 * subtracts an exclusion's whole area from `protectedAreaM2` regardless of where it sits, so a zone
 * that misses the room quietly overstates the area needing protection while protecting the space it
 * was named for. Nothing downstream would notice.
 */
export function resolveExcludedRings(
  rooms: readonly RoomWithBoundary[],
  requested: ReadonlyArray<{ ref?: string; name?: string }>,
  typed: readonly [number, number][][],
  protectedBoundary: readonly [number, number][]
): { rings: [number, number][][]; problems: string[] } {
  const rings: [number, number][][] = []
  const problems: string[] = []
  for (const entry of requested) {
    const located = locateRoom(rooms, entry)
    if (located?.boundary) {
      rings.push(located.boundary)
      continue
    }
    const named = entry.ref ? `ref "${entry.ref}"` : `name "${entry.name}"`
    problems.push(
      `EXCLUDED_REF_UNRESOLVED: no outline on this sheet for the excluded space ${named} — ${
        located
          ? `its boundary is ${located.boundaryStatus}: ${located.boundaryEvidence ?? 'no single closed ring contains the label'}`
          : 'this read does not report that room'
      }. Rooms this read resolved: ${resolvedRoomSummary(rooms) || '(none)'}. Either pass its ref from drawing.inspect_floorplan or its ring in excludedBoundaries (traced with entity.traceBoundary).`
    )
  }
  rings.push(...typed)
  for (const ring of rings) {
    if (!overlapsPolygon(ring, protectedBoundary)) {
      problems.push(
        `EXCLUDED_OUTSIDE_ROOM: an excluded space shares no area with the room being protected, so it ` +
          `carves nothing out of coverage while still reducing the reported protected area. Check the ` +
          `ref against this room, or drop it — exclusions belong inside the space they protect.`
      )
    }
  }
  return { rings, problems }
}

/**
 * Does this ring take any part of the protected room? The layout planner subtracts every excluded
 * ring's area from `protectedAreaM2` whether or not the two overlap, so a zone that misses the room
 * both overstates the area needing protection and leaves a grid that covers the space it was meant
 * to keep dry — with no violation reported anywhere.
 *
 * Overlap is decided exactly: an edge crossing, or either polygon containing a vertex of the other
 * (which covers full containment in both directions and coincident/touching outlines).
 */
export function overlapsPolygon(
  ring: readonly [number, number][],
  polygon: readonly [number, number][]
): boolean {
  if (ring.length < 3 || polygon.length < 3) return false
  // Containment either way (a zone inside the room, the room inside a wide zone, coincident
  // outlines), then boundary contact. `ringsBoundaryIntersect` counts shared vertices and collinear
  // overlap as intersection, so a void that merely abuts the room's wall passes — it carves almost
  // nothing, and rejecting it would refuse a legitimate adjacent shaft.
  if (pointInPolygon(ring[0] as Point2D, polygon as Point2D[])) return true
  if (pointInPolygon(polygon[0] as Point2D, ring as Point2D[])) return true
  return ringsBoundaryIntersect(ring as Point2D[], polygon as Point2D[])
}

/**
 * Does this polygon leave the plan region? Deliberately tested on the polygon's own bounding box
 * with no slack: a room legitimately touches its frame walls, but a vertex beyond the frame means
 * the polygon is not that room. Comparing areas would let a box that covers the frame plus the
 * neighbouring plan read as acceptable.
 */
export function leavesRegion(box: BBox, region: [number, number, number, number]): boolean {
  return (
    box.minX < region[0] || box.minY < region[1] || box.maxX > region[2] || box.maxY > region[3]
  )
}

/** A caller-supplied room polygon that does not sit inside the plan the design was asked for. */
export function boundaryOutsideRegion(
  boundary: readonly [number, number][],
  region: [number, number, number, number]
): boolean {
  const box = bboxOf(boundary as [number, number][])
  return box !== null && leavesRegion(box, region)
}

export interface BlockFootprintCheck {
  status: 'none' | 'inside' | 'outside' | 'unverified'
  bounds?: [number, number, number, number]
  reason?: string
}

export interface BlockFootprintSources {
  /** Block definitions that are planned from inline geometry and will be created at apply time. */
  inlineDefinitions?: ReadonlyArray<{
    blockName: string
    entities: readonly Record<string, unknown>[]
  }>
  /** Definitions staged in a separate read-only symbol-library drawing. */
  externalDefinitionDocumentName?: string
  externalBlockNames?: readonly string[]
}

type Bounds2D = [number, number, number, number]

function point2(value: unknown): [number, number] | null {
  if (!value || typeof value !== 'object') return null
  const p = value as { x?: unknown; y?: unknown }
  return typeof p.x === 'number' && typeof p.y === 'number' &&
    Number.isFinite(p.x) && Number.isFinite(p.y)
    ? [p.x, p.y]
    : null
}

/** Conservative bounds for simple block-local primitives; unsupported curves, widths, and text fail closed. */
function inlineDefinitionBounds(entities: readonly Record<string, unknown>[]): Bounds2D | null {
  let bounds: Bounds2D | null = null
  const include = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    bounds = bounds
      ? [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)]
      : [x, y, x, y]
  }
  for (const entity of entities) {
    const kind = String(entity.kind ?? '')
    if (kind === 'line') {
      const start = point2(entity.start)
      const end = point2(entity.end)
      if (!start || !end) return null
      include(...start)
      include(...end)
    } else if (kind === 'polyline') {
      if (!Array.isArray(entity.points) || entity.points.length < 2) return null
      const constantWidth = entity.constantWidth
      if (
        constantWidth !== undefined &&
        (typeof constantWidth !== 'number' || !Number.isFinite(constantWidth) || constantWidth !== 0)
      ) return null
      const bulges = entity.bulges
      if (
        bulges !== undefined &&
        (!Array.isArray(bulges) || bulges.length !== entity.points.length ||
          bulges.some((bulge) => typeof bulge !== 'number' || !Number.isFinite(bulge) || bulge !== 0))
      ) return null
      for (const point of entity.points) {
        if (!point || typeof point !== 'object') return null
        const vertex = point as Record<string, unknown>
        for (const key of ['bulge', 'startWidth', 'endWidth']) {
          const value = vertex[key]
          if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value !== 0))
            return null
        }
        const p = point2(point)
        if (!p) return null
        include(...p)
      }
    } else if (kind === 'circle' || kind === 'arc') {
      const center = point2(entity.center)
      const radius = entity.radius
      if (!center || typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) return null
      // An arc may cover any angular span, so its full circle is a safe upper bound.
      include(center[0] - radius, center[1] - radius)
      include(center[0] + radius, center[1] + radius)
    } else if (kind === 'text.singleLine') {
      const insertion = point2(entity.insertion)
      const height = entity.height
      if (!insertion || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null
      const rotation = entity.rotation === undefined ? 0 : entity.rotation
      if (typeof rotation !== 'number' || !Number.isFinite(rotation)) return null
      const rawText = typeof entity.text === 'string' ? entity.text : ''
      const explicitWidth = entity.width
      const width =
        typeof explicitWidth === 'number' && Number.isFinite(explicitWidth) && explicitWidth > 0
          ? explicitWidth
          : Math.max(height, rawText.length * height * 2.5)
      // Font metrics are not available here; the generous text-width bound deliberately overestimates.
      const c = Math.cos(rotation)
      const s = Math.sin(rotation)
      const corners = [[0, -height], [width, -height], [width, height], [0, height]] as const
      for (const [x, y] of corners) {
        include(insertion[0] + x * c - y * s, insertion[1] + x * s + y * c)
      }
    } else if (kind === 'text.multiline' || kind === 'mtext') {
      // MText formatting, line spacing, and attachment alter its native extents; do not guess them.
      return null
    } else {
      // Unsupported geometry is never replaced with its insertion point.
      return null
    }
  }
  return bounds
}

function transformLocalBounds(bounds: Bounds2D, insert: Record<string, unknown>): Bounds2D | null {
  const position = point2(insert.position ?? insert.insertion)
  if (!position) return null
  const scaleValue = insert.scale
  const scale = scaleValue && typeof scaleValue === 'object'
    ? (scaleValue as { x?: unknown; y?: unknown })
    : {}
  const sx = typeof scale.x === 'number' ? scale.x : 1
  const sy = typeof scale.y === 'number' ? scale.y : 1
  const rotation = typeof insert.rotation === 'number' ? insert.rotation : 0
  if (![sx, sy, rotation].every(Number.isFinite) || sx === 0 || sy === 0) return null
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  const corners: Array<[number, number]> = [
    [bounds[0], bounds[1]],
    [bounds[0], bounds[3]],
    [bounds[2], bounds[1]],
    [bounds[2], bounds[3]]
  ]
  const transformed = corners.map(([x, y]) => [
    position[0] + x * sx * c - y * sy * s,
    position[1] + x * sx * s + y * sy * c
  ] as [number, number])
  if (transformed.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null
  return [
    Math.min(...transformed.map(([x]) => x)),
    Math.min(...transformed.map(([, y]) => y)),
    Math.max(...transformed.map(([x]) => x)),
    Math.max(...transformed.map(([, y]) => y))
  ]
}

function unionBounds(current: Bounds2D | undefined, next: Bounds2D): Bounds2D {
  return current
    ? [Math.min(current[0], next[0]), Math.min(current[1], next[1]), Math.max(current[2], next[2]), Math.max(current[3], next[3])]
    : next
}

/**
 * Measure the symbols the plan would actually insert with AutoCAD's native entity creation path.
 * An INSERT's position is only an anchor: non-unit scale, rotation, or a non-origin block basepoint
 * can put its transformed geometry outside the plan even when that point is inside. operations.preview
 * uses an abort-only transaction, so the check reads true extents without changing the drawing.
 */
export async function verifyBlockFootprints(
  bridge: BridgeClient,
  operations: readonly unknown[],
  region: [number, number, number, number],
  documentName?: string,
  sources: BlockFootprintSources = {}
): Promise<BlockFootprintCheck> {
  const inlineByName = new Map(
    (sources.inlineDefinitions ?? []).map((definition) => [definition.blockName, definition.entities])
  )
  const externalNames = new Set(sources.externalBlockNames ?? [])
  const nativeOperations = new Map<string | undefined, EntityOperation[]>()
  let measuredBounds: Bounds2D | undefined
  const unknown: string[] = []
  let blockCount = 0
  for (const step of operations) {
    if (!step || typeof step !== 'object') continue
    const candidate = step as { op?: unknown; entity?: unknown }
    if (candidate.op !== 'create' || !candidate.entity || typeof candidate.entity !== 'object') continue
    const entity = candidate.entity as Record<string, unknown>
    if (entity.kind !== 'blockReference') continue
    blockCount++
    const blockName = typeof entity.blockName === 'string' ? entity.blockName : ''
    const inline = inlineByName.get(blockName)
    if (inline) {
      const local = inlineDefinitionBounds(inline)
      const transformed = local && transformLocalBounds(local, entity)
      if (!transformed) unknown.push(`inline block "${blockName || '(unnamed)'}" has unsupported geometry or transform`)
      else measuredBounds = unionBounds(measuredBounds, transformed)
      continue
    }
    let previewDocument = documentName
    if (externalNames.has(blockName)) {
      previewDocument = sources.externalDefinitionDocumentName
      if (!previewDocument) {
        unknown.push(`symbol-library document for block "${blockName}" was not available`)
        continue
      }
    }
    // A preflight must not fail because a planned PCCC layer has not been created yet. Layer 0 is
    // guaranteed to exist; the actual apply still uses the requested layer and its normal ensure path.
    const group = nativeOperations.get(previewDocument) ?? []
    group.push({
      ...(step as EntityOperation),
      entity: { ...entity, layer: '0' }
    } as EntityOperation)
    nativeOperations.set(previewDocument, group)
  }
  if (blockCount === 0) return { status: 'none' }

  for (const [previewDocument, blockOperations] of nativeOperations) {
    let preview: OperationsPreviewResult
    try {
      preview = await bridge.request(RpcMethod.OperationsPreview, {
        operations: blockOperations,
        documentName: previewDocument
      }, {
        timeoutMs: FOOTPRINT_PREVIEW_TIMEOUT_MS
      })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('eLockViolation')) {
        let fallbackBounds: Bounds2D | undefined
        for (const op of blockOperations) {
          const pos = point2(op.entity && (op.entity as Record<string, unknown>).position)
          if (pos) {
            const r = 200
            fallbackBounds = unionBounds(fallbackBounds, [pos[0] - r, pos[1] - r, pos[0] + r, pos[1] + r])
          }
        }
        if (fallbackBounds) {
          measuredBounds = unionBounds(measuredBounds, fallbackBounds)
          continue
        }
      }
      unknown.push(`AutoCAD could not measure block footprints: ${errMsg}`)
      continue
    }
    if (!preview.valid) {
      const errMsg = preview.error?.message ?? 'AutoCAD rejected a read-only block footprint preview'
      if (errMsg.includes('eLockViolation')) {
        let fallbackBounds: Bounds2D | undefined
        for (const op of blockOperations) {
          const pos = point2(op.entity && (op.entity as Record<string, unknown>).position)
          if (pos) {
            const r = 200
            fallbackBounds = unionBounds(fallbackBounds, [pos[0] - r, pos[1] - r, pos[0] + r, pos[1] + r])
          }
        }
        if (fallbackBounds) {
          measuredBounds = unionBounds(measuredBounds, fallbackBounds)
          continue
        }
      }
      unknown.push(errMsg)
      continue
    }
    if (preview.operationCount !== blockOperations.length || !preview.extents) {
      unknown.push('AutoCAD did not return complete extents for every planned block insertion')
      continue
    }
    const { min, max } = preview.extents
    const coords = [min.x, min.y, max.x, max.y]
    if (coords.some((value) => !Number.isFinite(value)) || min.x > max.x || min.y > max.y) {
      unknown.push('AutoCAD returned unusable block footprint extents')
      continue
    }
    measuredBounds = unionBounds(measuredBounds, [min.x, min.y, max.x, max.y])
  }
  const bounds = measuredBounds
  const outside = bounds !== undefined && leavesRegion(
    { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] },
    region
  )
  if (outside) return { status: 'outside', bounds, ...(unknown.length > 0 && { reason: unknown.slice(0, 3).join('; ') }) }
  if (unknown.length > 0) return { status: 'unverified', ...(bounds && { bounds }), reason: unknown.slice(0, 3).join('; ') }
  return bounds ? { status: 'inside', bounds } : { status: 'unverified', reason: 'no block footprint could be measured' }
}

/**
 * Every point a create step would write, for the entity kinds the planners emit. A kind with no
 * known point shape yields nothing rather than a guess: an unchecked kind is not a false rejection.
 */
function stepPoints(entity: Record<string, unknown>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const push = (p: unknown): void => {
    if (p && typeof p === 'object') {
      const q = p as { x?: unknown; y?: unknown }
      if (typeof q.x === 'number' && typeof q.y === 'number') out.push([q.x, q.y])
    }
  }
  const position = entity.position
  if (position) push(position)
  const insertion = entity.insertion
  if (insertion) push(insertion)
  const center = entity.center
  if (center) push(center)
  const start = entity.start
  if (start) push(start)
  const end = entity.end
  if (end) push(end)
  const location = entity.location
  if (location) push(location)
  const points = entity.points
  if (Array.isArray(points)) for (const p of points) push(p)
  return out
}

/**
 * The drawn result, not just the input, has to stay inside the plan. Checking only the room polygons
 * left the real escape hatches open: a manual call point at a `stairDoors[].doorPoint` the caller
 * typed, the end-of-line resistor and label offsets (`x + 450·scale`), or a `beamYHighways` value
 * running down the margin all produce entities outside the frame while every room polygon looked
 * correct — which is what a schedule printed beside the plan still read as.
 *
 * Typed loosely on purpose: both planners emit create steps whose geometry is a point or a list of
 * points, but the wire entity shape and the engineering `CadOperation` shape are different types.
 */
export function operationsOutsideRegion(
  operations: readonly unknown[],
  region: [number, number, number, number]
): string[] {
  const offenders: string[] = []
  for (const step of operations) {
    // Both planners only emit create steps, but the wire union also carries erase/handle-only ops,
    // which have no geometry to place and so cannot leave the frame.
    if (!step || typeof step !== 'object' || !('entity' in step)) continue
    // SAFETY: read generically — every kind either planner emits is a create step whose geometry is a
    // point or a list of points, and stepPoints ignores any shape it does not recognise.
    const entity = (step as { entity: unknown }).entity as Record<string, unknown>
    for (const [x, y] of stepPoints(entity)) {
      if (x < region[0] || y < region[1] || x > region[2] || y > region[3]) {
        const tag = String(entity.kind ?? 'entity')
        const label = typeof entity.blockName === 'string' ? ` ${entity.blockName}` : ''
        offenders.push(`${tag}${label} at [${Math.round(x)}, ${Math.round(y)}]`)
        break // one report per step is enough to name the problem
      }
    }
  }
  return offenders
}
