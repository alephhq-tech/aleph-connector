import type { Point2D } from '../schemas/semantic-model'
import { bboxOf, distancePointToSegment, pointInPolygon, type BBox } from './geometry'
import type { RestrictedZone } from './preflight'

/**
 * Obstacle-aware 2D route planning for engineering runs (fire alarm wiring/conduit, and any other
 * system that supplies its own obstacles).
 *
 * Fix D in two stages, deliberately in this order:
 *   1. Blocking an invalid route is the safety property, and that is `preflight.ts`'s job — the
 *      router never gets to decide what is allowed, it only proposes geometry inside what the
 *      policy left open.
 *   2. Proposing a *compliant* alternative is this module's job.
 *
 * Algorithm: A* over a uniform grid of the region, with 8-connected moves. A grid cell is blocked
 * when its centre lies inside a restricted polygon or within `clearance` of one — that is what
 * makes the route respect the shaft rather than just its bbox. Cost = distance + `bendPenalty` per
 * direction change + corridor support, so the result is not the shortest straight line but the
 * cheapest compliant path. Grid resolution is a real trade-off and is reported, never hidden: the
 * plan is only as accurate as `cellSize`.
 *
 * No route is ever approximated through an obstacle. If the grid cannot reach the goal the answer
 * is `NO_VALID_ROUTE` (or `INSUFFICIENT_DATA` when the geometry needed to decide was missing), and
 * the caller must not draw anything.
 */

export interface RouteRequest {
  start: Point2D
  end: Point2D
  /** Restricted volumes the route may not enter (and must clear by `clearance`). */
  obstacles: RestrictedZone[]
  /** Bounding box to search. Defaults to the union of obstacles + endpoints, padded. */
  bounds?: { min: Point2D; max: Point2D }
  /** Grid step in drawing units. Smaller = more accurate, more nodes. Default 500 (mm). */
  cellSize?: number
  /** Minimum distance the route must keep from an obstacle boundary. Default 0. */
  clearance?: number
  /** Extra cost per direction change, in drawing units. Default 1000 (mm): prefers straight runs. */
  bendPenalty?: number
  /**
   * Corridors/runways the system is allowed or preferred to use (project routing pathways). A leg
   * inside one gets `corridorDiscount` subtracted, which is how "run in the ceiling void above the
   * corridor" beats "cross the room" without hardcoding either.
   */
  corridors?: Point2D[][]
  corridorDiscount?: number
  /** Hard cap on expanded nodes, so a pathological region cannot hang a run. */
  maxNodes?: number
}

export interface RouteResult {
  status: 'FOUND' | 'NO_VALID_ROUTE' | 'INSUFFICIENT_DATA'
  /** Waypoints in drawing units, start..end inclusive. Empty unless FOUND. */
  waypoints: Point2D[]
  totalLength: number
  bends: number
  /** Diagnostics the caller reports: the plan is only as good as its grid. */
  grid: { cellSize: number; columns: number; rows: number; nodesExpanded: number }
  blockedBy: string[]
  reason?: string
}

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Nearest distance from a point to any obstacle boundary (0 when inside one). */
function distanceToObstacles(
  pt: Point2D,
  obstacles: RestrictedZone[]
): { inside: boolean; distance: number; zoneId?: string } {
  let best = Number.POSITIVE_INFINITY
  let insideZone: string | undefined
  for (const zone of obstacles) {
    if (zone.outer.length < 3) continue
    if (pointInPolygon(pt, zone.outer, zone.holes ?? [], 0)) {
      return { inside: true, distance: 0, zoneId: zone.id }
    }
    const n = zone.outer.length
    for (let i = 0; i < n; i++) {
      const d = distancePointToSegment(pt, zone.outer[i]!, zone.outer[(i + 1) % n]!)
      if (d < best) {
        best = d
        insideZone = zone.id
      }
      if (best === 0) break
    }
  }
  return { inside: false, distance: best, ...(insideZone !== undefined && { zoneId: insideZone }) }
}

/** Cheap rejection: does this cell even need the expensive polygon test? */
function cellNearBBox(box: BBox, zones: RestrictedZone[], pad: number): boolean {
  return zones.some((zone) => {
    const zb = bboxOf(zone.outer)
    if (!zb) return false
    return (
      box.minX <= zb.maxX + pad &&
      box.maxX >= zb.minX - pad &&
      box.minY <= zb.maxY + pad &&
      box.maxY >= zb.minY - pad
    )
  })
}

/** Snap a point to the grid, then nudge it clear of any obstacle it landed too close to. */
function snapToFreeCell(
  pt: Point2D,
  blocked: (p: Point2D) => boolean,
  cellSize: number,
  maxSteps = 1
): Point2D | null {
  const gx = Math.round(pt[0] / cellSize) * cellSize
  const gy = Math.round(pt[1] / cellSize) * cellSize
  const candidates: Array<[number, number]> = [[gx, gy]]
  // Ring search out to maxSteps cells, closest first.
  for (let radius = 1; radius <= maxSteps; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue
        candidates.push([gx + dx * cellSize, gy + dy * cellSize])
      }
    }
  }
  for (const [x, y] of candidates) if (!blocked([x, y])) return [x, y]
  return null
}

export function planRoute(request: RouteRequest): RouteResult {
  const cellSize = request.cellSize ?? 500
  const clearance = request.clearance ?? 0
  const bendPenalty = request.bendPenalty ?? 1000
  const corridorDiscount = request.corridorDiscount ?? 0
  const maxNodes = request.maxNodes ?? 40000

  const obstacles = request.obstacles.filter((z) => z.outer.length >= 3)
  const malformed = request.obstacles.length - obstacles.length
  if (obstacles.length === 0 && request.obstacles.length > 0) {
    return {
      status: 'INSUFFICIENT_DATA',
      waypoints: [],
      totalLength: 0,
      bends: 0,
      grid: { cellSize, columns: 0, rows: 0, nodesExpanded: 0 },
      blockedBy: request.obstacles.map((z) => z.id),
      reason: `${malformed} obstacle(s) have no usable boundary, so a compliant route cannot be proven`
    }
  }

  const pad = cellSize * 2
  const bounds =
    request.bounds ??
    (() => {
      const pts: Point2D[] = [request.start, request.end]
      for (const z of obstacles) pts.push(...z.outer)
      const box = bboxOf(pts) ?? {
        minX: request.start[0],
        minY: request.start[1],
        maxX: request.end[0],
        maxY: request.end[1]
      }
      return {
        min: [box.minX - pad, box.minY - pad] as Point2D,
        max: [box.maxX + pad, box.maxY + pad] as Point2D
      }
    })()

  const columns = clampInt(Math.ceil((bounds.max[0] - bounds.min[0]) / cellSize) + 1, 2, 400)
  const rows = clampInt(Math.ceil((bounds.max[1] - bounds.min[1]) / cellSize) + 1, 2, 400)

  const insideBounds = (p: Point2D): boolean =>
    p[0] >= bounds.min[0] && p[0] <= bounds.max[0] && p[1] >= bounds.min[1] && p[1] <= bounds.max[1]

  const blockedCache = new Map<string, boolean>()
  const blockedByZone = new Map<string, string>()
  const blocked = (p: Point2D): boolean => {
    if (!insideBounds(p)) return true
    const key = `${p[0].toFixed(1)}|${p[1].toFixed(1)}`
    const cached = blockedCache.get(key)
    if (cached !== undefined) return cached
    const cellBox: BBox = {
      minX: p[0] - cellSize / 2,
      minY: p[1] - cellSize / 2,
      maxX: p[0] + cellSize / 2,
      maxY: p[1] + cellSize / 2
    }
    let result = false
    if (cellNearBBox(cellBox, obstacles, clearance)) {
      const probe = distanceToObstacles(p, obstacles)
      if (probe.inside || probe.distance < clearance) {
        result = true
        if (probe.zoneId) blockedByZone.set(key, probe.zoneId)
      }
    }
    blockedCache.set(key, result)
    return result
  }

  const inCorridor = (p: Point2D): boolean =>
    (request.corridors ?? []).some((c) => c.length >= 3 && pointInPolygon(p, c, [], 0))

  const startProbe = distanceToObstacles(request.start, obstacles)
  if (startProbe.inside || startProbe.distance < clearance) {
    return {
      status: 'NO_VALID_ROUTE',
      waypoints: [],
      totalLength: 0,
      bends: 0,
      grid: { cellSize, columns, rows, nodesExpanded: 0 },
      blockedBy: startProbe.zoneId ? [startProbe.zoneId] : [],
      reason: `start (${request.start[0]}, ${request.start[1]}) lies inside or too close to a restricted zone; no clearance can be kept at that endpoint`
    }
  }

  const endProbe = distanceToObstacles(request.end, obstacles)
  if (endProbe.inside || endProbe.distance < clearance) {
    return {
      status: 'NO_VALID_ROUTE',
      waypoints: [],
      totalLength: 0,
      bends: 0,
      grid: { cellSize, columns, rows, nodesExpanded: 0 },
      blockedBy: endProbe.zoneId ? [endProbe.zoneId] : [],
      reason: `goal (${request.end[0]}, ${request.end[1]}) lies inside or too close to a restricted zone; no clearance can be kept at that endpoint`
    }
  }

  const start = snapToFreeCell(request.start, blocked, cellSize)
  const goal = snapToFreeCell(request.end, blocked, cellSize)
  if (!start || !goal) {
    return {
      status: 'NO_VALID_ROUTE',
      waypoints: [],
      totalLength: 0,
      bends: 0,
      grid: { cellSize, columns, rows, nodesExpanded: 0 },
      blockedBy: [...new Set(blockedByZone.values())],
      reason: 'start or goal could not be mapped to an unobstructed grid cell'
    }
  }

  const colOf = (p: Point2D): number =>
    clampInt(Math.round((p[0] - bounds.min[0]) / cellSize), 0, columns - 1)
  const rowOf = (p: Point2D): number =>
    clampInt(Math.round((p[1] - bounds.min[1]) / cellSize), 0, rows - 1)
  const pointAt = (col: number, row: number): Point2D => [
    bounds.min[0] + col * cellSize,
    bounds.min[1] + row * cellSize
  ]
  const key = (col: number, row: number, dir: number): string => `${col},${row},${dir}`

  const startCol = colOf(start)
  const startRow = rowOf(start)
  const goalCol = colOf(goal)
  const goalRow = rowOf(goal)

  // Direction index: 0 = none (start), then 8 neighbours in fixed order.
  const DIRS: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ]
  const diag = Math.SQRT2 * cellSize

  const heuristic = (col: number, row: number): number => {
    const dx = Math.abs(col - goalCol)
    const dy = Math.abs(row - goalRow)
    // Octile distance: admissible for 8-connected movement.
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * cellSize
  }

  const gScore = new Map<string, number>()
  const cameFrom = new Map<string, string>()
  const open: Array<{ f: number; col: number; row: number; dir: number }> = [
    { f: heuristic(startCol, startRow), col: startCol, row: startRow, dir: 0 }
  ]
  gScore.set(key(startCol, startRow, 0), 0)
  const closed = new Set<string>()
  let nodesExpanded = 0

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f)
    const current = open.shift()!
    const currentKey = key(current.col, current.row, current.dir)
    if (closed.has(currentKey)) continue
    closed.add(currentKey)
    nodesExpanded += 1
    if (nodesExpanded > maxNodes) {
      return {
        status: 'INSUFFICIENT_DATA',
        waypoints: [],
        totalLength: 0,
        bends: 0,
        grid: { cellSize, columns, rows, nodesExpanded },
        blockedBy: [...new Set(blockedByZone.values())],
        reason: `route search hit the ${maxNodes} node cap before reaching the goal; widen the corridor set or coarsen cellSize`
      }
    }

    if (current.col === goalCol && current.row === goalRow) {
      const path: Point2D[] = []
      let cursor: string | undefined = currentKey
      while (cursor !== undefined) {
        const [c, r] = cursor.split(',').map(Number) as [number, number]
        path.push(pointAt(c, r))
        cursor = cameFrom.get(cursor)
      }
      path.reverse()
      const simplified = simplifyCollinear(path)
      return {
        status: 'FOUND',
        waypoints: simplified,
        totalLength: pathLength(simplified),
        bends: countBends(simplified),
        grid: { cellSize, columns, rows, nodesExpanded },
        blockedBy: []
      }
    }

    for (const [dirIndex, [dc, dr]] of DIRS.entries()) {
      const nc = current.col + dc
      const nr = current.row + dr
      if (nc < 0 || nr < 0 || nc >= columns || nr >= rows) continue
      const point = pointAt(nc, nr)
      if (blocked(point)) continue
      // Diagonal moves require both orthogonal neighbours to be free: no squeezing through a
      // diagonal gap that a real conduit could not follow.
      if (dc !== 0 && dr !== 0) {
        if (
          blocked(pointAt(current.col + dc, current.row)) ||
          blocked(pointAt(current.col, current.row + dr))
        )
          continue
      }
      const step = dc !== 0 && dr !== 0 ? diag : cellSize
      const bend = current.dir !== 0 && current.dir !== dirIndex + 1 ? bendPenalty : 0
      const discount = inCorridor(point) ? corridorDiscount : 0
      const tentative =
        (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + step + bend - discount
      const nextKey = key(nc, nr, dirIndex + 1)
      if (tentative < (gScore.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        gScore.set(nextKey, tentative)
        cameFrom.set(nextKey, currentKey)
        open.push({ f: tentative + heuristic(nc, nr), col: nc, row: nr, dir: dirIndex + 1 })
      }
    }
  }

  return {
    status: 'NO_VALID_ROUTE',
    waypoints: [],
    totalLength: 0,
    bends: 0,
    grid: { cellSize, columns, rows, nodesExpanded },
    blockedBy: [...new Set(blockedByZone.values())],
    reason: 'no clearance-preserving path exists through this region at the given resolution'
  }
}

const pathLength = (pts: Point2D[]): number => {
  let total = 0
  for (let i = 0; i < pts.length - 1; i++)
    total += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1])
  return total
}

function countBends(pts: Point2D[]): number {
  let bends = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const prev = pts[i - 1]!
    const cross = (a[0] - prev[0]) * (b[1] - a[1]) - (a[1] - prev[1]) * (b[0] - a[0])
    if (Math.abs(cross) > 1e-9) bends += 1
  }
  return bends
}

/** Drop collinear intermediate vertices so the drawn polyline matches the intent. */
function simplifyCollinear(pts: Point2D[]): Point2D[] {
  if (pts.length <= 2) return pts
  const out: Point2D[] = [pts[0]!]
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1]!
    const a = pts[i]!
    const b = pts[i + 1]!
    const cross = (a[0] - prev[0]) * (b[1] - a[1]) - (a[1] - prev[1]) * (b[0] - a[0])
    if (Math.abs(cross) > 1e-9) out.push(a)
  }
  out.push(pts[pts.length - 1]!)
  return out
}
