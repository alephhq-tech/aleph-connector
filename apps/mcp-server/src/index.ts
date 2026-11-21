import type { DeviceSocketData } from '@aleph-connector/device-gateway'
import { createLogger, initTelemetry, type Logger } from '@aleph-connector/observability'
import { createApp } from './app.js'
import { configurePostgresIdentity } from './auth/configurePostgresIdentity.js'
import { loadMcpServerConfig } from './config.js'
import { configureDevIdentity } from './dev/configureDevIdentity.js'

initTelemetry({ serviceName: 'aleph-mcp' })

const log: Logger = createLogger('mcp-server')
const config = loadMcpServerConfig()
// Device credential issuer/verifier for Connector WSS only — never used as MCP client auth.
if (!configureDevIdentity(process.env, log)) {
  configurePostgresIdentity(process.env, log)
}
const app = createApp(config)
app.gateway.startHeartbeatSweep()

const server = Bun.serve<DeviceSocketData>({
  port: config.port,
  idleTimeout: 255,
  fetch: app.fetch,
  websocket: app.websocket
})

log.info('listening', {
  port: server.port,
  mcpPath: config.mcpPath,
  devicePath: config.gateway.devicePath,
  resource: config.resourceUrl,
  authorizationServer: config.gatewayIssuerUrl
})

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

async function shutdown(): Promise<void> {
  app.gateway.stopHeartbeatSweep()
  await app.mcpHandler.close()
  await server.stop()
  process.exit(0)
}
