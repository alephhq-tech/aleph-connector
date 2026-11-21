import { describe, expect, test } from 'bun:test'
import type { EntityDetail } from '@aleph-connector/cad-types'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * `entity.get`/`entity.list`'s `detail: "full"` (#25): geometry + common properties beyond layer,
 * round-tripped from exactly what `entity.create` recorded (`MockBridgeClient`'s `entityGeometry`
 * map) — real behavior, boundaries, not internal call order (no real AutoCAD available here).
 *
 * `EntitySummary`'s `kind` field is the full `EntityKind` union (not a per-kind literal), so
 * checking `entity.kind === "circle"` alone can't narrow away the `EntitySummary` branch of
 * `EntitySummary | EntityDetail` — `requireDetail` narrows on `"geometry" in entity` first, which
 * only `EntityDetail` has.
 */
function requireDetail(entity: object): EntityDetail {
  if (!('geometry' in entity)) throw new Error("expected detail:'full' to return an EntityDetail")
  return entity as EntityDetail
}

describe('entity.get detail:full (#25)', () => {
  test("detail omitted returns exactly today's EntitySummary shape (backwards compatible)", async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5
    })
    const { entity } = await bridge.request(RpcMethod.EntityGet, { handle: created.handle })
    expect(Object.keys(entity).sort()).toEqual(['bounds', 'handle', 'kind', 'layer'])
    expect(entity).not.toHaveProperty('properties')
    expect(entity).not.toHaveProperty('geometry')
  })

  test("detail:'summary' is identical to detail omitted", async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5
    })
    const omitted = await bridge.request(RpcMethod.EntityGet, { handle: created.handle })
    const summary = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'summary'
    })
    expect(summary).toEqual(omitted)
  })

  test('circle: center/radius round-trip, properties default to ByLayer/visible', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 10, y: 20, z: 0 },
      radius: 7.5
    })
    const got = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'full'
    })
    const entity = requireDetail(got.entity)
    expect(entity.kind).toBe('circle')
    if (entity.kind !== 'circle') throw new Error('expected circle')
    expect(entity.geometry).toEqual({ center: { x: 10, y: 20, z: 0 }, radius: 7.5 })
    expect(entity.properties).toEqual({
      color: { aci: 256 },
      linetype: 'ByLayer',
      linetypeScale: 1,
      lineweight: -1,
      visible: true
    })
  })

  test('polyline: vertices/closed/length round-trip, bulge/width only on vertices that set them', async () => {
    const bridge = new MockBridgeClient()
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 }
    ]
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'polyline',
      points,
      closed: true,
      bulges: [0, 0.5, 0]
    })
    const got = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'full'
    })
    const entity = requireDetail(got.entity)
    expect(entity.kind).toBe('polyline')
    if (entity.kind !== 'polyline') throw new Error('expected polyline')
    expect(entity.geometry.closed).toBe(true)
    expect(entity.geometry.vertices).toEqual([
      { point: points[0]! },
      { point: points[1]!, bulge: 0.5 },
      { point: points[2]! }
    ])
    expect(entity.geometry.length).toBeCloseTo(10 + 10 + Math.hypot(10, 10))
    expect(entity.geometry.area).toBe(50)
  })

  test("rectangle reads back as kind 'polyline' with 4 vertices (documented AutoCAD behavior)", async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'rectangle',
      corner1: { x: 0, y: 0, z: 0 },
      corner2: { x: 4, y: 3, z: 0 }
    })
    const got = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'full'
    })
    const entity = requireDetail(got.entity)
    expect(entity.kind).toBe('polyline')
    if (entity.kind !== 'polyline') throw new Error('expected polyline')
    expect(entity.geometry.vertices).toHaveLength(4)
    expect(entity.geometry.closed).toBe(true)
    expect(entity.geometry.area).toBe(12)
  })

  test('text.singleLine: insertion/text/height/rotation/style round-trip', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'text.singleLine',
      insertion: { x: 1, y: 2, z: 0 },
      text: 'PUMP-101',
      height: 3,
      rotation: 1.5707963267948966
    })
    const got = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'full'
    })
    const entity = requireDetail(got.entity)
    expect(entity.kind).toBe('text.singleLine')
    if (entity.kind !== 'text.singleLine') throw new Error('expected text.singleLine')
    expect(entity.geometry.insertion).toEqual({ x: 1, y: 2, z: 0 })
    expect(entity.geometry.text).toBe('PUMP-101')
    expect(entity.geometry.height).toBe(3)
    expect(entity.geometry.rotation).toBe(1.5707963267948966)
    expect(entity.geometry.style).toBe('Standard')
  })

  test('dimension.linear: measurement is the real computed distance, not an echo of the input points', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'dimension.linear',
      extLine1: { x: 0, y: 0, z: 0 },
      extLine2: { x: 30, y: 0, z: 0 },
      dimLinePoint: { x: 0, y: 10, z: 0 }
    })
    const got = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'full'
    })
    const entity = requireDetail(got.entity)
    expect(entity.kind).toBe('dimension.linear')
    if (entity.kind !== 'dimension.linear') throw new Error('expected dimension.linear')
    expect(entity.geometry.extLine1).toEqual({ x: 0, y: 0, z: 0 })
    expect(entity.geometry.extLine2).toEqual({ x: 30, y: 0, z: 0 })
    expect(entity.geometry.measurement).toBe(30)
    expect(typeof entity.geometry.text).toBe('string')
  })

  test('hatch: pattern/scale/angle/associative/loopCount/loopTypes round-trip', async () => {
    const bridge = new MockBridgeClient()
    const { entity: boundary } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'polyline',
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 10, z: 0 },
        { x: 0, y: 10, z: 0 }
      ],
      closed: true
    })
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'hatch',
      boundaryHandles: [boundary.handle],
      pattern: 'ANSI31',
      patternScale: 2,
      patternAngle: 0.5,
      associative: true
    })
    const got = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'full'
    })
    const entity = requireDetail(got.entity)
    expect(entity.kind).toBe('hatch')
    if (entity.kind !== 'hatch') throw new Error('expected hatch')
    expect(entity.geometry.pattern).toBe('ANSI31')
    expect(entity.geometry.patternScale).toBe(2)
    expect(entity.geometry.patternAngle).toBe(0.5)
    expect(entity.geometry.associative).toBe(true)
    expect(entity.geometry.loopCount).toBe(1)
    expect(entity.geometry.loopTypes).toEqual(['Default'])
    expect(entity.geometry.boundaryLoops).toBeDefined()
    expect(entity.geometry.boundaryLoops?.[0]?.closed).toBe(true)
    expect(entity.geometry.boundaryLoops?.[0]?.vertices).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
      { x: 0, y: 10, z: 0 }
    ])
  })

  test('blockReference: nestedGeometry returns mapped geometry with xref flag', async () => {
    const bridge = new MockBridgeClient()
    const { entity: created } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'DOOR',
      position: { x: 5, y: 10, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: 0
    })
    const got = await bridge.request(RpcMethod.EntityGet, {
      handle: created.handle,
      detail: 'full'
    })
    const entity = requireDetail(got.entity)
    expect(entity.kind).toBe('blockReference')
    if (entity.kind !== 'blockReference') throw new Error('expected blockReference')
    expect(entity.geometry.nestedGeometry).toBeDefined()
    expect(entity.geometry.nestedGeometry?.isXref).toBe(false)
    expect(entity.geometry.nestedGeometry?.truncated).toBe(false)
    expect(Array.isArray(entity.geometry.nestedGeometry?.entities)).toBe(true)
  })
})

describe('entity.list detail:full (#25)', () => {
  test("default (omitted) keeps today's EntitySummary shape for every entity", async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 1
    })
    const { entities } = await bridge.request(RpcMethod.EntityList, {})
    expect(entities[0]).not.toHaveProperty('geometry')
  })

  test("'full' returns an EntityDetail per entity, respecting includeBounds:false", async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 3
    })
    const { entities } = await bridge.request(RpcMethod.EntityList, {
      detail: 'full',
      includeBounds: false
    })
    expect(entities).toHaveLength(1)
    const entity = requireDetail(entities[0]!)
    expect(entity).toHaveProperty('geometry')
    expect(entity).toHaveProperty('properties')
    expect(entity.bounds).toBeUndefined()
  })
})
