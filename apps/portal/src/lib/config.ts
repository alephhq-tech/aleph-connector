export function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function portalConfig() {
  return {
    databaseUrl: requireEnv('DATABASE_URL'),
    jwtSecret: requireEnv('JWT_SECRET'),
    portalApproveSecret: requireEnv('PORTAL_APPROVE_SECRET'),
    mcpPublicUrl: (process.env.MCP_PUBLIC_URL?.trim() || 'http://127.0.0.1:8080').replace(/\/$/, ''),
    portalUrl: (process.env.PORTAL_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/$/, ''),
    sessionSecret: process.env.PORTAL_SESSION_SECRET?.trim() || requireEnv('JWT_SECRET')
  }
}
