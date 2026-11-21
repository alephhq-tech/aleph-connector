import type { Server } from 'bun'
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type McpHttpHandler
} from '@modelcontextprotocol/server'
import {
  AutoCadBridgeTokenAuthenticator,
  DeviceGatewayService,
  type DeviceSocketData,
  type DeviceWebSocketHandlers
} from '@aleph-connector/device-gateway'
import { MCP_SCOPES, type McpOAuthAuthorizationServer } from '@aleph-connector/identity'
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
  oauth: McpOAuthAuthorizationServer
  fetch: (request: Request, server: Server<DeviceSocketData>) => Promise<Response>
  websocket: DeviceWebSocketHandlers
}

/**
 * Composes MCP resource server + Device Gateway + MCP OAuth AS (same origin for local/MVP).
 * MCP clients authenticate via OAuth access tokens only. Connector WSS uses device credentials.
 */
export function createApp(
  config: McpServerConfig,
  oauth: McpOAuthAuthorizationServer
): McpServerApp {
  const gateway = new DeviceGatewayService(config.gateway, new AutoCadBridgeTokenAuthenticator())

  const resourceServerUrl = new URL(config.resourceUrl)
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl)
  const authGate = requireBearerAuth({
    verifier: new McpAccessTokenVerifier(oauth),
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

  const authMetadata = {
    oauthMetadata: oauth.metadata(),
    resourceServerUrl,
    scopesSupported: [...MCP_SCOPES],
    // Local/dev AS is served over http://127.0.0.1; production must use HTTPS issuer URLs.
    dangerouslyAllowInsecureIssuerUrl: resourceServerUrl.protocol === 'http:'
  }

  return {
    gateway,
    mcpHandler,
    oauth,
    websocket: gateway.websocketHandlers(),
    async fetch(request, server) {
      const url = new URL(request.url)

      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          service: 'aleph-mcp',
          version: process.env.ALEPH_RELEASE_VERSION ?? 'development',
          sha: process.env.ALEPH_RELEASE_SHA ?? 'unknown',
          auth: 'oauth'
        })
      }

      const oauthResponse = await oauth.handleRequest(request)
      if (oauthResponse) return oauthResponse

      const metadata = oauthMetadataResponse(request, authMetadata)
      if (metadata) return metadata

      // Explicit PRM at the RFC 9728 path for this resource (SDK helper may also cover it).
      if (
        request.method === 'GET' &&
        (url.pathname === '/.well-known/oauth-protected-resource' ||
          url.pathname === `/.well-known/oauth-protected-resource${config.mcpPath}`)
      ) {
        return Response.json(buildOAuthProtectedResourceMetadata(authMetadata))
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
