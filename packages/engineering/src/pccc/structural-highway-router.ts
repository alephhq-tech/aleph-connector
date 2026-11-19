import { sequenceDaisyChain, toCadPoint } from './fire-alarm-router'
import type { Point2D } from '../schemas/semantic-model'
import { unitsPerMetreFor, unknownUnitsViolation } from './drawing-units'
import type { DrawingUnits } from './drawing-units'
import type {
  CadPoint,
  FireAlarmDevice,
  FireAlarmRouteResult,
  FireAlarmWireSegment
} from './fire-alarm-types'

export interface StructuralGridHighwayInput {
  zoneId: string
  devices: FireAlarmDevice[]
  startDeviceId?: string
  /** Structural grid lines (e.g. Axis B at Y=105500, Axis D at Y=117000) */
  beamYHighways?: number[]
  /** Elevator core bounding box [minX, minY, maxX, maxY] strictly forbidden to cross */
  forbiddenZones?: Array<{ minX: number; minY: number; maxX: number; maxY: number }>
  layerWiring?: string
  /**
   * Drawing units from `drawing.summary` `insUnits` (E8): wire lengths are reported in
   * metres. Absent/`unitless` fails the route with UNKNOWN_DRAWING_UNITS.
   */
  insUnits?: DrawingUnits
}

function segmentCrossesBox(
  p1: Point2D,
  p2: Point2D,
  box: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  const minX = Math.min(p1[0], p2[0])
  const maxX = Math.max(p1[0], p2[0])
  const minY = Math.min(p1[1], p2[1])
  const maxY = Math.max(p1[1], p2[1])

  // Overlap test
  if (maxX < box.minX || minX > box.maxX || maxY < box.minY || minY > box.maxY) return false

  // Horizontal segment
  if (p1[1] === p2[1]) {
    const y = p1[1]
    if (y >= box.minY && y <= box.maxY && maxX >= box.minX && minX <= box.maxX) return true
  }
  // Vertical segment
  if (p1[0] === p2[0]) {
    const x = p1[0]
    if (x >= box.minX && x <= box.maxX && maxY >= box.minY && minY <= box.maxY) return true
  }
  return false
}

/**
 * Routes an orthogonal path between two points that strictly hugs structural beam lines
 * and never crosses forbidden zones (like elevator cores).
 *
 * Returns `null` when the span needs a beam axis and none of the supplied axes can carry it. A
 * highway is a coordinate that ends up as a polyline vertex on the sheet, so inventing one — a line
 * offset 1000 mm from a shaft, or the midpoint between two devices — draws a run that follows no
 * structural element while still reporting a clean route. "Cannot route" is the honest answer, and
 * the caller turns it into a violation.
 *
 * All thresholds are millimetres scaled by `unitsPerMm`: the 800 collinear tolerance,
 * the 15000 local-route cap and the 1000 clearance detour are mm constants, not drawing units.
 */
export function routeViaBeamHighway(
  start: Point2D,
  end: Point2D,
  highwayYList: number[],
  forbiddenZones: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [],
  unitsPerMm: number
): Point2D[] | null {
  // Practical Engineering Rule 1: Direct collinear alignment (same horizontal beam line or row)
  if (Math.abs(start[1] - end[1]) < 800 * unitsPerMm) {
    const directBlocked = forbiddenZones.some((fz) => segmentCrossesBox(start, end, fz))
    if (!directBlocked) {
      return [start, end]
    }
  }

  // Practical Engineering Rule 2: Direct vertical alignment (same column line or conduit drop)
  if (Math.abs(start[0] - end[0]) < 800 * unitsPerMm) {
    const directBlocked = forbiddenZones.some((fz) => segmentCrossesBox(start, end, fz))
    if (!directBlocked) {
      return [start, end]
    }
  }

  // Practical Engineering Rule 3: Local L-route (within local space or room, without detour)
  const cornerX: Point2D = [end[0], start[1]]
  const cornerXBlocked = forbiddenZones.some(
    (fz) => segmentCrossesBox(start, cornerX, fz) || segmentCrossesBox(cornerX, end, fz)
  )
  if (!cornerXBlocked) {
    const distL = Math.abs(start[0] - end[0]) + Math.abs(start[1] - end[1])
    if (distL <= 15000 * unitsPerMm) {
      return [start, cornerX, end]
    }
  }

  const cornerY: Point2D = [start[0], end[1]]
  const cornerYBlocked = forbiddenZones.some(
    (fz) => segmentCrossesBox(start, cornerY, fz) || segmentCrossesBox(cornerY, end, fz)
  )
  if (!cornerYBlocked) {
    const distL = Math.abs(start[0] - end[0]) + Math.abs(start[1] - end[1])
    if (distL <= 15000 * unitsPerMm) {
      return [start, cornerY, end]
    }
  }

  // Practical Engineering Rule 4: Long-distance traversal around forbidden zones (via Beam Highway)
  const validHighways = highwayYList.filter((hy) => {
    const minX = Math.min(start[0], end[0])
    const maxX = Math.max(start[0], end[0])
    for (const fz of forbiddenZones) {
      if (hy >= fz.minY && hy <= fz.maxY && maxX >= fz.minX && minX <= fz.maxX) {
        return false // Blocked by elevator/shaft
      }
    }
    return true
  })

  if (validHighways.length === 0) return null
  const firstHighway = validHighways[0]!
  const nearest = (a: number, b: number) =>
    Math.abs(a - start[1]) + Math.abs(a - end[1]) <= Math.abs(b - start[1]) + Math.abs(b - end[1])
  const axis = validHighways.reduce((best, cur) => (nearest(cur, best) ? cur : best), firstHighway)

  // Rule 4's trunk run always lies on an axis the caller read off the drawing — that is the property
  // the previous code broke by inventing one. The vertical legs that step around a core are placed at
  // x values that come from the drawing too: each endpoint's own x, or a line clear of a core's own
  // extents (a cable standing just outside a shaft is how it bypasses it). No y coordinate in a Rule 4
  // route is fabricated; short spurs between neighbouring devices come from Rules 1-3, whose y values
  // are the devices' own, which are themselves CAD-derived.
  const legCandidates = [start[0], end[0]]
  for (const fz of forbiddenZones) {
    legCandidates.push(fz.minX - 1000 * unitsPerMm, fz.maxX + 1000 * unitsPerMm)
  }

  const paths: Point2D[][] = [
    [start, [start[0], axis], [end[0], axis], end],
    // One extra vertical leg, placed clear of the core, so the run can get around it.
    ...legCandidates.flatMap((v): Point2D[][] => [
      [start, [v, start[1]], [v, axis], [end[0], axis], end],
      [start, [start[0], axis], [v, axis], [v, end[1]], end],
      [start, [v, start[1]], [v, axis], [v, end[1]], end]
    ])
  ]

  for (const candidate of paths) {
    const simplified: Point2D[] = [candidate[0]!]
    for (let i = 1; i < candidate.length; i++) {
      const prev = simplified[simplified.length - 1]!
      const cur = candidate[i]!
      // Drop a reversal: two consecutive legs on the same x going opposite ways cancel out.
      if (prev[0] === cur[0] && prev[1] === cur[1]) continue
      const before = simplified[simplified.length - 2]
      if (before && prev[0] === cur[0] && before[0] !== cur[0]) {
        const up = cur[1] - prev[1]
        const down = prev[1] - before[1]
        if (Math.sign(up) === Math.sign(down)) continue
      }
      simplified.push(cur)
    }

    let clear = true
    for (let i = 0; i < simplified.length - 1 && clear; i++) {
      for (const fz of forbiddenZones) {
        if (segmentCrossesBox(simplified[i]!, simplified[i + 1]!, fz)) {
          clear = false
          break
        }
      }
    }
    if (clear) return simplified
  }

  // No axis carries this span and no route around the cores is possible on it. Refusing is the only
  // honest answer: the old rescue drew a second horizontal run at `fz.minY - 1000`, a line that
  // follows no structural element, and still reported a clean route.
  return null
}

/**
 * Structural Beam Highway Router for Fire Alarm circuits.
 * Ensures:
 * 1. Strictly non-branching Daisy-Chain.
 * 2. All wires align with structural beam axes.
 * 3. 0% chance of cutting through elevator shafts.
 * 4. High-visibility Polyline CAD operations (Cyan ACI 4, Lineweight 0.35mm).
 */
export function routeStructuralHighway(input: StructuralGridHighwayInput): FireAlarmRouteResult {
  const layer = input.layerWiring ?? 'FA-WIRING'
  const forbiddenZones = input.forbiddenZones ?? []

  // E8: resolve the unit basis FIRST — the mm engineering constants in the router are scaled by
  // it, and unknown units fail the route before any geometry is drawn.
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
  // Only axes the caller read from the drawing. Synthesising a "highway" from a shaft's bounding
  // box (minY-1000 / maxY+1000) draws a cable run beside a shaft that follows no structural beam,
  // and reports a clean route while doing it.
  const beamYHighways = input.beamYHighways ?? []
  const violations: string[] = []

  if (!input.devices || input.devices.length === 0) {
    return {
      status: 'FAIL',
      zoneId: input.zoneId,
      sequence: [],
      segments: [],
      totalLengthM: 0,
      eolrDeviceId: '',
      violations: ['No devices provided'],
      cadOperations: []
    }
  }

  // 1. Sequence devices using Hamiltonian Daisy-Chain TSP (starts at JB, terminates at EOL)
  const jb = input.devices.find((d) => d.type === 'JUNCTION_BOX')
  const startId = input.startDeviceId ?? jb?.id ?? input.devices[0].id
  const sortedDevices = sequenceDaisyChain(input.devices, startId)

  // Practical Engineering Rule: ONLY the last device in the chain carries the EOLR
  for (let i = 0; i < sortedDevices.length - 1; i++) {
    sortedDevices[i].isEndOfLine = false
  }
  if (sortedDevices.length > 0) {
    sortedDevices[sortedDevices.length - 1].isEndOfLine = true
  }

  const sequence = sortedDevices.map((d) => d.id)
  const segments: FireAlarmWireSegment[] = []
  let totalLengthMm = 0

  // Wire operations go to the plugin verbatim, so they carry the plugin's point object, never the
  // router's internal `[x, y]` tuple — the tuple aborted the batch inside AutoCAD's transaction.
  const cadOperations: Array<{
    op: 'create'
    entity: { kind: 'polyline'; layer: string; points: CadPoint[] }
  }> = []

  for (let i = 0; i < sortedDevices.length - 1; i++) {
    const d1 = sortedDevices[i]
    const d2 = sortedDevices[i + 1]

    const pt1: Point2D = [d1.x, d1.y]
    const pt2: Point2D = [d2.x, d2.y]

    const waypoints = routeViaBeamHighway(pt1, pt2, beamYHighways, forbiddenZones, unitsPerMm)
    if (waypoints === null) {
      // Nothing is emitted for this span. A run along an axis nobody drew used to be committed and
      // still reported PASS, so the only signal that the circuit was unroutable was a wire appearing
      // in the middle of nowhere.
      violations.push(
        `NO_STRUCTURAL_HIGHWAY: no beam axis in ${
          beamYHighways.length ? `the supplied grid (${beamYHighways.join(', ')})` : 'the design'
        } can carry ${d1.id} [${d1.x}, ${d1.y}] -> ${d2.id} [${d2.x}, ${d2.y}] without crossing ` +
          `a forbidden zone. Supply the real beam/grid Y coordinates from the drawing ` +
          `(beamYHighways) or split the circuit; nothing was drawn for this span.`
      )
      continue
    }

    let segMm = 0
    for (let k = 0; k < waypoints.length - 1; k++) {
      segMm += Math.hypot(
        waypoints[k + 1][0] - waypoints[k][0],
        waypoints[k + 1][1] - waypoints[k][1]
      )
    }
    totalLengthMm += segMm

    segments.push({
      id: `WIRE_${d1.id}_${d2.id}`,
      zoneId: input.zoneId,
      startDeviceId: d1.id,
      endDeviceId: d2.id,
      points: waypoints,
      lengthM: Math.round((segMm / unitsPerMetre) * 10) / 10
    })

    cadOperations.push({
      op: 'create',
      entity: {
        kind: 'polyline',
        layer,
        points: waypoints.map(toCadPoint)
      }
    })
  }

  return {
    // An unroutable span breaks the circuit: the devices are still placed and still scheduled, so a
    // PASS here would claim a wired loop that was only partly drawn.
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    zoneId: input.zoneId,
    sequence,
    segments,
    totalLengthM: Math.round((totalLengthMm / unitsPerMetre) * 10) / 10,
    eolrDeviceId: sortedDevices[sortedDevices.length - 1].id,
    violations,
    cadOperations
  }
}
