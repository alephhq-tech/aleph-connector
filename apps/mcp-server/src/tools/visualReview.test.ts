import { describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { COMMIT_EVIDENCE_META_KEY } from '@arcdio/operation-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { MockDeviceGateway } from '../bridge/MockDeviceGateway.js'
import { createServer } from '../server.js'

/**
 * report §5.4 (SUNLAND run): `view.capture` failed once, the model never saw the drawing again, and
 * it went on to commit 141 entities across the whole floor — walls, corridors and shafts all commit
 * exactly like a correct protected area, so nothing in the receipt distinguished an unviewed bulk
 * draw from a checked one. A batch of `BULK_REVIEW_MIN_ENTITIES`+ now has to either ask for a
 * picture or declare that no picture is obtainable, and that choice lands on the commit receipt the
 * ledger keeps — never in the model-facing text.
 */
describe('bulk draws must be reviewed or declared unreviewable', () => {
  class SpyBridgeClient implements BridgeClient {
    readonly inner = new MockBridgeClient()
    readonly methods: RpcMethodName[] = []

    async request<M extends RpcMethodName>(
      method: M,
      params: RpcMethodMap[M]['params'],
      options?: BridgeRequestOptions
    ): Promise<RpcMethodMap[M]['result']> {
      this.methods.push(method)
      return this.inner.request(method, params, options)
    }

    async close(): Promise<void> {
      await this.inner.close()
    }
  }

  async function connect() {
    const spy = new SpyBridgeClient()
    const server = createServer(spy, new MockDeviceGateway('device_pc_01', []), 'device_pc_01')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'visual-review-test', version: '0.0.0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return { client, spy }
  }

  const batch = (count: number) => ({
    operation: 'apply',
    operations: Array.from({ length: count }, (_, i) => ({
      op: 'create' as const,
      entity: { kind: 'circle' as const, center: { x: i * 10, y: 0, z: 0 }, radius: 2 }
    }))
  })

  const commit = (result: CallToolResult) =>
    (result as { _meta?: Record<string, unknown> })._meta?.[COMMIT_EVIDENCE_META_KEY] as
      { visualEvidence?: string } | undefined

  test('a 20-entity batch with no capture and no declaration draws nothing', async () => {
    const { client, spy } = await connect()
    const refused = await client.callTool({ name: 'operations', arguments: batch(20) })

    expect(refused.isError).toBe(true)
    const text = JSON.stringify(refused.content)
    expect(text).toContain('bulk draw')
    expect(text).toContain('visualReview')
    // The point of refusing BEFORE the batch: a refused call has zero side effects.
    expect(spy.methods).not.toContain('operations.apply')
  })

  test('the same batch with a capture goes through and records it was seen', async () => {
    const { client, spy } = await connect()
    const ok = await client.callTool({
      name: 'operations',
      arguments: { ...batch(20), capture: 'changed' }
    })

    expect(ok.isError).toBeUndefined()
    expect(spy.methods).toContain('operations.apply')
    expect(ok.content.some((block) => block.type === 'image')).toBe(true)
    expect(commit(ok)?.visualEvidence).toBe('captured')
  })

  test('an explicit `unavailable` declaration draws, and says so on the receipt', async () => {
    const { client, spy } = await connect()
    const ok = await client.callTool({
      name: 'operations',
      arguments: { ...batch(25), visualReview: 'unavailable' }
    })

    expect(ok.isError).toBeUndefined()
    expect(spy.methods).toContain('operations.apply')
    expect(ok.content.some((block) => block.type === 'image')).toBe(false)
    expect(commit(ok)?.visualEvidence).toBe('unavailable')
  })

  test('a small batch is untouched by the gate and carries no visual claim', async () => {
    const { client, spy } = await connect()
    const ok = await client.callTool({ name: 'operations', arguments: batch(3) })

    expect(ok.isError).toBeUndefined()
    expect(spy.methods).toContain('operations.apply')
    expect(commit(ok)?.visualEvidence).toBeUndefined()
  })

  test('`construct` records the same declaration — a grid it expands to 24 entities', async () => {
    // Every bulk tool must stamp, or the ledger still can't tell an unviewed draw from a checked one.
    const { client, spy } = await connect()
    const ok = await client.callTool({
      name: 'construct',
      arguments: {
        operation: 'grid',
        origin: { x: 0, y: 0, z: 0 },
        x: { count: 5, spacing: 6000 },
        y: { count: 3, spacing: 4000 },
        extension: 1000,
        bubbleRadius: 400,
        visualReview: 'unavailable'
      }
    })

    expect(ok.isError).toBeUndefined()
    expect(spy.methods).toContain('operations.apply')
    expect(commit(ok)?.visualEvidence).toBe('unavailable')
  })

  test('a bulk preset expansion through `entity` is refused, since that tool cannot show a picture', async () => {
    const { client, spy } = await connect()
    const refused = await client.callTool({
      name: 'entity',
      arguments: {
        operation: 'create',
        // A layer the mock drawing lacks: if the refusal landed after the layer pre-flight, the
        // "Nothing was drawn" promise would be false and `layer.ensure` would show here.
        ensureLayer: true,
        entity: {
          kind: 'dimension.chain',
          layer: 'S-DIM-BULK',
          points: Array.from({ length: 25 }, (_, i) => ({ x: i * 1000, y: 0, z: 0 })),
          mode: 'continue',
          direction: 'horizontal',
          offset: 1000
        }
      }
    })

    expect(refused.isError).toBe(true)
    // The agent has to be told what to call instead, or it just retries the same tool.
    expect(JSON.stringify(refused.content)).toContain('capture')
    // Zero side effects of any kind — not just no batch.
    expect(spy.methods).toEqual([])
  })

  test('one `dimension.chain` step counts as the 24 entities it expands to, not as 1 operation', async () => {
    const { client, spy } = await connect()
    const refused = await client.callTool({
      name: 'operations',
      arguments: {
        operation: 'apply',
        operations: [
          {
            op: 'create',
            entity: {
              kind: 'dimension.chain',
              points: Array.from({ length: 25 }, (_, i) => ({ x: i * 1000, y: 0, z: 0 })),
              mode: 'continue',
              direction: 'horizontal',
              offset: 1000
            }
          }
        ]
      }
    })

    expect(refused.isError).toBe(true)
    expect(spy.methods).toEqual([])
  })
})
