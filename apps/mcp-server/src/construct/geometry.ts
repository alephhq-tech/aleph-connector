import { BridgeErrorCode, BridgeRpcError } from '@arcdio/cad-protocol'

/** Plain 2D geometry for the construct generators — pure functions, no AutoCAD. */

/** Bad input geometry, reported with the plugin's own InvalidGeometry code so tools map it alike. */
export const invalidGeometry = (message: string) =>
  new BridgeRpcError(BridgeErrorCode.InvalidGeometry, message)

export interface Vec2 {
  x: number
  y: number
}

const EPS = 1e-9

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x
const length = (a: Vec2): number => Math.hypot(a.x, a.y)

/** Unit normal pointing to the left of the direction a → b. */
function leftNormal(a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a)
  const len = length(d)
  if (len < EPS) throw invalidGeometry('Consecutive points must not coincide')
  return { x: -d.y / len, y: d.x / len }
}

/** Intersection of the infinite lines p + t·r and q + u·s, or undefined when parallel. */
function intersect(p: Vec2, r: Vec2, q: Vec2, s: Vec2): Vec2 | undefined {
  const denom = cross(r, s)
  if (Math.abs(denom) < EPS) return undefined
  const t = cross(sub(q, p), s) / denom
  return add(p, scale(r, t))
}

/**
 * Offsets a polyline by `distance` (positive = left of travel) with mitered joins. For a closed
 * polyline the first/last vertices are joined too; for an open one the end vertices are offset
 * perpendicular to their segment.
 */
export function offsetPolyline(points: Vec2[], distance: number, closed: boolean): Vec2[] {
  const n = points.length
  const segment = (i: number) => {
    const a = points[i]!
    const b = points[(i + 1) % n]!
    const shift = scale(leftNormal(a, b), distance)
    return { p: add(a, shift), r: sub(b, a) }
  }
  const segmentCount = closed ? n : n - 1
  const segments = Array.from({ length: segmentCount }, (_, i) => segment(i))

  return points.map((point, i) => {
    const incoming = closed ? segments[(i - 1 + n) % n] : segments[i - 1]
    const outgoing = segments[i]
    if (!incoming) return outgoing!.p
    if (!outgoing) return add(incoming.p, incoming.r)
    // Collinear neighbours: the shifted vertex itself.
    return (
      intersect(incoming.p, incoming.r, outgoing.p, outgoing.r) ??
      add(point, sub(outgoing.p, point))
    )
  })
}

/** Signed shoelace area (positive when counter-clockwise). */
export function signedArea(points: Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    sum += cross(a, b)
  }
  return sum / 2
}

/** Area centroid of a simple polygon (falls back to the vertex average for degenerate ones). */
export function centroid(points: Vec2[]): Vec2 {
  const area = signedArea(points)
  if (Math.abs(area) < EPS) {
    return scale(points.reduce(add, { x: 0, y: 0 }), 1 / points.length)
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    const f = cross(a, b)
    cx += (a.x + b.x) * f
    cy += (a.y + b.y) * f
  }
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

/** Ray-casting point-in-polygon test. */
export function containsPoint(polygon: Vec2[], p: Vec2): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Cumulative arc length along a polyline/ring. `closed` joins the last vertex back to the first.
 * This is what lets an opening be located *along* a wall run rather than snapped to a vertex.
 */
export function arcLengths(
  points: Vec2[],
  closed: boolean
): { cumulative: number[]; total: number } {
  const cumulative: number[] = [0]
  let total = 0
  const segments = closed ? points.length : points.length - 1
  for (let i = 0; i < segments; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    total += Math.hypot(b.x - a.x, b.y - a.y)
    cumulative.push(total)
  }
  return { cumulative, total }
}

/** Point and travel direction at arc-length `s` (clamped to the run's ends). */
export function pointAtArc(
  points: Vec2[],
  closed: boolean,
  s: number
): { point: Vec2; angleDeg: number } | undefined {
  if (points.length < 2) return undefined
  const { cumulative, total } = arcLengths(points, closed)
  const target = Math.min(Math.max(s, 0), total)
  let i = 0
  while (i < cumulative.length - 2 && cumulative[i + 1]! < target) i++
  const a = points[i]!
  const b = points[(i + 1) % points.length]!
  const segLen = cumulative[i + 1]! - cumulative[i]!
  const t = segLen <= 0 ? 0 : (target - cumulative[i]!) / segLen
  return {
    point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
    angleDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  }
}

/**
 * Project `p` onto the run: arc-length position, perpendicular distance and the local travel
 * direction. A door is placed on a wall by this projection, never by nearest-vertex guessing.
 */
export function projectOntoPolyline(
  points: Vec2[],
  closed: boolean,
  p: Vec2
): { s: number; distance: number; angleDeg: number } | undefined {
  if (points.length < 2) return undefined
  const { cumulative } = arcLengths(points, closed)
  const segments = closed ? points.length : points.length - 1
  let best: { s: number; distance: number; angleDeg: number } | undefined
  for (let i = 0; i < segments; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 <= 0 ? 0 : Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0), 1)
    const foot = { x: a.x + dx * t, y: a.y + dy * t }
    const distance = Math.hypot(p.x - foot.x, p.y - foot.y)
    if (!best || distance < best.distance) {
      best = {
        s: cumulative[i]! + Math.sqrt(len2) * t,
        distance,
        angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI
      }
    }
  }
  return best
}
