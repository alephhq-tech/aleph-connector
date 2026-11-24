import { parsePositiveInt } from '@aleph-connector/config'
import type { GatewayConfig } from '@aleph-connector/device-gateway'

export interface McpServerConfig {
  /** Port the MCP HTTP + WSS device listener binds to (loopback only). */
  port: number
  /** Path the Streamable HTTP MCP endpoint is served on. */
  mcpPath: string
  /** Public MCP origin (no trailing slash) — loopback in the local-first runtime. */
  publicUrl: string
  gateway: GatewayConfig
}

export function loadMcpServerConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const port = parsePositiveInt(env.MCP_AUTOCAD_PORT, 8080)
  const mcpPath = env.MCP_PATH?.trim() || '/mcp'
  const path = mcpPath.startsWith('/') ? mcpPath : `/${mcpPath}`
  const publicUrl = (
    env.ALEPH_PUBLIC_URL?.trim() ||
    env.MCP_PUBLIC_URL?.trim() ||
    `http://127.0.0.1:${port}`
  ).replace(/\/$/, '')

  return {
    port,
    mcpPath: path,
    publicUrl,
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
