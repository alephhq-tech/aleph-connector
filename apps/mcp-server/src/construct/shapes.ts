import { invalidGeometry, type Vec2 } from './geometry.js'

/**
 * Shape presets (#57): AutoCAD input forms (POLYGON, RECTANG rotation/chamfer, 3-point ARC,
 * start-end-radius ARC, 2P/3P CIRCLE) solved into the plain primitives the plugin already draws.
 * Pure functions; errors name the offending field so the model can fix the call.
 */

const EPS = 1e-9
const TAU = 2 * Math.PI

const rotate = (p: Vec2, angle: number): Vec2 => ({
  x: p.x * Math.cos(angle) - p.y * Math.sin(angle),
  y: p.x * Math.sin(angle) + p.y * Math.cos(angle)
})
const normalizeAngle = (a: number) => ((a % TAU) + TAU) % TAU
const angleOf = (center: Vec2, p: Vec2) =>
  normalizeAngle(Math.atan2(p.y - center.y, p.x - center.x))

/**
 * Regular polygon vertices. `inscribed`: vertices on the circle (AutoCAD's default);
 * `circumscribed`: edge midpoints on the circle. The first vertex (inscribed) or first edge
 * midpoint (circumscribed) sits at `rotation`.
 */
export function polygonVertices(
  center: Vec2,
  sides: number,
  radius: number,
  mode: 'inscribed' | 'circumscribed' = 'inscribed',
  rotation = 0
): Vec2[] {
  const step = TAU / sides
  const vertexRadius = mode === 'inscribed' ? radius : radius / Math.cos(step / 2)
  const start = mode === 'inscribed' ? rotation : rotation - step / 2
  return Array.from({ length: sides }, (_, i) => {
    const a = start + i * step
    return { x: center.x + vertexRadius * Math.cos(a), y: center.y + vertexRadius * Math.sin(a) }
  })
}

interface PolylineVertex {
  point: Vec2
  bulge: number
}

/** Bulge for a 90° fillet arc: tan(included-angle / 4) = tan(π/8). */
const FILLET_BULGE_90 = Math.tan(Math.PI / 8)

/**
 * Rectangle corners (counter-clockwise from `corner1`), rotated about `corner1` by `rotation`, with
 * an optional corner treatment at every corner — AutoCAD RECTANG's Rotation and Fillet/Chamfer
 * options (mutually exclusive; the caller enforces that, not this function). `chamfer`: straight
 * cut `d1` (along the first edge) / `d2` (along the second), bulge 0. `fillet`: rounded corner of
 * the given radius — same tangent-point layout as chamfer with `d1 = d2 = fillet` (the tangent
 * length from a corner to a 90° fillet's tangent point equals the radius), plus `FILLET_BULGE_90`
 * on each tangent-to-tangent arc segment.
 */
export function rectangleVertices(
  corner1: Vec2,
  width: number,
  height: number,
  rotation = 0,
  chamfer?: { d1: number; d2: number },
  fillet?: number
): PolylineVertex[] {
  const w = Math.abs(width)
  const h = Math.abs(height)
  const corner = fillet ? { d1: fillet, d2: fillet } : chamfer
  const cornerBulge = fillet ? FILLET_BULGE_90 : 0
  let local: PolylineVertex[]
  if (corner) {
    const { d1, d2 } = corner
    if (d1 * 2 > Math.min(w, h) + EPS || d2 * 2 > Math.min(w, h) + EPS) {
      throw invalidGeometry(
        `${fillet ? 'fillet' : 'chamfer'}: each distance must be at most half the shorter side`
      )
    }
    local = [
      { point: { x: d1, y: 0 }, bulge: 0 },
      { point: { x: w - d2, y: 0 }, bulge: cornerBulge },
      { point: { x: w, y: d1 }, bulge: 0 },
      { point: { x: w, y: h - d2 }, bulge: cornerBulge },
      { point: { x: w - d1, y: h }, bulge: 0 },
      { point: { x: d2, y: h }, bulge: cornerBulge },
      { point: { x: 0, y: h - d1 }, bulge: 0 },
      { point: { x: 0, y: d2 }, bulge: cornerBulge }
    ]
  } else {
    local = [
      { point: { x: 0, y: 0 }, bulge: 0 },
      { point: { x: w, y: 0 }, bulge: 0 },
      { point: { x: w, y: h }, bulge: 0 },
      { point: { x: 0, y: h }, bulge: 0 }
    ]
  }
  // Mirror the local frame so the rectangle grows toward the signed width/height. Mirroring
  // reverses the path's winding, so a nonzero bulge's arc direction must flip with it too.
  const sx = Math.sign(width) || 1
  const sy = Math.sign(height) || 1
  const mirrored = sx * sy < 0
  return local.map((v) => {
    const r = rotate({ x: v.point.x * sx, y: v.point.y * sy }, rotation)
    return {
      point: { x: corner1.x + r.x, y: corner1.y + r.y },
      bulge: mirrored ? -v.bulge : v.bulge
    }
  })
}

/**
 * A donut's two-vertex closed polyline (AutoCAD DONUT): vertices sit on the midradius circle
 * `(innerDiameter + outerDiameter) / 4`, diametrically opposite, each with bulge 1 (a bulge of
 * `tan(θ/4)`, and each of the 2 segments sweeps 180° — `tan(45°) = 1`). Constant width
 * `(outerDiameter - innerDiameter) / 2` then makes the outer edge trace `outerDiameter / 2` and the
 * inner edge trace `innerDiameter / 2` (verified algebraically, not copied from an assumption:
 * midradius ± width/2 = (inner+outer)/4 ± (outer-inner)/4 = outer/2 or inner/2). `innerDiameter: 0`
 * degenerates to a filled dot (midradius = outer/4, width = outer/2, inner edge = 0).
 */
export function donutVertices(
  center: Vec2,
  innerDiameter: number,
  outerDiameter: number
): { points: Vec2[]; bulges: number[]; width: number } {
  if (outerDiameter <= innerDiameter) {
    throw invalidGeometry('outerDiameter must be greater than innerDiameter')
  }
  const midRadius = (innerDiameter + outerDiameter) / 4
  const width = (outerDiameter - innerDiameter) / 2
  return {
    points: [
      { x: center.x + midRadius, y: center.y },
      { x: center.x - midRadius, y: center.y }
    ],
    bulges: [1, 1],
    width
  }
}

/** Circle through three points (AutoCAD CIRCLE 3P). */
export function circleThroughPoints(
  p1: Vec2,
  p2: Vec2,
  p3: Vec2
): { center: Vec2; radius: number } {
  const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y))
  if (Math.abs(d) < EPS)
    throw invalidGeometry('The three points are collinear; no circle or arc passes through them')
  const s1 = p1.x ** 2 + p1.y ** 2
  const s2 = p2.x ** 2 + p2.y ** 2
  const s3 = p3.x ** 2 + p3.y ** 2
  const center = {
    x: (s1 * (p2.y - p3.y) + s2 * (p3.y - p1.y) + s3 * (p1.y - p2.y)) / d,
    y: (s1 * (p3.x - p2.x) + s2 * (p1.x - p3.x) + s3 * (p2.x - p1.x)) / d
  }
  return { center, radius: Math.hypot(p1.x - center.x, p1.y - center.y) }
}

export interface ArcSolution {
  center: Vec2
  radius: number
  /** Counter-clockwise from startAngle to endAngle, radians, both in [0, 2π). */
  startAngle: number
  endAngle: number
}

/** Arc from `start` through `mid` to `end` (AutoCAD ARC 3-point), as a counter-clockwise arc. */
export function arcThroughPoints(start: Vec2, mid: Vec2, end: Vec2): ArcSolution {
  const { center, radius } = circleThroughPoints(start, mid, end)
  const a0 = angleOf(center, start)
  const am = angleOf(center, mid)
  const a1 = angleOf(center, end)
  // Counter-clockwise sweep from start reaches mid before end → keep; otherwise the arc runs
  // clockwise, which as a CCW arc means end → start.
  const ccw = normalizeAngle(am - a0) < normalizeAngle(a1 - a0)
  return ccw
    ? { center, radius, startAngle: a0, endAngle: a1 }
    : { center, radius, startAngle: a1, endAngle: a0 }
}

/**
 * Arc from `start` to `end` with `radius` (AutoCAD ARC Start-End-Radius), travelling
 * counter-clockwise (default) or clockwise; `large` picks the > 180° solution.
 */
export function arcStartEndRadius(
  start: Vec2,
  end: Vec2,
  radius: number,
  direction: 'ccw' | 'cw' = 'ccw',
  large = false
): ArcSolution {
  const chord = { x: end.x - start.x, y: end.y - start.y }
  const half = Math.hypot(chord.x, chord.y) / 2
  if (half < EPS) throw invalidGeometry('start and end must differ')
  if (radius + EPS < half) throw invalidGeometry(`radius must be at least half the chord (${half})`)
  const along = Math.sqrt(Math.max(radius ** 2 - half ** 2, 0))
  const left = { x: -chord.y / (2 * half), y: chord.x / (2 * half) }
  // A counter-clockwise minor arc has its centre left of start → end; clockwise or large flips it.
  const side = (direction === 'ccw') !== large ? 1 : -1
  const center = {
    x: (start.x + end.x) / 2 + side * along * left.x,
    y: (start.y + end.y) / 2 + side * along * left.y
  }
  const a0 = angleOf(center, start)
  const a1 = angleOf(center, end)
  return direction === 'ccw'
    ? { center, radius, startAngle: a0, endAngle: a1 }
    : { center, radius, startAngle: a1, endAngle: a0 }
}
