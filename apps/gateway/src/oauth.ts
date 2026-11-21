import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  McpOAuthAuthorizationServer,
  MemoryMcpOAuthStore
} from '@aleph-connector/identity'
import type { GatewayConfig } from './config.js'

export function createGatewayOAuth(config: GatewayConfig): McpOAuthAuthorizationServer {
  const persist =
    process.env.ALEPH_OAUTH_STORE_FILE?.trim() ||
    fileURLToPath(new URL('../.aleph-dev/oauth-store.json', import.meta.url))
  mkdirSync(dirname(resolve(persist)), { recursive: true })

  return new McpOAuthAuthorizationServer({
    issuer: config.publicUrl,
    resource: config.mcpResourceUrl,
    jwtSecret: config.jwtSecret,
    store: new MemoryMcpOAuthStore(persist),
    allowDevCodeIssuance: config.allowDevCodeIssuance,
    connectorConsentUri: config.connectorConsentUri,
    connectorApproveSecret: config.connectorApproveSecret
  })
}
