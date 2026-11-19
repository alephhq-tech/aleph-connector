import type { DeviceSocketData } from '@arcdio/device-gateway'
import { createLogger, initTelemetry, type Logger } from '@arcdio/observability'
import { createApp } from './app.js'
import { loadMcpServerConfig } from './config.js'

// No-op unless Langfuse observability is configured.
initTelemetry({ serviceName: 'mcp-autocad' })

const log: Logger = createLogger('mcp-server')
const config = loadMcpServerConfig()
const app = createApp(config)
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
  devicePath: config.gateway.devicePath
})

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

async function shutdown(): Promise<void> {
  app.gateway.stopHeartbeatSweep()
  await app.mcpHandler.close()
  await server.stop()
  process.exit(0)
}
