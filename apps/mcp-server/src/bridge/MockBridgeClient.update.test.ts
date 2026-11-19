import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * Entity.update (#26): in-place edit of an existing entity's common properties and/or kind-specific
 * geometry, keeping its handle stable. Pins MockBridgeClient's contract: only given fields change,
 * everything else keeps its exact prior value, and a geometry patch whose `kind` doesn't match the
 * handle's actual stored kind is a typed error that changes nothing.
 */

/** The mock attaches these as debug-only extras (not EntitySummary's own wire fields). */
type UpdateExtras = {
  color?: { aci: number }
  linetype?: string
  lineweight?: number
  radius?: number
  center?: { x: number; y: number; z: number }
  start?: { x: number; y: number; z: number }
  end?: { x: number; y: number; z: number }
  text?: string
  height?: number
  insertion?: { x: number; y: number; z: number }
}

describe('entity.update common properties (#26)', () => {
  test('layer/color/linetype/lineweight update in place, leaving geometry untouched', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.LayerCreate, { name: 'A-DOOR' })
    await bridge.request(RpcMethod.StyleLinetypesLoad, { names: ['DASHED'] })
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 1, y: 2, z: 0 },
      radius: 5
    })

    const { entity: updated } = await bridge.request(RpcMethod.EntityUpdate, {
      handle: created.handle,
      layer: 'A-DOOR',
      color: { aci: 3 },
      linetype: 'DASHED',
      lineweight: 30
    })
    const extras = updated as unknown as UpdateExtras

    expect(updated.handle).toBe(created.handle)
    expect(updated.layer).toBe('A-DOOR')
    expect(extras.color).toEqual({ aci: 3 })
    expect(extras.linetype).toBe('DASHED')
    expect(extras.lineweight).toBe(30)
    // Geometry (radius/center) is untouched — no `geometry` was given on this call. Create never
    // attaches circle radius/center as debug extras, but `bounds` (derived from them) is always
    // present and recomputed only on a `geometry` patch, so it proves geometry didn't move.
    expect(updated.bounds).toEqual({ min: { x: -4, y: -3, z: 0 }, max: { x: 6, y: 7, z: 0 } })
    const { entity: refetched } = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle
    })
    expect(refetched.bounds).toEqual({ min: { x: -4, y: -3, z: 0 }, max: { x: 6, y: 7, z: 0 } })
  })

  test('omitted common fields keep their current value', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 1, z: 0 }
    })

    const { entity: afterColor } = await bridge.request(RpcMethod.EntityUpdate, {
      handle: created.handle,
      color: { aci: 1 }
    })
    expect(afterColor.layer).toBe('0')

    const { entity: afterLineweight } = await bridge.request(RpcMethod.EntityUpdate, {
      handle: created.handle,
      lineweight: 50
    })
    const extras = afterLineweight as unknown as UpdateExtras
    // The earlier color change is still in effect even though this call didn't mention it.
    expect(extras.color).toEqual({ aci: 1 })
    expect(extras.lineweight).toBe(50)
  })

  test('unknown layer/linetype are typed errors and change nothing', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 1
    })

    await expect(
      bridge.request(RpcMethod.EntityUpdate, { handle: created.handle, layer: 'NOPE' })
    ).rejects.toMatchObject({
      code: BridgeErrorCode.LayerNotFound
    } satisfies Partial<BridgeRpcError>)
    await expect(
      bridge.request(RpcMethod.EntityUpdate, { handle: created.handle, linetype: 'NOPE' })
    ).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidGeometry
    } satisfies Partial<BridgeRpcError>)

    const { entity: unchanged } = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle
    })
    expect(unchanged.layer).toBe('0')
  })

  test('unknown handle is EntityNotFound', async () => {
    const bridge = new MockBridgeClient()
    await expect(
      bridge.request(RpcMethod.EntityUpdate, { handle: 'FFFFFF', layer: '0' })
    ).rejects.toMatchObject({
      code: BridgeErrorCode.EntityNotFound
    } satisfies Partial<BridgeRpcError>)
  })
})

describe('entity.update geometry patch (#26)', () => {
  test('circle: radius/center patch — only given fields change', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5
    })

    const { entity: updated } = await bridge.request(RpcMethod.EntityUpdate, {
      handle: created.handle,
      geometry: { kind: 'circle', radius: 10 }
    })
    const extras = updated as unknown as UpdateExtras

    expect(extras.radius).toBe(10)
    expect(extras.center).toEqual({ x: 0, y: 0, z: 0 })
    expect(updated.bounds).toEqual({ min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 0 } })
  })

  test('line: start/end patch', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 1, z: 0 }
    })

    const { entity: updated } = await bridge.request(RpcMethod.EntityUpdate, {
      handle: created.handle,
      geometry: { kind: 'line', end: { x: 5, y: 5, z: 0 } }
    })
    const extras = updated as unknown as UpdateExtras

    expect(extras.start).toEqual({ x: 0, y: 0, z: 0 })
    expect(extras.end).toEqual({ x: 5, y: 5, z: 0 })
  })

  test('mtext: text/height patch, insertion untouched', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'mtext',
      insertion: { x: 2, y: 3, z: 0 },
      text: 'Room 101',
      height: 2.5
    })

    const { entity: updated } = await bridge.request(RpcMethod.EntityUpdate, {
      handle: created.handle,
      geometry: { kind: 'mtext', text: 'Room 102', height: 4 }
    })
    const extras = updated as unknown as UpdateExtras

    expect(extras.text).toBe('Room 102')
    expect(extras.height).toBe(4)
    expect(extras.insertion).toEqual({ x: 2, y: 3, z: 0 })
  })

  test('mismatched kind field is rejected and the entity is unchanged', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 1, z: 0 }
    })

    await expect(
      bridge.request(RpcMethod.EntityUpdate, {
        handle: created.handle,
        geometry: { kind: 'circle', radius: 10 }
      })
    ).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidGeometry
    } satisfies Partial<BridgeRpcError>)

    const { entity: unchanged } = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle
    })
    // Create never attaches line start/end as debug extras, but `bounds` is always present and
    // only recomputed on a successful `geometry` patch, so it proves the line didn't move.
    expect(unchanged.bounds).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
  })

  test('common properties and geometry patch together in one call', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.LayerCreate, { name: 'A-DOOR' })
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 1
    })

    const { entity: updated } = await bridge.request(RpcMethod.EntityUpdate, {
      handle: created.handle,
      layer: 'A-DOOR',
      geometry: { kind: 'circle', radius: 3 }
    })
    const extras = updated as unknown as UpdateExtras

    expect(updated.layer).toBe('A-DOOR')
    expect(extras.radius).toBe(3)
  })
})
