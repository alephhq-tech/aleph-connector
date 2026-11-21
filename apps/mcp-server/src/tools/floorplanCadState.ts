import type { Point2D } from '@aleph-connector/engineering'
import {
  assembleRoomBoundaries,
  type RegionRing,
  type RoomWithBoundary
} from './floorplanBoundary.js'

/**
 * CAD State half of Slice 02: attach real room `boundary` polygons to an inspect by reading the
 * drawing's already-indexed snapshot, NOT by scripting a big plugin read. The tool makes at most
 * one bounded `cad.scan` (region hydrate) per inspect; a snapshot already verified at the live
 * revision with full geometry in the region costs zero extra AutoCAD round trips.
 *
 * It is a READER only. It never claims an index job and never writes a snapshot — the CAD State
 * Engine in run-engine owns the single scan path. When no current, verified geometry exists for the
 * region it fails closed: every room comes back `unresolved` with no fabricated polygon.
 */

/** Identity the plugin already reported on the inspect (no separate drawing.info probe). */
export interface InspectIdentity {
  documentId?: string
  fingerprintGuid?: string | null
  revision?: string
  documentName?: string
  layoutName?: string
  units?: string
}

/** A snapshot entity row projected to what boundary assembly needs. */
export interface SnapshotRow {
  handle: string
  kind: string
  /** CAD-authored classification retained for downstream evidence extraction (beam/grid layers). */
  layer?: string
  /** Definition name for block-reference evidence (panel/JB instances), never inferred from text. */
  blockName?: string | null
  geometry?: Record<string, unknown> | null
}

/**
 * The injectable seam the tool supplies. Production binds these to `cadStateService` + `db.cadSnapshotEntities`
 * + `bridge.request(CadScan)`; tests bind them to fakes so RPC counts are assertable without a DB.
 */
export interface RegionGeometrySource {
  /** Freshness + snapshot id for this live revision, or null when there is no verified drawing.
   * `fresh` means a snapshot verified at exactly `identity.revision`. */
  snapshotFor(identity: InspectIdentity): Promise<{ snapshotId: string; fresh: boolean } | null>
  /** Summary-or-full rows whose bbox intersects the window (0 AutoCAD RPC — reads the index). */
  rowsInWindow(snapshotId: string, window: Window2D, limit: number): Promise<SnapshotRow[]>
  /** Bounded full-geometry hydrate for specific handles (1 AutoCAD `cad.scan`). */
  hydrate(handles: string[], identity: InspectIdentity): Promise<SnapshotRow[]>
  /** One complete, revision-bracketed full scan of a named paper-space layout. */
  scanLayout?(
    layoutName: string,
    identity: InspectIdentity,
    limit: number
  ): Promise<{ rows: SnapshotRow[]; complete: boolean; note?: string }>
}

export interface Window2D {
  min: { x: number; y: number }
  max: { x: number; y: number }
}

/**
 * The fail-closed source used when no tenant context exists: no snapshot can be read, so every room
 * stays `unresolved` rather than being drawn from an invented outline. Both tools that assemble
 * geometry fall back to this same object, so "no index available" behaves identically everywhere.
 */
export const emptyGeometrySource: RegionGeometrySource = {
  async snapshotFor() {
    return null
  },
  async rowsInWindow() {
    return []
  },
  async hydrate() {
    return []
  }
}

/**
 * The handle a room is referenced by on this sheet. One definition, because two tools hand it out:
 * `drawing.inspect_floorplan` publishes it, `pccc_fire_alarm_overlay` resolves it. Drift between them
 * would make every published ref unresolvable, which is exactly the failure a caller cannot work
 * around from the outside.
 */
export function roomRef(revision: string | undefined, name: string): string {
  return `fp_${revision ?? 'unrev'}:${name}`.replace(/\s+/g, '')
}

// Cap region hydrate so a huge floor plan cannot pull an unbounded handle list into one call. The
// plugin caps cad.scan at 2000/page; we stay under that and page only as far as the window holds.
const HYDRATE_CAP = 1500
const ROW_QUERY_LIMIT = 2000

function windowFromBounds(bounds: [number, number, number, number]): Window2D {
  return { min: { x: bounds[0], y: bounds[1] }, max: { x: bounds[2], y: bounds[3] } }
}

/**
 * Extracts a closed ring from one snapshot entity's `geometry` (the shape entity.list/get full
 * returns, mirrored by the mock's `polylineGeometry`). A polyline that is not closed, has no usable
 * vertex list, or fewer than 3 finite vertices yields null — the assembler never sees a partial ring.
 */
export function ringFromGeometry(
  kind: string,
  geometry: Record<string, unknown> | null | undefined
): Point2D[] | null {
  if (kind !== 'polyline' || !geometry) return null
  const closed = geometry.closed
  if (closed !== true) return null
  const raw = geometry.vertices ?? geometry.points
  if (!Array.isArray(raw)) return null
  const ring: Point2D[] = []
  for (const entry of raw) {
    // Polyline vertex objects carry the point under `point`; a plain point list carries x/y directly.
    const p =
      entry && typeof entry === 'object' && 'point' in entry
        ? (entry as { point?: { x?: unknown; y?: unknown } }).point
        : (entry as { x?: unknown; y?: unknown })
    const x = p?.x
    const y = p?.y
    if (
      typeof x === 'number' &&
      typeof y === 'number' &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    ) {
      ring.push([x, y])
    }
  }
  return ring.length >= 3 ? ring : null
}

export interface RegionAssembly {
  rooms: RoomWithBoundary[]
  geometryComplete: boolean
  /** Same current-revision rows used for room assembly; downstream readers may derive CAD evidence. */
  evidenceRows: SnapshotRow[]
  /** Present when geometry could not be produced (and why) — never a silent empty. */
  geometryNote?: string
}

function unitScaleM(units: string | undefined): number {
  switch ((units ?? '').toLowerCase()) {
    case 'mm':
      return 0.001
    case 'cm':
      return 0.01
    case 'm':
      return 1
    case 'in':
    case 'inch':
    case 'inches':
      // Live SUNLAND reports INSUNITS = "in"; a mm-only assumption would inflate m² by ~39x.
      return 0.0254
    case 'ft':
    case 'feet':
      return 0.3048
    default:
      // Unknown/unitless units: areas are not trusted in m², so the convenience field simply stays
      // wrong-free by reporting drawing-units² scale of 1 (boundary geometry itself is unit-free).
      return 1
  }
}

/**
 * Assembles per-room boundaries for an attributed region from the CAD State snapshot. Fails closed
 * (all rooms `unresolved`) when there is no fresh verified snapshot for this exact revision, so a
 * stale or missing index never masquerades as room geometry.
 */
export async function assembleFloorplanGeometry(
  source: RegionGeometrySource,
  identity: InspectIdentity,
  rooms: ReadonlyArray<{ name: string; labelPosition: [number, number] }>,
  bounds: [number, number, number, number]
): Promise<RegionAssembly> {
  // Every room leaves this function addressable by a handle, verified or not: a caller that asks for
  // a room by `ref` gets an explicit "unresolved" back rather than a silent miss.
  const withRefs = (list: RoomWithBoundary[]): RoomWithBoundary[] =>
    list.map((r) => ({ ...r, ref: roomRef(identity.revision, r.name) }))

  const unresolved = (): RegionAssembly => ({
    rooms: withRefs(assembleRoomBoundaries(rooms, [], { regionBounds: bounds })),
    geometryComplete: false,
    evidenceRows: [],
    geometryNote: 'no current verified geometry for this region; boundaries unresolved'
  })

  // A label-less, block-merged sheet can still carry trustworthy panel/block and structural-line
  // evidence. Continue into the verified snapshot instead of returning early; rooms remain [].

  let rows: SnapshotRow[]
  const layoutName = identity.layoutName?.trim()
  if (layoutName && layoutName.toLowerCase() !== 'model') {
    if (!source.scanLayout) {
      return {
        ...unresolved(),
        geometryNote: `layout-scoped geometry scan is unavailable for layout "${layoutName}"`
      }
    }
    const scan = await source.scanLayout(layoutName, identity, ROW_QUERY_LIMIT)
    if (!scan.complete) {
      return {
        ...unresolved(),
        geometryNote:
          scan.note ?? `layout "${layoutName}" could not be read completely at the current revision`
      }
    }
    rows = scan.rows
  } else {
    const access = await source.snapshotFor(identity)
    if (!access)
      return { ...unresolved(), geometryNote: 'no verified CAD State snapshot for this drawing' }
    if (!access.fresh)
      return {
        ...unresolved(),
        geometryNote: 'CAD State snapshot is not verified at the current revision'
      }

    const window = windowFromBounds(bounds)
    rows = await source.rowsInWindow(access.snapshotId, window, ROW_QUERY_LIMIT)
  }

  // Rows already carrying full geometry need no round trip. Only handles whose geometry is missing
  // go to one bounded hydrate.
  const withGeometry = rows.filter((r) => r.geometry)
  const missing = rows.filter((r) => !r.geometry).map((r) => r.handle)

  let hydrated: SnapshotRow[] = []
  if (missing.length > 0) {
    const capped = missing.slice(0, HYDRATE_CAP)
    hydrated = await source.hydrate(capped, identity)
  }

  const rings: RegionRing[] = []
  for (const row of [...withGeometry, ...hydrated]) {
    const ring = ringFromGeometry(row.kind, row.geometry)
    if (ring) rings.push({ handle: row.handle, ring })
  }

  const assembled = withRefs(
    assembleRoomBoundaries(rooms, rings, {
      regionBounds: bounds,
      unitScaleM: unitScaleM(identity.units)
    })
  )
  const geometryComplete =
    assembled.length > 0 && assembled.every((r) => r.boundaryStatus === 'verified')

  return {
    rooms: assembled,
    geometryComplete,
    evidenceRows: [...withGeometry, ...hydrated],
    ...(geometryComplete
      ? {}
      : {
          geometryNote:
            rooms.length === 0
              ? 'the attributed region contains no room labels to bound; structural and block evidence remains available'
              : 'some rooms have no single trusted closed ring containing their label'
        })
  }
}
