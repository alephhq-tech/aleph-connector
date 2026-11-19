import { BridgeRpcError } from '@arcdio/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import type { DeviceGateway } from '@arcdio/device-contracts'
import type { BridgeClient, BridgeRequestOptions } from './BridgeClient.js'

/**
 * Adapts the Internal Command API (`DeviceGateway.execute`) to the tool-facing {@link BridgeClient}
 * interface, so every tool in src/tools/*.ts is unaware that AutoCAD is now reached over WSS +
 * named pipe instead of directly over a local named pipe. One instance is bound to one
 * authenticated deviceId — see src/auth/DeviceIdentityVerifier.ts for how that's resolved per
 * request.
 */
export class DeviceGatewayBridgeClient implements BridgeClient {
  constructor(
    private readonly gateway: DeviceGateway,
    private readonly deviceId: string,
    // Issue #349 requirement 3: the already-authenticated MCP caller's (workspaceId, userId),
    // threaded through to `DeviceGatewayService.execute` so it can re-validate the live
    // `device_grants` row one more time at the actual dispatch point. Optional so existing unit
    // tests that construct this client directly against a recording fake `DeviceGateway` (no
    // real auth gate in front of them) keep working unchanged — omitting it just means
    // `execute()` skips that extra re-check, the same as before this issue.
    private readonly caller?: { workspaceId: string; userId: string }
  ) {}

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    const outcome = await this.gateway.execute({
      deviceId: this.deviceId,
      capability: 'autocad',
      // aleph-platform#4: omitted means `DeviceGatewayService.execute` falls back to the
      // device's sole online instance (erroring on 0 or 2+) — unchanged default behavior.
      instanceId: options?.instanceId,
      // Same widen-at-the-boundary as the result cast below: RpcMethodMap[M]["params"] is a
      // concrete shape per method, but the wire's CapabilityOperation.arguments is generic JSON.
      operation: { type: method, arguments: params as Record<string, unknown> },
      signal: options?.signal,
      // Per-call timeout override (BridgeRequestOptions.timeoutMs): omitted here means the gateway
      // falls back to its defaultExecuteTimeoutMs, exactly as before.
      timeoutMs: options?.timeoutMs,
      callerWorkspaceId: this.caller?.workspaceId,
      callerUserId: this.caller?.userId
    })
    if (outcome.status === 'error') {
      throw new BridgeRpcError(outcome.error.code, outcome.error.message, outcome.error.data)
    }
    // The Internal Command API is deliberately untyped JSON at this boundary (one method
    // catalog shared by every RpcMethod); RpcMethodMap is what gives each call site back its
    // specific result type, mirroring the same widen-then-narrow the named-pipe client used.
    return outcome.result as RpcMethodMap[M]['result']
  }

  async close(): Promise<void> {
    // The Device Gateway connection's lifecycle belongs to the embedding process (see
    // src/index.ts), not to any single tool call — nothing to release here.
  }
}
