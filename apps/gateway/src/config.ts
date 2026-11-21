export interface GatewayConfig {
  port: number
  publicUrl: string
  mcpResourceUrl: string
  databaseUrl: string
  jwtSecret: string
  connectorApproveSecret: string
  connectorConsentUri: string
  allowDevCodeIssuance: boolean
  googleClientId?: string
  googleClientSecret?: string
  googleRedirectUri: string
  connectorAppCallbackUri: string
}

function normalizeMcpResource(raw: string | undefined): string {
  const fallback = 'http://127.0.0.1:8080/mcp'
  const value = raw?.trim()
  if (!value) return fallback
  const base = value.replace(/\/$/, '')
  return base.endsWith('/mcp') ? base : `${base}/mcp`
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number.parseInt(env.GATEWAY_PORT?.trim() || '8090', 10)
  if (!Number.isFinite(port) || port <= 0) throw new Error('GATEWAY_PORT must be a positive integer')

  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const jwtSecret = env.JWT_SECRET?.trim()
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error('JWT_SECRET is required (at least 16 characters)')
  }

  const connectorApproveSecret =
    env.CONNECTOR_APPROVE_SECRET?.trim() || env.PORTAL_APPROVE_SECRET?.trim()
  if (!connectorApproveSecret) {
    throw new Error('CONNECTOR_APPROVE_SECRET is required')
  }

  const publicUrl = (
    env.ALEPH_GATEWAY_URL?.trim() ||
    env.GATEWAY_PUBLIC_URL?.trim() ||
    `http://127.0.0.1:${port}`
  ).replace(/\/$/, '')

  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() || undefined
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() || undefined

  return {
    port,
    publicUrl,
    mcpResourceUrl: normalizeMcpResource(env.MCP_RESOURCE_URL || env.MCP_PUBLIC_URL),
    databaseUrl,
    jwtSecret,
    connectorApproveSecret,
    connectorConsentUri:
      env.CONNECTOR_CONSENT_URI?.trim() || 'aleph-connector://oauth/consent',
    allowDevCodeIssuance: env.ALEPH_DEV_IDENTITY === '1',
    ...(googleClientId ? { googleClientId } : {}),
    ...(googleClientSecret ? { googleClientSecret } : {}),
    googleRedirectUri:
      env.GOOGLE_REDIRECT_URI?.trim() || `${publicUrl}/auth/google/callback`,
    connectorAppCallbackUri:
      env.CONNECTOR_APP_CALLBACK_URI?.trim() || 'aleph-connector://auth/callback'
  }
}
