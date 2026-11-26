import type { Server } from 'bun'
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import {
  AutoCadBridgeTokenAuthenticator,
  DeviceGatewayService,
  type DeviceSocketData,
  type DeviceWebSocketHandlers
} from '@aleph-connector/device-gateway'
import { createLogger, type Logger } from '@aleph-connector/observability'
import { DeviceGatewayBridgeClient } from './bridge/DeviceGatewayBridgeClient.js'
import type { McpServerConfig } from './config.js'
import { guardLoopback } from './local/loopbackGuard.js'
import type { LocalRuntimeContext } from './local/runtimeIdentity.js'
import { createServer } from './server.js'

const log: Logger = createLogger('mcp-server')

interface McpServerApp {
  gateway: DeviceGatewayService
  mcpHandler: McpHttpHandler
  fetch: (request: Request, server: Server<DeviceSocketData>) => Promise<Response>
  websocket: DeviceWebSocketHandlers
}

/**
 * Local-first runtime: MCP resource server + Device Gateway WSS in one process, bound to
 * loopback. There is no OAuth gate — every request first passes the loopback Host/Origin
 * guard, and the Bridge authenticates on the device path with the locally minted ABT
 * credential (socket reachability is never authorization). The MCP caller is the fixed
 * local principal; product-level approval lives in the desktop app.
 */
export function createApp(config: McpServerConfig, ctx: LocalRuntimeContext): McpServerApp {
  const gateway = new DeviceGatewayService(config.gateway, new AutoCadBridgeTokenAuthenticator())

  const mcpHandler = createMcpHandler(
    () => {
      const bridge = new DeviceGatewayBridgeClient(gateway, ctx.deviceId, ctx.caller)
      return createServer(bridge, gateway, ctx.deviceId, ctx.caller.workspaceId)
    },
    { onerror: (err) => log.error('mcp handler error', { error: err.message }) }
  )

  return {
    gateway,
    mcpHandler,
    websocket: gateway.websocketHandlers(),
    async fetch(request, server) {
      const blocked = guardLoopback(request)
      if (blocked) return blocked

      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        return new Response('Bad Request', { status: 400 })
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          service: 'aleph-mcp',
          version: process.env.ALEPH_RELEASE_VERSION ?? 'development',
          sha: process.env.ALEPH_RELEASE_SHA ?? 'unknown',
          auth: 'local',
          deviceId: ctx.deviceId
        })
      }

      const deviceOutcome = await gateway.handleUpgradeRequest(request, server)
      if (deviceOutcome.matched) {
        return deviceOutcome.response as Response
      }

      if (url.pathname === config.mcpPath) {
        return mcpHandler.fetch(request, {})
      }

      return new Response('Not Found', { status: 404 })
    }
  }
}
