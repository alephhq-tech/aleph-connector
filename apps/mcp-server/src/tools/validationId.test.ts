import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import { entityInputSchema, registerEntityTools } from './entity.js'
import { portableInputSchema } from './portableSchema.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'

/**
 * Legacy design-validation tickets must not be presented to the model as a prerequisite to
 * CAD mutations. Old clients may still submit the field; Zod strips it rather than forwarding
 * it to the native Bridge. Actual native edit permissions and protections are independent.
 */

function flatten(schema: Parameters<typeof portableInputSchema>[0]): Record<string, unknown> {
  const standard = portableInputSchema(schema)['~standard']
  return standard.jsonSchema.input({ target: 'draft-07' }) as Record<string, unknown>
}

describe('legacy validation tickets are absent from the entity tool schema', () => {
  test('the flattened schema does not advertise a design ticket', () => {
    const properties = flatten(entityInputSchema).properties as Record<string, unknown>
    expect(properties.validationId).toBeUndefined()
  })

  test('every mutating operation silently strips a legacy ticket', () => {
    const mutating: Array<Record<string, unknown>> = [
      { operation: 'create', entity: { kind: 'circle', center: { x: 0, y: 0 }, radius: 5 } },
      { operation: 'erase', handles: ['A'] },
      { operation: 'copy_to', handles: ['A'], targetDocumentName: 'other.dwg' },
      { operation: 'transform', transform: { op: 'move', handles: ['A'], delta: { x: 1, y: 0 } } },
      { operation: 'update', handle: 'A', layer: 'A-WALL' }
    ]
    for (const base of mutating) {
      const parsed = entityInputSchema.safeParse({ ...base, validationId: 'svr_abc123' })
      expect(parsed.success, `${String(base.operation)} with legacy data`).toBe(true)
      if (parsed.success) expect(parsed.data).not.toHaveProperty('validationId')
    }
  })

  test('a read operation ignores it rather than rejecting the call', () => {
    // zod objects strip unknown keys by default, so a stale validationId on a read is harmless.
    const parsed = entityInputSchema.safeParse({ operation: 'list', validationId: 'svr_abc123' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).not.toHaveProperty('validationId')
  })
})

/** Records method/params for every request, delegating to the real mock (refs.test.ts pattern). */
class SpyBridgeClient implements BridgeClient {
  readonly inner = new MockBridgeClient()
  readonly calls: { method: RpcMethodName; params: unknown }[] = []

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    this.calls.push({ method, params })
    return this.inner.request(method, params, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

type Handler = (
  input: unknown,
  ctx: { mcpReq: { id: number; signal?: AbortSignal } }
) => Promise<unknown>

/** Drives the real `entity` tool handler with no transport (entity.test.ts pattern). */
function entityHandler(bridge: BridgeClient): Handler {
  let handler!: Handler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: Handler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerEntityTools>[0]
  registerEntityTools(serverDouble, bridge)
  return handler
}

describe('legacy validation data never reaches the Bridge', () => {
  test('entity.create forwards geometry only', async () => {
    const spy = new SpyBridgeClient()
    const handler = entityHandler(spy)
    await handler(
      {
        operation: 'create',
        entity: { kind: 'circle', center: { x: 0, y: 0 }, radius: 5 },
        validationId: 'svr_abc123'
      },
      { mcpReq: { id: 1 } }
    )
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.method).toBe(RpcMethod.EntityCreate)
    expect(JSON.stringify(spy.calls[0]!.params)).not.toContain('svr_abc123')
    expect(spy.calls[0]!.params).not.toHaveProperty('validationId')
  })
})
