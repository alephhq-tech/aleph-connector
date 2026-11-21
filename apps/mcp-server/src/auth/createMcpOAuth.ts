import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  McpOAuthAuthorizationServer,
  MemoryMcpOAuthStore,
  type McpOAuthAuthorizationServer as McpOAuthAS
} from '@aleph-connector/identity'

export interface McpOAuthRuntime {
  oauth: McpOAuthAS
  issuer: string
  resource: string
}

function publicBaseUrl(env: NodeJS.ProcessEnv, port: number): string {
  const configured = env.ALEPH_PUBLIC_URL?.trim() || env.MCP_PUBLIC_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')
  return `http://127.0.0.1:${port}`
}

export function createMcpOAuth(env: NodeJS.ProcessEnv, port: number): McpOAuthRuntime {
  const jwtSecret = env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required')
  }

  const issuer = publicBaseUrl(env, port)
  const mcpPath = env.MCP_PATH?.trim() || '/mcp'
  const resource = `${issuer}${mcpPath.startsWith('/') ? mcpPath : `/${mcpPath}`}`

  const persist =
    env.ALEPH_OAUTH_STORE_FILE?.trim() ||
    fileURLToPath(new URL('../../.aleph-dev/oauth-store.json', import.meta.url))
  mkdirSync(dirname(resolve(persist)), { recursive: true })

  const portalUrl = env.ALEPH_PORTAL_URL?.trim()
  const portalApproveSecret = env.PORTAL_APPROVE_SECRET?.trim()

  const oauth = new McpOAuthAuthorizationServer({
    issuer,
    resource,
    jwtSecret,
    store: new MemoryMcpOAuthStore(persist),
    allowDevCodeIssuance: env.ALEPH_DEV_IDENTITY === '1',
    ...(portalUrl ? { portalUrl } : {}),
    ...(portalApproveSecret ? { portalApproveSecret } : {})
  })

  return { oauth, issuer, resource }
}
