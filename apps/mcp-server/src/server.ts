import { McpServer } from '@modelcontextprotocol/server'
import type { DeviceGateway } from '@arcdio/device-contracts'
import type { BridgeClient } from './bridge/BridgeClient.js'
import { DocumentPin, PinnedBridgeClient } from './bridge/PinnedBridgeClient.js'
import { loadDraftingGuide, registerDraftingGuide } from './guide/draftingGuide.js'
import { registerAllTools } from './tools/index.js'

const SERVER_NAME = 'arcdio'
const SERVER_VERSION = '0.2.0'

// Read once per process; createServer runs per MCP session.
const draftingGuide = loadDraftingGuide()

/**
 * Builds one MCP server instance for one authenticated deviceId, wired to that device's AutoCAD via
 * the Device Gateway.
 */
export function createServer(
  bridge: BridgeClient,
  deviceGateway: DeviceGateway,
  deviceId: string,
  // Authenticated tenant from the caller's verified claims. Passed to the drawing tool so an
  // inspect reads that workspace's CAD State snapshot. Optional: callers without tenant context
  // (tests, stdio smoke) leave inspect geometry fail-closed, never cross-tenant.
  workspaceId?: string
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: draftingGuide.instructions }
  )
  // The pin is per MCP session (createServer runs once per session), never shared between users.
  const pin = new DocumentPin()
  registerAllTools(
    server,
    new PinnedBridgeClient(bridge, pin),
    pin,
    deviceGateway,
    deviceId,
    workspaceId
  )
  registerDraftingGuide(server, draftingGuide)
  return server
}
