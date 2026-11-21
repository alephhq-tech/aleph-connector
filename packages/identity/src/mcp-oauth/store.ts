import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomToken } from './jwt.js'

export interface RegisteredClient {
  clientId: string
  clientSecret?: string
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
  clientName?: string
  createdAt: number
}

export interface AuthorizationCodeRecord {
  code: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  scope: string
  resource: string
  userId: string
  workspaceId: string
  expiresAt: number
}

export interface RefreshTokenRecord {
  token: string
  clientId: string
  userId: string
  workspaceId: string
  scope: string
  resource: string
  expiresAt: number
  revoked: boolean
}

export interface McpOAuthStore {
  putClient(client: RegisteredClient): void
  getClient(clientId: string): RegisteredClient | undefined
  putCode(record: AuthorizationCodeRecord): void
  takeCode(code: string): AuthorizationCodeRecord | undefined
  putRefresh(record: RefreshTokenRecord): void
  getRefresh(token: string): RefreshTokenRecord | undefined
  revokeRefresh(token: string): void
}

export class MemoryMcpOAuthStore implements McpOAuthStore {
  private clients = new Map<string, RegisteredClient>()
  private codes = new Map<string, AuthorizationCodeRecord>()
  private refresh = new Map<string, RefreshTokenRecord>()

  constructor(private readonly persistPath?: string) {
    if (persistPath) this.load()
  }

  private load(): void {
    if (!this.persistPath) return
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as {
        clients?: RegisteredClient[]
        refresh?: RefreshTokenRecord[]
      }
      for (const c of raw.clients ?? []) this.clients.set(c.clientId, c)
      for (const r of raw.refresh ?? []) this.refresh.set(r.token, r)
    } catch {
      // first run
    }
  }

  private save(): void {
    if (!this.persistPath) return
    mkdirSync(dirname(this.persistPath), { recursive: true })
    writeFileSync(
      this.persistPath,
      JSON.stringify(
        {
          clients: [...this.clients.values()],
          refresh: [...this.refresh.values()].filter((r) => !r.revoked)
        },
        null,
        2
      ) + '\n'
    )
  }

  putClient(client: RegisteredClient): void {
    this.clients.set(client.clientId, client)
    this.save()
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId)
  }

  putCode(record: AuthorizationCodeRecord): void {
    this.codes.set(record.code, record)
  }

  takeCode(code: string): AuthorizationCodeRecord | undefined {
    const record = this.codes.get(code)
    if (!record) return undefined
    this.codes.delete(code)
    return record
  }

  putRefresh(record: RefreshTokenRecord): void {
    this.refresh.set(record.token, record)
    this.save()
  }

  getRefresh(token: string): RefreshTokenRecord | undefined {
    return this.refresh.get(token)
  }

  revokeRefresh(token: string): void {
    const existing = this.refresh.get(token)
    if (!existing) return
    existing.revoked = true
    this.save()
  }
}

export function newClientId(): string {
  return `mcp_${randomToken(12)}`
}
