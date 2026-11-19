import type { Server } from 'bun'
import {
  createMcpHandler,
  requireBearerAuth,
  type McpHttpHandler
} from '@modelcontextprotocol/server'
import {
  AutoCadBridgeTokenAuthenticator,
  DeviceGatewayService,
  type DeviceSocketData,
  type DeviceWebSocketHandlers
} from '@arcdio/device-gateway'
import { createLogger, type Logger } from '@arcdio/observability'
import {
  AUTOCAD_CONTROL_SCOPE,
  DeviceIdentityVerifier,
  requireDeviceId,
  requireCallerIdentity
} from './auth/DeviceIdentityVerifier.js'
import { DeviceGatewayBridgeClient } from './bridge/DeviceGatewayBridgeClient.js'
import type { McpServerConfig } from './config.js'
import { createServer } from './server.js'

const log: Logger = createLogger('mcp-server')

interface McpServerApp {
  gateway: DeviceGatewayService
  mcpHandler: McpHttpHandler
  fetch: (request: Request, server: Server<DeviceSocketData>) => Promise<Response>
  websocket: DeviceWebSocketHandlers
}

/**
 * Composes the "Server cloud" box from architecture.jpg into one process for v1: the Remote MCP
 * Server (Streamable HTTP, AI-Desktop-facing) and the Device Gateway (WSS, Bridge-facing) share one
 * Bun.serve listener and one in-process DeviceGatewayService — see AUTOCAD_MCP_PROJECT.md section 6
 * on why that's the correct MVP shape.
 */
export function createApp(config: McpServerConfig): McpServerApp {
  const gateway = new DeviceGatewayService(config.gateway, new AutoCadBridgeTokenAuthenticator())

  const authGate = requireBearerAuth({
    verifier: new DeviceIdentityVerifier(),
    requiredScopes: [AUTOCAD_CONTROL_SCOPE]
  })

  const mcpHandler = createMcpHandler(
    (ctx) => {
      const deviceId = requireDeviceId(ctx.authInfo)
      const caller = requireCallerIdentity(ctx.authInfo)
      const bridge = new DeviceGatewayBridgeClient(gateway, deviceId, caller)
      return createServer(bridge, gateway, deviceId, caller.workspaceId)
    },
    { onerror: (err) => log.error('mcp handler error', { error: err.message }) }
  )

  return {
    gateway,
    mcpHandler,
    websocket: gateway.websocketHandlers(),
    async fetch(request, server) {
      const url = new URL(request.url)
      // Public liveness probe; no Bridge/device credentials or workspace data exposed.
      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          service: 'aleph-mcp-autocad',
          version: process.env.ALEPH_RELEASE_VERSION ?? 'development',
          sha: process.env.ALEPH_RELEASE_SHA ?? 'unknown'
        })
      }

      const deviceOutcome = await gateway.handleUpgradeRequest(request, server)
      if (deviceOutcome.matched) {
        // undefined exactly when server.upgrade() already completed the 101 switch — see
        // DeviceGatewayService.ts's DeviceUpgradeOutcome doc comment.
        return deviceOutcome.response as Response
      }

      if (url.pathname === config.mcpPath) {
        const auth = await authGate(request)
        if (auth instanceof Response) return auth
        return mcpHandler.fetch(request, { authInfo: auth })
      }

      return new Response('Not Found', { status: 404 })
    }
  }
}
