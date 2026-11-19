import { describe, expect, test } from 'bun:test'
import {
  arcStartEndRadius,
  arcThroughPoints,
  circleThroughPoints,
  donutVertices,
  polygonVertices,
  rectangleVertices
} from './shapes.js'

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 9)

describe('polygonVertices', () => {
  test('inscribed hexagon r=50: vertices on the circle, first at rotation 0', () => {
    const v = polygonVertices({ x: 0, y: 0 }, 6, 50)
    expect(v).toHaveLength(6)
    for (const p of v) close(Math.hypot(p.x, p.y), 50)
    close(v[0]!.x, 50)
    close(v[0]!.y, 0)
  })

  test('circumscribed square: edge midpoints on the circle', () => {
    const [a, b] = polygonVertices({ x: 0, y: 0 }, 4, 10, 'circumscribed')
    close(Math.hypot((a!.x + b!.x) / 2, (a!.y + b!.y) / 2), 10)
    close(Math.hypot(a!.x, a!.y), 10 * Math.SQRT2)
  })
})

describe('rectangleVertices', () => {
  test('rotated 90° about corner1', () => {
    const [p0, p1, p2, p3] = rectangleVertices({ x: 10, y: 10 }, 4, 2, Math.PI / 2)
    close(p1!.point.x, 10)
    close(p1!.point.y, 14)
    close(p2!.point.x, 8)
    close(p2!.point.y, 14)
    expect([p0!.point.x, p0!.point.y]).toEqual([10, 10])
    close(p3!.point.x, 8)
    for (const p of [p0, p1, p2, p3]) expect(p!.bulge).toBe(0)
  })

  test('chamfered: 8 vertices, bulge 0 throughout, oversized chamfer rejected', () => {
    const v = rectangleVertices({ x: 0, y: 0 }, 100, 50, 0, { d1: 10, d2: 5 })
    expect(v).toHaveLength(8)
    expect(v[0]).toEqual({ point: { x: 10, y: 0 }, bulge: 0 })
    for (const p of v) expect(p.bulge).toBe(0)
    expect(() => rectangleVertices({ x: 0, y: 0 }, 100, 50, 0, { d1: 30, d2: 5 })).toThrow(
      /half the shorter/
    )
  })

  test('filleted: 8 vertices, tangent points at radius from each corner, bulge on the arc segments', () => {
    const v = rectangleVertices({ x: 0, y: 0 }, 100, 50, 0, undefined, 10)
    expect(v).toHaveLength(8)
    // Same tangent-point layout as chamfer d1=d2=radius, but with the fillet bulge on the arcs.
    expect(v[0]).toEqual({ point: { x: 10, y: 0 }, bulge: 0 })
    expect(v[1]!.point).toEqual({ x: 90, y: 0 })
    close(v[1]!.bulge, Math.tan(Math.PI / 8))
    close(v[3]!.bulge, Math.tan(Math.PI / 8))
    close(v[5]!.bulge, Math.tan(Math.PI / 8))
    close(v[7]!.bulge, Math.tan(Math.PI / 8))
    expect(() => rectangleVertices({ x: 0, y: 0 }, 100, 50, 0, undefined, 30)).toThrow(
      /half the shorter/
    )
  })

  test('mirrored (negative width) flips the fillet bulge sign to keep the arc curving inward', () => {
    const v = rectangleVertices({ x: 0, y: 0 }, -100, 50, 0, undefined, 10)
    close(v[1]!.bulge, -Math.tan(Math.PI / 8))
  })
})

describe('donutVertices', () => {
  test('outer/inner edges land at the requested radii', () => {
    const { points, bulges, width } = donutVertices({ x: 0, y: 0 }, 20, 40)
    expect(bulges).toEqual([1, 1])
    close(width, 10)
    // Midradius = (20+40)/4 = 15; outer edge = 15 + 10/2 = 20 = outerDiameter/2. ✓
    close(Math.hypot(points[0]!.x, points[0]!.y), 15)
    expect(points[1]).toEqual({ x: -15, y: 0 })
  })

  test('innerDiameter: 0 degenerates to a filled dot', () => {
    const { width } = donutVertices({ x: 0, y: 0 }, 0, 40)
    close(width, 20) // inner edge = midradius(10) - width/2(20/2=10) = 0
  })

  test('outerDiameter must exceed innerDiameter', () => {
    expect(() => donutVertices({ x: 0, y: 0 }, 40, 40)).toThrow(/outerDiameter/)
    expect(() => donutVertices({ x: 0, y: 0 }, 50, 40)).toThrow(/outerDiameter/)
  })
})

describe('polygonVertices edge form (derived in normalize.ts, checked here at the geometry level)', () => {
  test('center/radius/rotation derived from an edge reproduce that edge as two adjacent vertices', () => {
    // Edge from (10,0) to (10+10*cos(60°), 10*sin(60°)) for a hexagon: verify by re-deriving the
    // same center a hexagon's edge form would compute, then checking polygonVertices reproduces it.
    const sides = 6
    const edgeStart = { x: 10, y: 0 }
    const edgeEnd = { x: 5, y: 8.660254037844386 } // 10 * (cos(120°), sin(120°))
    const dx = edgeEnd.x - edgeStart.x
    const dy = edgeEnd.y - edgeStart.y
    const edgeLength = Math.hypot(dx, dy)
    const radius = edgeLength / 2 / Math.sin(Math.PI / sides)
    const apothem = radius * Math.cos(Math.PI / sides)
    const ux = dx / edgeLength
    const uy = dy / edgeLength
    const mid = { x: (edgeStart.x + edgeEnd.x) / 2, y: (edgeStart.y + edgeEnd.y) / 2 }
    const center = { x: mid.x - uy * apothem, y: mid.y + ux * apothem }
    const rotation = Math.atan2(edgeStart.y - center.y, edgeStart.x - center.x)
    const v = polygonVertices(center, sides, radius, 'inscribed', rotation)
    close(v[0]!.x, edgeStart.x)
    close(v[0]!.y, edgeStart.y)
    close(v[1]!.x, edgeEnd.x)
    close(v[1]!.y, edgeEnd.y)
  })
})

describe('circles and arcs', () => {
  test('circle through three points; collinear rejected', () => {
    const { center, radius } = circleThroughPoints(
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 0 }
    )
    close(center.x, 50)
    close(center.y, 0)
    close(radius, 50)
    expect(() => circleThroughPoints({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toThrow(
      /collinear/
    )
  })

  test('3-point arc over the top runs start → end counter-clockwise… as end → start', () => {
    // (0,0) → (50,50) → (100,0) is clockwise, so the CCW arc goes from 0 to π.
    const arc = arcThroughPoints({ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 })
    close(arc.startAngle, 0)
    close(arc.endAngle, Math.PI)
    // The same points below the chord are counter-clockwise already: π → 0 (= 2π).
    const below = arcThroughPoints({ x: 0, y: 0 }, { x: 50, y: -50 }, { x: 100, y: 0 })
    close(below.startAngle, Math.PI)
    close(below.endAngle, 0)
  })

  test('start-end-radius: ccw minor arc centre on the left, cw on the right', () => {
    const ccw = arcStartEndRadius({ x: 0, y: 0 }, { x: 100, y: 0 }, 50)
    close(ccw.center.x, 50)
    close(ccw.center.y, 0)
    const quarter = arcStartEndRadius({ x: 0, y: 0 }, { x: 10, y: 10 }, 10, 'ccw')
    expect([quarter.center.x, quarter.center.y].map((n) => Math.round(n * 1e9) / 1e9)).toEqual([
      0, 10
    ])
    const cw = arcStartEndRadius({ x: 0, y: 0 }, { x: 10, y: 10 }, 10, 'cw')
    expect([cw.center.x, cw.center.y].map((n) => Math.round(n * 1e9) / 1e9)).toEqual([10, 0])
    expect(() => arcStartEndRadius({ x: 0, y: 0 }, { x: 100, y: 0 }, 10)).toThrow(/half the chord/)
  })
})
