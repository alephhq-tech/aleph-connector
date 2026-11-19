import { describe, expect, it } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

describe('entity.traceBoundary RPC method', () => {
  it('returns found:false when pick point is outside any boundary', async () => {
    const client = new MockBridgeClient()
    const res = await client.request(RpcMethod.EntityTraceBoundary, {
      point: { x: 500, y: 500, z: 0 }
    })
    expect(res.found).toBe(false)
    expect(res.boundaries.length).toBe(0)
    expect(res.netArea).toBe(0)
    // E1 wire contract: every result states its coordinate system even when nothing was traced.
    expect(res.coordinateSystem).toBe('WCS')
    expect(res.ucsWithWorld).toBe(true)
  })

  it('detects closed polyline boundary around pick point and computes real area', async () => {
    const client = new MockBridgeClient()

    // Create a 2000x2000 room polyline (e.g. elevator shaft: [1000, 1000] to [3000, 3000])
    await client.request(RpcMethod.EntityCreate, {
      kind: 'polyline',
      layer: '0',
      points: [
        { x: 1000, y: 1000, z: 0 },
        { x: 3000, y: 1000, z: 0 },
        { x: 3000, y: 3000, z: 0 },
        { x: 1000, y: 3000, z: 0 }
      ],
      closed: true
    })

    // Pick inside the room at [2000, 2000]
    const res = await client.request(RpcMethod.EntityTraceBoundary, {
      point: { x: 2000, y: 2000, z: 0 }
    })

    expect(res.found).toBe(true)
    expect(res.boundaries.length).toBe(1)
    expect(res.boundaries[0]!.isClosed).toBe(true)
    expect(res.boundaries[0]!.points.length).toBe(4)
    expect(res.netArea).toBe(4_000_000) // 2000 * 2000 = 4,000,000 mm² (4 m²)
    // E1 wire contract: the traced ring is reported in WCS regardless of the active UCS; the mock
    // traces World-coordinate polylines, so ucsWithWorld is true on its path.
    expect(res.coordinateSystem).toBe('WCS')
    expect(res.ucsWithWorld).toBe(true)
  })
})
