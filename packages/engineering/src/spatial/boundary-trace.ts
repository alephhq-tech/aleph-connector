import type { Point2D } from '../schemas/semantic-model'
import { pointInRing } from './geometry'
import type { RestrictedZone } from './preflight'
import type { KnownZoneClass } from './region'

/** One vision/user-identified interior point of a region whose polygon must be recovered. */
export interface CandidatePickPoint {
  id?: string
  /** Approximate interior point in drawing coordinates. Only needs to be INSIDE the region. */
  point: Point2D
  /** Classification suggestion (vision or user). Never used to build geometry. */
  suggestedClass?: KnownZoneClass | string
  label?: string
}

export interface TraceBoundaryRequest {
  documentName?: string
  point: { x: number; y: number; z: number }
  detectIslands?: boolean
}

export interface TraceBoundaryLoop {
  kind: 'outer' | 'island'
  points: Array<{ x: number; y: number; z?: number }>
  area: number
  perimeter?: number
  isClosed: boolean
}

export interface TraceBoundaryResponse {
  found: boolean
  boundaries: TraceBoundaryLoop[]
  netArea: number
  /** Why nothing was traced, or what the CAD engine skipped. */
  reason?: string
  /** Always 'WCS' on the wire (mirrors EntityTraceBoundaryResult); optional here to keep the seam decoupled. */
  coordinateSystem?: 'WCS'
  /** True when the plugin traced under a non-World UCS (spec E1). Recorded, never used to build geometry. */
  ucsWithWorld?: boolean
}

/**
 * Structural stand-in for the `entity.traceBoundary` RPC. Kept as a plain function type so this
 * package does not depend on the AutoCAD wire protocol; the MCP tool passes
 * `(req) => bridge.request(RpcMethod.EntityTraceBoundary, req)`.
 */
export type TraceBoundaryCall = (request: TraceBoundaryRequest) => Promise<TraceBoundaryResponse>

export interface TracedRegion {
  id: string
  zoneClass: string
  label?: string
  outer: Point2D[]
  holes: Point2D[][]
  areaM2: number
  perimeter: number
  verified: boolean
  confidence: 'high' | 'medium' | 'low'
  evidence: string
}

export interface UnresolvedPickPoint {
  candidate: CandidatePickPoint
  /** The CAD engine's own explanation, when it gave one. */
  reason?: string
}

export interface TraceBoundariesResult {
  regions: TracedRegion[]
  /** Ready to hand to preflight as restricted volumes, and to routers as forbidden zones. */
  restrictedZones: RestrictedZone[]
  /** Pick points that produced no closed boundary — reported, never guessed around. */
  unresolvedPoints: UnresolvedPickPoint[]
}

/** Plausible area range per zone class, in m2 — a sanity signal, never a reason to fabricate a ring. */
const AREA_SANITY_LIMITS_M2: Record<string, { min: number; max: number }> = {
  elevator_shaft: { min: 1, max: 25 },
  stairwell: { min: 3, max: 80 },
  electrical_riser: { min: 0.3, max: 20 },
  // pick points are now sent for every room (PR #493 + skills), not just shafts, so the common room
  // classes need a band too: a ring that swallows the whole floor plan is far outside any single room.
  room: { min: 2, max: 400 },
  office: { min: 2, max: 400 },
  corridor: { min: 1, max: 400 },
  garage: { min: 20, max: 20000 }
}

/**
 * Jitter offsets (millimetres) for a pick point on a line or in a gap; scaled into
 * drawing units by the caller via `unitsPerMetre` — never applied raw to a non-mm drawing.
 */
const JITTER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [250, 250],
  [-250, 250],
  [250, -250],
  [-250, -250],
  [600, 0],
  [-600, 0],
  [0, 600],
  [0, -600]
]

/**
 * Turns rough pick points into authoritative closed polygons using the CAD engine's own boundary
 * trace (`Editor.TraceBoundary` in the plugin — the same engine behind HATCH boundary picking).
 *
 * This is the bridge between "the model can SEE the elevator" and "the router can be forced to avoid
 * it": the ring comes from real geometry, so it works on a drawing whose architecture is one merged
 * block, where no closed room polyline can be read directly. Vision names the region; CAD supplies
 * its boundary — never the other way round.
 */
export async function traceRegionBoundaries(
  traceBoundary: TraceBoundaryCall,
  candidates: readonly CandidatePickPoint[],
  options: {
    documentName?: string
    /**
     * Drawing units per metre, resolved from `drawing.summary` `insUnits` (E8).
     * When absent the boundary is not traced at all — candidates report unresolved.
     */
    unitsPerMetre?: number
    detectIslands?: boolean
  } = {}
): Promise<TraceBoundariesResult> {
  // E8: refuse to measure without a declared unit basis. There is no INSUFFICIENT_DATA
  // channel on this result type, so every candidate is unresolved with the reason named.
  if (
    options.unitsPerMetre === undefined ||
    !Number.isFinite(options.unitsPerMetre) ||
    options.unitsPerMetre <= 0
  ) {
    return {
      regions: [],
      restrictedZones: [],
      unresolvedPoints: candidates.map((candidate) => ({
        candidate,
        reason:
          'Drawing units were not declared (unitsPerMetre missing) — pass unitsPerMetre ' +
          'resolved from drawing.summary insUnits; the boundary was not traced and no area ' +
          'was measured as millimetres.'
      }))
    }
  }
  const unitsPerMetre = options.unitsPerMetre
  const unitsPerMm = unitsPerMetre / 1000
  const m2Divisor = unitsPerMetre * unitsPerMetre
  const detectIslands = options.detectIslands ?? true
  // Jitter offsets are physical millimetres, scaled into drawing units like every other
  // mm distance in this module.
  const jitterOffsets: ReadonlyArray<readonly [number, number]> = JITTER_OFFSETS.map(
    ([dx, dy]) => [dx * unitsPerMm, dy * unitsPerMm] as const
  )

  const regions: TracedRegion[] = []
  const restrictedZones: RestrictedZone[] = []
  const unresolvedPoints: UnresolvedPickPoint[] = []
  let counter = 1

  for (const candidate of candidates) {
    let response: TraceBoundaryResponse | null = null
    let lastReason: string | undefined
    let hitPoint: Point2D = candidate.point

    for (const [dx, dy] of jitterOffsets) {
      const testPoint: Point2D = [candidate.point[0] + dx, candidate.point[1] + dy]
      let result: TraceBoundaryResponse | null = null
      try {
        result = await traceBoundary({
          documentName: options.documentName,
          point: { x: testPoint[0], y: testPoint[1], z: 0 },
          detectIslands
        })
      } catch {
        result = null
      }
      if (result?.found && result.boundaries.length > 0) {
        response = result
        hitPoint = testPoint
        break
      }
      lastReason = result?.reason ?? lastReason
    }

    if (!response) {
      unresolvedPoints.push({ candidate, reason: lastReason })
      continue
    }

    const outer =
      response.boundaries.find((loop) => loop.kind === 'outer') ?? response.boundaries[0]!
    const islands = response.boundaries.filter((loop) => loop !== outer)
    if (!outer || outer.points.length < 3 || !outer.isClosed) {
      unresolvedPoints.push({
        candidate,
        reason: response.reason ?? 'AutoCAD returned an unreadable or open ring.'
      })
      continue
    }

    const outerRing: Point2D[] = outer.points.map((p) => [p.x, p.y])
    const holes: Point2D[][] = islands.map((isl) => isl.points.map((p) => [p.x, p.y]))
    const areaM2 = (outer.area || response.netArea) / m2Divisor
    const zoneClass = candidate.suggestedClass ?? 'unknown'

    // E2: TraceBoundary from an interior point returns the ring that ENCLOSES the point — but when
    // the pick lands on a wall stroke or in a gap, jitter can land it just outside the intended
    // room, and the engine then hands back the ring of the neighbouring room or the whole corridor.
    // A ring that does not contain the pick point proves it is not the region the caller pointed at,
    // so it is reported unresolved, never accepted as the region. `pointInRing` counts on-boundary
    // hits as inside, so a pick that landed exactly on a shared wall still matches its own room.
    if (!pointInRing(hitPoint, outerRing)) {
      unresolvedPoints.push({
        candidate,
        reason:
          `AutoCAD traced a closed ring at [${hitPoint[0]}, ${hitPoint[1]}] but that ring does not ` +
          `contain the pick point (area ${areaM2.toFixed(2)} m2) — the boundary found belongs to a ` +
          `different region than the one at this point`
      })
      continue
    }

    const id = candidate.id ?? `${zoneClass}_${counter++}`

    // verified is a real guarantee, not a default: the ring must contain the point (checked above)
    // AND its area must sit in the plausible band for the named class. An implausible area leaves
    // the polygon present but unverified so preflight refuses to certify a batch against it.
    const sanity = AREA_SANITY_LIMITS_M2[zoneClass]
    const withinBand = !sanity || (areaM2 >= sanity.min && areaM2 <= sanity.max)
    const confidence: TracedRegion['confidence'] = withinBand ? 'high' : 'medium'
    const verified = withinBand

    const evidence = `native boundary trace at [${hitPoint[0]}, ${hitPoint[1]}] (area ${areaM2.toFixed(2)} m2)`

    regions.push({
      id,
      zoneClass,
      label: candidate.label,
      outer: outerRing,
      holes,
      areaM2,
      perimeter: outer.perimeter ?? 0,
      verified,
      confidence,
      evidence
    })

    restrictedZones.push({
      id,
      zoneClass,
      outer: outerRing,
      holes,
      verified,
      sourceHandles: [],
      confidence,
      evidence
    })
  }

  return { regions, restrictedZones, unresolvedPoints }
}
