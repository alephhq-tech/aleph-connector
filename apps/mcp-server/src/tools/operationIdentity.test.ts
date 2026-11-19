import { describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { OPERATION_META_KEY } from '@arcdio/operation-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { MockDeviceGateway } from '../bridge/MockDeviceGateway.js'
import { createServer } from '../server.js'

/**
 * End-to-end proof of issue #388 §C, bullet 2's dispatch half: the identity a whole-turn retry
 * must keep is the coordinator's server-minted `operationId`, and it travels out-of-band in the
 * request's `_meta` — never as a tool argument a model could author or a prompt injection could
 * copy. Driven through the real `@modelcontextprotocol/client` SDK against the real v2
 * `McpServer` the AutoCAD MCP app runs, over an in-memory transport: that is what proves the
 * SDK's own wire layer keeps an extension `_meta` key intact across both protocol eras instead of
 * stripping it as unknown vocabulary. A regression that dropped `_meta` on the floor would make
 * every retry re-apply its write, and no amount of unit-level mocking would notice.
 */
describe('operation identity over the wire (#388 §C)', () => {
  class SpyBridgeClient implements BridgeClient {
    readonly inner = new MockBridgeClient()
    readonly keys: Array<string | undefined> = []
    readonly payloads: unknown[] = []

    async request<M extends RpcMethodName>(
      method: M,
      params: RpcMethodMap[M]['params'],
      options?: BridgeRequestOptions
    ): Promise<RpcMethodMap[M]['result']> {
      this.keys.push((params as { idempotencyKey?: string }).idempotencyKey)
      this.payloads.push(params)
      return this.inner.request(method, params, options)
    }

    async close(): Promise<void> {
      await this.inner.close()
    }
  }

  async function connectWith(spy: SpyBridgeClient) {
    const server = createServer(spy, new MockDeviceGateway('device_pc_01', []), 'device_pc_01')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'operation-identity-test', version: '0.0.0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return client
  }

  const circle = (radius: number) => ({
    operation: 'create',
    entity: { kind: 'circle', center: { x: 1, y: 2, z: 0 }, radius }
  })

  test("Cloud's `_meta` operationId becomes the bridge key — and survives a whole-turn retry with a fresh request id", async () => {
    const spy = new SpyBridgeClient()
    const client = await connectWith(spy)

    const first = await client.callTool({
      name: 'entity',
      arguments: circle(5),
      _meta: { [OPERATION_META_KEY]: 'op_retry_me' }
    })
    expect(first.isError).toBeFalsy()

    // A whole-turn retry re-issues the same operation with a NEW JSON-RPC id while the coordinator
    // keeps one operationId (identityFor). If the server derived the key from the request id, the
    // retry would present a different key and draw a second circle.
    const retry = await client.callTool({
      name: 'entity',
      arguments: circle(5),
      _meta: { [OPERATION_META_KEY]: 'op_retry_me' }
    })
    expect(retry.isError).toBeFalsy()

    const created = spy.keys.filter((k) => k === 'op_retry_me')
    expect(created.length).toBe(2) // both calls keyed by the minted id, not by their request ids
    const { total } = await spy.inner.request(
      'entity.list',
      {} as RpcMethodMap['entity.list']['params']
    )
    expect(total).toBe(1) // the retry deduped at the source: exactly one circle drawn

    const firstHandle = (
      JSON.parse((first.content[0] as { text: string }).text) as { entity: { handle: string } }
    ).entity.handle
    const retryHandle = (
      JSON.parse((retry.content[0] as { text: string }).text) as { entity: { handle: string } }
    ).entity.handle
    expect(retryHandle).toBe(firstHandle)
  })

  test('a `_meta` operationId outranks a model-authored idempotencyKey — the model cannot pick the identity', async () => {
    const spy = new SpyBridgeClient()
    const client = await connectWith(spy)

    const result = await client.callTool({
      name: 'entity',
      arguments: { ...circle(7), idempotencyKey: 'model-chose-this' },
      _meta: { [OPERATION_META_KEY]: 'op_server_minted' }
    })
    expect(result.isError).toBeFalsy()

    expect(spy.keys).toContain('op_server_minted')
    expect(spy.keys).not.toContain('model-chose-this')
  })

  test('one operationId reused with changed arguments fails instead of answering with the stored result', async () => {
    const spy = new SpyBridgeClient()
    const client = await connectWith(spy)

    const first = await client.callTool({
      name: 'entity',
      arguments: circle(5),
      _meta: { [OPERATION_META_KEY]: 'op_conflict' }
    })
    expect(first.isError).toBeFalsy()

    // Same identity, different payload. Returning the stored result would claim a radius-999 circle
    // that was never drawn; the guard refuses it.
    const changed = await client.callTool({
      name: 'entity',
      arguments: circle(999),
      _meta: { [OPERATION_META_KEY]: 'op_conflict' }
    })
    expect(changed.isError).toBe(true)
    const text = (changed.content[0] as { text: string }).text
    expect(text).toContain('already stands for a different set of parameters')

    const { total } = await spy.inner.request(
      'entity.list',
      {} as RpcMethodMap['entity.list']['params']
    )
    expect(total).toBe(1)
  })

  test('without `_meta` the old fallbacks still hold: model key first, then the request id', async () => {
    const spy = new SpyBridgeClient()
    const client = await connectWith(spy)

    await client.callTool({
      name: 'entity',
      arguments: { ...circle(3), idempotencyKey: 'model-key' }
    })
    expect(spy.keys).toContain('model-key')

    await client.callTool({ name: 'entity', arguments: circle(4) })
    const last = spy.keys[spy.keys.length - 1]
    expect(typeof last).toBe('string')
    expect(last).not.toBe('model-key')
    expect(last).not.toBe('op_server_minted')
  })
})
