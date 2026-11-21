import type { Point2D } from '@aleph-connector/engineering'
import { areaOf, ensureCCW, pointInRing } from '@aleph-connector/engineering'

/**
 * Pure half of Slice 02 step 4: given the label points an inspect already returned and the closed
 * rings that fall inside the same region, attach each room its real `boundary` — or a verdict that
 * the boundary could not be resolved. It never invents a polygon: a room is only `verified` when a
 * candidate ring actually contains the label.
 *
 * The rings come from the CAD State snapshot (region-scoped), not from the plugin, so this stays
 * "reduce RPCs", not "hide them in the plugin". The seam that fetches + maps entities to rings is
 * separate; this kernel is what turns them into a trustworthy per-room outline.
 */

/** A closed ring already extracted from one region entity. `handle` keeps provenance for evidence. */
export interface RegionRing {
  handle: string
  ring: Point2D[]
}

export interface RoomWithBoundary {
  name: string
  labelPosition: [number, number]
  boundary?: [number, number][]
  boundaryStatus: 'verified' | 'unresolved' | 'ambiguous'
  boundaryEvidence?: string
  areaM2?: number
  /**
   * Handle this room is addressed by within one document revision. Attached by the CAD State
   * assembler (the only layer that knows the revision), so the publisher
   * (`drawing.inspect_floorplan`) and the resolver (`pccc_fire_alarm_overlay`) cannot drift apart.
   */
  ref?: string
}

export interface AssembleOptions {
  /** Metres per drawing unit (mm default = 0.001). Used only for the `areaM2` convenience field. */
  unitScaleM?: number
  /** The region `bounds` [minX,minY,maxX,maxY]; a ring this size is the sheet border, not a room. */
  regionBounds?: [number, number, number, number]
  /** Fraction of the region area at/above which a containing ring is judged the whole sheet. */
  wholeRegionFraction?: number
}

// Area tie tolerance, as a fraction of the smaller candidate's area. Two rings that trace the same
// outline (or a border and a near-full region) are indistinguishable, so we refuse to pick one.
const AREA_TIE_FRACTION = 1e-6

function areaInRegion(regionBounds: [number, number, number, number] | undefined): number | null {
  if (!regionBounds) return null
  const [minX, minY, maxX, maxY] = regionBounds
  return Math.abs((maxX - minX) * (maxY - minY))
}

/**
 * Assembles per-room boundaries. Rooms whose label matches no candidate ring, or matches a set the
 * kernel cannot disambiguate, come back without `boundary` and a status explaining why — never with
 * a fabricated outline.
 */
export function assembleRoomBoundaries(
  rooms: ReadonlyArray<{ name: string; labelPosition: [number, number] }>,
  rings: readonly RegionRing[],
  options: AssembleOptions = {}
): RoomWithBoundary[] {
  const unitScaleM = options.unitScaleM ?? 0.001
  const regionArea = areaInRegion(options.regionBounds)
  const wholeRegionFraction = options.wholeRegionFraction ?? 0.85

  // Pre-filter to well-formed rings; the containment and area work is per label after.
  const usable: Array<RegionRing & { area: number }> = []
  for (const candidate of rings) {
    if (candidate.ring.length < 3) continue
    if (!candidate.ring.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) continue
    const area = areaOf(candidate.ring)
    if (area <= 0) continue
    // A ring that covers essentially the whole region is the sheet border / building outline, not
    // an individual room — verifying it as a "room boundary" would be a lie about the room.
    if (regionArea !== null && area >= regionArea * wholeRegionFraction) continue
    usable.push({ ...candidate, area })
  }

  return rooms.map((room) => {
    const label: Point2D = [room.labelPosition[0], room.labelPosition[1]]
    const containing = usable.filter((c) => pointInRing(label, c.ring))
    if (containing.length === 0) {
      return { ...room, boundaryStatus: 'unresolved' }
    }

    // The innermost containing ring is the room; an enclosing wall or a neighbouring room's outline
    // does not contain this room's centre label. Two rings that tie on area cannot be told apart.
    let smallest = containing[0]!
    for (const c of containing) if (c.area < smallest.area) smallest = c
    const tied = containing.filter(
      (c) => Math.abs(c.area - smallest.area) <= smallest.area * AREA_TIE_FRACTION
    )
    if (tied.length > 1) {
      const handles = tied.map((c) => c.handle).join(', ')
      return {
        ...room,
        boundaryStatus: 'ambiguous',
        boundaryEvidence: `${tied.length} closed rings share the smallest area containing the label (handles: ${handles}); no single outline is trusted`
      }
    }

    const ring = ensureCCW(smallest.ring)
    const areaM2 = smallest.area * unitScaleM * unitScaleM
    return {
      ...room,
      boundary: ring.map((p) => [p[0], p[1]] as [number, number]),
      boundaryStatus: 'verified',
      boundaryEvidence: `closed ring ${smallest.handle} contains label, area ${areaM2.toFixed(2)} m2`,
      areaM2
    }
  })
}

/** True when every room came back verified — the payload is `geometryComplete`. */
export function allBoundariesVerified(rooms: readonly RoomWithBoundary[]): boolean {
  return rooms.length > 0 && rooms.every((r) => r.boundaryStatus === 'verified')
}
