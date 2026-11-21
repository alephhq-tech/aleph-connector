import { parsePositiveInt } from '@aleph-connector/config'

export interface GatewayConfig {
  /** WSS upgrade path bridges connect to. */
  devicePath: string
  /** Milliseconds a new connection has to send "hello" before being dropped. */
  helloTimeoutMs: number
  /** Default timeout for a capability.execute round trip when the caller doesn't specify one. */
  defaultExecuteTimeoutMs: number
  /** Heartbeat cadence the gateway expects from a connected bridge. */
  heartbeatIntervalMs: number
  /** A device is marked offline after this long without any inbound frame. */
  heartbeatTimeoutMs: number
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    devicePath: env.DEVICE_GATEWAY_PATH?.trim() || '/device',
    helloTimeoutMs: parsePositiveInt(env.DEVICE_GATEWAY_HELLO_TIMEOUT_MS, 10_000),
    defaultExecuteTimeoutMs: parsePositiveInt(env.DEVICE_GATEWAY_EXECUTE_TIMEOUT_MS, 15_000),
    heartbeatIntervalMs: parsePositiveInt(env.DEVICE_GATEWAY_HEARTBEAT_INTERVAL_MS, 30_000),
    heartbeatTimeoutMs: parsePositiveInt(env.DEVICE_GATEWAY_HEARTBEAT_TIMEOUT_MS, 90_000)
  }
}

