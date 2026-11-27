import { describe, expect, it } from 'bun:test'
import {
  generateSprinklerLayout,
  routeSprinklerPipes,
  boundaryCopiesAnExtent,
  type Point2D
} from '../src/index'

describe('PCCC Sprinkler Layout & Pipe Routing', () => {
  const roomBoundary: Point2D[] = [
    [0, 0],
    [20000, 0],
    [20000, 10000],
    [0, 10000]
  ]

  it('generates compliant regular grid for Group 1 hazard (spacing <= 4.0m)', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 1'
    })

    expect(layout.status).toBe('PASS')
    expect(layout.spacingXMm).toBeLessThanOrEqual(4000)
    expect(layout.spacingYMm).toBeLessThanOrEqual(4000)
    expect(layout.headCount).toBeGreaterThan(0)
    expect(layout.violations.length).toBe(0)
  })

  it('generates compliant regular grid for Group 2 hazard (spacing <= 4.0m)', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 2'
    })

    expect(layout.status).toBe('PASS')
    expect(layout.spacingXMm).toBeLessThanOrEqual(4000)
    expect(layout.spacingYMm).toBeLessThanOrEqual(4000)
    expect(layout.headCount).toBeGreaterThan(0)
  })

  it('excludes heads from designated excluded regions', () => {
    const excludedServerRoom: Point2D[] = [
      [15000, 0],
      [20000, 0],
      [20000, 5000],
      [15000, 5000]
    ]

    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 2',
      excludedBoundaries: [excludedServerRoom]
    })

    // Assert no heads are inside [15000-20000, 0-5000]
    for (const h of layout.heads) {
      const insideExcluded = h.x >= 15000 && h.x <= 20000 && h.y >= 0 && h.y <= 5000
      expect(insideExcluded).toBe(false)
    }
  })

  it('routes connected pipe network from riser to all heads', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 2'
    })

    const route = routeSprinklerPipes({ insUnits: 'mm',
      heads: layout.heads,
      riserLocation: [0, 5000]
    })

    expect(route.isFullyConnected).toBe(true)
    expect(route.disconnectedHeads.length).toBe(0)
    expect(route.segments.length).toBeGreaterThan(0)
    expect(route.cadOperations.length).toBeGreaterThan(0)

    const mainSeg = route.segments.find((s) => s.kind === 'main')
    expect(mainSeg).toBeDefined()
    expect(mainSeg?.nominalDiameterMm).toBeGreaterThanOrEqual(65)

    const branchSegs = route.segments.filter((s) => s.kind === 'branch')
    expect(branchSegs.length).toBeGreaterThan(0)
  })

  it('measures room area from the polygon, not the bounding box', () => {
    // L-shaped room: 20x10 m bbox (200 m²) minus a 10x5 m notch = 150 m² of real floor.
    const lShape: Point2D[] = [
      [0, 0],
      [20000, 0],
      [20000, 5000],
      [10000, 5000],
      [10000, 10000],
      [0, 10000]
    ]

    const layout = generateSprinklerLayout({ insUnits: 'mm',  roomBoundary: lShape, hazardGroup: 'Group 2' })

    expect(layout.roomAreaM2).toBe(150)
    expect(layout.protectedAreaM2).toBe(150)
    expect(layout.excludedAreaM2).toBe(0)
    // Every head must sit inside the L, never in the missing notch.
    for (const h of layout.heads) {
      const inNotch = h.x > 10000 && h.y > 5000
      expect(inNotch).toBe(false)
    }
  })

  it('subtracts excluded regions from the protected area', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 2',
      excludedBoundaries: [
        [
          [15000, 0],
          [20000, 0],
          [20000, 5000],
          [15000, 5000]
        ]
      ]
    })

    expect(layout.roomAreaM2).toBe(200)
    expect(layout.excludedAreaM2).toBe(25)
    expect(layout.protectedAreaM2).toBe(175)
    expect(layout.averageAreaPerHeadM2).toBeLessThanOrEqual(9)
  })

  it('returns INSUFFICIENT_DATA for a degenerate boundary instead of a false PASS', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary: [
        [0, 0],
        [10000, 0],
        [0, 0]
      ],
      hazardGroup: 'Group 2'
    })

    expect(layout.status).toBe('INSUFFICIENT_DATA')
    expect(layout.headCount).toBe(0)
    expect(layout.violations.length).toBeGreaterThan(0)
  })

  it('detects violation when a straight main pipe crosses an excluded ring', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 2'
    })

    const excludedRing: Point2D[] = [
      [-1000, 2000],
      [1000, 2000],
      [1000, 3000],
      [-1000, 3000]
    ]

    const route = routeSprinklerPipes({ insUnits: 'mm',
      heads: layout.heads,
      riserLocation: [0, 5000],
      excludedBoundaries: [excludedRing]
    })

    expect(route.blocked).toBe(true)
    expect(route.violations.length).toBeGreaterThan(0)
    const mainViol = route.violations.find((v) => v.segmentId === 'PIPE_MAIN_01')
    expect(mainViol).toBeDefined()
    expect(mainViol?.code).toBe('PIPE_CROSSES_EXCLUDED_ZONE')
  })

  it('yields zero violations when the excluded ring is clear of every pipe segment', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 2'
    })

    const clearExcludedRing: Point2D[] = [
      [19000, 9000],
      [19500, 9000],
      [19500, 9500],
      [19000, 9500]
    ]

    const route = routeSprinklerPipes({ insUnits: 'mm',
      heads: layout.heads,
      riserLocation: [0, 5000],
      excludedBoundaries: [clearExcludedRing]
    })

    expect(route.blocked).toBe(false)
    expect(route.violations.length).toBe(0)
  })

  it('E8: the same physical room measures the same area in mm and in metres', () => {
    // 12 m x 8 m room, expressed once in millimetres and once in metres: same room,
    // same area (96 m2), same head count and same spacing in mm.
    const mmLayout = generateSprinklerLayout({
      insUnits: 'mm',
      roomBoundary: [
        [0, 0],
        [12000, 0],
        [12000, 8000],
        [0, 8000]
      ],
      hazardGroup: 'Group 1'
    })
    const mLayout = generateSprinklerLayout({
      insUnits: 'm',
      roomBoundary: [
        [0, 0],
        [12, 0],
        [12, 8],
        [0, 8]
      ],
      hazardGroup: 'Group 1'
    })

    expect(mmLayout.status).toBe('PASS')
    expect(mLayout.status).toBe('PASS')
    expect(mLayout.roomAreaM2).toBe(mmLayout.roomAreaM2)
    expect(mLayout.roomAreaM2).toBe(96)
    expect(mLayout.headCount).toBe(mmLayout.headCount)
    expect(mLayout.spacingXMm).toBe(mmLayout.spacingXMm)
    expect(mLayout.spacingYMm).toBe(mmLayout.spacingYMm)
  })

  it('E8: the same boundary numbers in metres measure 1e6x the area in millimetres', () => {
    const mmLayout = generateSprinklerLayout({
      insUnits: 'mm',
      roomBoundary: [
        [0, 0],
        [1200, 0],
        [1200, 800],
        [0, 800]
      ],
      hazardGroup: 'Group 1'
    })
    const mLayout = generateSprinklerLayout({
      insUnits: 'm',
      roomBoundary: [
        [0, 0],
        [1200, 0],
        [1200, 800],
        [0, 800]
      ],
      hazardGroup: 'Group 1'
    })

    expect(mmLayout.roomAreaM2).toBe(0.96)
    expect(mLayout.roomAreaM2).toBe(960000)
    expect(mLayout.roomAreaM2 / mmLayout.roomAreaM2).toBe(1_000_000)
  })

  it('E8: unknown units block the layout with INSUFFICIENT_DATA instead of assuming mm', () => {
    const noUnits = generateSprinklerLayout({ roomBoundary, hazardGroup: 'Group 1' })
    expect(noUnits.status).toBe('INSUFFICIENT_DATA')
    expect(noUnits.heads).toHaveLength(0)
    expect(noUnits.violations.some((v) => v.includes('UNKNOWN_DRAWING_UNITS'))).toBe(true)

    const unitless = generateSprinklerLayout({
      insUnits: 'unitless',
      roomBoundary,
      hazardGroup: 'Group 1'
    })
    expect(unitless.status).toBe('INSUFFICIENT_DATA')
    expect(unitless.violations.some((v) => v.includes('UNKNOWN_DRAWING_UNITS'))).toBe(true)
  })

  it('E8: the pipe router reports lengths in metres from the real unit basis', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary,
      hazardGroup: 'Group 1'
    })
    const routeMm = routeSprinklerPipes({ insUnits: 'mm',
      heads: layout.heads,
      riserLocation: [0, 5000]
    })
    expect(routeMm.blocked).toBe(false)
    expect(routeMm.totalLengthM).toBeGreaterThan(0)

    const noUnits = routeSprinklerPipes({ heads: layout.heads, riserLocation: [0, 5000] })
    expect(noUnits.blocked).toBe(true)
    expect(noUnits.violations.some((v) => v.code === 'UNKNOWN_DRAWING_UNITS')).toBe(true)
  })
})

describe('boundaryCopiesAnExtent — a container box is not a room (report §3.2)', () => {
  // The SUNLAND run read `bounds` off block reference 1965 and pasted its four corners as
  // `roomBoundary`; every 8.70 m²/đầu figure downstream was then built on 765.42 m² of floor slab,
  // walls, corridors and shafts included.
  const containerBox: Point2D[] = [
    [9.077, 99339.6],
    [32529.207, 99339.6],
    [32529.207, 122878],
    [9.077, 122878]
  ]
  const containerRow = {
    handle: '1965',
    kind: 'blockReference',
    layer: '0',
    blockName: 'MAT-BANG-TANG-HAM',
    bounds: { min: { x: 9.077, y: 99339.6 }, max: { x: 32529.207, y: 122878 } }
  }

  it('names the indexed row whose box the polygon repeats', () => {
    const verdict = boundaryCopiesAnExtent(containerBox, { rows: [containerRow] })
    expect(verdict?.handle).toBe('1965')
    expect(verdict?.blockName).toBe('MAT-BANG-TANG-HAM')
    expect(verdict?.kind).toBe('blockReference')
  })

  it('flags a polygon that copies the whole-drawing extents', () => {
    const verdict = boundaryCopiesAnExtent(containerBox, {
      rows: [],
      extents: { min: { x: 9, y: 99339 }, max: { x: 32530, y: 122879 } }
    })
    expect(verdict?.kind).toBe('drawing extents')
    expect(verdict?.handle).toBeNull()
  })

  it('leaves a typed room alone when nothing in the index has that box', () => {
    // Same shape, different drawing: with no matching extent there is nothing to prove, and a
    // boundary written from a brief is legitimate.
    expect(boundaryCopiesAnExtent(containerBox, { rows: [] })).toBeNull()
    expect(boundaryCopiesAnExtent(containerBox, { rows: [], extents: null })).toBeNull()
  })

  it('never refuses a real outline, even one whose bbox is the container box', () => {
    // An L-shaped floor inside that block: axis-aligned bbox identical, area is not.
    const lShape: Point2D[] = [
      [9.077, 99339.6],
      [32529.207, 99339.6],
      [32529.207, 122878],
      [15000, 122878],
      [15000, 110000],
      [9.077, 110000]
    ]
    expect(boundaryCopiesAnExtent(lShape, { rows: [containerRow] })).toBeNull()
  })

  it('absorbs mm rounding but not a real difference', () => {
    const rounded: Point2D[] = [
      [9, 99340],
      [32529, 99340],
      [32529, 122878],
      [9, 122878]
    ]
    expect(boundaryCopiesAnExtent(rounded, { rows: [containerRow] })?.handle).toBe('1965')

    const smallerRoom: Point2D[] = [
      [9.077, 99339.6],
      [30000, 99339.6],
      [30000, 122878],
      [9.077, 122878]
    ]
    expect(boundaryCopiesAnExtent(smallerRoom, { rows: [containerRow] })).toBeNull()
  })
})
