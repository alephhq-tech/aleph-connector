export const MCP_SCOPES = ['cad:read', 'cad:write', 'cad:file', 'cad:admin'] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export const DEFAULT_MCP_SCOPES: readonly McpScope[] = ['cad:read', 'cad:write']

export function parseScopeString(scope: string | null | undefined): McpScope[] {
  if (!scope?.trim()) return [...DEFAULT_MCP_SCOPES]
  const allowed = new Set<string>(MCP_SCOPES)
  const out: McpScope[] = []
  for (const part of scope.split(/\s+/)) {
    if (!part) continue
    if (!allowed.has(part)) {
      throw new Error(`unsupported_scope:${part}`)
    }
    if (!out.includes(part as McpScope)) out.push(part as McpScope)
  }
  return out.length > 0 ? out : [...DEFAULT_MCP_SCOPES]
}

export function scopeString(scopes: readonly string[]): string {
  return scopes.join(' ')
}
