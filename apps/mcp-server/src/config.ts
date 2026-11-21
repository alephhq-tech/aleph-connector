import { parsePositiveInt } from '@aleph-connector/config'
import type { GatewayConfig } from '@aleph-connector/device-gateway'

export interface McpServerConfig {
  /** Port the MCP HTTP + WSS device listener binds to. */
  port: number
  /** Path the Streamable HTTP MCP endpoint is served on. */
  mcpPath: string
  /** Public MCP resource URL (audience for access tokens). */
  resourceUrl: string
  /** Public MCP origin (no trailing slash) — used for resource metadata URLs. */
  publicUrl: string
  /** OAuth AS issuer (Aleph Gateway). Access tokens must have iss = this URL. */
  gatewayIssuerUrl: string
  /** Shared HMAC secret with gateway for MCP access tokens. */
  jwtSecret: string
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

  const gatewayIssuerUrl = (
    env.ALEPH_GATEWAY_URL?.trim() ||
    env.GATEWAY_PUBLIC_URL?.trim() ||
    'http://127.0.0.1:8090'
  ).replace(/\/$/, '')

  const jwtSecret = env.JWT_SECRET?.trim()
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error('JWT_SECRET is required (at least 16 characters; must match gateway)')
  }

  return {
    port,
    mcpPath: path,
    publicUrl,
    resourceUrl: `${publicUrl}${path}`,
    gatewayIssuerUrl,
    jwtSecret,
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
