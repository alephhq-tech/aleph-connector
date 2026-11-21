import { expect, test } from 'bun:test'
import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'

function recordingBridge(): {
  bridge: BridgeClient
  calls: { method: string; params: unknown; options?: BridgeRequestOptions }[]
} {
  const calls: { method: string; params: unknown; options?: BridgeRequestOptions }[] = []
  const bridge: BridgeClient = {
    request<M extends RpcMethodName>(
      method: M,
      params: RpcMethodMap[M]['params'],
      options?: BridgeRequestOptions
    ) {
      calls.push({ method, params, options })
      return Promise.resolve({}) as Promise<RpcMethodMap[M]['result']>
    },
    close: () => Promise.resolve()
  }
  return { bridge, calls }
}

test('no instanceId returns the exact same client, not a wrapper', () => {
  const { bridge } = recordingBridge()
  expect(withInstance(bridge, undefined)).toBe(bridge)
})

test("an instanceId is merged into every call's options", async () => {
  const { bridge, calls } = recordingBridge()
  const scoped = withInstance(bridge, 'acad_18244')
  await scoped.request('drawing.info' as RpcMethodName, { documentName: 'A.dwg' })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.options).toEqual({ instanceId: 'acad_18244' })
})

test('an existing signal/timeoutMs on the call survives alongside instanceId', async () => {
  const { bridge, calls } = recordingBridge()
  const scoped = withInstance(bridge, 'acad_18244')
  const signal = new AbortController().signal
  await scoped.request('drawing.info' as RpcMethodName, {}, { signal, timeoutMs: 5000 })
  expect(calls[0]!.options).toEqual({ signal, timeoutMs: 5000, instanceId: 'acad_18244' })
})

test('close() delegates to the wrapped client', async () => {
  let closed = false
  const bridge: BridgeClient = {
    request: () => Promise.resolve({}) as never,
    close: () => {
      closed = true
      return Promise.resolve()
    }
  }
  await withInstance(bridge, 'acad_18244').close()
  expect(closed).toBe(true)
})
