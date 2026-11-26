import { describe, expect, it } from 'bun:test'
import {
  sequenceDaisyChain,
  routeFireAlarmLoop,
  routeStructuralHighway,
  resolvePcccBlocks,
  compilePcccDeviceCadEntities,
  type Point2D,
  type FireAlarmRoomInput,
  type FireAlarmDevice,
  type FireAlarmDeviceType
} from '../src/index'
import { generateFireAlarmLayout, classifyRoomSensor } from '../src/pccc/fire-alarm-layout.js'
import { planHighwayFireAlarm } from '../src/pccc/fire-alarm-planner.js'

describe('PCCC Fire Alarm Design & Routing (TCVN 7568-14:2025)', () => {
  const basementGarage: FireAlarmRoomInput = {
    id: 'room_garage',
    name: 'Bãi đỗ xe hầm',
    usage: 'garage',
    boundary: [
      [10000, 100000],
      [28000, 100000],
      [28000, 112000],
      [10000, 112000]
    ]
  }

  const technicalRoom: FireAlarmRoomInput = {
    id: 'room_pump',
    name: 'Phòng bơm PCCC',
    usage: 'pump_room',
    boundary: [
      [18000, 112000],
      [28000, 112000],
      [28000, 118000],
      [18000, 118000]
    ]
  }

  const LIBRARY = resolvePcccBlocks([
    'DAU BAO KHOI',
    'DAU BAO NHIET',
    'NUT NHAN KHAN CAP',
    'CHUONG BAO CHAY',
    'BOX NOI DAY FA',
    'DIEN_TRO'
  ])

  const elevatorShaft: Point2D[] = [
    [16500, 109800],
    [20500, 109800],
    [20500, 113500],
    [16500, 113500]
  ]

  it('classifies parking space as a heat detector and technical space as a smoke detector', () => {
    expect(classifyRoomSensor('garage').deviceType).toBe('HEAT_DETECTOR')
    expect(classifyRoomSensor('electrical').deviceType).toBe('SMOKE_DETECTOR')
  })

  it('quotes spacing and reach from TCVN 7568-14:2025, which superseded TCVN 5738:2021', () => {
    // 5738:2021 was cancelled by 7568-14:2025 (Lời nói đầu), and the 2025 text states point-detector
    // placement as distances, not as an m² quota per detector. Pinning the clause it came from is
    // what let a cancelled standard keep driving placements.
    for (const usage of ['garage', 'electrical'] as const) {
      const criteria = classifyRoomSensor(usage)
      expect(criteria.standardRef).toContain('TCVN 7568-14:2025')
      // The two clause limits are only satisfiable together if the grid pitch respects the reach:
      // the worst-covered point of a cell sits pitch/sqrt(2) from its centre. 7568-14's own round
      // figures (10,2 m spacing, 7,2 m reach) sit 18 mm the wrong way round, which is exactly why
      // the pitch is derived from the reach and never taken from spacing alone.
      expect(criteria.maxSpacingMm).toBeLessThanOrEqual(
        Math.round(criteria.maxReachMm * Math.SQRT2) + 50
      )
      expect(criteria.wallClearanceMaxMm).toBe(criteria.maxSpacingMm / 2)
    }
  })

  it('leaves no protected ceiling point beyond the clause reach in an open garage', () => {
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [basementGarage],
      junctionBoxLocation: [11000, 101000]
    })
    const heat = layout.devices.filter((d) => d.type === 'HEAT_DETECTOR')
    const reach = classifyRoomSensor('garage').maxReachMm
    expect(heat.length).toBeGreaterThan(0)
    // Sample the whole floor rather than trusting the pitch: the clause is about every point.
    for (let x = 10250; x <= 27750; x += 250) {
      for (let y = 100250; y <= 111750; y += 250) {
        const nearest = Math.min(...heat.map((d) => Math.hypot(d.x - x, d.y - y)))
        expect(nearest <= reach).toBe(true)
      }
    }
  })

  it('covers the ceiling a shaft displaces detectors from, instead of leaving a blind patch', () => {
    // The old planner dropped every lattice cell that fell in or beside a shaft and never asked
    // whether the surviving detectors still reached that ceiling: the schedule counted devices while
    // a strip of the room monitored nothing.
    const shaft: Point2D[] = [
      [10000, 6000],
      [14000, 6000],
      [14000, 12000],
      [10000, 12000]
    ]
    const wideGarage: FireAlarmRoomInput = {
      id: 'room_wide',
      name: 'Gara ô to khu A',
      usage: 'garage',
      boundary: [
        [0, 0],
        [24000, 0],
        [24000, 18000],
        [0, 18000]
      ]
    }
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [wideGarage],
      elevatorShafts: [shaft],
      junctionBoxLocation: [1000, 1000]
    })
    expect(layout.violations).toEqual([])
    const heat = layout.devices.filter((d) => d.type === 'HEAT_DETECTOR')
    const reach = classifyRoomSensor('garage').maxReachMm

    for (const d of heat) {
      // No repair may stand inside the shaft's clearance band.
      const inBand =
        d.x > 8800 &&
        d.x < 15200 &&
        d.y > 4800 &&
        d.y < 13200 &&
        !(d.x < 10000 || d.x > 14000 || d.y < 6000 || d.y > 12000)
      expect(inBand).toBe(false)
    }
    for (let x = 250; x <= 23750; x += 250) {
      for (let y = 250; y <= 17750; y += 250) {
        if (x > 10000 && x < 14000 && y > 6000 && y < 12000) continue // the shaft itself
        const nearest = Math.min(...heat.map((d) => Math.hypot(d.x - x, d.y - y)))
        expect(nearest <= reach).toBe(true)
      }
    }
  })

  it('refuses rather than fakes coverage when no legal position can reach the ceiling', () => {
    // A room this small around a shaft leaves nowhere to stand: every point is inside the shaft or
    // its clearance band. Reporting that is the only honest outcome — a silent empty room would
    // still hand back a schedule that reads as designed.
    const cramped: FireAlarmRoomInput = {
      id: 'room_cramped',
      name: 'Khe hep giua gieng',
      usage: 'garage',
      boundary: [
        [0, 0],
        [3000, 0],
        [3000, 3000],
        [0, 3000]
      ]
    }
    const shaft: Point2D[] = [
      [1000, 1000],
      [2000, 1000],
      [2000, 2000],
      [1000, 2000]
    ]
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [cramped],
      elevatorShafts: [shaft],
      junctionBoxLocation: [1000, 1000]
    })
    expect(layout.status).toBe('FAIL')
    expect(layout.violations.some((v) => v.startsWith('UNCOVERED_CEILING'))).toBe(true)
    expect(layout.devices.filter((d) => d.type === 'HEAT_DETECTOR')).toHaveLength(0)
  })

  it('generates layout with distinct zones and avoids elevator shaft', () => {
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom],
      elevatorShafts: [elevatorShaft],
      junctionBoxLocation: [11000, 101000],
      stairDoors: [{ doorPoint: [11000, 108000], stairName: 'Thang bộ thoát hiểm 1' }]
    })

    expect(layout.status).toBe('PASS')
    expect(layout.devices.length).toBeGreaterThan(0)
    expect(layout.deviceCounts.HEAT_DETECTOR).toBeGreaterThan(0)
    expect(layout.deviceCounts.SMOKE_DETECTOR).toBeGreaterThan(0)
    expect(layout.deviceCounts.MANUAL_CALL_POINT).toBe(1)
    expect(layout.deviceCounts.JUNCTION_BOX).toBe(1)

    // Ensure no detector falls inside the elevator shaft
    for (const d of layout.devices) {
      const inElevator = d.x >= 16500 && d.x <= 20500 && d.y >= 109800 && d.y <= 113500
      expect(inElevator).toBe(false)
    }
  })

  it('sequences devices into a non-branching daisy chain terminating at EOLR', () => {
    const sampleDevices: FireAlarmDevice[] = [
      { id: 'JB', type: 'JUNCTION_BOX', x: 10000, y: 100000, zoneId: 'Z1', label: 'JB' },
      { id: 'D1', type: 'HEAT_DETECTOR', x: 15000, y: 100000, zoneId: 'Z1', label: 'D1' },
      { id: 'D2', type: 'HEAT_DETECTOR', x: 20000, y: 100000, zoneId: 'Z1', label: 'D2' },
      { id: 'D3', type: 'HEAT_DETECTOR', x: 20000, y: 106000, zoneId: 'Z1', label: 'D3' },
      { id: 'D4', type: 'HEAT_DETECTOR', x: 15000, y: 106000, zoneId: 'Z1', label: 'D4' }
    ]

    const sequenced = sequenceDaisyChain(sampleDevices, 'JB')
    expect(sequenced[0].id).toBe('JB')
    expect(sequenced.length).toBe(5)
    expect(sequenced[sequenced.length - 1].isEndOfLine).toBe(true)

    const route = routeFireAlarmLoop({
      zoneId: 'Z1',
      devices: sampleDevices,
      startDeviceId: 'JB',
      insUnits: 'mm'
    })

    expect(route.status).toBe('PASS')
    expect(route.segments.length).toBe(4) // 5 devices -> exactly 4 connecting segments (No T-taps!)
    expect(route.cadOperations.length).toBe(4)
    expect(route.cadOperations[0].entity.kind).toBe('polyline')
    // The plugin deserializes a point as {x,y,z}; the [x,y] tuple emitted before aborted the whole
    // batch on a real AutoCAD. `color` is not a per-entity create input, so it is not claimed here.
    expect(route.cadOperations[0].entity.points[0]).toEqual({ x: 10000, y: 100000, z: 0 })
  })

  it('structural highway router strictly avoids elevator shaft void', () => {
    const testDevices: FireAlarmDevice[] = [
      { id: 'DEV_WEST', type: 'HEAT_DETECTOR', x: 15000, y: 112000, zoneId: 'Z1', label: 'D_W' },
      { id: 'DEV_EAST', type: 'HEAT_DETECTOR', x: 22000, y: 112000, zoneId: 'Z1', label: 'D_E' }
    ]

    const route = routeStructuralHighway({
      insUnits: 'mm',
      zoneId: 'Z1',
      devices: testDevices,
      beamYHighways: [105500, 117000],
      forbiddenZones: [{ minX: 16500, minY: 109800, maxX: 20500, maxY: 113500 }]
    })

    expect(route.status).toBe('PASS')
    expect(route.segments.length).toBe(1)
    const points = route.segments[0].points

    // Verify that NO horizontal segment passes through Y in [109800, 113500] across the elevator X range
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i]
      const p2 = points[i + 1]
      if (p1[1] === p2[1]) {
        const segY = p1[1]
        const minX = Math.min(p1[0], p2[0])
        const maxX = Math.max(p1[0], p2[0])
        if (segY >= 109800 && segY <= 113500) {
          const overlapsElevatorX = maxX > 16500 && minX < 20500
          expect(overlapsElevatorX).toBe(false)
        }
      }
    }
  })

  it('refuses a long span instead of inventing a beam axis nobody drew', () => {
    // With no supplied grid, the router used to synthesise axes at shaft.minY-1000 / shaft.maxY+1000
    // (and, with no shafts at all, the midpoint of the two devices) and report a clean PASS. Those Y
    // values follow no structural element yet were committed to the sheet as wire, so an unroutable
    // circuit looked routed and the only trace of the problem was a run floating in the slab.
    const shaft = [{ minX: 8000, minY: 6000, maxX: 12000, maxY: 12000 }]
    const farApart: FireAlarmDevice[] = [
      { id: 'DEV_W', type: 'HEAT_DETECTOR', x: 1000, y: 9000, zoneId: 'Z1', label: 'D_W' },
      { id: 'DEV_E', type: 'HEAT_DETECTOR', x: 19000, y: 9000, zoneId: 'Z1', label: 'D_E' }
    ]

    const route = routeStructuralHighway({
      insUnits: 'mm',
      zoneId: 'Z1',
      devices: farApart,
      forbiddenZones: shaft
    })

    expect(route.status).toBe('FAIL')
    expect(route.violations.some((v) => v.startsWith('NO_STRUCTURAL_HIGHWAY'))).toBe(true)
    // Nothing at all is emitted for the span it could not route.
    expect(route.cadOperations).toHaveLength(0)
    expect(route.segments).toHaveLength(0)

    // The same span routes once a real axis is supplied, and every vertex that goes around the shaft
    // uses that axis — never the shaft box offset the router used to invent.
    const routed = routeStructuralHighway({
      insUnits: 'mm',
      zoneId: 'Z1',
      devices: farApart,
      beamYHighways: [4000],
      forbiddenZones: shaft
    })
    expect(routed.status).toBe('PASS')
    const allPoints = routed.segments.flatMap((s) => s.points)
    expect(allPoints.filter((p) => p[1] === 4000).length).toBeGreaterThan(0)
    for (const p of allPoints) {
      expect(p[1]).not.toBe(5000) // shaft.minY - 1000
      expect(p[1]).not.toBe(13000) // shaft.maxY + 1000
    }
  })

  it('routes a vertical span along a supplied vertical beam axis (regression: only horizontal axes were tried)', () => {
    // Two devices stacked vertically with a shaft blocking the direct line between them. No
    // horizontal axis can carry a vertical span without a fabricated horizontal leg, so before this
    // fix the span failed NO_STRUCTURAL_HIGHWAY even though a real vertical beam carried it.
    const devices: FireAlarmDevice[] = [
      { id: 'A', type: 'HEAT_DETECTOR', x: 16000, y: 100000, zoneId: 'Z1', label: 'A' },
      { id: 'B', type: 'HEAT_DETECTOR', x: 16000, y: 130000, zoneId: 'Z1', label: 'B' }
    ]
    const forbidden = [{ minX: 15000, minY: 110000, maxX: 17000, maxY: 120000 }]

    const noX = routeStructuralHighway({
      insUnits: 'mm',
      zoneId: 'Z1',
      devices,
      forbiddenZones: forbidden
    })
    expect(noX.status).toBe('FAIL')
    expect(noX.violations.some((v) => v.startsWith('NO_STRUCTURAL_HIGHWAY'))).toBe(true)

    const withX = routeStructuralHighway({
      insUnits: 'mm',
      zoneId: 'Z1',
      devices,
      beamXHighways: [12000],
      forbiddenZones: forbidden
    })
    expect(withX.status).toBe('PASS')
    expect(withX.segments).toHaveLength(1)
    // The trunk run lies on the supplied vertical axis (constant X = 12000), never a fabricated one.
    const points = withX.segments[0]!.points
    expect(points.filter((p) => p[0] === 12000).length).toBeGreaterThan(0)
    for (const p of points) {
      expect(p[0]).not.toBe(14000) // shaft.minX - 1000, the invented line the router must not draw
      expect(p[0]).not.toBe(18000) // shaft.maxX + 1000
    }
  })

  it('keeps the drawn symbol inside the room: a 400 mm-radius detector never prints across the wall', () => {
    // The clause wall-clearance floor is 300 mm, but a point detector is a 400 mm-radius circle, so a
    // centre at the clause minimum prints the graphic across the wall (the SUNLAND overhang). With a
    // caller-tightened pitch that would otherwise place a column at 300 mm, the symbol-radius inset
    // pushes the nearest detector out to the symbol radius; at a tiny symbol scale the clause floor
    // governs and the 300 mm column stays.
    const room: FireAlarmRoomInput = {
      id: 'r',
      name: 'R',
      usage: 'garage',
      boundary: [[0, 0], [14400, 0], [14400, 14400], [0, 14400]]
    }
    const full = generateFireAlarmLayout({
      rooms: [room],
      insUnits: 'mm',
      junctionBoxLocation: [7200, 7200],
      symbolScale: 1,
      maxHeatSpacingMm: 600
    })
    expect(full.status).toBe('PASS')
    const fullMinX = Math.min(...full.devices.filter((d) => d.type === 'HEAT_DETECTOR').map((d) => d.x))
    expect(fullMinX).toBeGreaterThanOrEqual(400) // symbol radius, not the 300 mm clause floor

    const tiny = generateFireAlarmLayout({
      rooms: [room],
      insUnits: 'mm',
      junctionBoxLocation: [7200, 7200],
      symbolScale: 0.1,
      maxHeatSpacingMm: 600
    })
    expect(tiny.status).toBe('PASS')
    const tinyMinX = Math.min(...tiny.devices.filter((d) => d.type === 'HEAT_DETECTOR').map((d) => d.x))
    expect(tinyMinX).toBeLessThan(fullMinX) // a small symbol may sit at the clause floor
  })

  it('covers a narrow arm at the clause floor rather than leaving it uncovered (symbol inset fallback)', () => {
    // A 700 mm-wide arm cannot hold a 400 mm-radius symbol anywhere (max inscribed half-width 350 mm
    // < the 400 mm inset), so a hard symbol-radius inset would drop every arm cell and report
    // UNCOVERED_CEILING. Coverage outranks a small overhang: the repair pass falls back to the clause
    // floor (300 mm) and the arm stays protected.
    const lShape: Point2D[] = [
      [0, 0],
      [14400, 0],
      [14400, 2400],
      [700, 2400],
      [700, 14400],
      [0, 14400]
    ]
    const res = generateFireAlarmLayout({
      rooms: [{ id: 'r', name: 'L', usage: 'garage', boundary: lShape }],
      insUnits: 'mm',
      junctionBoxLocation: [7200, 1200],
      symbolScale: 1
    })
    expect(res.status).toBe('PASS')
    expect(res.violations).toEqual([])
    const arm = res.devices.filter((d) => d.type === 'HEAT_DETECTOR' && d.x < 700 && d.y > 2400)
    expect(arm.length).toBeGreaterThan(0)
    // Placed at the clause floor, not the 400 mm symbol inset the arm cannot satisfy.
    expect(Math.min(...arm.map((d) => d.x))).toBeLessThan(400)
  })

  it('resolves every device type onto block definitions that actually exist in the library', () => {
    const resolution = resolvePcccBlocks([
      'DAU BAO KHOI',
      'DAU BAO NHIET',
      'NUT NHAN KHAN CAP',
      'CHUONG BAO CHAY',
      'BOX NOI DAY FA',
      'DIEN_TRO',
      'COT_DIEN'
    ])
    expect(resolution.missing).toEqual([])
    expect(resolution.blocks.SMOKE_DETECTOR).toBe('DAU BAO KHOI')
    expect(resolution.blocks.HEAT_DETECTOR).toBe('DAU BAO NHIET')
    expect(resolution.blocks.MANUAL_CALL_POINT).toBe('NUT NHAN KHAN CAP')
    expect(resolution.blocks.COMBINATION_ALARM).toBe('CHUONG BAO CHAY')
    expect(resolution.blocks.JUNCTION_BOX).toBe('BOX NOI DAY FA')
    expect(resolution.blocks.END_OF_LINE_RESISTOR).toBe('DIEN_TRO')
  })

  it('names the device types a library is missing instead of inventing a symbol for them', () => {
    const resolution = resolvePcccBlocks(['DAU BAO KHOI', 'DIEN_TRO'])
    expect(resolution.blocks.SMOKE_DETECTOR).toBe('DAU BAO KHOI')
    const expectedMissing: FireAlarmDeviceType[] = [
      'COMBINATION_ALARM',
      'HEAT_DETECTOR',
      'JUNCTION_BOX',
      'MANUAL_CALL_POINT'
    ]
    expect(resolution.missing.sort()).toEqual(expectedMissing.sort())
  })

  it('matches diacritic and separator variants of a block name, like the spatial fold does', () => {
    const resolution = resolvePcccBlocks(['ĐÈN BÁO CHÁY', 'HỘP NỐI DÂY', 'ĐẦU BÁO KHÓI'])
    expect(resolution.blocks.SMOKE_DETECTOR).toBe('ĐẦU BÁO KHÓI')
    expect(resolution.blocks.JUNCTION_BOX).toBe('HỘP NỐI DÂY')
  })

  it('draws every device as its library block reference, with no hand-drawn substitute geometry', () => {
    const libraryBlocks = resolvePcccBlocks([
      'DAU BAO KHOI',
      'DAU BAO NHIET',
      'NUT NHAN KHAN CAP',
      'CHUONG BAO CHAY',
      'BOX NOI DAY FA',
      'DIEN_TRO'
    ])

    const fullPlan = planHighwayFireAlarm({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom],
      elevatorShafts: [elevatorShaft],
      junctionBoxLocation: [11000, 101000],
      stairDoors: [{ doorPoint: [11000, 108000], stairName: 'Thang 1' }],
      beamYHighways: [105500, 117000],
      blockNames: libraryBlocks.blocks
    })

    expect(fullPlan.status).toBe('PASS')
    expect(fullPlan.violations).toEqual([])
    expect(fullPlan.totalDevices).toBeGreaterThan(0)
    expect(fullPlan.totalWireLengthM).toBeGreaterThan(0)

    const kinds = new Set(fullPlan.cadOperations.map((op) => op.entity.kind))
    // One block reference per device, wires, and the tag text — and nothing else: no circle/line
    // stand-in symbols, which is exactly the "white symbol set" defect. Equality against the allowed
    // set is the assertion; a hand-drawn `circle` is not representable in the planner's operation
    // type at all, so checking for one by name would not compile.
    expect(kinds).toEqual(new Set(['blockReference', 'polyline', 'text.singleLine']))

    const blockNames = new Set(
      fullPlan.cadOperations
        .filter((op) => op.entity.kind === 'blockReference')
        .map((op) => op.entity.blockName as string)
    )
    for (const name of blockNames) {
      expect(libraryBlocks.available).toContain(name)
    }
    expect(blockNames.size).toBeGreaterThan(1)
  })

  it('schedules exactly what it draws: every block reference has a counted device', () => {
    // The reported defect: a legend printed "09" đầu báo nhiệt over a sheet that carried 8, and the
    // end-of-line resistor was drawn as an extra block that appeared nowhere in the counts (or, with
    // no resistor symbol present, as a second copy of the detector's own symbol). `deviceCounts` is
    // what a schedule is built from, so it must equal the block references that go to AutoCAD.
    const plan = planHighwayFireAlarm({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom],
      elevatorShafts: [elevatorShaft],
      junctionBoxLocation: [11000, 101000],
      stairDoors: [{ doorPoint: [11000, 108000], stairName: 'Thang 1' }],
      beamYHighways: [105500, 117000],
      blockNames: LIBRARY.blocks
    })
    expect(plan.status).toBe('PASS')

    const drawn = plan.cadOperations.filter((op) => op.entity.kind === 'blockReference')
    const scheduled = Object.values(plan.layout.deviceCounts).reduce((a, b) => a + b, 0)
    expect(drawn.length).toBe(scheduled)
    expect(plan.totalDevices).toBe(scheduled)

    // The resistor is a listed device, not a side effect of compiling its neighbour.
    const resistors = plan.layout.devices.filter((d) => d.type === 'END_OF_LINE_RESISTOR')
    expect(resistors).toHaveLength(plan.routes.filter((r) => r.status === 'PASS').length)
    expect(plan.layout.deviceCounts.END_OF_LINE_RESISTOR).toBe(resistors.length)
    // Each one names the circuit it terminates: two zones carrying the same label put identical text
    // on the sheet, so nothing says which line ends where.
    for (const r of resistors) expect(r.label).toMatch(/^EOL-/)
    expect(new Set(resistors.map((r) => r.label)).size).toBe(resistors.length)
    expect(new Set(resistors.map((r) => r.id)).size).toBe(resistors.length)

    // Each device type resolves to one symbol, and no device draws a symbol another type owns.
    const drawnNames = new Set(drawn.map((op) => op.entity.blockName as string))
    for (const device of plan.layout.devices) {
      const symbol = LIBRARY.blocks[device.type]
      expect(symbol).toBeString()
      expect(drawnNames).toContain(symbol!)
    }
  })

  it('fails the plan closed when a device type has no block in the drawing', () => {
    const smokeOnly = planHighwayFireAlarm({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom],
      elevatorShafts: [elevatorShaft],
      junctionBoxLocation: [11000, 101000],
      blockNames: { SMOKE_DETECTOR: 'DAU BAO KHOI' }
    })

    expect(smokeOnly.status).toBe('FAIL')
    expect(smokeOnly.violations.some((v) => v.startsWith('MISSING_SYMBOL:HEAT_DETECTOR'))).toBe(
      true
    )

    // A heat detector was still laid out geometrically, but it produced no drawn entity: the plan
    // refuses to substitute a shape for a symbol it does not have.
    const drawnBlockNames = smokeOnly.cadOperations
      .filter((op) => op.entity.kind === 'blockReference')
      .map((op) => op.entity.blockName as string)
    expect(drawnBlockNames.length).toBeGreaterThan(0)
    expect(new Set(drawnBlockNames)).toEqual(new Set(['DAU BAO KHOI']))
    expect(smokeOnly.layout.devices.some((d) => d.type === 'HEAT_DETECTOR')).toBe(true)
  })

  it('automatically excludes elevator room from layout and wire paths even without manual elevatorShafts array', () => {
    const elevatorRoom: FireAlarmRoomInput = {
      id: 'room_lift',
      name: 'Thang máy',
      usage: 'elevator',
      boundary: [
        [16500, 109800],
        [20500, 109800],
        [20500, 113500],
        [16500, 113500]
      ]
    }

    const plan = planHighwayFireAlarm({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom, elevatorRoom],
      junctionBoxLocation: [11000, 101000],
      stairDoors: [{ doorPoint: [11000, 108000], stairName: 'Thang 1' }],
      blockNames: LIBRARY.blocks
    })

    expect(plan.status).toBe('PASS')
    // No device placed inside elevator room
    for (const d of plan.layout.devices) {
      const inLift = d.x >= 16500 && d.x <= 20500 && d.y >= 109800 && d.y <= 113500
      expect(inLift).toBe(false)
    }

    // No wire segment crossing through the elevator room
    for (const route of plan.routes) {
      for (const seg of route.segments) {
        for (let i = 0; i < seg.points.length - 1; i++) {
          const p1 = seg.points[i]
          const p2 = seg.points[i + 1]
          if (p1[1] === p2[1] && p1[1] >= 109800 && p1[1] <= 113500) {
            const minX = Math.min(p1[0], p2[0])
            const maxX = Math.max(p1[0], p2[0])
            const overlaps = maxX > 16500 && minX < 20500
            expect(overlaps).toBe(false)
          }
        }
      }
    }
  })

  it('E7: with no junction-box location the planner fails closed with NO_PANEL_ANCHOR and draws no junction box', () => {
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom],
      elevatorShafts: [elevatorShaft],
      stairDoors: [{ doorPoint: [11000, 108000], stairName: 'Thang bộ thoát hiểm 1' }]
    })

    expect(layout.status).toBe('FAIL')
    expect(layout.violations.some((v) => v.startsWith('NO_PANEL_ANCHOR'))).toBe(true)
    expect(layout.devices.some((d) => d.type === 'JUNCTION_BOX')).toBe(false)
    expect(layout.deviceCounts.JUNCTION_BOX).toBe(0)
    // The old fallback coordinates must not appear anywhere in the output.
    for (const d of layout.devices) {
      expect([d.x, d.y]).not.toEqual([17000, 110000])
    }
  })

  it('E7: NO_PANEL_ANCHOR names the real block candidates when the caller supplies them', () => {
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [basementGarage],
      junctionBoxCandidates: ['BOX NOI DAY FA', 'HỘP NỐI DÂY']
    })

    expect(layout.status).toBe('FAIL')
    const violation = layout.violations.find((v) => v.startsWith('NO_PANEL_ANCHOR'))
    expect(violation).toContain('BOX NOI DAY FA')
    expect(violation).toContain('HỘP NỐI DÂY')
  })

  it('E7: a supplied junction-box location is used verbatim, never shifted by an invented offset', () => {
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom],
      elevatorShafts: [elevatorShaft],
      junctionBoxLocation: [11000, 101000],
      stairDoors: [{ doorPoint: [11000, 108000], stairName: 'Thang bộ thoát hiểm 1' }]
    })

    expect(layout.status).toBe('PASS')
    const jb = layout.devices.find((d) => d.type === 'JUNCTION_BOX')
    expect(jb).toBeDefined()
    expect([jb!.x, jb!.y]).toEqual([11000, 101000])
  })

  it('E8: the same physical room measures the same area in mm and in metres', () => {
    const mmLayout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [basementGarage, technicalRoom],
      junctionBoxLocation: [11000, 101000]
    })
    const mGarage: FireAlarmRoomInput = {
      id: 'room_garage',
      name: 'Bãi đỗ xe hầm',
      usage: 'garage',
      boundary: [
        [10, 100],
        [28, 100],
        [28, 112],
        [10, 112]
      ]
    }
    const mPump: FireAlarmRoomInput = {
      id: 'room_pump',
      name: 'Phòng bơm PCCC',
      usage: 'pump_room',
      boundary: [
        [18, 112],
        [28, 112],
        [28, 118],
        [18, 118]
      ]
    }
    const mLayout = generateFireAlarmLayout({
      insUnits: 'm',
      rooms: [mGarage, mPump],
      junctionBoxLocation: [11, 101]
    })

    expect(mmLayout.status).toBe('PASS')
    expect(mLayout.status).toBe('PASS')
    expect(mLayout.totalProtectedAreaM2).toBe(mmLayout.totalProtectedAreaM2)
    expect(mLayout.totalProtectedAreaM2).toBe(276)
    expect(mLayout.deviceCounts.HEAT_DETECTOR).toBe(mmLayout.deviceCounts.HEAT_DETECTOR)
    expect(mLayout.deviceCounts.SMOKE_DETECTOR).toBe(mmLayout.deviceCounts.SMOKE_DETECTOR)
  })

  it('E8 follow-up: device labels sit 350 mm from the device in any drawing units', () => {
    // Regression test for unscaled label offsets: 350 mm is 350 drawing units in mm
    // but 0.35 in a metre drawing — the old code placed labels 350 m from the device.
    const device: FireAlarmDevice = {
      id: 'DEV_1',
      type: 'SMOKE_DETECTOR',
      x: 10000,
      y: 10000,
      zoneId: 'Z1',
      label: 'DB-K01'
    }
    const labelOf = (ops: ReturnType<typeof compilePcccDeviceCadEntities>) =>
      ops.find((op) => op.entity.kind === 'text.singleLine')
    const mmLabel = labelOf(
      compilePcccDeviceCadEntities(device, { blockNames: LIBRARY.blocks, unitsPerMm: 1 })
    )
    const mLabel = labelOf(
      compilePcccDeviceCadEntities(device, { blockNames: LIBRARY.blocks, unitsPerMm: 0.001 })
    )
    expect(mmLabel?.entity.insertion).toEqual({ x: 10350, y: 10350, z: 0 })
    expect(mmLabel?.entity.height).toBe(250)
    expect(mLabel?.entity.insertion).toEqual({ x: 10000.35, y: 10000.35, z: 0 })
    expect(mLabel?.entity.height).toBe(0.25)

    // An END_OF_LINE_RESISTOR device compiles its label with the same scaling.
    const eolDevice: FireAlarmDevice = {
      id: 'EOL_1',
      type: 'END_OF_LINE_RESISTOR',
      x: 10000.45,
      y: 10000.2,
      zoneId: 'Z1',
      label: 'EOL-DB-K01'
    }
    const eolOps = compilePcccDeviceCadEntities(eolDevice, {
      blockNames: LIBRARY.blocks,
      unitsPerMm: 0.001
    })
    const eolBlock = eolOps.find(
      (op) => op.entity.kind === 'blockReference' && op.entity.blockName === 'DIEN_TRO'
    )
    expect(eolBlock?.entity.position).toEqual({ x: 10000.45, y: 10000.2, z: 0 })
    const eolLabel = eolOps.find((op) => op.entity.kind === 'text.singleLine')
    expect(eolLabel?.entity.insertion).toEqual({
      x: 10000.8,
      y: 10000.55,
      z: 0
    })
    expect(eolLabel?.entity.height).toBe(0.25)
  })

  it('E8: unknown units block the layout with INSUFFICIENT_DATA instead of assuming mm', () => {
    const noUnits = generateFireAlarmLayout({ rooms: [basementGarage, technicalRoom] })
    expect(noUnits.status).toBe('INSUFFICIENT_DATA')
    expect(noUnits.devices).toHaveLength(0)
    expect(noUnits.violations.some((v) => v.includes('UNKNOWN_DRAWING_UNITS'))).toBe(true)

    const unitless = generateFireAlarmLayout({
      insUnits: 'unitless',
      rooms: [basementGarage, technicalRoom]
    })
    expect(unitless.status).toBe('INSUFFICIENT_DATA')
    expect(unitless.violations.some((v) => v.includes('UNKNOWN_DRAWING_UNITS'))).toBe(true)
  })

  it('E8: the highway detour around a shaft is 1 m in a metre drawing, not 1 km', () => {
    const testDevices: FireAlarmDevice[] = [
      { id: 'DEV_WEST', type: 'HEAT_DETECTOR', x: 1.5, y: 5, zoneId: 'Z1', label: 'D_W' },
      { id: 'DEV_EAST', type: 'HEAT_DETECTOR', x: 10.5, y: 5, zoneId: 'Z1', label: 'D_E' }
    ]
    const route = routeStructuralHighway({
      insUnits: 'm',
      zoneId: 'Z1',
      devices: testDevices,
      beamYHighways: [3],
      forbiddenZones: [{ minX: 4, minY: 4, maxX: 6, maxY: 6 }]
    })

    expect(route.status).toBe('PASS')
    expect(route.segments.length).toBe(1)
    const points = route.segments[0].points
    // The 1000 mm clearance detour is 1 drawing unit here; an unscaled 1000 would put
    // the wire kilometres from the shaft, yet read-back would still call it faithful.
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(12)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(10)
    }
    expect(route.totalLengthM).toBe(13)
  })

  it('E8: routeFireAlarmLoop reports metres from real units and blocks on unknown units', () => {
    const devices: FireAlarmDevice[] = [
      { id: 'JB', type: 'JUNCTION_BOX', x: 0, y: 0, zoneId: 'Z1', label: 'JB' },
      { id: 'D1', type: 'HEAT_DETECTOR', x: 3, y: 0, zoneId: 'Z1', label: 'D1' },
      { id: 'D2', type: 'HEAT_DETECTOR', x: 3, y: 4, zoneId: 'Z1', label: 'D2' }
    ]
    const metres = routeFireAlarmLoop({ zoneId: 'Z1', devices, startDeviceId: 'JB', insUnits: 'm' })
    expect(metres.status).toBe('PASS')
    expect(metres.totalLengthM).toBe(7)
    expect(metres.segments.map((s) => s.lengthM)).toEqual([3, 4])

    const noUnits = routeFireAlarmLoop({ zoneId: 'Z1', devices, startDeviceId: 'JB' })
    expect(noUnits.status).toBe('FAIL')
    expect(noUnits.cadOperations).toHaveLength(0)
    expect(noUnits.violations.some((v) => v.includes('UNKNOWN_DRAWING_UNITS'))).toBe(true)
  })

  it('E7: a junction box inside the shaft clearance is reported, not emitted', () => {
    const layout = generateFireAlarmLayout({
      insUnits: 'mm',
      rooms: [basementGarage],
      elevatorShafts: [elevatorShaft],
      junctionBoxLocation: [17000, 110000]
    })

    expect(layout.status).toBe('FAIL')
    expect(
      layout.violations.some((v) => v.includes('JUNCTION_BOX_TOO_CLOSE_TO_ELEVATOR_SHAFT'))
    ).toBe(true)
    expect(layout.devices.some((d) => d.type === 'JUNCTION_BOX')).toBe(false)
  })
})
