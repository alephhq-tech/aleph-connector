import { describe, expect, it } from 'bun:test'
import {
  extractSpatialModel,
  validatePlacement,
  validateBatch,
  checkAccessibility,
  checkDoorValidity,
  checkContainment,
  checkDoorSwing,
  checkSpaceAssignment,
  checkCirculation,
  checkObstacleCollision,
  deriveObstacles,
  suggestCorrections,
  extentsFromAabb,
  rotatedRect,
  ringsOverlap,
  pointInRing,
  areaOf,
  doorSweepPolygon,
  bulgeToArcPoints,
  minClearWidth,
  type SpatialRawEntity,
  type ProposedPlacement,
  type SpatialModel,
  type Space
} from '../src/index'
import { rect, polyline, block, wall, twoRoomScene } from './fixtures/spatial-entities'

/**
 * Deterministic architectural spatial tests. Every fixture carries REAL vertices (the shape the
 * wire actually delivers for `entity.list detail:"full"`), because the bug under test is precisely
 * that the extractor used to reason from axis-aligned boxes.
 *
 * Units: millimetres, Aleph drawing convention.
 */

const spaceOf = (model: SpatialModel, handle: string): Space =>
  model.spaces.find((s) => s.sourceHandles[0] === handle)!

describe('Spatial geometry kernel', () => {
  it('point-in-ring honours concavity, not the bounding box', () => {
    // L-shaped ring: the notch at (7000,7000) is inside the bbox but outside the polygon.
    const l: Array<[number, number]> = [
      [0, 0],
      [10000, 0],
      [10000, 4000],
      [4000, 4000],
      [4000, 10000],
      [0, 10000]
    ]
    expect(pointInRing([2000, 8000], l)).toBe(true)
    expect(pointInRing([7000, 7000], l)).toBe(false)
    expect(pointInRing([2000, 2000], l)).toBe(true)
  })

  it('shoelace area measures the real ring', () => {
    const l: Array<[number, number]> = [
      [0, 0],
      [10000, 0],
      [10000, 4000],
      [4000, 4000],
      [4000, 10000],
      [0, 10000]
    ]
    // 10000×10000 minus the 6000×6000 notch = 64e6 mm²
    expect(areaOf(l)).toBeCloseTo(64_000_000, 0)
  })

  it('rotated rectangles produce oriented footprints and invert back through their AABB', () => {
    const fp = rotatedRect([0, 0], 2000, 800, 90)
    // 90° turns the long edge vertical: its length is unchanged, its direction is not.
    const edgeLen = Math.hypot(fp[1]![0] - fp[0]![0], fp[1]![1] - fp[0]![1])
    expect(edgeLen).toBeCloseTo(2000, 6)
    expect(Math.abs(fp[1]![0] - fp[0]![0])).toBeLessThan(1e-9)

    const rotated = rotatedRect([5000, 5000], 2000, 800, 30)
    const xs = rotated.map((p) => p[0])
    const ys = rotated.map((p) => p[1])
    const aabbW = Math.max(...xs) - Math.min(...xs)
    const aabbH = Math.max(...ys) - Math.min(...ys)
    const [w, d] = extentsFromAabb(aabbW, aabbH, 30)
    expect(w).toBeCloseTo(2000, 3)
    expect(d).toBeCloseTo(800, 3)
  })

  it('overlap detection catches crossing rings that a centre-point test would miss', () => {
    // Two long strips crossing like an X: neither centre lies inside the other.
    const a = rotatedRect([0, 0], 2000, 100, 45)
    const b = rotatedRect([1400, 0], 2000, 100, -45)
    expect(pointInRing([0, 0], b)).toBe(false)
    expect(pointInRing([1400, 0], a)).toBe(false)
    expect(ringsOverlap(a, b)).toBe(true)
  })

  it('bulge tessellation turns an arc segment into extra vertices', () => {
    // bulge = 1 is a semicircle over the chord.
    const pts: Array<[number, number]> = [
      [0, 0],
      [1000, 0]
    ]
    const out = bulgeToArcPoints(pts, [1, 0], false, 8)
    expect(out.length).toBeGreaterThan(2)
    // Every tessellated vertex sits on the circle of radius 500 about (500,0).
    for (const p of out.slice(1, -1)) {
      expect(Math.abs(Math.hypot(p[0] - 500, p[1]) - 500)).toBeLessThan(1e-6)
    }
  })

  it('door sweep is a quarter disc of the clear width', () => {
    const sweep = doorSweepPolygon([0, 0], 900, 0, 90, 32)
    // π r² / 4 ≈ 636 173 mm²
    expect(areaOf(sweep)).toBeGreaterThan(620_000)
    expect(areaOf(sweep)).toBeLessThan(650_000)
  })
})

describe('Spatial extractor — real geometry, never fabricated', () => {
  it('reads the actual L-shaped boundary and its true area (case 7)', () => {
    const l: Array<[number, number]> = [
      [0, 0],
      [10000, 0],
      [10000, 4000],
      [4000, 4000],
      [4000, 10000],
      [0, 10000]
    ]
    const model = extractSpatialModel([polyline('rmL', 'A-ROOM-PHONG_KHACH', l)])
    const sp = spaceOf(model, 'rmL')
    expect(sp.boundary.length).toBe(6)
    expect(sp.areaM2).toBeCloseTo(64, 1) // 64 m², not the 100 m² a bbox would report
    expect(sp.confidence).toBe('high')
  })

  it('reports an unreadable boundary as insufficient data instead of inventing a rectangle (case 10)', () => {
    const model = extractSpatialModel([
      {
        handle: 'rmNoGeom',
        kind: 'polyline',
        layer: 'A-ROOM',
        bounds: { min: { x: 0, y: 0 }, max: { x: 5000, y: 5000 } }
      }
    ])
    expect(model.spaces.length).toBe(0)
    expect(model.insufficientData.find((i) => i.handle === 'rmNoGeom')).toBeDefined()
    expect(model.insufficientData.find((i) => i.handle === 'rmNoGeom')!.reason).toContain(
      'not fabricating'
    )
  })

  it('classifies indoor vs outdoor by topology, and a named courtyard stays a courtyard', () => {
    const model = extractSpatialModel([
      polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(6000, 0, 6000, 6000)),
      polyline('gardenBack', 'SAN_VUON', rect(0, 6000, 8000, 4000)),
      polyline('atrium', 'GIENG_TROI', rect(2000, 2000, 1500, 1500))
    ])
    expect(spaceOf(model, 'rmLiving').spaceType).toBe('indoor')
    expect(spaceOf(model, 'gardenBack').spaceType).toBe('outdoor')
    expect(spaceOf(model, 'gardenBack').usage).toBe('garden')
    expect(spaceOf(model, 'atrium').spaceType).toBe('courtyard')
    // The atrium is carved out of the living room's usable area.
    const living = spaceOf(model, 'rmLiving')
    expect(living.holes.length).toBe(1)
    expect(living.areaM2).toBeCloseTo(36 - 2.25, 1)
  })

  it('links a door to the two spaces whose boundary it actually sits on (case 9)', () => {
    const model = extractSpatialModel(twoRoomScene())
    const door = model.openings[0]!
    expect(door.hostWallHandle).toBe('wShared')
    expect(door.connectsSpaces.length).toBe(2)
    expect(new Set(door.connectsSpaces)).toEqual(
      new Set([spaceOf(model, 'rmLiving').id, spaceOf(model, 'rmBed').id])
    )
    expect(door.sweptArea).toBeDefined()
  })

  it('flags a door that sits on no wall', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM', rect(0, 0, 6000, 6000)),
      block('dStray', 'A-DOOR', 'DOOR_900', 3000, 3000, 900, 200) // middle of the room
    ])
    const findings = checkDoorValidity(model.openings[0]!, model)
    expect(findings.some((f) => f.code === 'DOOR_WITHOUT_HOST_WALL')).toBe(true)
  })

  it('gives furniture a real rotated footprint and assigns it to the containing space', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      block('sofa1', 'A-FURN', 'SOFA_3CHỖ', 2000, 1000, 2400, 900, 45)
    ])
    const sofa = model.furniture[0]!
    expect(sofa.kind).toBe('sofa')
    expect(sofa.assignedSpaceId).toBe(spaceOf(model, 'rm').id)
    expect(sofa.footprint.length).toBe(4)
    // A rotated footprint must not be axis-aligned: its edges are not parallel to the axes.
    const dx = sofa.footprint[1]![0] - sofa.footprint[0]![0]
    const dy = sofa.footprint[1]![1] - sofa.footprint[0]![1]
    expect(Math.abs(dx)).toBeGreaterThan(1)
    expect(Math.abs(dy)).toBeGreaterThan(1)
  })

  it('honours user space hints over layer guessing', () => {
    const model = extractSpatialModel([polyline('rmX', 'WEIRD_LAYER', rect(0, 0, 4000, 4000))], {
      spaceHints: [{ handle: 'rmX', usage: 'garden', spaceType: 'outdoor' }]
    })
    const sp = spaceOf(model, 'rmX')
    expect(sp.usage).toBe('garden')
    expect(sp.spaceType).toBe('outdoor')
    expect(sp.evidence.some((e) => e.source === 'user')).toBe(true)
  })

  it('converts units explicitly (case 16)', () => {
    const mm = extractSpatialModel([polyline('rm', 'A-ROOM', rect(0, 0, 5000, 4000))])
    const m = extractSpatialModel([polyline('rm', 'A-ROOM', rect(0, 0, 5, 4))], {
      unitsPerMetre: 1
    })
    expect(spaceOf(mm, 'rm').areaM2).toBeCloseTo(20, 1)
    expect(spaceOf(m, 'rm').areaM2).toBeCloseTo(20, 1)
  })

  it('reports an assumed unit basis instead of silently dropping rooms on inch drawings (#413 SS11.2)', () => {
    // The #413 SS11.1 native audit found real partner drawings declaring INSUNITS=1 (inches) while
    // their overlay sheets declare millimetres. A 1000x800 inch room is 25.4m x 20.3m = 516 m^2;
    // read as millimetres it is 0.8 m^2 - 645x (25.4^2) smaller - so the clutter gate under the 1 m^2
    // default deletes a real hall outright.
    const inchRoom = polyline('rmInch', 'A-ROOM', rect(0, 0, 1000, 800))

    const assumed = extractSpatialModel([inchRoom])
    expect(assumed.units).toEqual({ perMetre: 1000, declared: false })
    // The room is gone from spaces - that is the bug's visible shape.
    expect(assumed.spaces.find((sp) => sp.id === 'sp_rmInch')).toBeUndefined()
    // It must not be gone silently: the drop is recorded with the reason that caused it.
    expect(assumed.unclassifiedHandles).toContain('rmInch')
    expect(
      assumed.insufficientData.some((d) => d.handle === 'rmInch' && d.reason.includes('assumed'))
    ).toBe(true)

    const declared = extractSpatialModel([inchRoom], { unitsPerMetre: 39.3701 })
    expect(declared.units).toEqual({ perMetre: 39.3701, declared: true })
    const sp = declared.spaces.find((x) => x.id === 'sp_rmInch')!
    expect(sp).toBeDefined()
    expect(sp.areaM2).toBeCloseTo(516.13, 1)
    // Declaring units is the whole fix: no caveat, no lost room.
    expect(declared.insufficientData.filter((d) => d.handle === 'rmInch')).toHaveLength(0)
    // The factor itself is the claim worth pinning: an inch drawing read as millimetres is
    // 25.4^2 = 645x off in area, which is how a 516 m^2 hall becomes sub-clutter.
    const asMm = extractSpatialModel([polyline('rmBig', 'A-ROOM', rect(0, 0, 6000, 4000))])
    const asIn = extractSpatialModel([polyline('rmBig', 'A-ROOM', rect(0, 0, 6000, 4000))], {
      unitsPerMetre: 39.3701
    })
    const mmArea = asMm.spaces.find((x) => x.id === 'sp_rmBig')!.areaM2
    const inArea = asIn.spaces.find((x) => x.id === 'sp_rmBig')!.areaM2
    expect(inArea / mmArea).toBeCloseTo(25.4 * 25.4, 0)
  })

  it('classifies real Vietnamese layer names, diacritics and all', () => {
    // DWGs drawn by Vietnamese offices label layers with the words themselves, not ASCII tokens.
    // Folding ("TƯỜNG" → TUONG, "CỬA SỔ" → CUA_SO) is what makes those match.
    const model = extractSpatialModel([
      polyline('rmNgu', 'Phòng ngủ', rect(0, 0, 4000, 4000)),
      polyline('rmBep', 'BẾP', rect(4000, 0, 4000, 4000)),
      wall('w1', [4000, 0], [4000, 4000]),
      block('dDoor', 'Cửa đi', 'CỬA_ĐI_900', 4000, 2000, 900, 200),
      block('wWin', 'Cửa sổ', 'CUASO_1200', 2000, 4000, 1200, 200)
    ])
    expect(spaceOf(model, 'rmNgu').usage).toBe('bedroom')
    expect(spaceOf(model, 'rmBep').usage).toBe('kitchen')
    // The door block is recognised from its Vietnamese name and linked to the wall it sits on.
    const door = model.openings.find((o) => o.handle === 'dDoor')
    expect(door?.kind).toBe('door')
    expect(door?.hostWallHandle).toBe('w1')
    // A window is a window: "CỬA SỔ" must not be read as a door just because it contains "CỬA",
    // and it carries no swept area, so it cannot block a room or count as a way through.
    const win = model.openings.find((o) => o.handle === 'wWin')
    expect(win?.kind).toBe('window')
    expect(win?.sweptArea).toBeUndefined()
    expect(spaceOf(model, 'rmNgu').accessPoints).not.toContain('wWin')
  })
})

describe('Constraint engine — the failures the agent used to ship', () => {
  const scene = extractSpatialModel(twoRoomScene())
  const living = spaceOf(scene, 'rmLiving')
  const bed = spaceOf(scene, 'rmBed')
  const door = scene.openings[0]!

  it('case 1: a sofa in the door sweep is rejected', () => {
    const placement: ProposedPlacement = {
      id: 'SOFA01',
      kind: 'sofa',
      spaceId: living.id,
      // The hinge is at (6000,0) and the sweep runs from there; a sofa at (5600,900) sits in it.
      center: [5600, 900],
      width: 2400,
      depth: 900
    }
    const swing = checkDoorSwing(placement, door)
    expect(swing.code).toBe('DOOR_SWING_COLLISION')
    expect(swing.status).toBe('FAIL')
    expect(swing.entityIds).toContain('d1')

    const result = validatePlacement({ model: scene, placement })
    expect(result.status).toBe('FAIL')
    expect(result.findings.some((f) => f.code === 'DOOR_SWING_COLLISION')).toBe(true)
    expect(
      result.findings.find((f) => f.code === 'DOOR_SWING_COLLISION')!.suggestedCorrection
    ).toContain('d1')
  })

  it('case 1 (control): the same sofa away from the sweep passes', () => {
    const placement: ProposedPlacement = {
      id: 'SOFA02',
      kind: 'sofa',
      spaceId: living.id,
      center: [2000, 4500],
      width: 2400,
      depth: 900
    }
    const result = validatePlacement({ model: scene, placement })
    expect(result.status).toBe('PASS')
  })

  it('case 2: a door over intact wall / no wall is never a false success', () => {
    const stray = extractSpatialModel([
      polyline('rm', 'A-ROOM', rect(0, 0, 6000, 6000)),
      block('dX', 'A-DOOR', 'DOOR_900', 3000, 3000, 900, 200)
    ])
    const result = validateBatch({ model: stray, placements: [] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.some((f) => f.code === 'DOOR_WITHOUT_HOST_WALL')).toBe(true)
  })

  it('case 3: a garden dropped into a bedroom is an error', () => {
    const placement: ProposedPlacement = {
      id: 'GARDEN01',
      kind: 'garden',
      center: [8000, 3000], // inside the bedroom
      width: 2000,
      depth: 1500
    }
    const finding = checkSpaceAssignment(placement, scene)
    expect(finding.code).toBe('GARDEN_IN_INDOOR_ROOM')
    expect(finding.status).toBe('FAIL')
    expect(finding.entityIds).toContain(bed.id)
  })

  it('case 4: a courtyard garden inside the footprint is allowed', () => {
    const model = extractSpatialModel([
      polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('court', 'GIENG_TROI', rect(2000, 2000, 2000, 2000))
    ])
    const court = spaceOf(model, 'court')
    const placement: ProposedPlacement = {
      id: 'GARDEN02',
      kind: 'garden',
      spaceId: court.id,
      center: [3000, 3000],
      width: 1200,
      depth: 1200
    }
    const finding = checkSpaceAssignment(placement, model)
    expect(finding.status).toBe('PASS')
    expect(finding.code).toBe('GARDEN_ASSIGNED_OK')
  })

  it('case 5: a bedroom with no door path is reported inaccessible', () => {
    const model = extractSpatialModel([
      polyline('rmHall', 'A-ROOM-HANH_LANG', rect(0, 0, 6000, 2000)),
      polyline('rmSealed', 'A-ROOM-PHONG_NGU', rect(6000, 0, 5000, 6000))
    ])
    const { findings } = checkAccessibility(model)
    const sealed = findings.find((f) => f.code === 'ROOM_INACCESSIBLE')
    expect(sealed).toBeDefined()
    expect(sealed!.entityIds).toContain(spaceOf(model, 'rmSealed').id)
  })

  it('case 6: a bed parked in the corridor blocks circulation', () => {
    const model = extractSpatialModel([
      polyline('hall', 'A-ROOM-HANH_LANG', rect(0, 0, 8000, 1200)),
      polyline('bedrm', 'A-ROOM-PHONG_NGU', rect(0, 1200, 8000, 4000))
    ])
    const placement: ProposedPlacement = {
      id: 'BED01',
      kind: 'bed',
      center: [4000, 600],
      width: 2000,
      depth: 1200
    }
    const findings = checkCirculation([placement], model, 900)
    expect(findings.some((f) => f.code === 'CIRCULATION_BLOCKED')).toBe(true)
  })

  it('case 6 (control): no regulatory width is invented when none is supplied', () => {
    const findings = checkCirculation([], extractSpatialModel(twoRoomScene()), undefined)
    expect(findings[0]!.status).toBe('NOT_APPLICABLE')
  })

  it('case 7: containment uses the real polygon, so the L-notch is not usable floor', () => {
    const l: Array<[number, number]> = [
      [0, 0],
      [10000, 0],
      [10000, 4000],
      [4000, 4000],
      [4000, 10000],
      [0, 10000]
    ]
    const model = extractSpatialModel([polyline('rmL', 'A-ROOM-PHONG_KHACH', l)])
    const sp = spaceOf(model, 'rmL')
    const inNotch: ProposedPlacement = {
      id: 'DESK01',
      kind: 'desk',
      center: [7000, 7000],
      width: 1400,
      depth: 700
    }
    expect(checkContainment(inNotch, sp).code).toBe('FURNITURE_OUTSIDE_SPACE')
    const inLeg: ProposedPlacement = {
      id: 'DESK02',
      kind: 'desk',
      center: [2000, 7000],
      width: 1400,
      depth: 700
    }
    expect(checkContainment(inLeg, sp).status).toBe('PASS')
  })

  it('case 8: a rotated footprint collides where its centre does not', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM', rect(0, 0, 8000, 8000)),
      wall('wCol', [5000, 0], [5000, 8000])
    ])
    const sp = spaceOf(model, 'rm')
    // A 3000-long sofa angled across a column line: centre clear of x=5000, body not.
    const placement: ProposedPlacement = {
      id: 'SOFA03',
      kind: 'sofa',
      spaceId: sp.id,
      center: [3800, 4000],
      width: 3000,
      depth: 900,
      rotationDeg: 45
    }
    const fp =
      placement.footprint ?? rotatedRect(placement.center, placement.width, placement.depth, 45)
    const maxX = Math.max(...fp.map((p) => p[0]))
    expect(maxX).toBeGreaterThan(5000)
    const hits = checkContainment(placement, sp)
    expect(hits.status).toBe('PASS') // still inside the room
    const obstacle = checkObstacleCollision(placement, [
      { id: 'wCol', footprint: rect(4950, 0, 100, 8000) }
    ])
    expect(obstacle.some((f) => f.code === 'OBSTACLE_COLLISION')).toBe(true)
  })

  it('case 11: unclassifiable entities are reported, never silently dropped or redrawn', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM', rect(0, 0, 6000, 6000)),
      {
        handle: 'dim1',
        kind: 'linearDimension',
        layer: 'A-DIM',
        bounds: { min: { x: 0, y: 0 }, max: { x: 1000, y: 0 } }
      },
      { handle: 'unk1', kind: 'spline', layer: 'A-DETAIL' }
    ])
    expect(model.unclassifiedHandles).toEqual(['dim1', 'unk1'])
    // The room the extractor did understand is untouched.
    expect(model.spaces.length).toBe(1)
  })

  it('case 12: two placements valid alone are rejected as a batch', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      wall('wExt', [0, 2000], [0, 3500]),
      block('dExt', 'A-DOOR', 'DOOR_900', 0, 2750, 900, 200)
    ])
    const sp = spaceOf(model, 'rm')
    const a: ProposedPlacement = {
      id: 'SOFA_A',
      kind: 'sofa',
      spaceId: sp.id,
      center: [2000, 3000],
      width: 2400,
      depth: 900
    }
    const b: ProposedPlacement = {
      id: 'SOFA_B',
      kind: 'sofa',
      spaceId: sp.id,
      center: [2600, 3100],
      width: 2400,
      depth: 900
    }
    expect(validatePlacement({ model, placement: a }).status).toBe('PASS')
    expect(validatePlacement({ model, placement: b }).status).toBe('PASS')
    const batch = validateBatch({ model, placements: [a, b] })
    expect(batch.status).toBe('FAIL')
    const collision = batch.findings.find((f) => f.code === 'PLACEMENT_COLLISION')
    expect(collision).toBeDefined()
    expect(collision!.entityIds.sort()).toEqual(['SOFA_A', 'SOFA_B'])
  })

  it('INSUFFICIENT_DATA is returned instead of PASS when swing geometry is unknown', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM', rect(0, 0, 6000, 6000)),
      wall('w', [6000, 0], [6000, 6000])
    ])
    const doorNoSweep = { ...model.openings[0]!, sweptArea: undefined }
    const finding = checkDoorSwing(
      { id: 'X', kind: 'sofa', center: [5600, 900], width: 2400, depth: 900 },
      doorNoSweep
    )
    expect(finding.status).toBe('INSUFFICIENT_DATA')
  })
})

describe('Building footprint is real rings, never a convex hull', () => {
  it('a region in the notch of an L-shaped plan is outdoor, not swallowed by a hull', () => {
    // Two rooms form an L; the missing corner of their bounding box is open air. A convex hull of
    // the room vertices covers that corner, so the old code called anything in it "indoor".
    const model = extractSpatialModel([
      polyline('rmLegA', 'A-ROOM-PHONG_KHACH', rect(0, 0, 10000, 4000)),
      polyline('rmLegB', 'A-ROOM-PHONG_NGU', rect(0, 4000, 4000, 6000)),
      polyline('notch', 'A-DETAIL', rect(4000, 4000, 6000, 3000))
    ])
    expect(spaceOf(model, 'notch').spaceType).toBe('outdoor')
    expect(spaceOf(model, 'rmLegA').spaceType).toBe('indoor')
    expect(spaceOf(model, 'rmLegB').spaceType).toBe('indoor')
  })

  it('a ring nested inside another room is carved as a hole, not a separate plate', () => {
    const model = extractSpatialModel([
      polyline('rmOuter', 'A-ROOM-PHONG_KHACH', rect(0, 0, 10000, 10000)),
      polyline('rmInner', 'A-DETAIL', rect(3000, 3000, 3000, 3000))
    ])
    expect(spaceOf(model, 'rmInner').spaceType).toBe('courtyard')
  })

  it('the site records the building as its real rings', () => {
    const model = extractSpatialModel([
      polyline('site', 'RANH_THUA', rect(0, 0, 20000, 20000)),
      polyline('rmA', 'A-ROOM-PHONG_KHACH', rect(0, 0, 10000, 4000)),
      polyline('rmB', 'A-ROOM-PHONG_NGU', rect(0, 4000, 4000, 6000))
    ])
    expect(model.site?.buildingRings.length).toBe(2)
  })
})

describe('Circulation is measured free width, not a bounding box', () => {
  it('minClearWidth finds the pinch an L-corridor hides from a bbox', () => {
    // An L corridor: 8000 x 5200 overall, but one leg is only 700 wide.
    const l: Array<[number, number]> = [
      [0, 0],
      [8000, 0],
      [8000, 700],
      [1200, 700],
      [1200, 5200],
      [0, 5200]
    ]
    expect(minClearWidth(l)).toBeLessThan(900)
    expect(Math.min(8000, 5200)).toBeGreaterThan(900) // what the old bbox test compared
  })

  it('an L-corridor with a narrow leg fails a width the bbox would have passed', () => {
    const model = extractSpatialModel([
      {
        handle: 'hall',
        kind: 'polyline',
        layer: 'A-ROOM-HANH_LANG',
        geometry: {
          closed: true,
          vertices: [
            [0, 0],
            [8000, 0],
            [8000, 700],
            [1200, 700],
            [1200, 5200],
            [0, 5200]
          ].map(([x, y]) => ({ point: { x, y } }))
        },
        bounds: { min: { x: 0, y: 0 }, max: { x: 8000, y: 5200 } }
      }
    ])
    const findings = checkCirculation([], model, 900)
    const narrow = findings.find((f) => f.code === 'CIRCULATION_TOO_NARROW')
    expect(narrow).toBeDefined()
    expect(narrow!.measurements!.clearWidth).toBeLessThan(900)
  })
})

describe('Door hinge, sweep and wall-cut come from the drawing, not a guess', () => {
  /** A door block inserted at its BASE point (the hinge), as a real door library does. */
  const doorAtHinge = (
    handle: string,
    layer: string,
    name: string,
    hinge: [number, number],
    width: number,
    thickness: number,
    rotation = 0
  ): SpatialRawEntity => ({
    handle,
    kind: 'blockReference',
    layer,
    geometry: { name, position: { x: hinge[0], y: hinge[1] }, rotation },
    bounds: {
      min: { x: hinge[0] - thickness / 2, y: hinge[1] },
      max: { x: hinge[0] + thickness / 2, y: hinge[1] + width }
    }
  })

  it('reads the hinge from the block insertion point, not the wall end', () => {
    const model = extractSpatialModel([
      polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(6000, 0, 6000, 6000)),
      wall('wShared', [6000, 0], [6000, 6000]),
      doorAtHinge('d1', 'A-DOOR', 'DOOR_900', [6000, 3000], 900, 200)
    ])
    const door = model.openings[0]!
    expect(door.hingeSource).toBe('block-insertion')
    // The wall-endpoint guess would have picked (6000,6000) — 3 m from the real hinge.
    expect(door.hinge).toEqual([6000, 3000])
    expect(door.confidence).toBe('high')
  })

  it('falls back to the wall endpoint and says so, lowering confidence', () => {
    const model = extractSpatialModel(twoRoomScene())
    const door = model.openings[0]!
    expect(door.hingeSource).toBe('wall-endpoint')
    expect(door.confidence).toBe('medium')
    expect(door.evidence.some((e) => e.detail.includes('guessed'))).toBe(true)
  })

  it('takes hinge and swing from explicit block attributes', () => {
    const model = extractSpatialModel([
      polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(6000, 0, 6000, 6000)),
      wall('wShared', [6000, 0], [6000, 6000]),
      {
        ...block('dAttr', 'A-DOOR', 'DOOR_900', 6000, 3450, 200, 900),
        attributes: { HINGE: '6000;3000', SWING: 'inward' }
      }
    ])
    const door = model.openings[0]!
    expect(door.hingeSource).toBe('attribute')
    expect(door.hinge).toEqual([6000, 3000])
    expect(door.swingDirection).toBe('inward')
  })

  it('swing direction stays unknown when the drawing does not say', () => {
    const model = extractSpatialModel(twoRoomScene())
    expect(model.openings[0]!.swingDirection).toBe('unknown')
  })

  it('flags a door dropped on an unbroken wall line', () => {
    const model = extractSpatialModel([
      polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(6000, 0, 6000, 6000)),
      wall('wFull', [6000, 0], [6000, 6000]),
      block('d1', 'A-DOOR', 'DOOR_900', 6000, 2900, 900, 200)
    ])
    const door = model.openings[0]!
    expect(door.cutsWall).toBe(false)
    const advisory = checkDoorValidity(door, model).find((f) => f.code === 'DOOR_ON_UNCUT_WALL')
    expect(advisory).toBeDefined()
    // Advisory: the layout is still valid, so it must not fail the batch on its own.
    expect(advisory!.status).toBe('PASS')
  })

  it('confirms the wall is actually broken where the door sits', () => {
    const model = extractSpatialModel([
      polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(6000, 0, 6000, 6000)),
      wall('wA', [6000, 0], [6000, 2450]),
      wall('wB', [6000, 3350], [6000, 6000]),
      block('d1', 'A-DOOR', 'DOOR_900', 6000, 2900, 900, 200)
    ])
    expect(model.openings[0]!.cutsWall).toBe(true)
    expect(
      checkDoorValidity(model.openings[0]!, model).some((f) => f.code === 'DOOR_ON_UNCUT_WALL')
    ).toBe(false)
  })
})

describe('Door connection type drives accessibility', () => {
  it('an opening between two indoor rooms is interior', () => {
    const model = extractSpatialModel(twoRoomScene())
    expect(model.openings[0]!.connectionType).toBe('interior')
  })

  it('an opening onto a garden is exterior, and the garden is a way in', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('garden', 'SAN_VUON', rect(6000, 0, 6000, 6000)),
      wall('w', [6000, 0], [6000, 6000]),
      block('dExt', 'A-DOOR', 'DOOR_900', 6000, 3000, 900, 200)
    ])
    expect(model.openings[0]!.connectionType).toBe('exterior')
    const { findings } = checkAccessibility(model)
    expect(findings.some((f) => f.code === 'ROOM_INACCESSIBLE')).toBe(false)
  })

  it('a single room with a front door is valid — an exterior door joins one space', () => {
    // The outside is not a modelled space, so a front door legitimately connects exactly one.
    // Demanding two spaces from it is a false FAIL: it would call a faithful single-room drawing
    // invalid (and, via read-back, an honestly-drawn bedroom unfaithful).
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_NGU', rect(0, 0, 6000, 6000)),
      wall('w', [0, 0], [6000, 0]),
      block('dFront', 'A-DOOR', 'DOOR_900', 5000, 0, 900, 200)
    ])
    const door = model.openings[0]!
    expect(door.connectionType).toBe('exterior')
    expect(door.connectsSpaces.length).toBe(1)
    const findings = checkDoorValidity(door, model)
    expect(findings.some((f) => f.code === 'DOOR_CONNECTS_ONE_SPACE')).toBe(false)
    expect(findings.some((f) => f.code === 'DOOR_CONNECTS_NOTHING')).toBe(false)
  })

  it('a door that connects nothing is still a FAIL even if labelled exterior', () => {
    // A symbol floating over open ground is wrong regardless of its label.
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_NGU', rect(0, 0, 6000, 6000)),
      block('dFloat', 'A-DOOR', 'DOOR_900', 3000, 3000, 900, 200)
    ])
    const door = model.openings[0]!
    const findings = checkDoorValidity(door, model)
    expect(findings.some((f) => f.code === 'DOOR_CONNECTS_NOTHING' && f.status === 'FAIL')).toBe(
      true
    )
  })

  it('a contradiction between the label and the space typing is reported', () => {
    const model = extractSpatialModel([
      polyline('rmA', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('rmB', 'SAN_VUON', rect(6000, 0, 6000, 6000)),
      wall('w', [6000, 0], [6000, 6000]),
      block('d1', 'A-DOOR', 'DOOR_900', 6000, 3000, 900, 200)
    ])
    const door = model.openings[0]!
    expect(door.connectionType).toBe('exterior')
    const forced = { ...door, connectionType: 'interior' as const }
    expect(
      checkDoorValidity(forced, model).some((f) => f.code === 'DOOR_CONNECTION_CONTRADICTION')
    ).toBe(true)
  })
})

describe('Existing drawing content is an obstacle without being told', () => {
  it('a column block is kinded as a column, not furniture', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 8000, 8000)),
      block('col1', 'A-COLUMN', 'COT_01', 5000, 4000, 400, 400)
    ])
    expect(model.furniture[0]!.kind).toBe('column')
    expect(deriveObstacles(model).map((o) => o.id)).toContain('col1')
  })

  it('a terrace layer is not mistaken for a column via the TRU token', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 8000, 8000)),
      polyline('terrace', 'SAN_TRUOC', rect(8000, 0, 4000, 4000))
    ])
    expect(spaceOf(model, 'terrace').spaceType).toBe('outdoor')
    expect(model.furniture.length).toBe(0)
  })

  it('a new sofa collides with a sofa already in the DWG, with no caller obstacles', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      block('sofaExisting', 'A-FURN', 'SOFA_3CHO', 2000, 1000, 2400, 900)
    ])
    const result = validatePlacement({
      model,
      placement: { id: 'SOFA_NEW', kind: 'sofa', center: [2100, 1050], width: 2400, depth: 900 }
    })
    expect(result.status).toBe('FAIL')
    const hit = result.findings.find((f) => f.code === 'OBSTACLE_COLLISION')
    expect(hit).toBeDefined()
    expect(hit!.entityIds).toContain('sofaExisting')
  })

  it('re-placing an existing item does not collide with itself', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      block('sofaExisting', 'A-FURN', 'SOFA_3CHO', 2000, 1000, 2400, 900)
    ])
    const result = validatePlacement({
      model,
      placement: { id: 'sofaExisting', kind: 'sofa', center: [2100, 1050], width: 2400, depth: 900 }
    })
    expect(result.findings.some((f) => f.code === 'OBSTACLE_COLLISION')).toBe(false)
  })

  it('a placement clear of existing content still passes', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      block('sofaExisting', 'A-FURN', 'SOFA_3CHO', 2000, 1000, 2400, 900)
    ])
    const result = validatePlacement({
      model,
      placement: { id: 'DESK_NEW', kind: 'desk', center: [4500, 4500], width: 1400, depth: 700 }
    })
    expect(result.findings.some((f) => f.code === 'OBSTACLE_COLLISION')).toBe(false)
  })
})

describe('Indoor landscaping is a first-class intent', () => {
  it('a planting bed inside a room is allowed', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000))
    ])
    const finding = checkSpaceAssignment(
      { id: 'BED01', kind: 'plant', center: [5000, 5000], width: 1200, depth: 600 },
      model
    )
    expect(finding.code).toBe('PLANTING_ASSIGNED_OK')
    expect(finding.status).toBe('PASS')
  })

  it('a garden declared as indoor landscaping is not forced through a fake courtyard', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000))
    ])
    const finding = checkSpaceAssignment(
      {
        id: 'GREEN01',
        kind: 'garden',
        intent: 'indoor-planting',
        center: [3000, 3000],
        width: 2000,
        depth: 1500
      },
      model
    )
    expect(finding.code).toBe('PLANTING_ASSIGNED_OK')
    expect(finding.status).toBe('PASS')
  })

  it('an outdoor landscape in an indoor room still fails', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000))
    ])
    const finding = checkSpaceAssignment(
      {
        id: 'GARDEN01',
        kind: 'garden',
        intent: 'outdoor-landscape',
        center: [3000, 3000],
        width: 2000,
        depth: 1500
      },
      model
    )
    expect(finding.code).toBe('GARDEN_IN_INDOOR_ROOM')
    expect(finding.status).toBe('FAIL')
    expect(finding.suggestedCorrection).toContain('indoor-planting')
  })

  it('an indoor planting dropped outdoors is allowed but named', () => {
    const model = extractSpatialModel([polyline('yard', 'SAN_VUON', rect(0, 0, 6000, 6000))])
    const finding = checkSpaceAssignment(
      { id: 'POT01', kind: 'plant', center: [3000, 3000], width: 600, depth: 600 },
      model
    )
    expect(finding.code).toBe('PLANTING_OUTDOORS')
    expect(finding.status).toBe('PASS')
  })
})

describe('Suggested corrections respect what is already standing', () => {
  it('a suggested spot never lands inside an existing column', () => {
    const model = extractSpatialModel([
      polyline('rm', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
      polyline('hall', 'A-ROOM-HANH_LANG', rect(-2000, 2000, 2000, 2000)),
      wall('wShared', [0, 2000], [0, 4000]),
      block('d1', 'A-DOOR', 'DOOR_900', 0, 3000, 900, 200),
      block('col1', 'A-COLUMN', 'COT_01', 3000, 3000, 500, 500)
    ])
    const suggestions = suggestCorrections(
      model,
      { id: 'DESK01', kind: 'desk', center: [3000, 3000], width: 1400, depth: 700 },
      {},
      500
    )
    expect(suggestions.length).toBeGreaterThan(0)
    for (const s of suggestions) {
      // The column footprint is 2750..3250 on both axes; no suggestion may sit in it.
      const fp = rotatedRect(s.center, 1400, 700, s.rotationDeg)
      expect(ringsOverlap(fp, rect(2750, 2750, 500, 500))).toBe(false)
    }
  })
})
