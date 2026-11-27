import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, RpcMethod } from '@aleph-connector/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'
import { entityInputSchema, registerEntityTools } from './entity.js'
import { portableInputSchema } from './portableSchema.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'

/**
 * The `entity` tool's flattened (tools/list) schema — same posture as portableSchema.test.ts:
 * building it at all is the collision assertion, since flattenOperationUnion throws on two
 * operations sharing a field name with incompatible type/bounds.
 */
function flattenEntity(): Record<string, unknown> {
  const standard = portableInputSchema(entityInputSchema)['~standard']
  return standard.jsonSchema.input({ target: 'draft-07' }) as Record<string, unknown>
}

describe('entity.list window region filter', () => {
  test('the flattened schema has `window` and no field-name collision throw', () => {
    const schema = flattenEntity()
    const properties = schema.properties as Record<string, { type?: string }>
    expect(properties.window).toBeDefined()
    // `window` is new to the entity tool's union — nothing else in this tool declares it, so the
    // per-tool flatten guard has nothing to collide with.
    expect(() => flattenEntity()).not.toThrow()
  })

  test('the list operation parses a window in compact [x,y] point form', () => {
    const parsed = entityInputSchema.safeParse({
      operation: 'list',
      window: { min: [0, 0], max: [100, 100] }
    })
    expect(parsed.success).toBe(true)
  })
})

/** Records method/params/options for every request, delegating to the real mock (refs.test.ts pattern). */
class SpyBridgeClient implements BridgeClient {
  readonly inner = new MockBridgeClient()
  readonly calls: {
    method: RpcMethodName
    params: RpcMethodMap[typeof RpcMethod.EntityList]['params'] | unknown
    options?: BridgeRequestOptions
  }[] = []

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    this.calls.push({ method, params, options })
    return this.inner.request(method, params, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

type EntityHandler = (
  input: unknown,
  ctx: { mcpReq: { id: number; signal?: AbortSignal } }
) => Promise<unknown>

/**
 * Drives the real `entity` tool handler (no transport): a test double for McpServer capturing the
 * callback registerEntityTools passes. Only registerTool is exercised; McpServer's transport/
 * notification surface is irrelevant here, hence the named-const cast to the parameter type.
 */
function entityHandler(spy: SpyBridgeClient): EntityHandler {
  let handler!: EntityHandler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: EntityHandler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerEntityTools>[0]
  registerEntityTools(serverDouble, spy)
  return handler
}

describe('entity.list window reaches the wire and filters', () => {
  test('the window passthrough lands in the entity.list wire params', async () => {
    const spy = new SpyBridgeClient()
    const handler = entityHandler(spy)
    await handler(
      { operation: 'list', window: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 0 } } },
      { mcpReq: { id: 1 } }
    )
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.method).toBe(RpcMethod.EntityList)
    expect(spy.calls[0]!.params).toMatchObject({
      window: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 0 } }
    })
  })

  test("MockBridgeClient's window filter narrows both the page and the total", async () => {
    // The mock mirrors the plugin's skip-before-count semantics, so `total` means "matches the
    // filters" — a region query reads as its own count, not the whole drawing's.
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.LayerCreate, { name: 'A-WALL', color: { aci: 1 } })
    const inside = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      layer: 'A-WALL',
      start: { x: 10, y: 10, z: 0 },
      end: { x: 20, y: 10, z: 0 }
    })
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      layer: 'A-WALL',
      start: { x: 5000, y: 5000, z: 0 },
      end: { x: 5010, y: 5000, z: 0 }
    })

    const region = await bridge.request(RpcMethod.EntityList, {
      window: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 0 } }
    })
    expect(region.total).toBe(1)
    expect(region.entities.map((e) => e.handle)).toEqual([inside.entity.handle])

    const whole = await bridge.request(RpcMethod.EntityList, {})
    expect(whole.total).toBe(2)
  })
})

describe('entity.area_measure', () => {
  test("the flattened schema carries area_measure's fields with no collision throw", () => {
    const schema = flattenEntity()
    const properties = schema.properties as Record<string, { type?: string }>
    expect(properties.handles).toBeDefined()
    expect(properties.selection).toBeDefined()
    expect(properties.outputUnit).toBeDefined()
    expect(() => flattenEntity()).not.toThrow()
  })

  test('a scope-less call is rejected by the tool schema', () => {
    const parsed = entityInputSchema.safeParse({ operation: 'area_measure' })
    expect(parsed.success).toBe(false)
  })

  test('a closed rectangle in mm reports drawing-units² AND m²', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const rect = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'rectangle',
      corner1: { x: 0, y: 0, z: 0 },
      corner2: { x: 200, y: 100, z: 0 }
    })

    const result = await bridge.request(RpcMethod.EntityAreaMeasure, {
      handles: [rect.entity.handle],
      outputUnit: 'm2'
    })

    expect(result.insUnits).toBe('mm')
    expect(result.convertedToM2).toBe(true)
    expect(result.regions).toHaveLength(1)
    const region = result.regions[0]!
    expect(region.status).toBe('measured')
    expect(region.method).toBe('polyline-area')
    expect(region.areaDrawingUnits2).toBeCloseTo(20_000, 6) // 200×100 mm
    expect(region.areaM2).toBeCloseTo(0.02, 9) // = 0.02 m²
    expect(region.perimeterDrawingUnits).toBeCloseTo(600, 6)
  })

  test('a unitless drawing asked for m² reports no areaM2 at all', async () => {
    // Default mock insUnits is "unitless". The honest answer: give the drawing-units² number,
    // refuse to invent a metre figure.
    const bridge = new MockBridgeClient()
    const rect = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'rectangle',
      corner1: { x: 0, y: 0, z: 0 },
      corner2: { x: 4, y: 5, z: 0 }
    })

    const result = await bridge.request(RpcMethod.EntityAreaMeasure, {
      handles: [rect.entity.handle],
      outputUnit: 'm2'
    })

    expect(result.insUnits).toBe('unitless')
    expect(result.convertedToM2).toBe(false)
    expect(result.regions[0]!.areaDrawingUnits2).toBeCloseTo(20, 6)
    expect(result.regions[0]!.areaM2).toBeUndefined()
  })

  test('an open polyline is open_boundary, never a bounding-box area', async () => {
    const bridge = new MockBridgeClient()
    const open = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'polyline',
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 10, z: 0 }
      ],
      closed: false
    })

    const result = await bridge.request(RpcMethod.EntityAreaMeasure, {
      handles: [open.entity.handle]
    })

    expect(result.regions[0]!.status).toBe('open_boundary')
    expect(result.regions[0]!.areaDrawingUnits2).toBeUndefined()
    expect(result.regions[0]!.method).toBeUndefined()
  })

  test('a hatch with an island nets the hole out and reports loop counts', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'm' })
    const hatch = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'hatch',
      loops: [
        {
          points: [
            { x: 0, y: 0, z: 0 },
            { x: 6, y: 0, z: 0 },
            { x: 6, y: 6, z: 0 },
            { x: 0, y: 6, z: 0 }
          ]
        },
        {
          points: [
            { x: 2, y: 2, z: 0 },
            { x: 4, y: 2, z: 0 },
            { x: 4, y: 4, z: 0 },
            { x: 2, y: 4, z: 0 }
          ]
        }
      ]
    })

    const result = await bridge.request(RpcMethod.EntityAreaMeasure, {
      handles: [hatch.entity.handle],
      outputUnit: 'm2'
    })

    const region = result.regions[0]!
    expect(region.method).toBe('hatch-area')
    expect(region.areaDrawingUnits2).toBeCloseTo(36 - 4, 6) // 36 m² outer minus 4 m² island
    expect(region.areaM2).toBeCloseTo(32, 6)
    expect(region.loopCount).toBe(2)
    expect(region.holeLoopCount).toBe(1)
  })

  test('a hatch and its own boundary are both reported, boundary flagged not summed', async () => {
    const bridge = new MockBridgeClient()
    const boundary = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'polyline',
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 0, z: 0 },
        { x: 5, y: 5, z: 0 },
        { x: 0, y: 5, z: 0 }
      ],
      closed: true
    })
    const hatch = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'hatch',
      boundaryHandles: [boundary.entity.handle]
    })

    const result = await bridge.request(RpcMethod.EntityAreaMeasure, {
      handles: [boundary.entity.handle, hatch.entity.handle]
    })

    const boundaryRegion = result.regions.find((r) => r.handle === boundary.entity.handle)!
    const hatchRegion = result.regions.find((r) => r.handle === hatch.entity.handle)!
    expect(hatchRegion.areaDrawingUnits2).toBeCloseTo(25, 6)
    expect(boundaryRegion.boundaryOfHandle).toBe(hatch.entity.handle)
    expect(boundaryRegion.message).toContain('do not add it')
  })

  test('a line inside a window scope is ambiguous_region, not summed', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 10, y: 10, z: 0 },
      end: { x: 20, y: 10, z: 0 }
    })

    const result = await bridge.request(RpcMethod.EntityAreaMeasure, {
      window: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 0 } }
    })

    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]!.status).toBe('ambiguous_region')
    expect(result.regions[0]!.areaDrawingUnits2).toBeUndefined()
  })

  test('a non-existent handle is an error, never a silently skipped one', async () => {
    const bridge = new MockBridgeClient()
    await expect(
      bridge.request(RpcMethod.EntityAreaMeasure, { handles: ['DEADBEEF'] })
    ).rejects.toThrow(/not found/)
  })

  test('the fast path sends handles straight to the wire (no window/scan)', async () => {
    const spy = new SpyBridgeClient()
    const handler = entityHandler(spy)
    await handler(
      { operation: 'area_measure', handles: ['A1'], outputUnit: 'm2' },
      { mcpReq: { id: 1 } }
    )
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.method).toBe(RpcMethod.EntityAreaMeasure)
    expect(spy.calls[0]!.params).toMatchObject({ handles: ['A1'], outputUnit: 'm2' })
  })

  test('selection:implied returns an empty scope (mock has no live pick)', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'rectangle',
      corner1: { x: 0, y: 0, z: 0 },
      corner2: { x: 2, y: 2, z: 0 }
    })
    const result = await bridge.request(RpcMethod.EntityAreaMeasure, { selection: 'implied' })
    expect(result.regions).toHaveLength(0)
    expect(result.skippedNonAreaCount).toBe(0)
  })
})

describe('entity.erase ownership protection', () => {
  test('erasing user pre-existing geometry is refused with ProtectedEntity (-32038) and mentions handle', async () => {
    const spy = new SpyBridgeClient()
    const handler = entityHandler(spy)
    const userEnt = spy.inner.seedUserEntity({
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const result = (await handler(
      { operation: 'erase', handles: [userEnt.handle] },
      { mcpReq: { id: 101 } }
    )) as {
      isError?: boolean
      content?: { text?: string }[]
      structuredContent?: { error?: { code?: number; name?: string } }
    }

    expect(result.isError).toBe(true)
    const text = result.content?.[0]?.text ?? ''
    expect(text).toContain(String(BridgeErrorCode.ProtectedEntity))
    expect(text).toContain('ProtectedEntity')
    expect(text).toContain(userEnt.handle)
    expect(result.structuredContent?.error?.code).toBe(BridgeErrorCode.ProtectedEntity)

    // Entity was not erased
    const list = await spy.inner.request(RpcMethod.EntityList, {})
    expect(list.entities.map((e) => e.handle)).toContain(userEnt.handle)
  })

  test('erasing CadAI-created entity succeeds', async () => {
    const spy = new SpyBridgeClient()
    const handler = entityHandler(spy)
    const createRes = (await handler(
      { operation: 'create', entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 5 } },
      { mcpReq: { id: 102 } }
    )) as { content?: { text?: string }[] }
    const created = JSON.parse(createRes.content?.[0]?.text ?? '{}') as {
      entity: { handle: string }
    }
    expect(created.entity.handle).toBeDefined()

    const eraseRes = (await handler(
      { operation: 'erase', handles: [created.entity.handle] },
      { mcpReq: { id: 103 } }
    )) as { isError?: boolean; content?: { text?: string }[] }

    expect(eraseRes.isError).toBeUndefined()
    const parsed = JSON.parse(eraseRes.content?.[0]?.text ?? '{}') as { erased: string[] }
    expect(parsed.erased).toContain(created.entity.handle)

    const list = await spy.inner.request(RpcMethod.EntityList, {})
    expect(list.entities.map((e) => e.handle)).not.toContain(created.entity.handle)
  })

  test('a mixed batch refuses atomically before erasing anything', async () => {
    const spy = new SpyBridgeClient()
    const handler = entityHandler(spy)
    const userEnt = spy.inner.seedUserEntity({
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 5, y: 0, z: 0 }
    })
    const createRes = (await handler(
      {
        operation: 'create',
        entity: { kind: 'circle', center: { x: 10, y: 10, z: 0 }, radius: 2 }
      },
      { mcpReq: { id: 104 } }
    )) as { content?: { text?: string }[] }
    const cadAiEnt = JSON.parse(createRes.content?.[0]?.text ?? '{}') as {
      entity: { handle: string }
    }

    const result = (await handler(
      { operation: 'erase', handles: [cadAiEnt.entity.handle, userEnt.handle] },
      { mcpReq: { id: 105 } }
    )) as { isError?: boolean; content?: { text?: string }[] }

    expect(result.isError).toBe(true)
    const text = result.content?.[0]?.text ?? ''
    expect(text).toContain(userEnt.handle)
    expect(text).toContain('ProtectedEntity')

    // Neither entity was erased!
    const list = await spy.inner.request(RpcMethod.EntityList, {})
    const remainingHandles = list.entities.map((e) => e.handle)
    expect(remainingHandles).toContain(userEnt.handle)
    expect(remainingHandles).toContain(cadAiEnt.entity.handle)
  })
})

describe('entity.trace_boundary', () => {
  test('dispatches point to EntityTraceBoundary RPC', async () => {
    const spy = new SpyBridgeClient()
    const handler = entityHandler(spy)
    const result = (await handler(
      {
        operation: 'trace_boundary',
        point: [15000, 112000]
      },
      { mcpReq: { id: 201 } }
    )) as { content?: { text?: string }[] }

    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.method).toBe(RpcMethod.EntityTraceBoundary)
    expect(spy.calls[0]!.params).toEqual({
      point: { x: 15000, y: 112000, z: 0 },
      detectIslands: undefined,
      documentName: undefined
    })
    expect(result.content?.[0]?.text).toBeDefined()
  })
})
