import { AutoCadBridgeTokenAuthenticator } from './auth/DeviceAuthenticator.js'
import { loadGatewayConfig } from './config.js'
import { DeviceGatewayService } from './DeviceGatewayService.js'
import { serveGateway } from './serve.js'

/**
 * Standalone entrypoint for running the Device Gateway as its own process (AUTOCAD_MCP_PROJECT.md
 * section 6: "Later, if the services are deployed independently..."). For v1 server embeds
 * `DeviceGatewayService` directly instead of running this — see server/src/index.ts.
 */
const config = loadGatewayConfig()
const gateway = new DeviceGatewayService(config, new AutoCadBridgeTokenAuthenticator())
gateway.startHeartbeatSweep()

const server = serveGateway(gateway, {
  port: Number.parseInt(process.env.MCP_AUTOCAD_DEVICE_GATEWAY_PORT ?? '8081', 10)
})

console.error(`device-gateway: listening on :${server.port}${config.devicePath} (standalone mode)`)

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

async function shutdown(): Promise<void> {
  gateway.stopHeartbeatSweep()
  await server.stop()
  process.exit(0)
}
