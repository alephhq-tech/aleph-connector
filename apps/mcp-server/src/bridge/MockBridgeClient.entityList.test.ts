import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * Entity.list pagination/filter/count/includeBounds (#10). entity.list used to build a summary
 * (including entity.Bounds, the expensive part) of every entity in model space before applying
 * offset/limit; a page cost the same as listing the whole drawing. These pin the corrected contract
 * on MockBridgeClient's real filter+count+page+conditional-bounds pipeline: real behavior,
 * boundaries, not internal call order or timing (no real AutoCAD available here).
 */

async function seed(bridge: MockBridgeClient, count: number, layer?: string): Promise<string[]> {
  if (layer) await bridge.request(RpcMethod.LayerCreate, { name: layer })
  const handles: string[] = []
  for (let i = 0; i < count; i++) {
    const { entity } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: i, y: 0, z: 0 },
      radius: 1,
      layer
    })
    handles.push(entity.handle)
  }
  return handles
}

describe('entity.list pagination/filter/count (#10)', () => {
  test('total counts every match, independent of limit/offset', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 12)
    const page = await bridge.request(RpcMethod.EntityList, { limit: 3 })
    expect(page.total).toBe(12)
    expect(page.entities).toHaveLength(3)
  })

  test('ordering stays model-space (creation) order and offset/limit page correctly', async () => {
    const bridge = new MockBridgeClient()
    const handles = await seed(bridge, 10)
    const page = await bridge.request(RpcMethod.EntityList, { offset: 3, limit: 4 })
    expect(page.entities.map((e) => e.handle)).toEqual(handles.slice(3, 7))
    expect(page.total).toBe(10)
  })

  test('offset beyond total returns no entities but the correct total', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 5)
    const page = await bridge.request(RpcMethod.EntityList, { offset: 100, limit: 10 })
    expect(page.entities).toEqual([])
    expect(page.total).toBe(5)
  })

  test('layer filter narrows both the page and the total', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 3, 'A')
    await seed(bridge, 5, 'B')
    const page = await bridge.request(RpcMethod.EntityList, { layer: 'B', limit: 100 })
    expect(page.total).toBe(5)
    expect(page.entities.every((e) => e.layer === 'B')).toBe(true)
  })

  test('kind filter narrows both the page and the total', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 4)
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 1, z: 0 }
    })
    const page = await bridge.request(RpcMethod.EntityList, { kind: 'line', limit: 100 })
    expect(page.total).toBe(1)
    expect(page.entities[0]?.kind).toBe('line')
  })

  test('default limit is 100 when omitted', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 150)
    const page = await bridge.request(RpcMethod.EntityList, {})
    expect(page.entities).toHaveLength(100)
    expect(page.total).toBe(150)
  })
})

describe('entity.list includeBounds (#10)', () => {
  test("omitted/true keeps every entity's bounds, identical to pre-#10 behavior", async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 3)
    const omitted = await bridge.request(RpcMethod.EntityList, {})
    const explicitTrue = await bridge.request(RpcMethod.EntityList, { includeBounds: true })
    expect(omitted.entities.every((e) => e.bounds !== undefined)).toBe(true)
    expect(explicitTrue).toEqual(omitted)
  })

  test('false omits bounds from every returned entity without changing entities/total/order', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 4)
    const withBounds = await bridge.request(RpcMethod.EntityList, {})
    const noBounds = await bridge.request(RpcMethod.EntityList, { includeBounds: false })
    expect(noBounds.total).toBe(withBounds.total)
    expect(noBounds.entities.map((e) => e.handle)).toEqual(withBounds.entities.map((e) => e.handle))
    expect(noBounds.entities.every((e) => e.bounds === undefined)).toBe(true)
    expect(
      noBounds.entities.map((e) => ({ handle: e.handle, kind: e.kind, layer: e.layer }))
    ).toEqual(withBounds.entities.map((e) => ({ handle: e.handle, kind: e.kind, layer: e.layer })))
  })
})

describe('entity.list limit cap (#10)', () => {
  test('a limit above the cap is rejected with InvalidGeometry, not silently clamped', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 2)
    await expect(bridge.request(RpcMethod.EntityList, { limit: 1001 })).rejects.toThrow(
      BridgeRpcError
    )
    try {
      await bridge.request(RpcMethod.EntityList, { limit: 1001 })
      throw new Error('expected rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.InvalidGeometry)
    }
  })

  test('a limit exactly at the cap is accepted', async () => {
    const bridge = new MockBridgeClient()
    await seed(bridge, 2)
    const page = await bridge.request(RpcMethod.EntityList, { limit: 1000 })
    expect(page.total).toBe(2)
  })
})
