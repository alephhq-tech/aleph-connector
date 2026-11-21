import type { DeviceSocketData } from '@aleph-connector/device-gateway'
import { createLogger, initTelemetry, type Logger } from '@aleph-connector/observability'
import { createApp } from './app.js'
import { createMcpOAuth } from './auth/createMcpOAuth.js'
import { configurePostgresIdentity } from './auth/configurePostgresIdentity.js'
import { loadMcpServerConfig } from './config.js'
import { configureDevIdentity } from './dev/configureDevIdentity.js'

// No-op unless Langfuse observability is configured.
initTelemetry({ serviceName: 'aleph-mcp' })

const log: Logger = createLogger('mcp-server')
const config = loadMcpServerConfig()
// Device credential issuer/verifier for Connector WSS only — never used as MCP client auth.
// Dev file store wins when ALEPH_DEV_IDENTITY=1; otherwise Postgres when DATABASE_URL is set.
if (!configureDevIdentity(process.env, log)) {
  configurePostgresIdentity(process.env, log)
}
const { oauth } = createMcpOAuth(process.env, config.port)
const app = createApp(config, oauth)
app.gateway.startHeartbeatSweep()

// Bun closes a connection that sends nothing for `idleTimeout` seconds, 10 by default. A tool call
// that waits on the Bridge is exactly that: the SSE response has its headers out and no bytes to
// send until AutoCAD answers. The gateway's execute timeout defaults to 15 s, so with Bun's default
// the socket was cut at 10 s and the client saw ECONNRESET instead of the gateway's own clean
// timeout error. 255 is Bun's maximum, comfortably above any execute timeout worth configuring.
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
  issuer: config.issuerUrl,
  resource: config.resourceUrl,
  authorize: `${config.issuerUrl}/oauth/authorize`
})

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

async function shutdown(): Promise<void> {
  app.gateway.stopHeartbeatSweep()
  await app.mcpHandler.close()
  await server.stop()
  process.exit(0)
}
