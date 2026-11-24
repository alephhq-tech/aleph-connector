import type { DeviceSocketData } from '@aleph-connector/device-gateway'
import { createLogger, initTelemetry, type Logger } from '@aleph-connector/observability'
import { createApp } from './app.js'
import { loadMcpServerConfig } from './config.js'
import { configureLocalRuntime } from './local/runtimeIdentity.js'

initTelemetry({ serviceName: 'aleph-mcp' })

const log: Logger = createLogger('mcp-server')
const config = loadMcpServerConfig()
// Local trust: the runtime owns the Bridge device credential (identity.json) and the
// grant store. The Bridge still authenticates on /device — reachability is not authorization.
const ctx = await configureLocalRuntime(process.env, log)
const app = createApp(config, ctx)
app.gateway.startHeartbeatSweep()

const server = Bun.serve<DeviceSocketData>({
  hostname: '127.0.0.1',
  port: config.port,
  idleTimeout: 255,
  fetch: app.fetch,
  websocket: app.websocket
})

log.info('listening', {
  port: server.port,
  mcpPath: config.mcpPath,
  devicePath: config.gateway.devicePath,
  resource: config.publicUrl,
  deviceId: ctx.deviceId
})

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

async function shutdown(): Promise<void> {
  app.gateway.stopHeartbeatSweep()
  await app.mcpHandler.close()
  await server.stop()
  process.exit(0)
}
