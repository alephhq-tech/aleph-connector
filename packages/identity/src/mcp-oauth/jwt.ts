import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface McpAccessTokenClaims {
  iss: string
  aud: string
  sub: string
  client_id: string
  workspace_id: string
  scope: string
  iat: number
  exp: number
  jti: string
}

export class McpJwtService {
  constructor(private readonly secret: string) {
    if (secret.trim().length < 16) {
      throw new Error('MCP OAuth JWT_SECRET must be at least 16 characters')
    }
  }

  private mac(unsigned: string): Buffer {
    return createHmac('sha256', `${this.secret}:mcp-access-token`).update(unsigned).digest()
  }

  sign(claims: Omit<McpAccessTokenClaims, 'iat' | 'exp' | 'jti'> & { ttlSeconds: number }): {
    token: string
    expiresAt: number
    jti: string
  } {
    const now = Math.floor(Date.now() / 1000)
    const jti = randomBytes(16).toString('hex')
    const payload: McpAccessTokenClaims = {
      iss: claims.iss,
      aud: claims.aud,
      sub: claims.sub,
      client_id: claims.client_id,
      workspace_id: claims.workspace_id,
      scope: claims.scope,
      iat: now,
      exp: now + claims.ttlSeconds,
      jti
    }
    const unsigned =
      `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.` +
      Buffer.from(JSON.stringify(payload)).toString('base64url')
    return {
      token: `${unsigned}.${this.mac(unsigned).toString('base64url')}`,
      expiresAt: payload.exp,
      jti
    }
  }

  verify(token: string, expected: { issuer: string; audience: string }): McpAccessTokenClaims | null {
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some((p) => !p)) return null
    const [header, body, signature] = parts as [string, string, string]
    let signatureBytes: Buffer
    try {
      signatureBytes = Buffer.from(signature, 'base64url')
    } catch {
      return null
    }
    const expectedMac = this.mac(`${header}.${body}`)
    if (
      expectedMac.length !== signatureBytes.length ||
      !timingSafeEqual(expectedMac, signatureBytes)
    ) {
      return null
    }
    let payload: McpAccessTokenClaims
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as McpAccessTokenClaims
    } catch {
      return null
    }
    if (
      typeof payload.iss !== 'string' ||
      typeof payload.aud !== 'string' ||
      typeof payload.sub !== 'string' ||
      typeof payload.client_id !== 'string' ||
      typeof payload.workspace_id !== 'string' ||
      typeof payload.scope !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number' ||
      typeof payload.jti !== 'string'
    ) {
      return null
    }
    if (payload.iss !== expected.issuer) return null
    if (payload.aud !== expected.audience) return null
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null
    return payload
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
