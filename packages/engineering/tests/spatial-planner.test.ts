import { describe, expect, it } from 'bun:test'
import {
  extractSpatialModel,
  checkSpatialProgram,
  analyzeSpatialDrawing,
  checkProgram,
  checkProgramAdjacency,
  deriveAdjacencyGraph,
  deriveCirculationGraph,
  zoneOf,
  generateLayoutCandidates,
  candidateToModel,
  generateFurnitureCandidates,
  ringDistance,
  segmentDistance,
  checkAccessibility,
  type SpatialProgramInput,
  type SpatialProgram
} from '../src/index'
import { rect, polyline, wall, block, twoRoomScene } from './fixtures/spatial-entities'

/**
 * Spatial program + planner tests. Units: millimetres (Aleph convention). Fixtures carry real
 * vertices, same as the engine tests — the planner's whole point is that adjacency and area are
 * MEASURED, so a fixture that only carries bboxes would prove nothing.
 */

const program = (
  rooms: SpatialProgramInput['rooms'],
  extra: Partial<SpatialProgramInput> = {}
): SpatialProgramInput => ({
  id: 'prog-1',
  rooms,
  unitsPerMetre: 1000,
  ...extra
})

// --- declared versus assumed unit basis (#413 SS11.2) ---------------------------------------------

describe('unit basis is reported, never silently assumed', () => {
  const inchRoom = polyline('rmHall', 'A-ROOM-HALL', rect(0, 0, 1000, 800))
  const rooms = [
    {
      id: 'rmHall',
      usage: 'living' as const,
      targetAreaM2: 20,
      priority: 0,
      requiredAdjacency: [],
      forbiddenAdjacency: []
    }
  ]
  // The capability layer forwards model-authored JSON as-is (checkSpatialProgram(request.input as
  // unknown as ProgramCheckInput)), so a program without unitsPerMetre is a real runtime shape;
  // the schema default must not disguise that as a declared basis.
  const undeclared = { id: 'prog-1', rooms } as unknown as SpatialProgram

  it('checkSpatialProgram states the assumption when units were never declared', () => {
    const res = checkSpatialProgram({ program: undeclared, entities: [inchRoom] })
    expect(res.success).toBe(true)
    expect(res.assumptions ?? []).toHaveLength(1)
    expect(res.assumptions![0]).toContain('millimetres')
  })

  it('checkSpatialProgram stays silent once the caller declares the basis', () => {
    const res = checkSpatialProgram({
      program: { id: 'prog-1', rooms, unitsPerMetre: 1000 },
      entities: [inchRoom]
    })
    expect(res.assumptions ?? []).toHaveLength(0)
  })

  it('analyzeSpatialDrawing surfaces the basis in the summary the model reads', () => {
    const assumed = analyzeSpatialDrawing({ entities: [inchRoom] })
    expect(assumed.summary!.units).toEqual({ perMetre: 1000, declared: false })
    const declared = analyzeSpatialDrawing({ entities: [inchRoom], unitsPerMetre: 39.3701 })
    expect(declared.summary!.units).toEqual({ perMetre: 39.3701, declared: true })
  })
})

// --- ringDistance -------------------------------------------------------------------------------

describe('ringDistance measures the real gap between boundaries', () => {
  it('two rooms sharing a long wall are 0 apart even when first vertices are far apart', () => {
    // extract's adjacency pass samples boundary[0] only; these rings start at opposite corners of
    // the shared wall, so the first-vertex sample reports 12 m while the true gap is 0.
    const a = rect(0, 0, 6000, 6000) // first vertex (0,0)
    const b: Array<[number, number]> = [
      [12000, 6000],
      [12000, 0],
      [6000, 0],
      [6000, 6000]
    ] // first vertex (12000,6000); shares x=6000 edge with a
    expect(ringDistance(a, b)).toBeCloseTo(0, 6)
  })

  it('parallel walls 500 apart report 500', () => {
    expect(ringDistance(rect(0, 0, 1000, 1000), rect(1500, 0, 1000, 1000))).toBeCloseTo(500, 6)
  })

  it('segmentDistance is 0 for crossing segments and exact for parallel ones', () => {
    expect(segmentDistance([0, 0], [10, 10], [0, 10], [10, 0])).toBe(0)
    expect(segmentDistance([0, 0], [10, 0], [0, 3], [10, 3])).toBeCloseTo(3, 9)
  })
})

// --- graphs -------------------------------------------------------------------------------------

describe('adjacency and circulation graphs come from measured geometry', () => {
  it('two rooms sharing a wall are adjacent; the door forms a circulation edge', () => {
    const model = extractSpatialModel(twoRoomScene(), { unitsPerMetre: 1000 })
    const adj = deriveAdjacencyGraph(model, 500)
    expect(adj.edges.some((e) => e.touching)).toBe(true)
    const circ = deriveCirculationGraph(model)
    expect(circ.edges.length).toBe(1)
    expect(circ.edges[0]!.via).toBe('d1')
  })

  it('rooms 20 m apart are NOT adjacent at the default gap', () => {
    const model = extractSpatialModel(
      [
        polyline('rmA', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
        polyline('rmB', 'A-ROOM-PHONG_NGU', rect(26000, 0, 6000, 6000))
      ],
      { unitsPerMetre: 1000 }
    )
    expect(deriveAdjacencyGraph(model, 500).edges.length).toBe(0)
  })
})

// --- program checks -----------------------------------------------------------------------------

describe('checkProgram areas and adjacency', () => {
  it('a drawn room inside its program range passes', () => {
    const model = extractSpatialModel(twoRoomScene(), { unitsPerMetre: 1000 })
    const p = program([
      {
        id: 'rmLiving',
        usage: 'living',
        targetAreaM2: 36,
        minAreaM2: 30,
        maxAreaM2: 42,
        requiredAdjacency: [],
        forbiddenAdjacency: [],
        priority: 0
      }
    ])
    const { status, findings } = checkProgram(p, model)
    expect(status).toBe('PASS')
    expect(findings.some((f) => f.code === 'PROGRAM_AREA_OK')).toBe(true)
  })

  it('a room drawn smaller than its program minimum FAILS with the measured number', () => {
    const model = extractSpatialModel(
      [polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(0, 0, 3000, 3000))],
      { unitsPerMetre: 1000 }
    )
    const p = program([
      { id: 'rmBed', usage: 'bedroom', targetAreaM2: 20, minAreaM2: 16, priority: 0 }
    ])
    const { status, findings } = checkProgram(p, model)
    const fail = findings.find((f) => f.code === 'PROGRAM_AREA_OUT_OF_RANGE')
    expect(status).toBe('FAIL')
    expect(fail!.measurements!.areaM2).toBeCloseTo(9, 1)
    expect(fail!.message).toContain('9.0 m²')
  })

  it('a program room that is not drawn is INSUFFICIENT_DATA, never a pass', () => {
    const model = extractSpatialModel(
      [polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000))],
      { unitsPerMetre: 1000 }
    )
    const p = program([
      { id: 'rmLiving', usage: 'living', targetAreaM2: 36, priority: 0 },
      { id: 'rmKitchen', usage: 'kitchen', targetAreaM2: 12, priority: 0 }
    ])
    const { status, findings } = checkProgram(p, model)
    expect(status).toBe('INSUFFICIENT_DATA')
    expect(
      findings.some((f) => f.code === 'PROGRAM_ROOM_NOT_DRAWN' && f.entityIds.includes('rmKitchen'))
    ).toBe(true)
  })

  it('required adjacency between two drawn rooms that do not touch FAILS', () => {
    const model = extractSpatialModel(
      [
        polyline('rmA', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
        polyline('rmB', 'A-ROOM-PHONG_NGU', rect(26000, 0, 6000, 6000))
      ],
      { unitsPerMetre: 1000 }
    )
    const p = program([
      {
        id: 'sp_rmA',
        usage: 'living',
        targetAreaM2: 36,
        requiredAdjacency: ['sp_rmB'],
        priority: 0
      },
      { id: 'sp_rmB', usage: 'bedroom', targetAreaM2: 36, priority: 0 }
    ])
    const { status, findings } = checkProgram(p, model, 500)
    expect(status).toBe('FAIL')
    expect(findings.some((f) => f.code === 'PROGRAM_ADJACENCY_MISSING')).toBe(true)
  })

  it('forbidden adjacency that is present FAILS', () => {
    const model = extractSpatialModel(twoRoomScene(), { unitsPerMetre: 1000 })
    const p = program([
      {
        id: 'sp_rmLiving',
        usage: 'living',
        targetAreaM2: 36,
        forbiddenAdjacency: ['sp_rmBed'],
        priority: 0
      },
      { id: 'sp_rmBed', usage: 'bedroom', targetAreaM2: 36, priority: 0 }
    ])
    const findings = checkProgramAdjacency(p, model, 500)
    expect(
      findings.some((f) => f.code === 'PROGRAM_ADJACENCY_FORBIDDEN' && f.status === 'FAIL')
    ).toBe(true)
  })

  it('a program room named by entity handle matches the sp_ prefixed space', () => {
    const model = extractSpatialModel(twoRoomScene(), { unitsPerMetre: 1000 })
    const p = program([
      {
        id: 'rmLiving',
        usage: 'living',
        targetAreaM2: 36,
        minAreaM2: 30,
        maxAreaM2: 42,
        priority: 0
      }
    ])
    const { status } = checkProgram(p, model)
    expect(status).toBe('PASS')
  })

  it('zoneOf maps usages to functional zones', () => {
    expect(zoneOf('bedroom')).toBe('private')
    expect(zoneOf('kitchen')).toBe('shared')
    expect(zoneOf('storage')).toBe('service')
    expect(zoneOf('hallway')).toBe('circulation')
    expect(zoneOf('garden')).toBe('outdoor')
  })
})

// --- layout generation --------------------------------------------------------------------------

describe('generateLayoutCandidates packs a program deterministically', () => {
  const p = program(
    [
      { id: 'living', usage: 'living', targetAreaM2: 36, requiredAdjacency: ['bed'], priority: 2 },
      { id: 'bed', usage: 'bedroom', targetAreaM2: 20, priority: 1 },
      { id: 'bath', usage: 'bathroom', targetAreaM2: 6, priority: 0 }
    ],
    { siteBoundary: rect(0, 0, 12000, 8000) }
  )

  it('same input yields byte-identical candidates (determinism)', () => {
    const a = generateLayoutCandidates(p, { minX: 0, minY: 0, maxX: 12000, maxY: 8000 }, 3)
    const b = generateLayoutCandidates(p, { minX: 0, minY: 0, maxX: 12000, maxY: 8000 }, 3)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('every placed room sits inside the site and matches its target area within 15%', () => {
    const [best] = generateLayoutCandidates(p, { minX: 0, minY: 0, maxX: 12000, maxY: 8000 }, 3)
    for (const r of best!.rooms) {
      expect(r.areaM2).toBeGreaterThan(0)
      expect(Math.abs(r.areaM2 - r.targetAreaM2) / r.targetAreaM2).toBeLessThan(0.15)
      for (const [x, y] of r.boundary) {
        expect(x).toBeGreaterThanOrEqual(-1e-6)
        expect(y).toBeGreaterThanOrEqual(-1e-6)
        expect(x).toBeLessThanOrEqual(12000 + 1e-6)
        expect(y).toBeLessThanOrEqual(8000 + 1e-6)
      }
    }
  })

  it('rooms that share a wall get an interior door, and the layout gets an exterior entry door', () => {
    const [best] = generateLayoutCandidates(p, { minX: 0, minY: 0, maxX: 12000, maxY: 8000 }, 3)
    const interior = best!.openings.filter((o) => o.connectionType === 'interior')
    expect(interior.length).toBeGreaterThan(0)
    const door = interior[0]!
    expect(door.connectsSpaces.length).toBe(2)
    // The door centre lies on the shared segment.
    const [a, b] = door.wallSegment
    expect(door.center[0]).toBeCloseTo((a[0] + b[0]) / 2, 6)
    expect(door.center[1]).toBeCloseTo((a[1] + b[1]) / 2, 6)
    // Exactly one entry door, joining a single room to the outside.
    const entry = best!.openings.filter((o) => o.connectionType === 'exterior')
    expect(entry.length).toBe(1)
    expect(entry[0]!.connectsSpaces.length).toBe(1)
  })

  it('a candidate converts to a model that satisfies its own program and is accessible', () => {
    const [best] = generateLayoutCandidates(p, { minX: 0, minY: 0, maxX: 12000, maxY: 8000 }, 1)
    const model = candidateToModel(best!, p)
    expect(model.spaces.length).toBe(3)
    // The candidate's rooms match the program by id, so areas are evaluable (not NOT_DRAWN).
    const programResult = checkProgram(p, model)
    expect(programResult.findings.some((f) => f.code === 'PROGRAM_ROOM_NOT_DRAWN')).toBe(false)
    // Rooms share walls by construction; the door set the packing implied makes every room
    // reachable, so accessibility must not report an unreachable room.
    const access = checkAccessibility(model)
    expect(access.findings.some((f) => f.code === 'ROOM_INACCESSIBLE')).toBe(false)
  })

  it('required adjacency the packing cannot satisfy is reported, not hidden', () => {
    // A tiny site that cannot fit all rooms: the unplaced rooms must not silently pass.
    const tight = program([
      { id: 'living', usage: 'living', targetAreaM2: 36, requiredAdjacency: ['bed'], priority: 0 },
      { id: 'bed', usage: 'bedroom', targetAreaM2: 20, priority: 0 }
    ])
    const cands = generateLayoutCandidates(tight, { minX: 0, minY: 0, maxX: 7000, maxY: 7000 }, 1)
    const best = cands[0]!
    const placedIds = new Set(best.rooms.map((r) => r.roomId))
    if (placedIds.size < 2) {
      // One room dropped: adjacency is unmet and must be listed.
      expect(best.unmetAdjacency.length).toBeGreaterThan(0)
    } else {
      expect(best.adjacencyScore).toBe(1)
    }
  })
})

// --- furniture candidates -----------------------------------------------------------------------
describe('generateFurnitureCandidates ranks by measured facts', () => {
  it('a bed in a 6×6 m room with a door: top candidate is wall-borne and passes the per-item gate', () => {
    const model = extractSpatialModel(
      [
        polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(0, 0, 6000, 6000)),
        wall('wBed', [0, 0], [6000, 0]),
        block('dBed', 'A-DOOR', 'DOOR_900', 5000, 0, 900, 200)
      ],
      { unitsPerMetre: 1000 }
    )
    const cands = generateFurnitureCandidates(
      model,
      { id: 'bed1', kind: 'bed', width: 2000, depth: 1600, spaceId: 'sp_rmBed' },
      {},
      500
    )
    expect(cands.length).toBeGreaterThan(0)
    const top = cands[0]!
    expect(top.status).toBe('PASS')
    // Wall-borne preference: the best bed sits closer to a boundary than the room centre is.
    expect(top.reasons.some((r) => r.startsWith('wall-borne'))).toBe(true)
    // Every returned candidate must be inside the room.
    for (const c of cands) {
      expect(c.center[0]).toBeGreaterThanOrEqual(0)
      expect(c.center[1]).toBeGreaterThanOrEqual(0)
      expect(c.center[0]).toBeLessThanOrEqual(6000)
      expect(c.center[1]).toBeLessThanOrEqual(6000)
    }
  })

  it('a dining table prefers the room centre over a wall', () => {
    const model = extractSpatialModel(
      [polyline('rmEat', 'A-ROOM-PHAN_AN', rect(0, 0, 6000, 6000))],
      { unitsPerMetre: 1000 }
    )
    const cands = generateFurnitureCandidates(
      model,
      { id: 'table1', kind: 'diningTable', width: 1800, depth: 900, spaceId: 'sp_rmEat' },
      {},
      500
    )
    const top = cands[0]!
    const distToCentre = Math.hypot(top.center[0] - 3000, top.center[1] - 3000)
    expect(distToCentre).toBeLessThanOrEqual(700) // grid step 500 → nearest centre cell
  })

  it('a wardrobe never lands inside an existing column', () => {
    const model = extractSpatialModel(
      [
        polyline('rm', 'A-ROOM-PHONG_NGU', rect(0, 0, 6000, 6000)),
        block('col1', 'KET_CAU', 'COLUMN_400', 1000, 1000, 400, 400)
      ],
      { unitsPerMetre: 1000 }
    )
    const cands = generateFurnitureCandidates(
      model,
      { id: 'wardrobe1', kind: 'wardrobe', width: 2000, depth: 600, spaceId: 'sp_rm' },
      {},
      500
    )
    for (const c of cands) {
      // Footprint must not overlap the column at (1000,1000) 400×400.
      const overlapsCol =
        c.center[0] - 1000 < 1000 + 1000 &&
        c.center[0] + 1000 > 1000 - 1000 &&
        c.center[1] - 300 < 1000 + 1000 &&
        c.center[1] + 300 > 1000 - 1000
      expect(overlapsCol).toBe(false)
    }
  })

  it('no candidates at all when the item cannot fit the room', () => {
    const model = extractSpatialModel([polyline('closet', 'A-ROOM-KHO', rect(0, 0, 1000, 1000))], {
      unitsPerMetre: 1000
    })
    const cands = generateFurnitureCandidates(
      model,
      { id: 'bed1', kind: 'bed', width: 2000, depth: 1600, spaceId: 'sp_closet' },
      {},
      500
    )
    expect(cands.length).toBe(0)
  })
})
