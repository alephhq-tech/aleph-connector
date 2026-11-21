import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'

/**
 * Per-call options every {@link BridgeClient} implementation accepts (#9). `signal`, when given and
 * already aborted or later aborted, lets a transport that supports mid-flight cancellation (the
 * Device Gateway-backed client) ask the Bridge to cancel the request — e.g. when the MCP client
 * sends `notifications/cancelled` for this tool call. Implementations that can't cancel (the
 * in-memory mock) accept and ignore it.
 *
 * `timeoutMs` overrides the gateway's `defaultExecuteTimeoutMs` (15 s) for this one call — for
 * operations that legitimately run longer against real AutoCAD (opening a multi-MB DWG cold). The
 * Device Gateway stamps it onto `capability.execute`, which the Bridge honors as its own per-request
 * cancellation window; implementations with no timeout of their own (the mock) accept and ignore it.
 */
export interface BridgeRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Which AutoCAD process (Device Gateway `DeviceExecutionRequest.instanceId`) this call should
   * run against — aleph-platform#4. Omitted = the gateway's own default (its sole online
   * instance, erroring if there are 0 or 2+); the in-memory mock has no concept of multiple
   * instances and ignores this.
   */
  instanceId?: string
}

/** Transport-agnostic contract every tool handler talks to. */
export interface BridgeClient {
  request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']>
  close(): Promise<void>
}
