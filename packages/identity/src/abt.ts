import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  DeviceCredentialPayload,
  DeviceCredentialService,
  DeviceCredentialVerification
} from './device.js'
import type { MutableDeviceGrantStore } from './grants.js'

const TOKEN_TTL_SECONDS_DEFAULT = 24 * 60 * 60
const ABT_KEY_SUFFIX = 'autocad-bridge-token'

export interface AbtWirePayload {
  deviceId: string
  userId: string
  workspaceId: string
  grantGeneration?: number
  iat: number
  exp: number
}

export interface AbtMintResult {
  token: string
  expiresAt: number
  grantGeneration: number
}

/** Returns null for any payload that fails the shape check, so callers map it to `malformed`. */
export function parseAbtWirePayload(value: unknown): AbtWirePayload | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (
    typeof o.deviceId !== 'string' ||
    o.deviceId.length === 0 ||
    typeof o.userId !== 'string' ||
    o.userId.length === 0 ||
    typeof o.workspaceId !== 'string' ||
    o.workspaceId.length === 0 ||
    typeof o.iat !== 'number' ||
    typeof o.exp !== 'number' ||
    (o.grantGeneration !== undefined && typeof o.grantGeneration !== 'number')
  ) {
    return null
  }
  return {
    deviceId: o.deviceId,
    userId: o.userId,
    workspaceId: o.workspaceId,
    ...(o.grantGeneration !== undefined ? { grantGeneration: o.grantGeneration } : {}),
    iat: o.iat,
    exp: o.exp
  }
}

/**
 * Compact HMAC-signed `typ:"ABT"` device credentials keyed on `${jwtSecret}:autocad-bridge-token`.
 * Shared by portal minting and mcp-server verification so both speak the same wire format.
 */
export class AbtTokenService implements DeviceCredentialService {
  constructor(
    private readonly jwtSecret: string,
    private readonly grants: MutableDeviceGrantStore
  ) {
    if (jwtSecret.trim().length < 16) {
      throw new Error('ABT JWT_SECRET must be at least 16 characters')
    }
  }

  /** The salt is load-bearing: signing with the bare secret produces `invalid_token:signature`. */
  private sign(unsigned: string): Buffer {
    return createHmac('sha256', `${this.jwtSecret}:${ABT_KEY_SUFFIX}`).update(unsigned).digest()
  }

  async mint(
    identity: { deviceId: string; userId: string; workspaceId: string },
    ttlSeconds = TOKEN_TTL_SECONDS_DEFAULT
  ): Promise<AbtMintResult> {
    const grant = await this.grants.claim(identity.deviceId, identity.workspaceId, identity.userId)
    const now = Math.floor(Date.now() / 1000)
    const payload: AbtWirePayload = {
      ...identity,
      grantGeneration: grant.generation,
      iat: now,
      exp: now + ttlSeconds
    }
    const unsigned =
      `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'ABT' })).toString('base64url')}.` +
      Buffer.from(JSON.stringify(payload)).toString('base64url')
    return {
      token: `${unsigned}.${this.sign(unsigned).toString('base64url')}`,
      expiresAt: payload.exp,
      grantGeneration: grant.generation
    }
  }

  async verify(token: string): Promise<DeviceCredentialPayload | null> {
    const result = await this.verifyDetailed(token)
    return result.ok ? result.payload : null
  }

  async verifyDetailed(token: string): Promise<DeviceCredentialVerification> {
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      return { ok: false, reason: 'malformed' }
    }
    const [header, body, signature] = parts as [string, string, string]

    let signatureBytes: Buffer
    let payloadBytes: Buffer
    try {
      signatureBytes = Buffer.from(signature, 'base64url')
      payloadBytes = Buffer.from(body, 'base64url')
    } catch {
      return { ok: false, reason: 'malformed' }
    }

    const expected = this.sign(`${header}.${body}`)
    if (expected.length !== signatureBytes.length || !timingSafeEqual(expected, signatureBytes)) {
      return { ok: false, reason: 'signature' }
    }

    let payload: AbtWirePayload | null
    try {
      payload = parseAbtWirePayload(JSON.parse(new TextDecoder().decode(payloadBytes)))
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (!payload) return { ok: false, reason: 'malformed' }
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' }

    let grantGeneration = payload.grantGeneration
    if (grantGeneration === undefined) {
      try {
        grantGeneration = (
          await this.grants.claim(payload.deviceId, payload.workspaceId, payload.userId)
        ).generation
      } catch {
        return { ok: false, reason: 'grant_denied' }
      }
    }

    const stillValid = await this.grants.validate(
      payload.deviceId,
      payload.workspaceId,
      payload.userId,
      grantGeneration
    )
    if (!stillValid) return { ok: false, reason: 'grant_stale' }

    return {
      ok: true,
      payload: {
        deviceId: payload.deviceId,
        userId: payload.userId,
        workspaceId: payload.workspaceId,
        grantGeneration,
        exp: payload.exp
      }
    }
  }
}
