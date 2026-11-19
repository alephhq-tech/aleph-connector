import type { Point2D } from '../schemas/semantic-model'
import type { Space, SpatialModel, SpatialOpening } from './spatial-schema'
import { bboxOf, ensureCCW } from './geometry'
import {
  normalizeProgram,
  spaceTypeOfUsage,
  type SpatialProgram,
  type SpatialProgramInput,
  type ProgramRoom
} from './program'

/**
 * Deterministic layout candidate generation.
 *
 * Given a spatial program and a site (a polygon, or an already-drawn model whose spaces act as
 * anchors), this produces a small set of ranked room-placement candidates plus the door openings
 * those placements imply. It is a CANDIDATE GENERATOR, not an architect: every candidate still has
 * to pass `validateBatch`/`checkProgram` before anything is drawn, and nothing here asserts a
 * regulation — room sizes come from the program's own target areas, and the only geometry invented
 * is rectangular packing inside the site the caller supplied.
 *
 * Determinism is a hard requirement: the same program + site must yield the same candidates, so a
 * run can be replayed and a verdict can be pinned by a test. No randomness, no iteration budget
 * that depends on wall-clock.
 */

export interface SiteBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface RoomPlacement {
  roomId: string
  usage: ProgramRoom['usage']
  spaceType: Space['spaceType']
  /** Rectangle corners in drawing units, CCW. */
  boundary: Point2D[]
  areaM2: number
  targetAreaM2: number
}

export interface OpeningCandidate {
  /** Deterministic id so a caller can reference it before the entity exists. */
  id: string
  kind: 'door'
  /**
   * The spaces this door joins. Two for an interior door; ONE for an exterior entry door (the
   * other side is the outside, which is not a modelled room) — the same convention `extract` uses
   * for a real exterior door.
   */
  connectsSpaces: string[]
  connectionType: 'interior' | 'exterior'
  center: Point2D
  width: number
  /** The wall segment this door sits on. */
  wallSegment: [Point2D, Point2D]
}

export interface LayoutCandidate {
  id: string
  rooms: RoomPlacement[]
  openings: OpeningCandidate[]
  /** 0..1: how many required adjacencies the packing satisfies. */
  adjacencyScore: number
  /** Required adjacencies that the packing failed to make adjacent. */
  unmetAdjacency: Array<{ room: string; needs: string }>
  /** Site area actually covered by rooms (0..1) — a sanity signal, not a target. */
  coverage: number
}

const rectRing = (x: number, y: number, w: number, h: number): Point2D[] =>
  ensureCCW([
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ])

/** Site bounds from a program's site polygon, falling back to an explicit box. */
export function siteBoundsOf(
  program: SpatialProgramInput,
  fallback?: SiteBounds
): SiteBounds | null {
  if (program.siteBoundary?.length) {
    const b = bboxOf(program.siteBoundary)
    if (b) return b
  }
  return fallback ?? null
}

/**
 * Shelf-pack rooms into the site: sort by priority then area, lay them left-to-right in rows whose
 * height is the tallest room in the row. Aspect ratio comes from the room's own target area (a
 * square-ish footprint unless the program says otherwise), converted to drawing units via
 * unitsPerMetre. Bounded and deterministic — no backtracking, no randomness.
 */
function packRooms(
  program: SpatialProgram,
  bounds: SiteBounds
): Array<{ room: ProgramRoom; x: number; y: number; w: number; h: number }> {
  const siteW = bounds.maxX - bounds.minX
  const siteH = bounds.maxY - bounds.minY
  const upm = program.unitsPerMetre
  const sorted = [...program.rooms].sort(
    (a, b) => b.priority - a.priority || b.targetAreaM2 - a.targetAreaM2 || a.id.localeCompare(b.id)
  )

  const placed: Array<{ room: ProgramRoom; x: number; y: number; w: number; h: number }> = []
  let shelfY = bounds.minY
  let shelfHeight = 0
  let cursorX = bounds.minX

  for (const room of sorted) {
    // Target area (m²) → drawing units², then a square-ish footprint.
    const areaUnits = room.targetAreaM2 * upm * upm
    let w = Math.sqrt(areaUnits)
    let h = w
    // Fit to the shelf: never exceed the site width, keep the aspect.
    if (cursorX + w > bounds.maxX) {
      shelfY += shelfHeight
      shelfHeight = 0
      cursorX = bounds.minX
    }
    w = Math.min(w, bounds.maxX - cursorX)
    h = Math.min(areaUnits / w, bounds.maxY - shelfY)
    if (w <= 0 || h <= 0) break // site exhausted — remaining rooms go unplaced, reported as such

    placed.push({ room, x: cursorX, y: shelfY, w, h })
    cursorX += w
    shelfHeight = Math.max(shelfHeight, h)
  }

  // Keep the packing inside the site vertically; anything that overflowed is dropped (reported).
  return placed.filter((p) => p.y + p.h <= bounds.maxY + 1e-6 && p.x + p.w <= bounds.maxX + 1e-6)
}

/** Shared edge between two axis-aligned rectangles, if any (returns the segment or null). */
function sharedEdge(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): [Point2D, Point2D] | null {
  const eps = 1e-6
  // a right edge against b left edge (or vice versa), overlapping in y.
  const vertical = Math.abs(a.x + a.w - b.x) < eps || Math.abs(b.x + b.w - a.x) < eps
  const horizontal = Math.abs(a.y + a.h - b.y) < eps || Math.abs(b.y + b.h - a.y) < eps
  if (vertical) {
    const lo = Math.max(a.y, b.y)
    const hi = Math.min(a.y + a.h, b.y + b.h)
    if (hi - lo > eps) {
      const x = Math.abs(a.x + a.w - b.x) < eps ? a.x + a.w : b.x + b.w
      return [
        [x, lo],
        [x, hi]
      ]
    }
  }
  if (horizontal) {
    const lo = Math.max(a.x, b.x)
    const hi = Math.min(a.x + a.w, b.x + b.w)
    if (hi - lo > eps) {
      const y = Math.abs(a.y + a.h - b.y) < eps ? a.y + a.h : b.y + b.h
      return [
        [lo, y],
        [hi, y]
      ]
    }
  }
  return null
}

/**
 * Generate ranked layout candidates for a program on a site. `variants` rotates the shelf axis and
 * the sort tie-break so the caller gets a handful of genuinely different packings to validate,
 * still fully deterministic.
 */
export function generateLayoutCandidates(
  program: SpatialProgramInput,
  bounds: SiteBounds,
  variants = 3
): LayoutCandidate[] {
  const normalized = normalizeProgram(program)
  const upm = normalized.unitsPerMetre ?? 1000
  const candidates: LayoutCandidate[] = []

  for (let v = 0; v < Math.max(1, Math.min(variants, 4)); v++) {
    // Variant 0: priority-first, horizontal shelves. Variant 1: area-first. Variant 2: vertical
    // shelves (swap axes). All deterministic orderings of the same input.
    const sortKey =
      v === 1
        ? (a: ProgramRoom, b: ProgramRoom) =>
            b.targetAreaM2 - a.targetAreaM2 || a.id.localeCompare(b.id)
        : (a: ProgramRoom, b: ProgramRoom) =>
            b.priority - a.priority || b.targetAreaM2 - a.targetAreaM2 || a.id.localeCompare(b.id)
    const rooms = [...normalized.rooms].sort(sortKey)
    const swapped = v === 2
    const box = swapped
      ? { minX: bounds.minY, minY: bounds.minX, maxX: bounds.maxY, maxY: bounds.maxX }
      : bounds

    const packed = packRooms({ ...normalized, rooms }, box)
    const placed = packed.map((p) => {
      const [x, y, w, h] = swapped ? [p.y, p.x, p.h, p.w] : [p.x, p.y, p.w, p.h]
      return {
        room: p.room,
        x,
        y,
        w,
        h,
        boundary: rectRing(x, y, w, h),
        areaM2: (w * h) / (upm * upm)
      }
    })

    // Openings: every pair of placed rooms that shares a wall gets a door candidate at the
    // midpoint of the shared edge.
    const openings: OpeningCandidate[] = []
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const seg = sharedEdge(placed[i]!, placed[j]!)
        if (!seg) continue
        const center: Point2D = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2]
        openings.push({
          id: `door_${placed[i]!.room.id}_${placed[j]!.room.id}`,
          kind: 'door',
          connectsSpaces: [placed[i]!.room.id, placed[j]!.room.id],
          connectionType: 'interior',
          center,
          width: 900, // a nominal door width in mm; the caller overrides from a Design Basis
          wallSegment: seg
        })
      }
    }

    // Entry door: a planned layout must be enterable, or `checkAccessibility` has no root and
    // every room reads unreachable. Put one exterior door on the site boundary, on the first
    // placed room (packing order, so deterministic) that has an edge lying on the boundary.
    const eps = 1e-6
    for (const p of placed) {
      const sides: Array<{ seg: [Point2D, Point2D]; ok: boolean }> = [
        {
          seg: [
            [p.x, p.y],
            [p.x + p.w, p.y]
          ],
          ok: Math.abs(p.y - bounds.minY) < eps
        },
        {
          seg: [
            [p.x, p.y + p.h],
            [p.x + p.w, p.y + p.h]
          ],
          ok: Math.abs(p.y + p.h - bounds.maxY) < eps
        },
        {
          seg: [
            [p.x, p.y],
            [p.x, p.y + p.h]
          ],
          ok: Math.abs(p.x - bounds.minX) < eps
        },
        {
          seg: [
            [p.x + p.w, p.y],
            [p.x + p.w, p.y + p.h]
          ],
          ok: Math.abs(p.x + p.w - bounds.maxX) < eps
        }
      ]
      const onBoundary = sides.find((s) => s.ok)
      if (!onBoundary) continue
      openings.push({
        id: `entry_${p.room.id}`,
        kind: 'door',
        connectsSpaces: [p.room.id],
        connectionType: 'exterior',
        center: [
          (onBoundary.seg[0][0] + onBoundary.seg[1][0]) / 2,
          (onBoundary.seg[0][1] + onBoundary.seg[1][1]) / 2
        ],
        width: 1000,
        wallSegment: onBoundary.seg
      })
      break
    }

    // Score: required adjacencies satisfied (shared wall) over required adjacencies total.
    const adjacent = new Set<string>()
    for (const o of openings) {
      if (o.connectionType !== 'interior') continue
      adjacent.add(`${o.connectsSpaces[0]}|${o.connectsSpaces[1]}`)
      adjacent.add(`${o.connectsSpaces[1]}|${o.connectsSpaces[0]}`)
    }
    const unmet: Array<{ room: string; needs: string }> = []
    let required = 0
    for (const room of rooms) {
      for (const need of room.requiredAdjacency) {
        required++
        if (!adjacent.has(`${room.id}|${need}`)) unmet.push({ room: room.id, needs: need })
      }
    }
    const adjacencyScore = required === 0 ? 1 : (required - unmet.length) / required
    const siteArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)
    const coverage = siteArea > 0 ? placed.reduce((sum, p) => sum + p.w * p.h, 0) / siteArea : 0

    candidates.push({
      id: `layout_${v}`,
      rooms: placed.map((p) => ({
        roomId: p.room.id,
        usage: p.room.usage,
        spaceType: p.room.spaceType ?? spaceTypeOfUsage(p.room.usage),
        boundary: p.boundary,
        areaM2: p.areaM2,
        targetAreaM2: p.room.targetAreaM2
      })),
      openings,
      adjacencyScore,
      unmetAdjacency: unmet,
      coverage
    })
  }

  // Rank: adjacency first, then coverage (a packing that wastes less site is better), then id for
  // a stable tie-break.
  return candidates.sort(
    (a, b) =>
      b.adjacencyScore - a.adjacencyScore || b.coverage - a.coverage || a.id.localeCompare(b.id)
  )
}

/**
 * Turn a candidate into a `SpatialModel` the existing constraint engine can validate: rooms become
 * spaces, opening candidates become doors with a known hinge side. This is the bridge that lets an
 * empty-DWG plan run through the SAME `validateBatch`/`checkAccessibility` code as a drawn one —
 * no second validation path.
 */
export function candidateToModel(
  candidate: LayoutCandidate,
  program: SpatialProgramInput
): SpatialModel {
  const spaces: Space[] = candidate.rooms.map((r) => {
    const b = bboxOf(r.boundary)
    return {
      id: r.roomId,
      usage: r.usage,
      spaceType: r.spaceType,
      boundary: r.boundary,
      holes: [],
      level: 0,
      areaM2: r.areaM2,
      bbox: b ?? undefined,
      adjacentSpaces: [],
      accessPoints: [],
      sourceHandles: [],
      confidence: 'medium',
      evidence: [{ source: 'user', detail: `planned from program room ${r.roomId}` }]
    }
  })
  const openings: SpatialOpening[] = candidate.openings.map((o) => ({
    handle: o.id,
    kind: 'door',
    hostWallHandle: null,
    openingCenter: o.center,
    width: o.width,
    swingAngleDeg: 90,
    hingeSource: 'unknown',
    swingDirection: 'unknown',
    cutsWall: null,
    connectionType: o.connectionType,
    connectsSpaces: [...o.connectsSpaces],
    confidence: 'medium',
    evidence: [{ source: 'geometry', detail: 'candidate door on shared wall' }]
  }))
  return {
    documentName: program.title ? `plan:${program.title}` : `plan:${program.id}`,
    site: program.siteBoundary
      ? {
          boundary: program.siteBoundary,
          buildingRings: spaces.map((s) => s.boundary),
          outdoorRegions: [],
          noPlacementRegions: [],
          sourceHandles: [],
          confidence: 'medium'
        }
      : undefined,
    spaces,
    openings,
    furniture: [],
    relationships: [],
    unclassifiedHandles: [],
    insufficientData: [],
    // A planned layout is unit-declared only when the program said so; otherwise the millimetre
    // default below is an assumption, and the model has to carry that the same way an extracted
    // one does (#413 SS11.2).
    units: {
      perMetre: program.unitsPerMetre ?? 1000,
      declared: program.unitsPerMetre !== undefined
    },
    analyzedAt: 0
  }
}
