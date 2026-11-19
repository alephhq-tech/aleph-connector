import { describe, expect, test } from 'bun:test'
import { assembleRoomBoundaries, allBoundariesVerified, type RegionRing } from './floorplanBoundary.js'

// Region is 10000x10000 drawing units (mm). Unit scale 0.001 → area in m².
const REGION: [number, number, number, number] = [0, 0, 10000, 10000]

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ] as [number, number][]

describe('assembleRoomBoundaries', () => {
  test('a label inside one closed ring is verified, with CCW boundary + area', () => {
    const rooms = [{ name: 'GARA', labelPosition: [2000, 2500] as [number, number] }]
    const rings: RegionRing[] = [{ handle: 'A1', ring: rect(0, 0, 4000, 5000) }]
    const out = assembleRoomBoundaries(rooms, rings, { regionBounds: REGION })

    expect(out[0]!.boundaryStatus).toBe('verified')
    expect(out[0]!.boundary).toHaveLength(4)
    // 4000mm x 5000mm = 20 m² at mm scale.
    expect(out[0]!.areaM2).toBeCloseTo(20, 1)
    expect(out[0]!.boundaryEvidence).toContain('A1')
    // The emitted ring is counter-clockwise (positive signed area).
    expect(out[0]!.boundary).toEqual(rect(0, 0, 4000, 5000))
    expect(allBoundariesVerified(out)).toBe(true)
  })

  test('a label matching no ring is unresolved and gets no boundary', () => {
    const rooms = [{ name: 'SÂN', labelPosition: [9000, 9000] as [number, number] }]
    const rings: RegionRing[] = [{ handle: 'A1', ring: rect(0, 0, 4000, 5000) }]
    const out = assembleRoomBoundaries(rooms, rings, { regionBounds: REGION })
    expect(out[0]!.boundaryStatus).toBe('unresolved')
    expect(out[0]!.boundary).toBeUndefined()
    expect(allBoundariesVerified(out)).toBe(false)
  })

  test('a whole-region sheet border is rejected, never reported as a room', () => {
    // The only ring is the sheet border (covers ~the whole region). A label inside it must NOT be
    // handed that border as its room outline — that would verify a lie.
    const rooms = [{ name: 'PHÒNG', labelPosition: [5000, 5000] as [number, number] }]
    const rings: RegionRing[] = [{ handle: 'BORDER', ring: rect(0, 0, 10000, 10000) }]
    const out = assembleRoomBoundaries(rooms, rings, { regionBounds: REGION })
    expect(out[0]!.boundaryStatus).toBe('unresolved')
    expect(out[0]!.boundary).toBeUndefined()
  })

  test('nested rings resolve to the innermost that contains the label', () => {
    const rooms = [{ name: 'WC', labelPosition: [1000, 1000] as [number, number] }]
    const rings: RegionRing[] = [
      { handle: 'OUTER', ring: rect(0, 0, 8000, 8000) },
      { handle: 'ROOM', ring: rect(0, 0, 2000, 2000) }
    ]
    const out = assembleRoomBoundaries(rooms, rings, { regionBounds: REGION })
    expect(out[0]!.boundaryStatus).toBe('verified')
    expect(out[0]!.boundaryEvidence).toContain('ROOM')
    expect(out[0]!.boundary).toEqual(rect(0, 0, 2000, 2000))
  })

  test('two same-area rings containing the label are ambiguous, not guessed', () => {
    const rooms = [{ name: '?', labelPosition: [1000, 1000] as [number, number] }]
    const rings: RegionRing[] = [
      { handle: 'H1', ring: rect(0, 0, 2000, 2000) },
      // The same outline, reversed winding (e.g. a wall ring and a hatch over the same room): the
      // kernel cannot say which is the room, so it refuses to pick.
      { handle: 'H2', ring: [ [0, 0], [0, 2000], [2000, 2000], [2000, 0] ] as [number, number][] }
    ]
    const out = assembleRoomBoundaries(rooms, rings, { regionBounds: REGION })
    expect(out[0]!.boundaryStatus).toBe('ambiguous')
    expect(out[0]!.boundary).toBeUndefined()
    expect(out[0]!.boundaryEvidence).toContain('H1')
    expect(out[0]!.boundaryEvidence).toContain('H2')
  })

  test('degenerate rings (fewer than 3 points / non-finite) are ignored', () => {
    const rooms = [{ name: 'X', labelPosition: [5000, 5000] as [number, number] }]
    const rings: RegionRing[] = [
      { handle: 'DEGEN', ring: [ [0, 0], [1, 1] ] as [number, number][] },
      { handle: 'NAN', ring: [ [0, 0], [1e6, NaN], [1e6, 1e6], [0, 1e6] ] as [number, number][] }
    ]
    const out = assembleRoomBoundaries(rooms, rings, { regionBounds: REGION })
    expect(out[0]!.boundaryStatus).toBe('unresolved')
  })
})
