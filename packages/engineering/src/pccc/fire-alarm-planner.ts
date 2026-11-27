import type {
  CadOperation,
  FireAlarmFullPlanResult,
  FireAlarmLayoutInput,
  FireAlarmRouteResult
} from './fire-alarm-types'
import { generateFireAlarmLayout } from './fire-alarm-layout'
import { routeStructuralHighway } from './structural-highway-router'
import { unitsPerMetreFor, unitsPerMmFor } from './drawing-units'
import { compilePcccDeviceCadEntities, type PcccBlockAssignment } from './block-library'

export interface HighwayFireAlarmPlannerInput extends FireAlarmLayoutInput {
  layerDevices?: string
  layerWiring?: string
  layerText?: string
  symbolScale?: number
  beamYHighways?: number[]
  beamXHighways?: number[]
  forbiddenZones?: Array<{ minX: number; minY: number; maxX: number; maxY: number }>
  /**
   * Device type -> the exact block definition name available in the target drawing, resolved by the
   * caller from `block.list` (see `resolvePcccBlocks`). Without it nothing is drawn for that type and
   * the plan fails closed, instead of substituting hand-drawn shapes.
   */
  blockNames?: PcccBlockAssignment
}

/**
 * 1-Shot Automated Fire Alarm Planner with Structural Beam Highway Routing.
 * Completely eliminates manual coordinate guessing, spiderweb crossing, and elevator shaft collisions.
 */
export function planHighwayFireAlarm(input: HighwayFireAlarmPlannerInput): FireAlarmFullPlanResult {
  const layerDevices = input.layerDevices ?? 'FA-DEVICES'
  const layerWiring = input.layerWiring ?? 'FA-WIRING'
  const layerText = input.layerText ?? 'FA-TEXT'
  const scale = input.symbolScale ?? 1.0

  // 1. Collect all forbidden polygons: elevator shafts, stairwells, ramps, and voids
  const allForbiddenPolygons: Point2D[][] = [...(input.elevatorShafts ?? [])]
  const elevatorShaftsForLayout: Point2D[][] = [...(input.elevatorShafts ?? [])]

  if (input.rooms) {
    for (const r of input.rooms) {
      const name = r.name || ''
      const isLobby = /s[aả]nh|lobby|corridor/i.test(name)
      const isElevator =
        r.usage === 'elevator' ||
        (!isLobby && /(h[oố]\s*)?thang\s*m[aá]y|elevator(\s*shaft)?/i.test(name))
      const isStair =
        r.usage === 'stairwell' ||
        (!isLobby && /thang\s*b[oộ]|bu[oồ]ng\s*thang|stair(well)?|tho[aá]t\s*hi[eể]m/i.test(name))
      const isRamp =
        r.usage === 'ramp' ||
        /ram(\s*d[oố]c)?|d[oố]c(\s*xe)?|car\s*ramp/i.test(name)
      const isVoid =
        r.usage === 'void' ||
        /th[oô]ng\s*t[aầ]ng|\bvoid\b/i.test(name)

      const isForbidden = isElevator || isStair || isRamp || isVoid

      if (r.boundary && r.boundary.length >= 3) {
        if (isElevator) elevatorShaftsForLayout.push(r.boundary)
        if (isForbidden) allForbiddenPolygons.push(r.boundary)
      }
      if (r.excludedBoundaries) {
        for (const eb of r.excludedBoundaries) {
          if (eb && eb.length >= 3) {
            allForbiddenPolygons.push(eb)
          }
        }
      }
    }
  }

  // Derive forbidden zones (bounding boxes) for wire routing and device avoidance around shafts, stairs, ramps
  const derivedForbiddenZones: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = []
  for (const poly of allForbiddenPolygons) {
    if (!poly || poly.length === 0) continue
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const [x, y] of poly) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    derivedForbiddenZones.push({ minX, minY, maxX, maxY })
  }

  const forbiddenZones = input.forbiddenZones
    ? [...input.forbiddenZones, ...derivedForbiddenZones]
    : derivedForbiddenZones

  // Beam axes come from the caller (read off the drawing's grid), never from the shaft boxes: an axis
  // at `minY-1000` is a polyline vertex that follows no structural element, yet it used to be drawn
  // and reported as a clean route. Without a real axis a long span is refused (NO_STRUCTURAL_HIGHWAY).
  const beamYHighways = input.beamYHighways ?? []
  const beamXHighways = input.beamXHighways ?? []

  // Generate compliant sensor layout with all forbidden zones registered for exclusion
  const layout = generateFireAlarmLayout({
    ...input,
    elevatorShafts: elevatorShaftsForLayout,
    forbiddenZones
  })
  const routes: FireAlarmRouteResult[] = []
  const cadOperations: CadOperation[] = []
  const violations = [...layout.violations]

  // 2. Route each zone along the structural beam highway (Strictly Daisy-Chain, No elevator crossing)
  for (const zone of layout.zones) {
    const zoneDevices = layout.devices.filter((d) => d.zoneId === zone.zoneId)
    if (zoneDevices.length === 0) continue

    const route = routeStructuralHighway({
      zoneId: zone.zoneId,
      devices: zoneDevices,
      startDeviceId: zoneDevices.find((d) => d.type === 'JUNCTION_BOX')?.id,
      beamYHighways,
      beamXHighways,
      forbiddenZones,
      layerWiring,
      insUnits: input.insUnits
    })

    routes.push(route)
    violations.push(...route.violations)

    // Append wire polyline operations
    for (const op of route.cadOperations) {
      cadOperations.push(op)
    }
  }

  // 2b. The end-of-line resistor is a device the schedule has to list, not decoration the symbol
  // compiler draws on the side. Making it a record keeps `deviceCounts` equal, 1:1, to the block
  // references actually sent to AutoCAD. Before this it was drawn as an extra block — or, when the
  // drawing had no resistor symbol, silently as a second copy of the detector's own symbol — while
  // its count stayed 0. That is how a legend prints "09" over a sheet carrying 8.
  for (const zone of layout.zones) {
    const terminal = layout.devices.find(
      (d) => d.zoneId === zone.zoneId && d.isEndOfLine && d.type !== 'END_OF_LINE_RESISTOR'
    )
    if (!terminal) continue
    layout.devices.push({
      id: `${zone.zoneId}_EOL`,
      type: 'END_OF_LINE_RESISTOR',
      x: Math.round(terminal.x + 450 * scale),
      y: Math.round(terminal.y + 200 * scale),
      zoneId: zone.zoneId,
      // Names the circuit it terminates. A fixed "EOL-4.7k" repeated once per zone put identical
      // text on the sheet, so nothing said which line ended where.
      label: `EOL-${terminal.label}`
    })
    layout.deviceCounts.END_OF_LINE_RESISTOR++
  }

  // 3. Compile the library symbol for every device; an unresolved type fails the plan closed.
  // Label offsets/heights are physical millimetres scaled to drawing units (E8):
  // unitsPerMm is non-null whenever devices exist — the layout already failed closed
  // on unknown units, so a missing value here means "no devices", never "assume mm".
  const unitsPerMm = unitsPerMmFor(input.insUnits)
  const unresolvable = new Set<string>()
  if (unitsPerMm !== null) {
    for (const dev of layout.devices) {
      const devOps = compilePcccDeviceCadEntities(dev, {
        blockNames: input.blockNames,
        layerDevices,
        layerText,
        scale,
        unitsPerMm
      })
      if (devOps.length === 0) unresolvable.add(dev.type)
      cadOperations.push(...devOps)
    }
  }
  for (const deviceType of [...unresolvable].sort()) {
    violations.push(
      `MISSING_SYMBOL:${deviceType} — no block definition in this drawing matches that device type; import the standard symbol library and retry.`
    )
  }

  let totalWireM = 0
  for (const r of routes) totalWireM += r.totalLengthM

  return {
    status:
      violations.length === 0
        ? 'PASS'
        : layout.status === 'INSUFFICIENT_DATA'
          ? 'INSUFFICIENT_DATA'
          : 'FAIL',
    layout,
    routes,
    totalDevices: layout.devices.length,
    totalWireLengthM: Math.round(totalWireM * 10) / 10,
    cadOperations,
    violations
  }
}
