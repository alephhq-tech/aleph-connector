import type { Point2D } from '../schemas/semantic-model'
import { areaOf, pointInPolygon, distancePointToSegment } from '../spatial/geometry'
import { unitsPerMetreFor, unitsPerMmFor, unknownUnitsViolation } from './drawing-units'
import type {
  FireAlarmDevice,
  FireAlarmDeviceType,
  FireAlarmLayoutInput,
  FireAlarmLayoutResult,
  FireAlarmRoomUsage,
  FireAlarmZone
} from './fire-alarm-types'

/**
 * The clause limits a point-type detector on a flat ceiling is held to. TCVN 7568-14:2025 replaced
 * TCVN 7568-14:2015 AND TCVN 5738:2021 (Lời nói đầu), and it states placement purely in distances:
 * there is no "m² per detector" quota for point detectors, so coverage is bounded by `maxReachMm`
 * ("khoảng cách từ bất cứ điểm nào trên bề mặt bằng phẳng đến đầu báo cháy gần nhất").
 */
export interface SensorCriteria {
  deviceType: FireAlarmDeviceType
  /** Cap on the distance between adjacent detectors (5.9.1.1.2 / 5.9.2.1.2). */
  maxSpacingMm: number
  /** Cap on the distance from ANY point of the protected ceiling to the nearest detector. */
  maxReachMm: number
  wallClearanceMaxMm: number
  wallClearanceMinMm: number
  standardRef: string
}

/**
 * A square lattice of step S leaves its worst-covered point at a cell corner, S/sqrt(2) from the
 * nearest centre. Holding that inside the clause reach caps the step at reach*sqrt(2) — the spacing
 * figure alone is not a sufficient pitch, because a 10,2 m smoke lattice puts a cell corner 7,21 m
 * from the nearest detector, past the 7,2 m limit.
 *
 * Both clauses also set the outer-row-to-wall distance to exactly half their spacing figure, so a
 * pitch at or under the spacing cap satisfies that limit too.
 */
function latticePitchMm(criteria: SensorCriteria, callerCapMm?: number): number {
  // -2 mm so the whole-number positions devices are placed at cannot push a cell corner past the
  // limit: the centre of a kept cell is rounded by up to sqrt(2)/2 mm from the ideal lattice point.
  const candidates = [criteria.maxSpacingMm, criteria.maxReachMm * Math.SQRT2 - 2]
  // A caller may tighten the pitch for a room; it can never widen it past what the clause allows.
  if (callerCapMm !== undefined && callerCapMm > 0) candidates.push(callerCapMm)
  return Math.min(...candidates)
}

// The default point-detector symbol is a 400 mm-radius circle (default-symbol-geometry.ts);
// MCP/combination graphics are the same half-extent. The clause wall clearance bounds the insert
// point, but the drawn graphic reaches this far, so a centre legal at the clause minimum still
// prints the symbol across the wall. Placement keeps the larger of the two from the boundary.
const DEFAULT_SYMBOL_RADIUS_MM = 400

export function classifyRoomSensor(usage: FireAlarmRoomUsage): SensorCriteria {
  switch (usage) {
    case 'garage':
    case 'parking':
    case 'kitchen':
    case 'generator':
      return {
        deviceType: 'HEAT_DETECTOR',
        maxSpacingMm: 7200,
        maxReachMm: 5100,
        wallClearanceMaxMm: 3600,
        wallClearanceMinMm: 300,
        standardRef: 'TCVN 7568-14:2025 5.9.2.1.2 / 5.9.2.1.4'
      }
    case 'office':
    case 'corridor':
    case 'electrical':
    case 'pump_room':
    case 'storage':
    case 'elevator':
    case 'stairwell':
    case 'general':
    default:
      return {
        deviceType: 'SMOKE_DETECTOR',
        maxSpacingMm: 10200,
        maxReachMm: 7200,
        wallClearanceMaxMm: 5100,
        wallClearanceMinMm: 500,
        standardRef: 'TCVN 7568-14:2025 5.9.1.1.2 / 5.9.1.1.4'
      }
  }
}

function computeBBox(points: Point2D[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

function distToPolygonBoundary(pt: Point2D, poly: Point2D[]): number {
  let minDist = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const d = distancePointToSegment(pt, a, b)
    if (d < minDist) minDist = d
  }
  return minDist
}

export function generateFireAlarmLayout(input: FireAlarmLayoutInput): FireAlarmLayoutResult {
  const violations: string[] = []
  const devices: FireAlarmDevice[] = []
  const zones: FireAlarmZone[] = []
  const deviceCounts: Record<FireAlarmDeviceType, number> = {
    HEAT_DETECTOR: 0,
    SMOKE_DETECTOR: 0,
    MANUAL_CALL_POINT: 0,
    COMBINATION_ALARM: 0,
    JUNCTION_BOX: 0,
    END_OF_LINE_RESISTOR: 0
  }

  if (!input.rooms || input.rooms.length === 0) {
    return {
      status: 'INSUFFICIENT_DATA',
      zones: [],
      devices: [],
      deviceCounts,
      totalProtectedAreaM2: 0,
      violations: ['No rooms provided for fire alarm layout']
    }
  }

  // E8: no measurement without declared units. `insUnits` comes from drawing.summary; an
  // unknown unit blocks the plan instead of silently measuring millimetres.
  const unitsPerMetre = unitsPerMetreFor(input.insUnits)
  const unitsPerMm = unitsPerMmFor(input.insUnits)
  if (unitsPerMetre === null || unitsPerMm === null) {
    return {
      status: 'INSUFFICIENT_DATA',
      zones: [],
      devices: [],
      deviceCounts,
      totalProtectedAreaM2: 0,
      violations: [unknownUnitsViolation(input.insUnits)]
    }
  }
  // All TCVN thresholds below are physical millimetres; drawing coordinates are in the
  // drawing's own units, so every mm distance is scaled by drawing-units-per-mm.
  const areaDivisor = unitsPerMetre * unitsPerMetre
  const shaftClearance = 1200 * unitsPerMm
  const mcpShaftClearance = 500 * unitsPerMm
  const combinationOffset = 300 * unitsPerMm

  let totalAreaM2 = 0
  let heatCounter = 1
  let smokeCounter = 1

  // 1. Process rooms and group into Zones
  const zone1Rooms = input.rooms.filter((r) => r.usage === 'garage' || r.usage === 'parking')
  const zone2Rooms = input.rooms.filter((r) => r.usage !== 'garage' && r.usage !== 'parking')

  const zoneBuckets = [
    { zoneId: 'ZONE_01', name: 'Zone 1: Gara do xe & Ram doc', rooms: zone1Rooms },
    { zoneId: 'ZONE_02', name: 'Zone 2: Phong ky thuat & Khu phu tro', rooms: zone2Rooms }
  ].filter((b) => b.rooms.length > 0)

  for (const bucket of zoneBuckets) {
    let zoneAreaM2 = 0
    let zoneDeviceCount = 0

    for (const room of bucket.rooms) {
      if (!room.boundary || room.boundary.length < 3) continue
      // Elevator shafts, voids, and ramps must NEVER have sensors placed inside
      const isElevator =
        room.usage === 'elevator' || /thang(\s*m[aá]y)?|elevator/i.test(room.name || '')
      if (isElevator) {
        continue
      }
      const isRamp = /ram(\s*d[oố]c)?|d[oố]c|ramp/i.test(room.name || '')
      if (isRamp) {
        continue
      }
      // Area in m²: polygon area in drawing-units² divided by (drawing units per metre)².
      const roomAreaM2 = areaOf(room.boundary) / areaDivisor
      zoneAreaM2 += roomAreaM2
      totalAreaM2 += roomAreaM2

      const criteria = classifyRoomSensor(room.usage)
      // Clause pitch in millimetres, scaled to drawing units: the grid itself is laid
      // out in the drawing's own units.
      const pitch =
        latticePitchMm(
          criteria,
          criteria.deviceType === 'HEAT_DETECTOR' ? input.maxHeatSpacingMm : input.maxSmokeSpacingMm
        ) * unitsPerMm

      const bbox = computeBBox(room.boundary)
      const width = bbox.maxX - bbox.minX
      const height = bbox.maxY - bbox.minY

      const cols = Math.max(1, Math.ceil(width / pitch))
      const rows = Math.max(1, Math.ceil(height / pitch))
      const stepX = width / cols
      const stepY = height / rows

      // Two different questions, and conflating them produces wrong answers in both directions.
      // `protectedCeiling` is a point that must be monitored: inside this room, and not inside a
      // void, shaft or excluded zone (clause 5.2 lets a design exclude areas with no combustibles).
      // `placeable` is stricter: a detector may not stand in or beside a shaft, but the ceiling
      // around it is still protected and still has to be reached from somewhere else.
      const protectedCeiling = (pt: Point2D): boolean => {
        if (!pointInPolygon(pt, room.boundary)) return false
        if (room.excludedBoundaries) {
          for (const excl of room.excludedBoundaries) {
            if (pointInPolygon(pt, excl)) return false
          }
        }
        if (input.elevatorShafts) {
          for (const shaft of input.elevatorShafts) {
            if (pointInPolygon(pt, shaft)) return false
          }
        }
        return true
      }

      // Keep the drawn symbol inside the room: a point detector is a 400 mm-radius circle, so a
      // centre legal at the clause minimum (300 mm) still prints the graphic across the wall (the
      // SUNLAND overhang). The inset is the larger of the clause floor and the symbol radius — but
      // ONLY when the room can actually hold the symbol. A space narrower than the symbol's diameter
      // cannot fit it anywhere, so there the clause floor stays: leaving a corridor unprotected to
      // avoid a 100 mm overhang is the worse failure. min(width,height)/2 is a conservative proxy for
      // the largest inscribed circle; when it is under the radius the room is too tight and we relax.
      const symbolRadius = DEFAULT_SYMBOL_RADIUS_MM * (input.symbolScale ?? 1) * unitsPerMm
      const roomHoldsSymbol = Math.min(width, height) / 2 >= symbolRadius
      const placementInset = roomHoldsSymbol
        ? Math.max(criteria.wallClearanceMinMm * unitsPerMm, symbolRadius)
        : criteria.wallClearanceMinMm * unitsPerMm

      const clauseFloor = criteria.wallClearanceMinMm * unitsPerMm
      const placeable = (pt: Point2D, inset = placementInset): boolean => {
        if (!protectedCeiling(pt)) return false
        if (input.elevatorShafts) {
          for (const shaft of input.elevatorShafts) {
            if (distToPolygonBoundary(pt, shaft) < shaftClearance) return false
          }
        }
        // Clause 5.9.1.1.4 a) / 5.9.2.1.4 a) bound the outer row on BOTH sides: no farther than
        // wallClearanceMaxMm (which the pitch already guarantees) and no closer than
        // wallClearanceMinMm. A detector crowded onto a wall or perched on a shaft's edge reads as
        // placed but reports poorly.
        if (distToPolygonBoundary(pt, room.boundary) < inset) return false
        return true
      }

      const addDevice = (candX: number, candY: number): void => {
        const isHeat = criteria.deviceType === 'HEAT_DETECTOR'
        const label = isHeat
          ? `DB-N${heatCounter < 10 ? '0' : ''}${heatCounter++}`
          : `DB-K${smokeCounter < 10 ? '0' : ''}${smokeCounter++}`
        const device: FireAlarmDevice = {
          id: `${bucket.zoneId}_${label}`,
          type: criteria.deviceType,
          x: candX,
          y: candY,
          zoneId: bucket.zoneId,
          label,
          roomUsage: room.usage
        }
        devices.push(device)
        placedInRoom.push(device)
        deviceCounts[criteria.deviceType]++
        zoneDeviceCount++
      }

      // Clause 5.9.1.1.2 / 5.9.2.1.2 bounds EVERY point of the protected ceiling, not just the
      // spacing between the detectors that happened to fit, so coverage is what has to be
      // established — the check a schedule can never provide, since the placed count always agrees
      // with the drawn count while a strip of ceiling monitors nothing.
      //
      // Kept cells need no sampling: a detector stands at the centre of each, so the farthest point
      // of such a cell is its corner, at half the cell diagonal <= pitch/sqrt(2), and the pitch is
      // capped below reach*sqrt(2) (see latticePitchMm) to leave room for rounding. Coverage there is
      // exact by construction.
      //
      // Coverage is lost only in cells that were DROPPED — the polygon's own edge, a void, a shaft —
      // and those are sampled: every point of a dropped cell lies within half the sample diagonal of
      // a sample, so requiring each sample to be within (reach - that margin) of a detector makes the
      // whole cell compliant with the clause, rather than "probably fine except for an unsampled
      // residual". If no legal position can do that, the room is reported instead of drawn.
      const reach = criteria.maxReachMm * unitsPerMm
      const auditStep = Math.min(stepX, stepY) / 8
      const sampleMargin = (auditStep * Math.SQRT2) / 2
      const safeReach = reach - sampleMargin

      const placedInRoom: FireAlarmDevice[] = []
      const droppedCells: Array<[number, number]> = []

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x0 = bbox.minX + c * stepX
          const y0 = bbox.minY + r * stepY
          const cx = x0 + stepX / 2
          const cy = y0 + stepY / 2
          if (placeable([cx, cy])) addDevice(Math.round(cx), Math.round(cy))
          else droppedCells.push([x0, y0])
        }
      }

      const holes: Point2D[] = []
      for (const [x0, y0] of droppedCells) {
        for (let x = x0 + auditStep / 2; x < x0 + stepX; x += auditStep) {
          for (let y = y0 + auditStep / 2; y < y0 + stepY; y += auditStep) {
            const p: Point2D = [x, y]
            if (!protectedCeiling(p)) continue
            if (placedInRoom.every((d) => Math.hypot(d.x - p[0], d.y - p[1]) > safeReach))
              holes.push(p)
          }
        }
      }

      // Repair greedily. Each added detector must stand on this room's protected ceiling, outside
      // every shaft's clearance band, and within safeReach of the ceiling it is claimed to cover — a
      // repair placed on the far side of a void repairs nothing.
      // Search for a repair spot at a given boundary inset, deepest-into-the-room first.
      const findRepair = (seed: Point2D, inset: number): { spot: Point2D; covers: number } | null => {
        let best: { spot: Point2D; covers: number } | null = null
        // Prefer the direction going deeper into the room (away from the wall the hole sits under).
        const baseAngle = Math.atan2(
          (bbox.minY + bbox.maxY) / 2 - seed[1],
          (bbox.minX + bbox.maxX) / 2 - seed[0]
        )
        const maxRadius = safeReach
        for (let i = 0; i <= 8; i++) {
          const radius = (maxRadius * i) / 8
          const rings = radius === 0 ? 1 : 24
          for (let k = 0; k < rings; k++) {
            const angle = baseAngle + (k * Math.PI * 2) / rings
            const spot: Point2D = [
              seed[0] + radius * Math.cos(angle),
              seed[1] + radius * Math.sin(angle)
            ]
            if (!placeable(spot, inset)) continue
            if (
              placedInRoom.some((d) => Math.hypot(d.x - spot[0], d.y - spot[1]) < 1000 * unitsPerMm)
            )
              continue
            // The seed counts: it was shifted out of `holes`, and a spot covering only the seed is
            // still a valid repair.
            const covers =
              1 +
              holes.filter((p) => Math.hypot(p[0] - spot[0], p[1] - spot[1]) <= safeReach).length
            if (!best || covers > best.covers) best = { spot, covers }
          }
        }
        return best
      }

      while (holes.length > 0) {
        const seed = holes.shift()!
        // Keep the drawn symbol inside the room first; only if no inset-legal spot can cover the
        // hole (a narrow arm of an L-shaped room cannot hold the symbol) fall back to the clause
        // floor. A small overhang beats an uncovered strip of ceiling — the clause is about coverage.
        let best = findRepair(seed, placementInset)
        if (!best && placementInset > clauseFloor) best = findRepair(seed, clauseFloor)
        if (!best) {
          violations.push(
            `UNCOVERED_CEILING: ${room.name || room.id} has protected ceiling at ` +
              `[${Math.round(seed[0])}, ${Math.round(seed[1])}] that no detector can reach from a ` +
              `legal position — every point within ${(reach / unitsPerMetre).toFixed(1)} m of it is a void, a ` +
              `shaft or their clearance band (${criteria.standardRef}). This part of the room cannot ` +
              `be covered as drawn, so it is not counted in the schedule.`
          )
          continue
        }
        addDevice(Math.round(best.spot[0]), Math.round(best.spot[1]))
        for (let i = holes.length - 1; i >= 0; i--) {
          const p = holes[i]!
          if (Math.hypot(p[0] - best.spot[0], p[1] - best.spot[1]) <= safeReach) holes.splice(i, 1)
        }
      }
    }

    if (zoneAreaM2 > 2000) {
      violations.push(
        `${bucket.name} area (${Math.round(zoneAreaM2)} m2) exceeds the 2000 m2 maximum for one ` +
          `fire detection zone per TCVN 7568-14:2025 5.7.2.1 — split it into separate zones.`
      )
    }

    zones.push({
      zoneId: bucket.zoneId,
      name: bucket.name,
      areaM2: Math.round(zoneAreaM2 * 10) / 10,
      deviceCount: zoneDeviceCount,
      maxAreaM2: 2000
    })
  }

  // 2. Junction Box (JB) — E7: the panel anchor is a real CAD entity or a caller
  // decision, never an invented coordinate. No `junctionBoxLocation` fails closed
  // with NO_PANEL_ANCHOR; a too-close anchor is reported, not silently moved.
  if (input.junctionBoxLocation) {
    const jbLoc = input.junctionBoxLocation
    let jbTooClose = false
    if (input.elevatorShafts) {
      for (const shaft of input.elevatorShafts) {
        if (distToPolygonBoundary(jbLoc, shaft) < shaftClearance) {
          violations.push(
            `JUNCTION_BOX_TOO_CLOSE_TO_ELEVATOR_SHAFT: junction box at [${jbLoc[0]}, ${jbLoc[1]}] ` +
              `is inside the 1200 mm shaft clearance — move the panel anchor to a real block ` +
              `outside the shaft instead of shifting it by an invented offset`
          )
          jbTooClose = true
          break
        }
      }
    }
    // A placement that violates the shaft clearance is reported, not emitted: a direct
    // engineering consumer that ignores status/violations must never draw it.
    if (!jbTooClose) {
      devices.unshift({
        id: 'JB_FA_01',
        type: 'JUNCTION_BOX',
        x: jbLoc[0],
        y: jbLoc[1],
        zoneId: zones[0]?.zoneId ?? 'ZONE_01',
        label: 'BOX NOI DAY FA'
      })
      deviceCounts.JUNCTION_BOX++
    }
  } else {
    const candidates = (input.junctionBoxCandidates ?? []).filter((c) => c.trim() !== '')
    violations.push(
      'NO_PANEL_ANCHOR: no junction box location was supplied — the planner does not invent ' +
        'one. Pass junctionBoxLocation from a real panel/junction-box block in the drawing' +
        (candidates.length > 0
          ? ` (candidates in this drawing: ${candidates.join(', ')})`
          : ' (block.list)') +
        '.'
    )
  }

  // 3. Add Manual Call Points (MCP) & Combination units beside stair doors
  if (input.stairDoors && input.stairDoors.length > 0) {
    let mcpCounter = 1
    for (const stair of input.stairDoors) {
      const pt = stair.doorPoint
      let onElevator = false
      if (input.elevatorShafts) {
        for (const shaft of input.elevatorShafts) {
          // Inside the shaft counts too, and worse: a door point in the middle of a shaft is far
          // from its wall, so a boundary-proximity test alone waved it through and the call point was
          // mounted over the moving cabin.
          if (pointInPolygon(pt, shaft) || distToPolygonBoundary(pt, shaft) < mcpShaftClearance) {
            onElevator = true
            violations.push(
              `ELEVATOR_SHAFT_DOOR: stair door [${pt[0]}, ${pt[1]}] is inside or within 0,5 m of an ` +
                `elevator shaft, so no call point can be mounted there — give the door point on the ` +
                `landing side of the stair enclosure.`
            )
            break
          }
        }
      }
      if (onElevator) continue

      const mcpId = `MCP_${mcpCounter < 10 ? '0' : ''}${mcpCounter}`
      const combId = `TH_${mcpCounter < 10 ? '0' : ''}${mcpCounter++}`

      devices.push({
        id: mcpId,
        type: 'MANUAL_CALL_POINT',
        x: pt[0],
        y: pt[1],
        zoneId: zones[0]?.zoneId ?? 'ZONE_01',
        label: mcpId
      })
      deviceCounts.MANUAL_CALL_POINT++

      devices.push({
        id: combId,
        type: 'COMBINATION_ALARM',
        x: pt[0] + combinationOffset,
        y: pt[1],
        zoneId: zones[0]?.zoneId ?? 'ZONE_01',
        label: combId
      })
      deviceCounts.COMBINATION_ALARM++
    }
  }

  return {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    zones,
    devices,
    deviceCounts,
    totalProtectedAreaM2: Math.round(totalAreaM2 * 10) / 10,
    violations
  }
}
