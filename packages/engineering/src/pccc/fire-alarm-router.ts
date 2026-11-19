import type { Point2D } from '../schemas/semantic-model'
import { pointInPolygon, segmentsIntersect } from '../spatial/geometry'
import { unitsPerMetreFor, unknownUnitsViolation } from './drawing-units'
import type { DrawingUnits } from './drawing-units'
import type {
  CadPoint,
  FireAlarmDevice,
  FireAlarmRouteResult,
  FireAlarmWireSegment
} from './fire-alarm-types'

/** The routers' internal `[x, y]` → the point shape the plugin deserializes. */
export const toCadPoint = ([x, y]: Point2D): CadPoint => ({ x, y, z: 0 })

export interface FireAlarmRouterInput {
  zoneId: string
  devices: FireAlarmDevice[]
  startDeviceId?: string
  walls?: Point2D[][]
  doors?: Point2D[][]
  clearanceMm?: number
  layerWiring?: string
  /** Drawing units from `drawing.summary` `insUnits` (E8). Absent/`unitless` fails the route. */
  insUnits?: DrawingUnits
}

function manhattanDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

/**
 * Sequences devices into a continuous, strictly non-branching Daisy-Chain topology.
 * Solves an open Traveling Salesperson Problem (Hamiltonian Path) starting at startDeviceId.
 * Uses Nearest-Neighbor construction followed by 2-Opt local search to untangle crossings.
 */
export function sequenceDaisyChain(
  devices: FireAlarmDevice[],
  startDeviceId?: string
): FireAlarmDevice[] {
  if (devices.length <= 2) return [...devices]

  const pool = [...devices]
  let startIndex = 0
  if (startDeviceId) {
    const found = pool.findIndex((d) => d.id === startDeviceId)
    if (found >= 0) startIndex = found
  }

  // 1. Nearest Neighbor construction
  const tour: FireAlarmDevice[] = [pool.splice(startIndex, 1)[0]]
  while (pool.length > 0) {
    const current = tour[tour.length - 1]
    let nearestIdx = 0
    let nearestDist = Infinity

    for (let i = 0; i < pool.length; i++) {
      const d = manhattanDist(current, pool[i])
      if (d < nearestDist) {
        nearestDist = d
        nearestIdx = i
      }
    }
    tour.push(pool.splice(nearestIdx, 1)[0])
  }

  // 2. 2-Opt optimization to eliminate crossings (triệt tiêu mạng nhện)
  let improved = true
  let iterations = 0
  const maxIterations = 50

  while (improved && iterations < maxIterations) {
    improved = false
    iterations++

    for (let i = 0; i < tour.length - 2; i++) {
      for (let j = i + 2; j < tour.length; j++) {
        // Test if reversing segment between i+1 and j reduces Manhattan distance or eliminates geometric crossing
        const a = tour[i]
        const b = tour[i + 1]
        const c = tour[j]
        const d = tour[j + 1]

        const currentCost = manhattanDist(a, b) + (d ? manhattanDist(c, d) : 0)
        const newCost = manhattanDist(a, c) + (d ? manhattanDist(b, d) : 0)

        // Check 2D segment intersection
        const ptA: Point2D = [a.x, a.y]
        const ptB: Point2D = [b.x, b.y]
        const ptC: Point2D = [c.x, c.y]
        const ptD: Point2D = d ? [d.x, d.y] : [c.x, c.y]
        const intersects = d && segmentsIntersect(ptA, ptB, ptC, ptD)

        if (intersects || newCost < currentCost) {
          // Reverse subsegment tour[i+1 ... j]
          let left = i + 1
          let right = j
          while (left < right) {
            const temp = tour[left]
            tour[left] = tour[right]
            tour[right] = temp
            left++
            right--
          }
          improved = true
        }
      }
    }
  }

  // Mark the last device as the End-Of-Line Resistor location
  tour[tour.length - 1].isEndOfLine = true
  return tour
}

/**
 * Checks if a point or segment collides with structural walls without going through a door.
 */
function isBlockedByWall(pt: Point2D, walls?: Point2D[][], doors?: Point2D[][]): boolean {
  if (!walls || walls.length === 0) return false

  // If point is inside an allowed door opening, it is traversable
  if (doors) {
    for (const door of doors) {
      if (pointInPolygon(pt, door)) return false
    }
  }

  // If point is inside a wall obstacle, it is blocked
  for (const wall of walls) {
    if (pointInPolygon(pt, wall)) return true
  }

  return false
}

/**
 * Simplifies a sequence of orthogonal points by removing intermediate collinear points.
 */
function simplifyCollinear(pts: Point2D[]): Point2D[] {
  if (pts.length <= 2) return pts
  const result: Point2D[] = [pts[0]]

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = result[result.length - 1]
    const curr = pts[i]
    const next = pts[i + 1]

    // Collinear horizontally or vertically
    const isCollinearX = prev[0] === curr[0] && curr[0] === next[0]
    const isCollinearY = prev[1] === curr[1] && curr[1] === next[1]

    if (!isCollinearX && !isCollinearY) {
      result.push(curr)
    }
  }

  result.push(pts[pts.length - 1])
  return result
}

/**
 * Routes an orthogonal path between two points.
 * Tries direct L-shaped routing (X-then-Y or Y-then-X). If collision with walls occurs,
 * steps along a discrete grid to find a non-colliding route.
 *
 * The wall-escape offset is 1000 mm, scaled by `unitsPerMm` (drawing units per mm).
 */
export function routeOrthogonalBetween(
  start: Point2D,
  end: Point2D,
  walls: Point2D[][] = [],
  doors: Point2D[][] = [],
  // Required, no mm default: the only caller (routeFireAlarmLoop) resolves it from insUnits.
  unitsPerMm: number
): Point2D[] {
  // Option 1: X then Y
  const mid1: Point2D = [end[0], start[1]]
  const collidesMid1 = isBlockedByWall(mid1, walls, doors)

  // Option 2: Y then X
  const mid2: Point2D = [start[0], end[1]]
  const collidesMid2 = isBlockedByWall(mid2, walls, doors)

  if (!collidesMid1) {
    return simplifyCollinear([start, mid1, end])
  }
  if (!collidesMid2) {
    return simplifyCollinear([start, mid2, end])
  }

  // If both direct corners hit a wall, find a clearance waypoint
  // Offset intermediate coordinate by 1000 mm (scaled to drawing units) to step around
  const offsetX = (start[0] < end[0] ? 1000 : -1000) * unitsPerMm
  const midEscaped: Point2D = [start[0] + offsetX, start[1]]
  const cornerEscaped: Point2D = [start[0] + offsetX, end[1]]

  if (!isBlockedByWall(midEscaped, walls, doors) && !isBlockedByWall(cornerEscaped, walls, doors)) {
    return simplifyCollinear([start, midEscaped, cornerEscaped, end])
  }

  // Fallback to least-colliding L-turn
  return simplifyCollinear([start, mid1, end])
}

/**
 * Routes the complete Daisy-Chain fire alarm loop for a zone.
 */
export function routeFireAlarmLoop(input: FireAlarmRouterInput): FireAlarmRouteResult {
  const violations: string[] = []
  const layer = input.layerWiring ?? 'FA-WIRING'

  // E8: wire lengths are metres and the wall-escape offset is millimetres — both need
  // the real unit basis. Unknown units fail the route, never silently measured in mm.
  const unitsPerMetre = unitsPerMetreFor(input.insUnits)
  if (unitsPerMetre === null) {
    return {
      status: 'FAIL',
      zoneId: input.zoneId,
      sequence: [],
      segments: [],
      totalLengthM: 0,
      eolrDeviceId: '',
      violations: [unknownUnitsViolation(input.insUnits)],
      cadOperations: []
    }
  }
  const unitsPerMm = unitsPerMetre / 1000

  if (!input.devices || input.devices.length === 0) {
    return {
      status: 'FAIL',
      zoneId: input.zoneId,
      sequence: [],
      segments: [],
      totalLengthM: 0,
      eolrDeviceId: '',
      violations: ['No devices to route'],
      cadOperations: []
    }
  }

  // 1. Sequence the devices into a strictly continuous Daisy-Chain (No T-taps!)
  const orderedDevices = sequenceDaisyChain(input.devices, input.startDeviceId)
  const sequence = orderedDevices.map((d) => d.id)
  const segments: FireAlarmWireSegment[] = []
  let totalLengthUnits = 0

  // A CAD operation is deserialized by the plugin's typed DTO, so points travel as {x,y,z}, never
  // as the router's internal [x,y] tuple: the tuple aborted every real overlay batch with a
  // Newtonsoft error. Color/width are not per-entity create inputs (the plugin has no such field on
  // CreateEntityRequest), so they are set on the layer, not here.
  const cadOperations: Array<{
    op: 'create'
    entity: { kind: 'polyline'; layer: string; points: CadPoint[] }
  }> = []

  // 2. Route wire between each adjacent pair in sequence
  for (let i = 0; i < orderedDevices.length - 1; i++) {
    const d1 = orderedDevices[i]
    const d2 = orderedDevices[i + 1]

    const ptStart: Point2D = [d1.x, d1.y]
    const ptEnd: Point2D = [d2.x, d2.y]

    const waypoints = routeOrthogonalBetween(ptStart, ptEnd, input.walls, input.doors, unitsPerMm)

    // Calculate segment length in drawing units, reported in metres.
    let segLenUnits = 0
    for (let k = 0; k < waypoints.length - 1; k++) {
      segLenUnits += Math.hypot(
        waypoints[k + 1][0] - waypoints[k][0],
        waypoints[k + 1][1] - waypoints[k][1]
      )
    }

    totalLengthUnits += segLenUnits
    const segId = `WIRE_${d1.id}_${d2.id}`

    segments.push({
      id: segId,
      zoneId: input.zoneId,
      startDeviceId: d1.id,
      endDeviceId: d2.id,
      points: waypoints,
      lengthM: Math.round((segLenUnits / unitsPerMetre) * 10) / 10
    })

    // One polyline per daisy-chain leg: a closed loop would fabricate a return path that does not
    // exist in the circuit.
    cadOperations.push({
      op: 'create',
      entity: {
        kind: 'polyline',
        layer,
        points: waypoints.map(toCadPoint)
      }
    })
  }

  const eolrDevice = orderedDevices[orderedDevices.length - 1]

  return {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    zoneId: input.zoneId,
    sequence,
    segments,
    totalLengthM: Math.round((totalLengthUnits / unitsPerMetre) * 10) / 10,
    eolrDeviceId: eolrDevice.id,
    violations,
    cadOperations
  }
}
