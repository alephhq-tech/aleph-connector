import { expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { AutoCadInstance } from '@aleph-connector/cad-protocol'
import { BridgeErrorCode, BridgeRpcError } from '@aleph-connector/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { MockDeviceGateway } from '../bridge/MockDeviceGateway.js'
import { createServer } from '../server.js'

function textOf(result: CallToolResult): string {
  const block = result.content[0]
  if (!block || block.type !== 'text') throw new Error('expected a text block')
  return block.text
}

const instance = (instanceId: string, status: AutoCadInstance['status']): AutoCadInstance => ({
  instanceId,
  processId: 1,
  status,
  autocadVersion: '2024-mock',
  pluginVersion: '0.1.0-mock',
  protocol: 1,
  activeDocument: 'Drawing1.dwg'
})

/**
 * aleph-platform#4: `context` must list every online AutoCAD instance, not silently resolve to
 * one and hide the rest — the exact gap that made a 2nd instance invisible until the very next
 * tool call failed `InstanceAmbiguous` with no clue why.
 */
test('context lists every instance, not just one', async () => {
  const deviceId = 'device_pc_01'
  const bridge = new MockBridgeClient()
  const deviceGateway = new MockDeviceGateway(deviceId, [
    instance('acad_1001', 'online'),
    instance('acad_1002', 'online')
  ])
  const server = createServer(bridge, deviceGateway, deviceId)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'context-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const result = await client.callTool({ name: 'context', arguments: {} })
  expect(result.isError).toBeUndefined()
  const parsed = JSON.parse(textOf(result as CallToolResult)) as {
    instances: AutoCadInstance[]
    autocad: AutoCadInstance | null
  }
  expect(parsed.instances.map((i) => i.instanceId).sort()).toEqual(['acad_1001', 'acad_1002'])
  // Exactly one instance online in the single-instance case is unambiguous — kept here only to
  // prove `autocad` still resolves to SOMETHING sensible, never the trigger for picking which one
  // a multi-instance call should target (every AutoCAD-touching tool's own `instanceId` is).
  expect(parsed.autocad).not.toBeNull()
  expect(['acad_1001', 'acad_1002']).toContain(parsed.autocad!.instanceId)
})

test("context still reports a single instance unchanged when there's only one", async () => {
  const deviceId = 'device_pc_01'
  const bridge = new MockBridgeClient()
  const deviceGateway = new MockDeviceGateway(deviceId, instance('acad_18244', 'online'))
  const server = createServer(bridge, deviceGateway, deviceId)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'context-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const result = await client.callTool({ name: 'context', arguments: {} })
  const parsed = JSON.parse(textOf(result as CallToolResult)) as {
    instances: AutoCadInstance[]
    autocad: AutoCadInstance | null
  }
  expect(parsed.instances).toHaveLength(1)
  expect(parsed.autocad?.instanceId).toBe('acad_18244')
})

/**
 * The tab read used to swallow every failure and return `undefined`, so "Bridge online but no
 * `documents`" told the model nothing about a refused pipe vs. a busy AutoCAD vs. an ambiguous
 * 2-instance call — and it retried blind.
 */
test('context names why `documents` is missing instead of dropping the failure', async () => {
  const deviceId = 'device_pc_01'
  const failing: BridgeClient = {
    request: () =>
      Promise.reject(
        new BridgeRpcError(BridgeErrorCode.PipeOccupied, 'another client holds this pipe')
      ),
    close: () => Promise.resolve()
  }
  const server = createServer(
    failing,
    new MockDeviceGateway(deviceId, instance('acad_1001', 'online')),
    deviceId
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'context-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const result = await client.callTool({ name: 'context', arguments: {} })
  // Still a usable, non-error result: the connection facts are worth reporting on their own.
  expect(result.isError).toBeUndefined()
  const parsed = JSON.parse(textOf(result as CallToolResult)) as {
    documents?: unknown
    documentsError?: { code: number; name: string; retryable: boolean; hint: string }
  }
  expect(parsed.documents).toBeUndefined()
  expect(parsed.documentsError?.code).toBe(BridgeErrorCode.PipeOccupied)
  expect(parsed.documentsError?.name).toBe('PipeOccupied')
  // Retry-in-place is the wrong advice for a refused pipe, so the hint must not invite it.
  expect(parsed.documentsError?.retryable).toBe(false)
  expect(parsed.documentsError?.hint).toContain('Bridge')
})

/** `context` must be able to read a specific instance's tabs when 2+ are online. */
test('context forwards instanceId to the plugin', async () => {
  const deviceId = 'device_pc_01'
  class SpyBridgeClient implements BridgeClient {
    readonly inner = new MockBridgeClient()
    readonly instanceIds: Array<string | undefined> = []

    async request<M extends RpcMethodName>(
      method: M,
      params: RpcMethodMap[M]['params'],
      options?: BridgeRequestOptions
    ): Promise<RpcMethodMap[M]['result']> {
      this.instanceIds.push(options?.instanceId)
      return this.inner.request(method, params, options)
    }

    async close(): Promise<void> {
      await this.inner.close()
    }
  }
  const spy = new SpyBridgeClient()
  const server = createServer(
    spy,
    new MockDeviceGateway(deviceId, [
      instance('acad_1001', 'online'),
      instance('acad_1002', 'online')
    ]),
    deviceId
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'context-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const targeted = await client.callTool({
    name: 'context',
    arguments: { instanceId: 'acad_1002' }
  })
  expect(targeted.isError).toBeUndefined()
  const untargeted = await client.callTool({ name: 'context', arguments: {} })
  expect(untargeted.isError).toBeUndefined()
  expect(spy.instanceIds).toEqual(['acad_1002', undefined])

  const parsed = JSON.parse(textOf(targeted as CallToolResult)) as {
    documents?: unknown
    documentsError?: unknown
  }
  expect(parsed.documentsError).toBeUndefined()
  expect(parsed.documents).toBeDefined()
})
