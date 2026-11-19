import type { Point2D } from '../schemas/semantic-model'

/**
 * Deterministic 2D polygon kernel for architectural spatial reasoning.
 *
 * Coordinates are drawing units (millimetres by Aleph convention) — area conversions to m² are
 * explicit at the call site, never baked in here. Rings are simple closed vertex lists with the
 * first vertex NOT repeated; a ring with fewer than 3 finite vertices is degenerate and every
 * predicate on it returns a conservative false/0 rather than guessing.
 *
 * Bounding boxes appear only as broad-phase rejection filters. No containment, area, or
 * intersection decision in this module is made from a bbox alone.
 */

const EPS = 1e-9

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const isFinitePoint = (p: Point2D): boolean =>
  Number.isFinite(p[0]) && Number.isFinite(p[1])

export function bboxOf(ring: Point2D[]): BBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let n = 0
  for (const p of ring) {
    if (!isFinitePoint(p)) continue
    n++
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
  }
  return n === 0 ? null : { minX, minY, maxX, maxY }
}

export const bboxOverlap = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

/** Signed shoelace area; positive when the ring runs counter-clockwise. */
export function signedArea(ring: Point2D[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!
    const [x2, y2] = ring[(i + 1) % ring.length]!
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

export const areaOf = (ring: Point2D[]): number => Math.abs(signedArea(ring))

/** Returns the ring in counter-clockwise order (in-place-free). */
export function ensureCCW(ring: Point2D[]): Point2D[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring
}

/** Ray-casting point-in-ring test. Boundary points count as inside (tolerance-based). */
export function pointInRing(pt: Point2D, ring: Point2D[], tol = 0): boolean {
  if (ring.length < 3) return false
  if (tol > 0 && distanceToRingBoundary(pt, ring) <= tol) return true
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Point membership in a polygon with holes: inside the outer ring and outside every hole.
 * `holes` are treated as subtracted regions regardless of their winding.
 */
export function pointInPolygon(
  pt: Point2D,
  outer: Point2D[],
  holes: Point2D[][] = [],
  tol = 0
): boolean {
  if (!pointInRing(pt, outer, tol)) return false
  for (const hole of holes) if (pointInRing(pt, hole, -0)) return false
  return true
}

const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

/** Orientation of (a,b,c): >0 CCW, <0 CW, 0 collinear. */
const orient = (a: Point2D, b: Point2D, c: Point2D): number =>
  cross2(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1])

const onSegment = (a: Point2D, b: Point2D, p: Point2D): boolean =>
  Math.min(a[0], b[0]) - EPS <= p[0] &&
  p[0] <= Math.max(a[0], b[0]) + EPS &&
  Math.min(a[1], b[1]) - EPS <= p[1] &&
  p[1] <= Math.max(a[1], b[1]) + EPS

/**
 * Segment intersection including proper crossings, T-junctions, and collinear overlap.
 * Touching endpoints count as intersection — architectural boundaries share vertices by design.
 */
export function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
      ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true
  if (Math.abs(o1) <= EPS && onSegment(a, b, c)) return true
  if (Math.abs(o2) <= EPS && onSegment(a, b, d)) return true
  if (Math.abs(o3) <= EPS && onSegment(c, d, a)) return true
  if (Math.abs(o4) <= EPS && onSegment(c, d, b)) return true
  return false
}

/** True when any edge of ring A crosses or touches any edge of ring B. */
export function ringsBoundaryIntersect(a: Point2D[], b: Point2D[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]!
    const a2 = a[(i + 1) % a.length]!
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2, b[j]!, b[(j + 1) % b.length]!)) return true
    }
  }
  return false
}

/**
 * Do two simple closed rings overlap in area? Bbox rejection first, then boundary crossing,
 * then one-direction vertex containment. Vertex containment alone is not enough (a star inside a
 * square with no vertex inside the square still overlaps), hence the crossing test.
 */
export function ringsOverlap(a: Point2D[], b: Point2D[]): boolean {
  const ba = bboxOf(a)
  const bb = bboxOf(b)
  if (!ba || !bb || !bboxOverlap(ba, bb)) return false
  if (ringsBoundaryIntersect(a, b)) return true
  return pointInRing(a[0]!, b) || pointInRing(b[0]!, a)
}

/**
 * Is ring `inner` fully inside the polygon (outer minus holes)? Every vertex must be inside and
 * no edge may cross either boundary. `tol` lets a footprint sit flush against a wall line.
 */
export function ringInsidePolygon(
  inner: Point2D[],
  outer: Point2D[],
  holes: Point2D[][] = [],
  tol = 0
): boolean {
  if (inner.length < 3) return false
  for (const p of inner) if (!pointInPolygon(p, outer, holes, tol)) return false
  if (ringsBoundaryIntersect(inner, outer)) {
    // A shared boundary is allowed within tol; a real crossing is not.
    if (tol <= 0) return false
    for (const hole of holes) if (ringsBoundaryIntersect(inner, hole)) return false
  }
  for (const hole of holes) {
    if (ringsBoundaryIntersect(inner, hole)) return false
    if (hole.length > 0 && pointInRing(hole[0]!, inner)) return false
  }
  return true
}

export function distancePointToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 <= EPS) return Math.hypot(p[0] - a[0], p[1] - a[1])
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Shortest distance from a point to a ring's boundary (not its interior). */
export function distanceToRingBoundary(pt: Point2D, ring: Point2D[]): number {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const d = distancePointToSegment(pt, ring[i]!, ring[(i + 1) % ring.length]!)
    if (d < best) best = d
  }
  return best
}

/**
 * Shortest distance between two rings' boundaries — the minimum over every edge pair. `extract`'s
 * adjacency pass only samples `boundary[0]`, which reports a huge gap for two rooms that share a
 * long wall but whose first vertices are far apart. The planner needs the real gap to decide
 * whether two program rooms may share a door, so this measures every pair.
 */
export function ringDistance(a: Point2D[], b: Point2D[]): number {
  let best = Infinity
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i]!
    const a1 = a[(i + 1) % a.length]!
    for (let j = 0; j < b.length; j++) {
      const d = segmentDistance(a0, a1, b[j]!, b[(j + 1) % b.length]!)
      if (d < best) best = d
    }
  }
  return best
}

/**
 * Shortest distance between segments AB and CD: the smallest of the four point-to-segment
 * distances, which is exact for the non-crossing case and 0 when they cross or touch.
 */
export function segmentDistance(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    distancePointToSegment(a, c, d),
    distancePointToSegment(b, c, d),
    distancePointToSegment(c, a, b),
    distancePointToSegment(d, a, b)
  )
}


export const rotate = (p: Point2D, deg: number, origin: Point2D = [0, 0]): Point2D => {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p[0] - origin[0]
  const dy = p[1] - origin[1]
  return [origin[0] + dx * cos - dy * sin, origin[1] + dx * sin + dy * cos]
}

/**
 * Axis-aligned rectangle rotated about its centre — the footprint of a furniture block inserted
 * at `center` with `size` and `rotationDeg`. Axis-aligned bbox checks are never used as the final
 * collision test; this is the real oriented footprint.
 */
export function rotatedRect(center: Point2D, width: number, depth: number, rotationDeg = 0): Point2D[] {
  const hw = width / 2
  const hd = depth / 2
  const base: Point2D[] = [
    [center[0] - hw, center[1] - hd],
    [center[0] + hw, center[1] - hd],
    [center[0] + hw, center[1] + hd],
    [center[0] - hw, center[1] + hd],
  ]
  return rotationDeg ? base.map((p) => rotate(p, rotationDeg, center)) : base
}
/** Area centroid of a simple ring; falls back to the vertex average for degenerate rings. */
export function centroidOf(ring: Point2D[]): Point2D {
  const n = ring.length
  if (n === 0) return [0, 0]
  let cx = 0
  let cy = 0
  let a = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]!
    const [x2, y2] = ring[(i + 1) % n]!
    const f = x1 * y2 - x2 * y1
    a += f
    cx += (x1 + x2) * f
    cy += (y1 + y2) * f
  }
  if (Math.abs(a) < EPS) {
    const sx = ring.reduce((s, p) => s + p[0], 0) / n
    const sy = ring.reduce((s, p) => s + p[1], 0) / n
    return [sx, sy]
  }
  return [cx / (3 * a), cy / (3 * a)]
}

/**
 * The area a door leaf sweeps: an annular sector from `startDeg` through `sweepDeg` around the
 * hinge, radius = clear opening width. Tessellated into a closed ring so it composes with every
 * other predicate here. `segments` trades vertex count for arc fidelity.
 */
export function doorSweepPolygon(
  hinge: Point2D,
  width: number,
  startDeg: number,
  sweepDeg = 90,
  segments = 16
): Point2D[] {
  const steps = Math.max(2, Math.abs(sweepDeg) >= 360 ? 32 : segments)
  const ring: Point2D[] = [hinge]
  for (let i = 0; i <= steps; i++) {
    const deg = startDeg + (sweepDeg * i) / steps
    const rad = (deg * Math.PI) / 180
    ring.push([hinge[0] + width * Math.cos(rad), hinge[1] + width * Math.sin(rad)])
  }
  return ring
}

/**
 * Tessellate a polyline's bulges into arc vertices. AutoCAD stores `bulge = tan(theta/4)` per
 * segment; a zero bulge is a straight segment and is passed through untouched. Inserted arcs keep
 * vertex order so the result is still a traversable ring.
 */
export function bulgeToArcPoints(
  points: Point2D[],
  bulges: number[],
  closed: boolean,
  segmentsPerArc = 8
): Point2D[] {
  if (points.length < 2) return points
  const out: Point2D[] = []
  const segmentCount = closed ? points.length : points.length - 1
  for (let i = 0; i < points.length; i++) {
    out.push(points[i]!)
    if (i >= segmentCount) continue
    const bulge = bulges[i] ?? 0
    if (!Number.isFinite(bulge) || Math.abs(bulge) < EPS) continue
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    const theta = 4 * Math.atan(bulge)
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const chord = Math.hypot(dx, dy)
    if (chord < EPS) continue
    const radius = chord / (2 * Math.sin(theta / 2))
    const midX = (a[0] + b[0]) / 2
    const midY = (a[1] + b[1]) / 2
    // Unit normal to the chord, flipped for a negative (clockwise) bulge.
    const nx = -dy / chord
    const ny = dx / chord
    const sign = bulge > 0 ? 1 : -1
    const h = radius * Math.cos(theta / 2)
    const cx = midX + nx * sign * h
    const cy = midY + ny * sign * h
    const startA = Math.atan2(a[1] - cy, a[0] - cx)
    const r = Math.abs(radius)
    for (let s = 1; s < segmentsPerArc; s++) {
      const ang = startA + (theta * s) / segmentsPerArc
      out.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)])
    }
  }
  return out
}
/** Uniformly resample a ring so long edges compare fairly against short ones. */
export function densifyRing(ring: Point2D[], maxSegmentLength: number): Point2D[] {
  if (!(maxSegmentLength > 0)) return ring
  const out: Point2D[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % ring.length]!
    out.push(a)
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.floor(len / maxSegmentLength)
    for (let s = 1; s < steps; s++) {
      const t = s / steps
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

/**
 * Longest contiguous run of scan-line points that lie inside the polygon (outer minus holes).
 * `axis` is the corridor's running direction; the chord is measured perpendicular to it. Sampling
 * is deliberate: an exact polygon-clip is overkill for a QA width and the sample count bounds the
 * error to one step. Returns 0 when the line misses the polygon entirely.
 */
function scanChord(
  outer: Point2D[],
  holes: Point2D[][],
  axis: 'x' | 'y',
  fixed: number,
  lo: number,
  hi: number,
  steps: number
): number {
  let best = 0
  let run = 0
  const step = (hi - lo) / steps
  for (let i = 0; i <= steps; i++) {
    const v = lo + step * i
    const pt: Point2D = axis === 'x' ? [fixed, v] : [v, fixed]
    const inside = pointInRing(pt, outer) && !holes.some((h) => pointInRing(pt, h))
    if (inside) {
      run += step
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

/**
 * Minimum clear width of a corridor-like polygon, measured as the narrowest perpendicular chord
 * along its running axis — NOT the bounding-box short side. An L-corridor or a corridor pinched by
 * a column reports its real bottleneck; a bbox would report the wide leg and miss it.
 */
export function minClearWidth(
  outer: Point2D[],
  holes: Point2D[][] = [],
  samples = 24,
  stepsPerChord = 48
): number {
  const box = bboxOf(outer)
  if (!box) return 0
  const spanX = box.maxX - box.minX
  const spanY = box.maxY - box.minY
  // Run along the longer axis; measure the chord across the shorter one.
  const axis: 'x' | 'y' = spanX >= spanY ? 'x' : 'y'
  const alongLo = axis === 'x' ? box.minX : box.minY
  const alongHi = axis === 'x' ? box.maxX : box.maxY
  const acrossLo = axis === 'x' ? box.minY : box.minX
  const acrossHi = axis === 'x' ? box.maxY : box.maxX
  let min = Infinity
  for (let i = 0; i <= samples; i++) {
    const fixed = alongLo + ((alongHi - alongLo) * i) / samples
    const chord = scanChord(outer, holes, axis, fixed, acrossLo, acrossHi, stepsPerChord)
    if (chord > 0 && chord < min) min = chord
  }
  return Number.isFinite(min) ? min : 0
}

/**
 * Perpendicular free width through a specific point, along the corridor's running axis. Used to
 * ask "after this item is placed, how much walking width is left here".
 */
export function clearWidthThrough(
  outer: Point2D[],
  holes: Point2D[][],
  pt: Point2D,
  axis: 'x' | 'y'
): number {
  const box = bboxOf(outer)
  if (!box) return 0
  const fixed = axis === 'x' ? pt[0] : pt[1]
  const acrossLo = axis === 'x' ? box.minY : box.minX
  const acrossHi = axis === 'x' ? box.maxY : box.maxX
  return scanChord(outer, holes, axis, fixed, acrossLo, acrossHi, 64)
}
