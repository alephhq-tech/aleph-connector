import { describe, expect, test } from 'bun:test'
import {
  arrayPathPlacements,
  pathLength,
  sampleByCount,
  sampleBySpacing,
  segmentsFromArc,
  segmentsFromLine,
  segmentsFromPoints,
  segmentsFromPolyline
} from './arrayPath.js'

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 9)
const closePoint = (
  actual: { x: number; y: number; z: number },
  expected: [number, number, number?]
) => {
  close(actual.x, expected[0])
  close(actual.y, expected[1])
  close(actual.z, expected[2] ?? 0)
}

describe('pathLength', () => {
  test('line: straight-line distance', () => {
    close(pathLength(segmentsFromLine({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })), 5)
  })

  test('polyline: sum of segment lengths, closed adds the return leg', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 100, z: 0 }
    ]
    close(pathLength(segmentsFromPoints(points)), 200)
    close(pathLength(segmentsFromPolyline(points, true)), 200 + Math.hypot(100, 100))
  })

  test('arc: radius × angular span, direction-agnostic', () => {
    const ccw = segmentsFromArc({ x: 0, y: 0, z: 0 }, 50, 0, Math.PI / 2)
    close(pathLength(ccw), 50 * (Math.PI / 2))
    const cw = segmentsFromArc({ x: 0, y: 0, z: 0 }, 50, Math.PI / 2, 0)
    close(pathLength(cw), 50 * (Math.PI / 2))
  })
})

describe('sampleByCount (ARRAYPATH "Divide": count items incl. both endpoints)', () => {
  test('3-point polyline, count 3 lands on both endpoints and the exact midpoint by arc length', () => {
    // 0,0 -> 100,0 -> 100,100: total length 200, midpoint (length 100) is the corner itself.
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 100, z: 0 }
    ]
    const samples = sampleByCount(segmentsFromPoints(points), 3)
    expect(samples).toHaveLength(3)
    closePoint(samples[0]!.point, [0, 0])
    closePoint(samples[1]!.point, [100, 0])
    closePoint(samples[2]!.point, [100, 100])
  })

  test('straight line, count 5 divides into 4 equal gaps', () => {
    const samples = sampleByCount(segmentsFromLine({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 0 }), 5)
    expect(samples.map((s) => s.point.x)).toEqual([0, 100, 200, 300, 400])
  })

  test('quarter-circle arc, count 4: exact angular thirds and tangent rotates with travel', () => {
    const radius = 100
    const samples = sampleByCount(segmentsFromArc({ x: 0, y: 0, z: 0 }, radius, 0, Math.PI / 2), 4)
    const angles = [0, Math.PI / 6, Math.PI / 3, Math.PI / 2]
    samples.forEach((sample, i) => {
      closePoint(sample.point, [radius * Math.cos(angles[i]!), radius * Math.sin(angles[i]!)])
      close(sample.tangentAngle, angles[i]! + Math.PI / 2)
    })
  })
})

describe('sampleBySpacing (ARRAYPATH "Measure": items every spacing from the start)', () => {
  test('length 200, spacing 60: floor(200/60) = 3 extra items past the source, last short of the end', () => {
    const samples = sampleBySpacing(
      segmentsFromLine({ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }),
      60
    )
    expect(samples.map((s) => s.point.x)).toEqual([0, 60, 120, 180])
  })

  test('spacing exactly dividing the length lands the last item on the end', () => {
    const samples = sampleBySpacing(
      segmentsFromLine({ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }),
      50
    )
    expect(samples.map((s) => s.point.x)).toEqual([0, 50, 100, 150, 200])
  })

  test('spacing longer than the path places only the source', () => {
    const samples = sampleBySpacing(
      segmentsFromLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }),
      50
    )
    expect(samples).toHaveLength(1)
    closePoint(samples[0]!.point, [0, 0])
  })

  test('arc, spacing = quarter of the arc length: 5 points at equal angular steps', () => {
    const radius = 100
    const segments = segmentsFromArc({ x: 0, y: 0, z: 0 }, radius, 0, Math.PI / 2)
    const total = pathLength(segments)
    const samples = sampleBySpacing(segments, total / 4)
    expect(samples).toHaveLength(5)
    closePoint(samples[4]!.point, [0, radius])
  })
})

describe('arrayPathPlacements', () => {
  test('delta/angleDelta are relative to the first sample, first entry is zero', () => {
    const samples = sampleByCount(
      segmentsFromLine({ x: 10, y: 20, z: 0 }, { x: 10, y: 220, z: 0 }),
      3
    )
    const placements = arrayPathPlacements(samples)
    closePoint(placements[0]!.delta, [0, 0])
    close(placements[0]!.angleDelta, 0)
    closePoint(placements[1]!.delta, [0, 100])
    closePoint(placements[2]!.delta, [0, 200])
  })
})
