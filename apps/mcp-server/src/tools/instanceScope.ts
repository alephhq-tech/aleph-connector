import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'

/**
 * Pins every call a tool handler makes through the returned client to one AutoCAD process
 * (aleph-platform#4) — the tool handler's body (its `bridge.request(...)` calls) stays exactly as
 * written; only the `const bridge = withInstance(baseBridge, input.instanceId)` line at the top of
 * each `guarded(async (input) => ...)` changes. `undefined` returns the same client unchanged, so
 * the single-instance case (today's only case) does nothing differently.
 */
export function withInstance(bridge: BridgeClient, instanceId: string | undefined): BridgeClient {
  if (!instanceId) return bridge
  return {
    request<M extends RpcMethodName>(
      method: M,
      params: RpcMethodMap[M]['params'],
      options?: BridgeRequestOptions
    ): Promise<RpcMethodMap[M]['result']> {
      return bridge.request(method, params, { ...options, instanceId })
    },
    close: () => bridge.close()
  }
}
