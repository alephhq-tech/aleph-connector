import { pointInPolygon } from '../spatial/geometry'
import type { Point2D } from '../schemas/semantic-model'

/**
 * E9 scope gate: no planned entity may land outside the inspected region.
 * A point is in scope inside ANY ring (on-ring counts within `tolerance`); the first
 * out-of-scope point refuses the whole batch. Wires/pipes to an external anchor are not gated.
 */
export interface OutOfScopePoint {
  point: Point2D
  /** Index of the point in the list the caller passed, for a stable error message. */
  index: number
}

/** First point outside every scope ring, or `null` when all are in scope. An empty scope never passes. */
export function findOutOfScopePoint(
  points: readonly Point2D[],
  scopeRings: readonly Point2D[][],
  tolerance = 0
): OutOfScopePoint | null {
  if (scopeRings.length === 0) {
    return points.length > 0 ? { point: points[0]!, index: 0 } : null
  }
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]!
    const inside = scopeRings.some((ring) => pointInPolygon(pt, ring, [], tolerance))
    if (!inside) return { point: pt, index: i }
  }
  return null
}

/** The one E9 violation string, naming the first offending point and the scope it left. */
export function outOfScopeViolation(
  points: readonly Point2D[],
  scopeRings: readonly Point2D[][],
  tolerance = 0
): string | null {
  const bad = findOutOfScopePoint(points, scopeRings, tolerance)
  if (!bad) return null
  return (
    `OUT_OF_SCOPE: planned point [${bad.point[0]}, ${bad.point[1]}] (point ${bad.index + 1} of ` +
    `${points.length}) lies outside the inspected region (${scopeRings.length} room ` +
    `polygon(s)) — re-inspect the region that contains it, or narrow the plan to the region ` +
    `already inspected. No entity outside the inspected region is drawn.`
  )
}
