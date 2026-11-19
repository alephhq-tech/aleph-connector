import { parsePositiveInt } from '@arcdio/config'
import type { GatewayConfig } from '@arcdio/device-gateway'

export interface McpServerConfig {
  /** Port the combined HTTP (MCP) + WSS (device) listener binds to. */
  port: number
  /** Path the Streamable HTTP MCP endpoint is served on. */
  mcpPath: string
  gateway: GatewayConfig
}

export function loadMcpServerConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  return {
    port: parsePositiveInt(env.MCP_AUTOCAD_PORT, 8080),
    mcpPath: env.MCP_PATH?.trim() || '/mcp',
    gateway: loadEmbeddedGatewayConfig(env)
  }
}

function loadEmbeddedGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  return {
    devicePath: env.DEVICE_GATEWAY_PATH?.trim() || '/device',
    helloTimeoutMs: parsePositiveInt(env.DEVICE_GATEWAY_HELLO_TIMEOUT_MS, 10_000),
    defaultExecuteTimeoutMs: parsePositiveInt(env.DEVICE_GATEWAY_EXECUTE_TIMEOUT_MS, 15_000),
    heartbeatIntervalMs: parsePositiveInt(env.DEVICE_GATEWAY_HEARTBEAT_INTERVAL_MS, 30_000),
    heartbeatTimeoutMs: parsePositiveInt(env.DEVICE_GATEWAY_HEARTBEAT_TIMEOUT_MS, 90_000)
  }
}
