import { describe, expect, test } from 'bun:test'
import {
  assembleFloorplanGeometry,
  ringFromGeometry,
  type RegionGeometrySource
} from './floorplanCadState.js'

// The shape entity.list/get `detail:'full'` (and cad.scan full) carry for a polyline — mirrored by
// the mock's polylineGeometry and the plugin's PolylineGeometryDto. If this shape drifts, ring
// extraction silently returns null and every room degrades to `unresolved`; these tests pin it.
describe('ringFromGeometry', () => {
  test('extracts a closed polyline ring from `vertices:[{point}]`', () => {
    const ring = ringFromGeometry('polyline', {
      closed: true,
      vertices: [
        { point: { x: 0, y: 0, z: 0 } },
        { point: { x: 4000, y: 0, z: 0 } },
        { point: { x: 4000, y: 5000, z: 0 } },
        { point: { x: 0, y: 5000, z: 0 } }
      ]
    })
    expect(ring).toEqual([
      [0, 0],
      [4000, 0],
      [4000, 5000],
      [0, 5000]
    ])
  })

  test('accepts the plain `points:[{x,y}]` list shape too', () => {
    const ring = ringFromGeometry('polyline', {
      closed: true,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    })
    expect(ring).toHaveLength(3)
  })

  test('an OPEN polyline yields no ring — never a half boundary', () => {
    expect(
      ringFromGeometry('polyline', {
        closed: false,
        vertices: [
          { point: { x: 0, y: 0 } },
          { point: { x: 1, y: 0 } },
          { point: { x: 1, y: 1 } }
        ]
      })
    ).toBeNull()
  })

  test('non-polyline kinds yield no ring', () => {
    expect(ringFromGeometry('blockReference', { closed: true, vertices: [{ point: { x: 0, y: 0 } }] })).toBeNull()
  })

  test('fewer than 3 finite vertices yields no ring', () => {
    expect(
      ringFromGeometry('polyline', {
        closed: true,
        vertices: [{ point: { x: 0, y: 0 } }, { point: { x: NaN, y: 1 } }, { point: { x: 1, y: 1 } }]
      })
    ).toBeNull()
  })

  test('missing geometry / missing vertex list yields no ring', () => {
    expect(ringFromGeometry('polyline', null)).toBeNull()
    expect(ringFromGeometry('polyline', { closed: true })).toBeNull()
  })
})

describe('assembleFloorplanGeometry layout scope', () => {
  test('reads the requested paper layout, not modelspace snapshot rows', async () => {
    const layoutReads: string[] = []
    const geometry = (points: Array<[number, number]>) => ({
      closed: true,
      vertices: points.map(([x, y]) => ({ point: { x, y } }))
    })
    const source: RegionGeometrySource = {
      async snapshotFor() {
        return { snapshotId: 'model-snapshot', fresh: true }
      },
      async rowsInWindow() {
        return [{ handle: 'MODEL-RING', kind: 'polyline', geometry: geometry([[16, 16], [24, 16], [24, 24], [16, 24]]) }]
      },
      async hydrate() {
        return []
      },
      async scanLayout(layoutName) {
        layoutReads.push(layoutName)
        return {
          complete: true,
          rows: [{ handle: 'LAYOUT-RING', kind: 'polyline', geometry: geometry([[10, 10], [30, 10], [30, 30], [10, 30]]) }]
        }
      }
    }

    const result = await assembleFloorplanGeometry(
      source,
      { revision: 'r1', layoutName: 'Plan-A', units: 'mm' },
      [{ name: 'PHÒNG SẢN XUẤT', labelPosition: [20, 20] }],
      [0, 0, 100, 100]
    )

    expect(layoutReads).toEqual(['Plan-A'])
    expect(result.rooms[0]?.boundary).toEqual([[10, 10], [30, 10], [30, 30], [10, 30]])
    expect(result.geometryComplete).toBe(true)
  })
})
