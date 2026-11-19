import type { Point2D } from '../schemas/semantic-model'
import type { FurnitureKind, Space, SpatialModel } from './spatial-schema'
import { bboxOf, centroidOf, distanceToRingBoundary, pointInPolygon, rotatedRect } from './geometry'
import { validatePlacement, type ProposedPlacement, type ValidateOptions } from './constraints'

/**
 * Furniture candidate generation + ranking.
 *
 * The agent states WHAT a room needs (a bed, a wardrobe, a dining table) with real block sizes from
 * a library or the Design Basis; this module enumerates the placements that actually fit and ranks
 * them by deterministic, geometry-grounded preferences. It never invents a clearance or a code
 * minimum — a candidate is only ever scored on measured facts (does it fit, does it block a door
 * sweep, does it sit against a wall when that kind of item normally does).
 *
 * Every candidate is run through the SAME `validatePlacement` the preflight gate uses, so a ranked
 * suggestion can never be something the gate would later reject. `INSUFFICIENT_DATA` candidates are
 * kept (that status means "swing clearance could not be evaluated", not "invalid") but scored below
 * clean `PASS` ones, so the agent sees the caveat rather than a silently-dropped option.
 */

export interface FurnitureRequest {
  id: string
  kind: FurnitureKind
  width: number
  depth: number
  /** Target space id. Omit to try every evaluable space. */
  spaceId?: string
  /** How many candidates to return. */
  limit?: number
}

export interface FurnitureCandidate {
  center: Point2D
  rotationDeg: number
  spaceId: string
  /** 'PASS' = fully validated; 'INSUFFICIENT_DATA' = fits, but some check could not run. */
  status: 'PASS' | 'INSUFFICIENT_DATA'
  /** Higher is better. Composition of the measured preferences below. */
  score: number
  /** Why this scored what it did — auditable, not a bare number. */
  reasons: string[]
}

/** Kinds that normally sit against a wall (beds, wardrobes, cabinets, counters, desks). */
const WALL_BORNE: ReadonlySet<FurnitureKind> = new Set([
  'bed',
  'wardrobe',
  'cabinet',
  'counter',
  'desk',
  'appliance',
])
/** Kinds that normally sit in the middle of a room (tables, sofas). */
const CENTER_BORNE: ReadonlySet<FurnitureKind> = new Set(['table', 'diningTable', 'sofa'])

/**
 * Enumerate and rank placements for one furniture request. The search is bounded by each space's
 * bbox × grid step × two rotations, so cost is polynomial and deterministic — no backtracking, no
 * randomness, no wall-clock-dependent iteration budget.
 */
export function generateFurnitureCandidates(
  model: SpatialModel,
  request: FurnitureRequest,
  options: ValidateOptions = {},
  gridStep = 400
): FurnitureCandidate[] {
  const spaces = request.spaceId
    ? model.spaces.filter((s) => s.id === request.spaceId)
    : model.spaces.filter((s) => s.boundary.length >= 3 && s.confidence !== 'low')
  const out: FurnitureCandidate[] = []

  for (const space of spaces) {
    const box = bboxOf(space.boundary)
    if (!box) continue
    for (let x = box.minX; x <= box.maxX; x += gridStep) {
      for (let y = box.minY; y <= box.maxY; y += gridStep) {
        for (const rotationDeg of [0, 90]) {
          const placement: ProposedPlacement = {
            id: request.id,
            kind: request.kind,
            spaceId: space.id,
            center: [x, y],
            width: request.width,
            depth: request.depth,
            rotationDeg,
          }
          const result = validatePlacement({ model, placement, batch: [], options })
          if (result.status === 'FAIL') continue
          const footprint = rotatedRect([x, y], request.width, request.depth, rotationDeg)
          const scored = scoreCandidate(space, footprint, [x, y], request.kind, model)
          const status = result.status === 'PASS' ? 'PASS' : 'INSUFFICIENT_DATA'
          if (status === 'INSUFFICIENT_DATA') {
            scored.score -= 25
            scored.reasons.push('some checks could not run (door sweep not modelled)')
          }
          out.push({ center: [x, y], rotationDeg, spaceId: space.id, status, ...scored })
        }
      }
    }
  }

  // Deterministic ranking: score desc, then coordinates for a stable tie-break.
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.center[0] - b.center[0] ||
      a.center[1] - b.center[1] ||
      a.rotationDeg - b.rotationDeg
  )
  return out.slice(0, request.limit ?? 5)
}

function scoreCandidate(
  space: Space,
  footprint: Point2D[],
  center: Point2D,
  kind: FurnitureKind,
  model: SpatialModel
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  // Wall-borne items score higher near a wall; center-borne items higher near the centroid.
  const wallDist = distanceToRingBoundary(center, space.boundary)
  const centroid = centroidOf(space.boundary)
  const centerDist = Math.hypot(center[0] - centroid[0], center[1] - centroid[1])
  if (WALL_BORNE.has(kind)) {
    score += 100 - wallDist / 100
    reasons.push(`wall-borne: ${Math.round(wallDist)} units from boundary`)
  } else if (CENTER_BORNE.has(kind)) {
    score += 100 - centerDist / 100
    reasons.push(`center-borne: ${Math.round(centerDist)} from room centroid`)
  }

  // Keep clear of door sweeps: penalise any footprint that lands in a leaf's swept region.
  for (const d of model.openings) {
    if (d.kind !== 'door' || !d.sweptArea) continue
    if (footprintOverlaps(footprint, d.sweptArea)) {
      score -= 60
      reasons.push(`blocks door sweep ${d.handle}`)
    }
  }

  // Furniture parked in a corridor is legal but worth flagging.
  if (space.spaceType === 'circulation') {
    score -= 20
    reasons.push('in a circulation space')
  }

  return { score, reasons }
}

/** Overlap test: any footprint vertex inside the sweep, or vice versa. */
function footprintOverlaps(a: Point2D[], b: Point2D[]): boolean {
  for (const p of a) if (pointInPolygon(p, b)) return true
  for (const p of b) if (pointInPolygon(p, a)) return true
  return false
}
