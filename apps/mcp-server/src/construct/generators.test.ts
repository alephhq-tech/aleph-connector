import { describe, expect, test } from 'bun:test'
import { dimensionChain, grid, room, roomArea, walls } from './generators.js'

const pointsOf = (step: { entity: unknown }): Array<[number, number]> =>
  (step.entity as { points: { x: number; y: number }[] }).points.map(
    ({ x, y }) => [x, y] as [number, number]
  )

/** Mitered joins carry float noise; compare coordinates at drafting precision. */
const roundX = (points: Array<[number, number]>) => points.map(([x]) => Math.round(x * 1e6) / 1e6)

describe('walls', () => {
  test('L-shaped open run, centre-justified: one closed outline with mitred corners', () => {
    const [outline, ...rest] = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 3000 }
      ],
      thickness: 200
    })
    expect(rest).toHaveLength(0)
    expect(outline!.label).toBe('walls.outline')
    // Left face (inside of the turn) then right face reversed.
    expect(pointsOf(outline!)).toEqual([
      [0, 100],
      [3900, 100],
      [3900, 3000],
      [4100, 3000],
      [4100, -100],
      [0, -100]
    ])
  })

  test('closed rectangular run, left-justified: the given line is a face', () => {
    const [left, right] = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 500 },
        { x: 0, y: 500 }
      ],
      thickness: 100,
      closed: true,
      justification: 'left'
    })
    expect(pointsOf(left!)).toEqual([
      [0, 0],
      [1000, 0],
      [1000, 500],
      [0, 500]
    ])
    expect(pointsOf(right!)).toEqual([
      [-100, -100],
      [1100, -100],
      [1100, 600],
      [-100, 600]
    ])
  })

  // The gap, not the arc, is what makes a door a door: an opening must remove wall geometry.
  test('open run with one door: two pieces with a real gap between them', () => {
    const steps = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 6000, y: 0 }
      ],
      thickness: 200,
      openings: [{ along: 3000, width: 900 }]
    })
    expect(steps.map((s) => s.label)).toEqual(['walls.segment1', 'walls.segment2'])
    // Door spans s=2550..3450, so the wall stops short of it on both sides.
    expect(roundX(pointsOf(steps[0]!))).toEqual([0, 2550, 2550, 0])
    expect(roundX(pointsOf(steps[1]!))).toEqual([3450, 6000, 6000, 3450])
  })

  test('an opening given as a point is projected onto the centreline, not snapped to a vertex', () => {
    const steps = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 6000, y: 0 }
      ],
      thickness: 200,
      // 1200 above the wall: still resolves to the same arc-length as along: 3000.
      openings: [{ at: { x: 3000, y: 1200 }, width: 900 }]
    })
    expect(pointsOf(steps[0]!).map(([x]) => x)).toEqual([0, 2550, 2550, 0])
  })

  test('two nearby openings merge instead of leaving a hairline sliver', () => {
    const steps = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 6000, y: 0 }
      ],
      thickness: 200,
      openings: [
        { along: 2000, width: 1000 }, // 1500..2500
        { along: 2600, width: 1000 } // 2100..3100
      ]
    })
    // Overlapping cuts merge to one 1500..3100 gap, so exactly two pieces remain.
    expect(steps).toHaveLength(2)
    expect(roundX(pointsOf(steps[0]!))).toEqual([0, 1500, 1500, 0])
    expect(roundX(pointsOf(steps[1]!))).toEqual([3100, 6000, 6000, 3100])
  })

  test('an L-shaped run keeps its corner when the opening is on one leg', () => {
    const steps = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 3000 }
      ],
      thickness: 200,
      openings: [{ along: 1000, width: 900 }]
    })
    expect(steps).toHaveLength(2)
    // Second piece runs from the end of the door to the far end, through the mitred corner.
    expect(pointsOf(steps[1]!)).toEqual([
      [1450, 100],
      [3900, 100],
      [3900, 3000],
      [4100, 3000],
      [4100, -100],
      [1450, -100]
    ])
  })

  test('closed ring with one opening: the wall stops short of the gap on both sides', () => {
    const steps = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
        { x: 0, y: 1000 }
      ],
      thickness: 100,
      closed: true,
      // Midway along the first edge: s=500 of perimeter 4000, so the cut spans 250..750.
      openings: [{ along: 500, width: 500 }]
    })
    // The solid run wraps the start vertex, so it is drawn as two pieces meeting there.
    expect(steps).toHaveLength(2)
    expect(roundX(pointsOf(steps[0]!))).toEqual([750, 950, 950, 50, 50, -50, -50, 1050, 1050, 750])
    expect(roundX(pointsOf(steps[1]!))).toEqual([0, 250, 250, 0])
    // No vertex sits inside the opening band along the wall's centreline row.
    for (const step of steps)
      for (const [x, y] of pointsOf(step)) if (y === 0) expect(x <= 250 || x >= 750).toBe(true)
  })

  test('an opening straddling the start of a closed ring still cuts one gap', () => {
    const steps = walls({
      centerline: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
        { x: 0, y: 1000 }
      ],
      thickness: 100,
      closed: true,
      // s=0 is the seam: the cut wraps as 3800..4000 + 0..200, leaving one solid run 200..3800.
      openings: [{ along: 0, width: 400 }]
    })
    expect(steps).toHaveLength(1)
    const pts = pointsOf(steps[0]!)
    expect(pts[0]).toEqual([200, 50])
    expect(pts[pts.length - 1]).toEqual([200, -50])
    for (const [x, y] of pts) if (y === 0) expect(x >= 200).toBe(true)
  })

  test('openings that consume the whole run are rejected, not silently drawn', () => {
    expect(() =>
      walls({
        centerline: [
          { x: 0, y: 0 },
          { x: 1000, y: 0 }
        ],
        thickness: 200,
        openings: [{ along: 500, width: 1200 }]
      })
    ).toThrow(/cover the whole wall/)
  })

  test('an opening with no position is rejected with a usable message', () => {
    expect(() =>
      walls({
        centerline: [
          { x: 0, y: 0 },
          { x: 1000, y: 0 }
        ],
        thickness: 200,
        openings: [{ width: 900 }]
      })
    ).toThrow(/at \(a point near the wall\) or along/)
  })
})

describe('grid', () => {
  test('uneven x spacings and count-based y axes', () => {
    const steps = grid({
      origin: { x: 0, y: 0 },
      x: { spacings: [6000, 4500] },
      y: { count: 2, spacing: 5000 },
      extension: 1000,
      bubbleRadius: 400
    })
    const axes = steps.filter((s) => s.label.startsWith('grid.axis.'))
    expect(axes.map((s) => s.label)).toEqual([
      'grid.axis.1',
      'grid.axis.2',
      'grid.axis.3',
      'grid.axis.A',
      'grid.axis.B'
    ])
    expect(axes[2]!.entity).toMatchObject({
      start: { x: 10500, y: -1000 },
      end: { x: 10500, y: 6000 }
    })
    expect(axes[4]!.entity).toMatchObject({
      start: { x: -1000, y: 5000 },
      end: { x: 11500, y: 5000 }
    })
    const bubbleA = steps.find((s) => s.label === 'grid.bubble.A')!
    expect(bubbleA.entity).toMatchObject({
      kind: 'circle',
      center: { x: -1400, y: 0 },
      radius: 400
    })
    expect(steps).toHaveLength(5 * 3) // axis + bubble + label each
  })

  test('row letters skip I and O', () => {
    const steps = grid({
      origin: { x: 0, y: 0 },
      x: { count: 1, spacing: 1 },
      y: { count: 10, spacing: 1 },
      extension: 0,
      bubbleRadius: 1
    })
    const rows = steps
      .filter((s) => /^grid\.axis\.[A-Z]+$/.test(s.label))
      .map((s) => s.label.slice(10))
    expect(rows).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'])
  })
})

describe('room', () => {
  const lShape = [
    { x: 0, y: 0 },
    { x: 6000, y: 0 },
    { x: 6000, y: 2000 },
    { x: 2000, y: 2000 },
    { x: 2000, y: 5000 },
    { x: 0, y: 5000 }
  ]

  test('non-convex area in m² for a millimetre drawing', () => {
    expect(roomArea(lShape, 'mm')).toBeCloseTo(18, 9) // 6×2 + 2×3
  })

  test('outline, name and area label, label inside the room', () => {
    const [outline, name, area] = room({ outline: lShape, name: 'KITCHEN', textHeight: 250 })
    expect(outline!.entity).toMatchObject({ kind: 'polyline', closed: true })
    expect(name!.entity).toMatchObject({ kind: 'text.singleLine', text: 'KITCHEN', height: 250 })
    expect(area!.entity).toMatchObject({ text: '18.00 m²' })
  })
})

describe('dimensionChain', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 900, y: 0 },
    { x: 2400, y: 0 },
    { x: 4000, y: 0 }
  ]

  test('continue: consecutive pairs on one line', () => {
    const steps = dimensionChain({
      points,
      mode: 'continue',
      direction: 'horizontal',
      offset: -800
    })
    expect(steps).toHaveLength(3)
    expect(steps.map((s) => (s.entity as { dimLinePoint: { y: number } }).dimLinePoint.y)).toEqual([
      -800, -800, -800
    ])
    expect(steps[1]!.entity).toMatchObject({
      extLine1: { x: 900 },
      extLine2: { x: 2400 },
      rotation: 0
    })
  })

  test('baseline: all from the first point, stacked by spacing; vertical rotates π/2', () => {
    const steps = dimensionChain({
      points: points.map(({ x, y }) => ({ x: y, y: x })),
      mode: 'baseline',
      direction: 'vertical',
      offset: 500,
      spacing: 400
    })
    expect(steps.map((s) => (s.entity as { dimLinePoint: { x: number } }).dimLinePoint.x)).toEqual([
      500, 900, 1300
    ])
    expect(steps[2]!.entity).toMatchObject({
      extLine1: { y: 0 },
      extLine2: { y: 4000 },
      rotation: Math.PI / 2
    })
  })

  test('points that coincide along the direction are rejected', () => {
    expect(() =>
      dimensionChain({
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 5 }
        ],
        mode: 'continue',
        direction: 'horizontal',
        offset: 1
      })
    ).toThrow(/coincide/)
  })
})
