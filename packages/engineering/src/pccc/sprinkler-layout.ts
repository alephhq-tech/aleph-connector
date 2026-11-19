import type { Point2D } from '../schemas/semantic-model'
import { areaOf, bboxOf, pointInPolygon, type BBox } from '../spatial/geometry'
import { unitsPerMetreFor, unitsPerMmFor, unknownUnitsViolation } from './drawing-units'
import type { DrawingUnits } from './drawing-units'

export interface SprinklerLayoutInput {
  roomBoundary: Point2D[]
  hazardGroup: 'Group 1' | 'Group 2' | 'Group 3'
  excludedBoundaries?: Point2D[][]
  customMaxSpacingMm?: number
  wallClearanceMm?: number
  /** Drawing units from `drawing.summary` `insUnits` (E8). Absent/`unitless` blocks the plan. */
  insUnits?: DrawingUnits
}

export interface SprinklerHead {
  id: string
  x: number
  y: number
  row: number
  col: number
}

export interface SprinklerLayoutResult {
  /** Echoed from the input — the verifier needs it to look up the matching standards rule
   * (aleph-platform#279) and has no other way to recover it from the result alone. Widened to
   * `string` (not the input's own union) because the degenerate-input early return can receive a
   * value outside Group 1/2/3 and must still report it verbatim, not lie about what was asked. */
  hazardGroup: string
  heads: SprinklerHead[]
  headCount: number
  spacingXMm: number
  spacingYMm: number
  maxSpacingAllowedMm: number
  /** True polygon area of the room (shoelace), in m² — not its bounding box. */
  roomAreaM2: number
  /** Area of the excluded regions that fall inside the room, in m². */
  excludedAreaM2: number
  /** `roomAreaM2` minus `excludedAreaM2` — the area actually required to be protected. */
  protectedAreaM2: number
  averageAreaPerHeadM2: number
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
  violations: string[]
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Coincidence tolerance for comparing a submitted polygon against an indexed box: CAD reads round
 * to whole mm and block extents are reported as reals, so 0.5% of each span (never less than 1 mm). */
const EXTENT_MATCH_RATIO = 0.005

/** Indexed boxes arrive as `{min,max}` corner pairs (the wire shape and the DB columns), so the
 * evidence keeps that form and is converted once here rather than at every call site. */
export interface BoundaryExtentEvidence {
  handle: string | null
  kind?: string
  layer?: string | null
  blockName?: string | null
  bounds: CornerBox
}

export interface BoundarySourceVerdict {
  handle: string | null
  kind: string
  layer?: string | null
  blockName?: string | null
}

interface CornerBox {
  min: { x: number; y: number }
  max: { x: number; y: number }
}

const toBox = (b: CornerBox): BBox => ({
  minX: b.min.x,
  minY: b.min.y,
  maxX: b.max.x,
  maxY: b.max.y
})

function sameBox(a: BBox, b: BBox): boolean {
  const tolX = Math.max(1, Math.abs(b.maxX - b.minX) * EXTENT_MATCH_RATIO)
  const tolY = Math.max(1, Math.abs(b.maxY - b.minY) * EXTENT_MATCH_RATIO)
  return (
    Math.abs(a.minX - b.minX) <= tolX &&
    Math.abs(a.maxX - b.maxX) <= tolX &&
    Math.abs(a.minY - b.minY) <= tolY &&
    Math.abs(a.maxY - b.maxY) <= tolY
  )
}

/**
 * Does this "room polygon" copy something else's bounding box?
 *
 * Two conditions must hold, so a real rectangular room typed from a brief is never refused:
 * 1. the polygon has no shape of its own — its shoelace area is its bounding box area (≥99%), i.e.
 *    it is an axis-aligned box rather than an outline; and
 * 2. that box coincides with an extent the engine already published: an indexed row that carries no
 *    full geometry (a block reference, an unresolved entity — the box the model was handed), or the
 *    snapshot's whole-drawing extents.
 * That is exactly how a floor's bbox reaches `roomBoundary`: the model reads `bounds` off a container
 * row and pastes its four corners. Everything downstream then protects walls, corridors and shafts.
 */
export function boundaryCopiesAnExtent(
  boundary: Point2D[],
  evidence: { rows: BoundaryExtentEvidence[]; extents?: CornerBox | null }
): BoundarySourceVerdict | null {
  if (boundary.length < 4) return null
  const box = bboxOf(boundary)
  if (!box) return null
  const bboxArea = (box.maxX - box.minX) * (box.maxY - box.minY)
  if (bboxArea <= 0) return null
  if (areaOf(boundary) < bboxArea * 0.99) return null // real outline: not a pasted box

  for (const row of evidence.rows) {
    if (!row.bounds || !Number.isFinite(row.bounds.min.x)) continue
    if (sameBox(box, toBox(row.bounds)))
      return {
        handle: row.handle,
        kind: row.kind ?? 'entity',
        layer: row.layer ?? null,
        blockName: row.blockName ?? null
      }
  }
  if (evidence.extents && sameBox(box, toBox(evidence.extents)))
    return { handle: null, kind: 'drawing extents' }
  return null
}

interface HazardCriteria {
  maxSpacingMm: number
  maxAreaPerHeadM2: number
}

/** TCVN 7336:2021 Table 1 hazard criteria. */
const HAZARD_CRITERIA: Record<string, HazardCriteria> = {
  'Group 1': { maxSpacingMm: 4000, maxAreaPerHeadM2: 12.0 },
  'Group 2': { maxSpacingMm: 3500, maxAreaPerHeadM2: 9.0 },
  'Group 3': { maxSpacingMm: 3000, maxAreaPerHeadM2: 9.0 }
}

/** The one shape for "nothing was measurable": no heads, no areas, and the reason why. Exported so
 * a caller that refuses an unusable boundary reports the SAME empty result the generator would have
 * produced, instead of inventing a parallel one. */
export function insufficientSprinklerLayout(
  hazardGroup: unknown,
  violations: string[]
): SprinklerLayoutResult {
  return {
    hazardGroup: String(hazardGroup),
    heads: [],
    headCount: 0,
    spacingXMm: 0,
    spacingYMm: 0,
    maxSpacingAllowedMm: 0,
    roomAreaM2: 0,
    excludedAreaM2: 0,
    protectedAreaM2: 0,
    averageAreaPerHeadM2: 0,
    status: 'INSUFFICIENT_DATA',
    violations
  }
}

/**
 * Deterministic Sprinkler Head Grid Generator.
 *
 * Areas are computed from the real polygon (shoelace) minus excluded regions, never from the
 * bounding box — an L-shaped room needs fewer heads than the rectangle that encloses it, and
 * a room with an excluded technical room must not be charged for that area. Grid placement is
 * still a regular grid over the bounding box, then filtered by true polygon membership, so
 * spacing stays uniform and predictable while coverage accounting stays honest.
 *
 * The verdict is tri-state: `INSUFFICIENT_DATA` when the hazard group is unknown or the
 * boundary is degenerate (nothing measurable to check), `FAIL` when a placement rule is
 * violated, `PASS` only when every rule is satisfied by measured geometry.
 */
export function generateSprinklerLayout(input: SprinklerLayoutInput): SprinklerLayoutResult {
  const empty = (violations: string[]): SprinklerLayoutResult =>
    insufficientSprinklerLayout(input.hazardGroup, violations)

  const criteria = HAZARD_CRITERIA[input.hazardGroup]
  if (!criteria) {
    return empty([
      `Hazard group "${String(input.hazardGroup)}" is not one of Group 1 / Group 2 / Group 3 — no spacing or coverage limit can be applied.`
    ])
  }

  // E8: no measurement without declared units (see drawing-units.ts).
  const unitsPerMetre = unitsPerMetreFor(input.insUnits)
  const unitsPerMm = unitsPerMmFor(input.insUnits)
  if (unitsPerMetre === null || unitsPerMm === null) {
    return empty([unknownUnitsViolation(input.insUnits)])
  }
  const areaDivisor = unitsPerMetre * unitsPerMetre

  if (input.roomBoundary.length < 3) {
    return empty([
      `Room boundary has ${input.roomBoundary.length} point(s); a closed polygon needs at least 3.`
    ])
  }

  // Spacing thresholds are physical millimetres; the grid is laid out in drawing units.
  let maxSpacingMm = criteria.maxSpacingMm
  const maxAreaPerHeadM2 = criteria.maxAreaPerHeadM2

  if (input.customMaxSpacingMm && input.customMaxSpacingMm > 0) {
    maxSpacingMm = Math.min(maxSpacingMm, input.customMaxSpacingMm)
  }
  const maxSpacing = maxSpacingMm * unitsPerMm

  // Real polygon area, not the enclosing rectangle.
  const roomAreaM2 = round2(areaOf(input.roomBoundary) / areaDivisor)
  if (roomAreaM2 <= 0) {
    return empty([
      'Room boundary polygon is degenerate (zero area) — its outline could not be measured.'
    ])
  }

  const excluded = input.excludedBoundaries ?? []
  const excludedAreaM2 = round2(excluded.reduce((sum, ring) => sum + areaOf(ring), 0) / areaDivisor)
  const protectedAreaM2 = round2(Math.max(0, roomAreaM2 - excludedAreaM2))
  if (protectedAreaM2 <= 0) {
    return empty([
      `Excluded regions cover the entire room (${excludedAreaM2} m² of ${roomAreaM2} m²) — nothing is left to protect.`
    ])
  }

  // Bounding box drives grid geometry; polygon membership decides what survives.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const [x, y] of input.roomBoundary) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  // Widths/lengths below are in drawing units; only the reported `spacingXMm`/
  // `spacingYMm` are converted back to mm.
  const roomWidth = maxX - minX
  const roomLength = maxY - minY

  const wallClearanceMm =
    (input.wallClearanceMm ?? Math.min(1500, maxSpacingMm / 2)) * unitsPerMm

  const effectiveWidthMm = Math.max(0, roomWidth - 2 * wallClearanceMm)
  const effectiveLengthMm = Math.max(0, roomLength - 2 * wallClearanceMm)

  let cols = effectiveWidthMm <= 0 ? 1 : Math.ceil(effectiveWidthMm / maxSpacing) + 1
  let rows = effectiveLengthMm <= 0 ? 1 : Math.ceil(effectiveLengthMm / maxSpacing) + 1

  // Satisfy both max spacing AND maximum coverage area per head (TCVN 7336 Table 1),
  // sized against the protected area the polygon actually leaves us.
  const minRequiredHeads = Math.ceil(protectedAreaM2 / maxAreaPerHeadM2)
  while (cols * rows < minRequiredHeads) {
    const spacingX = cols > 1 ? effectiveWidthMm / (cols - 1) : effectiveWidthMm
    const spacingY = rows > 1 ? effectiveLengthMm / (rows - 1) : effectiveLengthMm
    if (spacingX >= spacingY) {
      cols++
    } else {
      rows++
    }
  }

  const spacingX = cols > 1 ? effectiveWidthMm / (cols - 1) : 0
  const spacingY = rows > 1 ? effectiveLengthMm / (rows - 1) : 0
  const spacingXMm = Math.round(spacingX / unitsPerMm)
  const spacingYMm = Math.round(spacingY / unitsPerMm)

  const heads: SprinklerHead[] = []
  let headIdx = 1

  for (let r = 0; r < rows; r++) {
    const y = rows === 1 ? minY + roomLength / 2 : minY + wallClearanceMm + r * spacingY
    for (let c = 0; c < cols; c++) {
      const x = cols === 1 ? minX + roomWidth / 2 : minX + wallClearanceMm + c * spacingX

      // Inside the real room polygon and outside every excluded region.
      if (pointInPolygon([x, y], input.roomBoundary, excluded)) {
        heads.push({
          id: `SPK_${headIdx++}`,
          x: Math.round(x),
          y: Math.round(y),
          row: r,
          col: c
        })
      }
    }
  }

  const headCount = heads.length
  const averageAreaPerHeadM2 = headCount > 0 ? round2(protectedAreaM2 / headCount) : 0

  const violations: string[] = []
  if (spacingXMm > maxSpacingMm) {
    violations.push(
      `Spacing X ${spacingXMm}mm exceeds maximum allowable ${maxSpacingMm}mm for ${input.hazardGroup}`
    )
  }
  if (spacingYMm > maxSpacingMm) {
    violations.push(
      `Spacing Y ${spacingYMm}mm exceeds maximum allowable ${maxSpacingMm}mm for ${input.hazardGroup}`
    )
  }
  if (headCount === 0) {
    violations.push(
      `No sprinkler head landed inside the measured room polygon (${roomAreaM2} m²) — the boundary outline is unusable for placement.`
    )
  } else if (averageAreaPerHeadM2 > maxAreaPerHeadM2) {
    violations.push(
      `Average coverage area ${averageAreaPerHeadM2} m²/head exceeds ${maxAreaPerHeadM2} m²/head limit`
    )
  }

  return {
    hazardGroup: input.hazardGroup,
    heads,
    headCount,
    spacingXMm,
    spacingYMm,
    maxSpacingAllowedMm: maxSpacingMm,
    roomAreaM2,
    excludedAreaM2,
    protectedAreaM2,
    averageAreaPerHeadM2,
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    violations
  }
}
