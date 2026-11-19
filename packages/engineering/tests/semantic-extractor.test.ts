import { describe, expect, it } from 'bun:test'
import {
  extractSemanticModel,
  SpatialIndex2D,
  type RawCadEntity
} from '../src/index'

describe('CAD Semantic Extractor', () => {
  it('extracts walls, room boundary, and door from a simple room', () => {
    const entities: RawCadEntity[] = [
      // 4 walls
      { handle: 'w1', kind: 'line', layer: 'A-WALL', bounds: { min: { x: 0, y: 0 }, max: { x: 10000, y: 200 } } },
      { handle: 'w2', kind: 'line', layer: 'A-WALL', bounds: { min: { x: 9800, y: 0 }, max: { x: 10000, y: 8000 } } },
      { handle: 'w3', kind: 'line', layer: 'A-WALL', bounds: { min: { x: 0, y: 7800 }, max: { x: 10000, y: 8000 } } },
      { handle: 'w4', kind: 'line', layer: 'A-WALL', bounds: { min: { x: 0, y: 0 }, max: { x: 200, y: 8000 } } },
      // Room polyline
      { handle: 'rm1', kind: 'polyline', layer: 'A-ROOM', bounds: { min: { x: 200, y: 200 }, max: { x: 9800, y: 7800 } } },
      // Door block
      { handle: 'd1', kind: 'blockReference', layer: 'A-DOOR', geometry: { name: 'DOOR_900' }, bounds: { min: { x: 4500, y: 0 }, max: { x: 5400, y: 200 } } }
    ]

    const model = extractSemanticModel(entities, { documentName: 'test_room.dwg' })
    expect(model.documentName).toBe('test_room.dwg')
    expect(model.walls.length).toBe(4)
    expect(model.openings.length).toBe(1)
    expect(model.openings[0]?.type).toBe('door')
    expect(model.rooms.length).toBe(1)
    expect(model.rooms[0]?.areaM2).toBeGreaterThan(70)
    expect(model.protectedRegions.length).toBe(1)
  })

  it('detects equipment containment relationship within room boundary', () => {
    const entities: RawCadEntity[] = [
      { handle: 'rm1', kind: 'polyline', layer: 'A-ROOM', bounds: { min: { x: 0, y: 0 }, max: { x: 10000, y: 10000 } } },
      // 2 sprinkler heads placed inside
      { handle: 'sp1', kind: 'blockReference', layer: 'PCCC_SPRINKLER', geometry: { name: 'SPRINKLER_PENDENT' }, bounds: { min: { x: 2500, y: 2500 }, max: { x: 2600, y: 2600 } } },
      { handle: 'sp2', kind: 'blockReference', layer: 'PCCC_SPRINKLER', geometry: { name: 'SPRINKLER_PENDENT' }, bounds: { min: { x: 7500, y: 7500 }, max: { x: 7600, y: 7600 } } }
    ]

    const model = extractSemanticModel(entities)
    expect(model.equipment.length).toBe(2)
    expect(model.relationships.length).toBe(2)
    expect(model.relationships[0]?.relation).toBe('contains')
    expect(model.relationships[0]?.targetId).toBe('sp1')
  })

  it('distinguishes excluded regions from protected regions', () => {
    const entities: RawCadEntity[] = [
      { handle: 'r_main', kind: 'polyline', layer: 'A-ROOM-PROTECTED', bounds: { min: { x: 0, y: 0 }, max: { x: 10000, y: 10000 } } },
      { handle: 'r_shaft', kind: 'polyline', layer: 'A-ROOM-EXCLUDE-SHAFT', bounds: { min: { x: 8000, y: 8000 }, max: { x: 10000, y: 10000 } } }
    ]

    const model = extractSemanticModel(entities)
    expect(model.protectedRegions.length).toBe(1)
    expect(model.excludedRegions.length).toBe(1)
    expect(model.excludedRegions[0]?.name).toContain('EXCLUDE')
  })

  it('spatial index queries return correct candidates without quadratic scanning', () => {
    const index = new SpatialIndex2D<{ name: string }>(1000)
    index.insert('item1', { minX: 100, minY: 100, maxX: 200, maxY: 200 }, { name: 'A' })
    index.insert('item2', { minX: 5000, minY: 5000, maxX: 5100, maxY: 5100 }, { name: 'B' })

    const foundA = index.query({ minX: 0, minY: 0, maxX: 500, maxY: 500 })
    expect(foundA.length).toBe(1)
    expect(foundA[0]?.name).toBe('A')

    const foundNone = index.query({ minX: 2000, minY: 2000, maxX: 2500, maxY: 2500 })
    expect(foundNone.length).toBe(0)
  })
})
