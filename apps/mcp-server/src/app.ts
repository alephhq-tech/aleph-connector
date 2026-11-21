import type { Server } from 'bun'
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type McpHttpHandler
} from '@modelcontextprotocol/server'
import {
  AutoCadBridgeTokenAuthenticator,
  DeviceGatewayService,
  type DeviceSocketData,
  type DeviceWebSocketHandlers
} from '@aleph-connector/device-gateway'
import { MCP_SCOPES } from '@aleph-connector/identity'
import { createLogger, type Logger } from '@aleph-connector/observability'
import { McpAccessTokenVerifier } from './auth/McpAccessTokenVerifier.js'
import { MCP_REQUIRED_SCOPE, requireCallerIdentity, requireDeviceId } from './auth/DeviceIdentityVerifier.js'
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
 * MCP resource server + Device Gateway WSS. OAuth AS lives on Aleph Gateway —
 * this process only advertises the gateway issuer and verifies access tokens.
 */
export function createApp(config: McpServerConfig): McpServerApp {
  const gateway = new DeviceGatewayService(config.gateway, new AutoCadBridgeTokenAuthenticator())

  const resourceServerUrl = new URL(config.resourceUrl)
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl)
  const authGate = requireBearerAuth({
    verifier: new McpAccessTokenVerifier(
      config.gatewayIssuerUrl,
      config.resourceUrl,
      config.jwtSecret
    ),
    requiredScopes: [MCP_REQUIRED_SCOPE],
    resourceMetadataUrl
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

  const protectedResourceMetadata = {
    resource: config.resourceUrl,
    authorization_servers: [config.gatewayIssuerUrl],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header']
  }

  return {
    gateway,
    mcpHandler,
    websocket: gateway.websocketHandlers(),
    async fetch(request, server) {
      const url = new URL(request.url)

      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          service: 'aleph-mcp',
          version: process.env.ALEPH_RELEASE_VERSION ?? 'development',
          sha: process.env.ALEPH_RELEASE_SHA ?? 'unknown',
          auth: 'oauth',
          authorization_server: config.gatewayIssuerUrl
        })
      }

      // RFC 9728 protected resource metadata — points agents at the Gateway AS.
      if (
        request.method === 'GET' &&
        (url.pathname === '/.well-known/oauth-protected-resource' ||
          url.pathname === `/.well-known/oauth-protected-resource${config.mcpPath}`)
      ) {
        return Response.json(protectedResourceMetadata)
      }

      // Convenience: redirect AS discovery toward the gateway issuer.
      if (
        request.method === 'GET' &&
        url.pathname === '/.well-known/oauth-authorization-server'
      ) {
        return Response.redirect(`${config.gatewayIssuerUrl}/.well-known/oauth-authorization-server`, 302)
      }

      const deviceOutcome = await gateway.handleUpgradeRequest(request, server)
      if (deviceOutcome.matched) {
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
