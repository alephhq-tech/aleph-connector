import { describe, expect, it } from 'bun:test'
import {
  generateSprinklerLayout,
  routeSprinklerPipes,
  verifyPipeConnectivity,
  type Point2D,
  type PipeSegmentRoute,
  type SprinklerHead
} from '../src/index'

const roomBoundary: Point2D[] = [
  [0, 0],
  [20000, 0],
  [20000, 10000],
  [0, 10000]
]

describe('verifyPipeConnectivity — independent of the router\'s own claim', () => {
  it('confirms a genuinely connected network the router produced', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',  roomBoundary, hazardGroup: 'Group 2' })
    const riserLocation: Point2D = [0, 5000]
    const route = routeSprinklerPipes({ insUnits: 'mm',  heads: layout.heads, riserLocation })

    const result = verifyPipeConnectivity({
      riserLocation,
      heads: layout.heads,
      segments: route.segments
    })

    expect(result.isFullyConnected).toBe(true)
    expect(result.disconnectedHeads).toEqual([])
    expect(result.riserDisconnected).toBe(false)
  })

  it('aleph-platform#279 regression: zero segments with heads present is NOT connected, whatever the caller claims', () => {
    const heads: SprinklerHead[] = [{ id: 'SPK_1', x: 1000, y: 1000, row: 0, col: 0 }]
    const result = verifyPipeConnectivity({
      riserLocation: [0, 0],
      heads,
      segments: []
    })

    expect(result.isFullyConnected).toBe(false)
    expect(result.disconnectedHeads).toEqual(['SPK_1'])
    expect(result.riserDisconnected).toBe(true)
  })

  it('flags a head whose branch never actually reaches the riser-fed network', () => {
    const heads: SprinklerHead[] = [
      { id: 'SPK_1', x: 1000, y: 0, row: 0, col: 0 },
      { id: 'SPK_2', x: 5000, y: 9000, row: 1, col: 0 } // far away, own isolated stub
    ]
    const segments: PipeSegmentRoute[] = [
      {
        id: 'PIPE_MAIN_01',
        kind: 'main',
        start: [0, 0],
        end: [0, 1000],
        nominalDiameterMm: 65,
        connectedHeadIds: ['SPK_1'],
        lengthM: 1
      },
      {
        id: 'PIPE_BRANCH_1',
        kind: 'branch',
        start: [0, 0],
        end: [1000, 0],
        nominalDiameterMm: 25,
        connectedHeadIds: ['SPK_1'],
        lengthM: 1
      },
      {
        // Claims to serve SPK_2 (connectedHeadIds), but its geometry sits nowhere near it or the
        // riser-fed branch above — exactly the gap an independent check must catch.
        id: 'PIPE_BRANCH_2',
        kind: 'branch',
        start: [4800, 8800],
        end: [5200, 8800],
        nominalDiameterMm: 25,
        connectedHeadIds: ['SPK_2'],
        lengthM: 1
      }
    ]

    const result = verifyPipeConnectivity({ riserLocation: [0, 0], heads, segments })

    expect(result.isFullyConnected).toBe(false)
    expect(result.disconnectedHeads).toEqual(['SPK_2'])
    expect(result.reachableSegmentIds.sort()).toEqual(['PIPE_BRANCH_1', 'PIPE_MAIN_01'])
  })

  it('a riser that touches no segment makes the whole network unreachable, not just one head', () => {
    const heads: SprinklerHead[] = [{ id: 'SPK_1', x: 1000, y: 1000, row: 0, col: 0 }]
    const segments: PipeSegmentRoute[] = [
      {
        id: 'PIPE_BRANCH_1',
        kind: 'branch',
        start: [0, 1000],
        end: [2000, 1000],
        nominalDiameterMm: 25,
        connectedHeadIds: ['SPK_1'],
        lengthM: 2
      }
    ]

    // Riser is nowhere near the only segment present.
    const result = verifyPipeConnectivity({ riserLocation: [50000, 50000], heads, segments })

    expect(result.isFullyConnected).toBe(false)
    expect(result.riserDisconnected).toBe(true)
    expect(result.disconnectedHeads).toEqual(['SPK_1'])
  })

  it('a head mid-span on a branch (not at either endpoint) still counts as connected', () => {
    const heads: SprinklerHead[] = [
      { id: 'SPK_1', x: 0, y: 1000, row: 0, col: 0 },
      { id: 'SPK_2', x: 1000, y: 1000, row: 0, col: 1 }, // between the two endpoints below
      { id: 'SPK_3', x: 2000, y: 1000, row: 0, col: 2 }
    ]
    const segments: PipeSegmentRoute[] = [
      {
        id: 'PIPE_MAIN_01',
        kind: 'main',
        start: [0, 0],
        end: [0, 1000],
        nominalDiameterMm: 65,
        connectedHeadIds: [],
        lengthM: 1
      },
      {
        id: 'PIPE_BRANCH_1',
        kind: 'branch',
        start: [0, 1000],
        end: [2000, 1000],
        nominalDiameterMm: 40,
        connectedHeadIds: ['SPK_1', 'SPK_2', 'SPK_3'],
        lengthM: 2
      }
    ]

    const result = verifyPipeConnectivity({ riserLocation: [0, 0], heads, segments })

    expect(result.isFullyConnected).toBe(true)
    expect(result.disconnectedHeads).toEqual([])
  })

  it('a riser between the first and last head of a row is still a connected grid (report §3.3)', () => {
    // `routeSprinklerPipes` draws the main at the RISER's x and every branch across its whole row.
    // With the riser mid-span, the branch crosses the main: no endpoint of either touches the other,
    // so endpoint-only adjacency declared 70 of the SUNLAND run's 88 heads disconnected and
    // Plan verify could never PASS a run whose layout the engine itself produced.
    const heads: SprinklerHead[] = []
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 3; col++)
        heads.push({ id: `SPK_${row}_${col}`, x: 1000 + col * 5000, y: 10000 - row * 3000, row, col })
    const riserLocation: Point2D = [6000, 10500] // strictly between the first and last head x
    const route = routeSprinklerPipes({ insUnits: 'mm',  heads, riserLocation })

    const result = verifyPipeConnectivity({ riserLocation, heads, segments: route.segments })

    expect(result.riserDisconnected).toBe(false)
    expect(result.disconnectedHeads).toEqual([])
    expect(result.isFullyConnected).toBe(true)
  })

  it('a main that misses every branch by more than tolerance is still disconnected', () => {
    // The cross-junction fix must not turn "close" into "connected": the same grid with the riser
    // offset a full metre off every branch line has no junction at all.
    const heads: SprinklerHead[] = [
      { id: 'SPK_1', x: 1000, y: 10000, row: 0, col: 0 },
      { id: 'SPK_2', x: 6000, y: 10000, row: 0, col: 1 }
    ]
    const riserLocation: Point2D = [6000, 10500]
    const route = routeSprinklerPipes({ insUnits: 'mm',  heads, riserLocation })
    const shifted = route.segments.map((s) => ({
      ...s,
      start: [s.start[0] - 1000, s.start[1]] as Point2D,
      end: [s.end[0] - 1000, s.end[1]] as Point2D
    }))

    const result = verifyPipeConnectivity({ riserLocation, heads, segments: shifted })

    expect(result.riserDisconnected).toBe(true)
    expect(result.isFullyConnected).toBe(false)
  })
})
