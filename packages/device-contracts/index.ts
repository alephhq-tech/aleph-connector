/**
 * The Internal Command API (docs/PROTOCOL.md section "Internal Command API"; AUTOCAD_MCP_PROJECT.md
 * section 6). For v1 this is an in-process TypeScript interface — server imports device-gateway's
 * `DeviceGatewayService` and calls it directly, no network hop. If the two are ever split into
 * independently deployed services, only the implementation behind this interface changes (e.g. an
 * internal HTTP/gRPC client) — tool code in server never changes.
 */
import type {
  AutoCadInstance,
  Capabilities,
  ErrorEnvelope
} from '@arcdio/device-protocol'

export interface DeviceExecutionRequest {
  /** Which user device (Bridge instance) should run this. */
  deviceId: string
  capability: 'autocad'
  /**
   * Omitted = the gateway targets the device's sole online AutoCAD instance, error if there are 0
   * or 2+.
   */
  instanceId?: string
  operation: {
    /** Local IPC method name, e.g. "entity.create" — see @arcdio/cad-protocol RpcMethod. */
    type: string
    arguments: Record<string, unknown>
  }
  timeoutMs?: number
  /**
   * Aborts the in-flight request (#9): when given and the signal fires before the Bridge answers,
   * the gateway sends `capability.cancel` for this request's id instead of waiting out `timeoutMs`.
   * Set by server from the MCP SDK's per-call `ctx.mcpReq.signal`, which fires on a client
   * `notifications/cancelled`. The call still eventually settles with
   * `GatewayErrorCode.RequestTimeout` (cancellation has no result of its own to report) — the
   * plugin-side effect is what matters: not-yet-started work is dropped, in-flight work still
   * completes atomically (see docs/PROTOCOL.md's threading contract).
   */
  signal?: AbortSignal
  /**
   * The authenticated MCP caller's (workspaceId, userId) (issue #349 requirement 3) — set from
   * the Bridge token's verified claims (`DeviceIdentityVerifier`/`requireDeviceId`'s sibling
   * extras), NEVER from client-supplied input. When present, `DeviceGatewayService.execute` one
   * more time re-validates the live `device_grants` row before dispatching to the Bridge —
   * defense in depth alongside `DeviceIdentityVerifier.verifyAccessToken`'s own per-request
   * re-check, so a grant revoked mid-stream is enforced at the actual dispatch point too, not
   * only at the HTTP auth gate. Optional for backward compatibility with callers (tests, the
   * standalone smoke harness) that construct a request directly without going through the MCP
   * auth gate.
   */
  callerWorkspaceId?: string
  callerUserId?: string
}

export type DeviceExecutionResult =
  { status: 'success'; result: Record<string, unknown> } | { status: 'error'; error: ErrorEnvelope }

export interface DeviceSummary {
  deviceId: string
  online: boolean
  bridgeVersion: string | null
  capabilities: Capabilities
}

/**
 * Live snapshot used by tools like `cad.get_context`; null when the requested instance isn't
 * connected.
 */
export type DeviceContext = AutoCadInstance | null

/** The boundary every MCP tool talks to instead of reaching into transport details. See section 6. */
export interface DeviceGateway {
  execute(request: DeviceExecutionRequest): Promise<DeviceExecutionResult>
  getContext(deviceId: string, instanceId?: string): Promise<DeviceContext>
  listDevices(): Promise<DeviceSummary[]>
}

/**
 * Error codes for device-routing failures — distinct from AutoCAD-plugin errors
 * (@arcdio/cad-protocol BridgeErrorCode).
 */
export const GatewayErrorCode = {
  DeviceNotFound: -33001,
  DeviceOffline: -33002,
  InstanceNotFound: -33003,
  InstanceAmbiguous: -33004,
  RequestTimeout: -33005,
  ProtocolIncompatible: -33006
} as const

export type GatewayErrorCode = (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode]

export class DeviceGatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'DeviceGatewayError'
  }
}
