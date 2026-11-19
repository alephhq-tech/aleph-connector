import type { Server } from 'bun'
import type { DeviceGatewayService } from './DeviceGatewayService.js'
import type { DeviceSocketData } from './registry/DeviceRegistry.js'

/**
 * Wires a `DeviceGatewayService` onto its own `Bun.serve` listener: the `/device` upgrade path
 * plus the websocket handlers, everything else 404. Used by the standalone entrypoint (`bin.ts`)
 * and offline tests; the production topology embeds the gateway in the Remote MCP Server's
 * listener instead (apps/mcp-autocad/src/app.ts) — one process serves both `/mcp` and `/device`
 * (AUTOCAD_MCP_PROJECT.md section 6).
 */
export function serveGateway(
  gateway: DeviceGatewayService,
  options: { port?: number; hostname?: string } = {}
): Server<DeviceSocketData> {
  return Bun.serve<DeviceSocketData>({
    ...options,
    async fetch(request, server) {
      const outcome = await gateway.handleUpgradeRequest(request, server)
      if (outcome.matched) {
        // `response` is undefined exactly when server.upgrade() already completed the 101
        // switch — bun-types' fetch signature doesn't model that case. See DeviceGatewayService.ts.
        return outcome.response as Response
      }
      return new Response('Not Found', { status: 404 })
    },
    websocket: gateway.websocketHandlers()
  })
}
