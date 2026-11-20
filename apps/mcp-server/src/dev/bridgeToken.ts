import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DeviceCredentialPayload,
  DeviceCredentialService,
  DeviceCredentialVerification,
  DeviceGrantStore
} from '@arcdio/identity'

/**
 * Development credential issuer/verifier for the live AutoCAD E2E lane.
 *
 * ARCDIO's production MCP OAuth issuer does not exist yet, so `@arcdio/identity` ships fail-closed.
 * This is the opt-in dev tier that lets a real Windows Connector + AutoCAD plugin talk to a local
 * mcp-server. It speaks the SAME wire format the extracted connector already presents
 * (compact HMAC-signed `typ:"ABT"` tokens keyed on `${JWT_SECRET}:autocad-bridge-token`, plus the
 * `grantGeneration` revocation re-check), so the WSS handshake and the per-dispatch grant validation
 * the lane exercises are the production code paths — only secret custody and grant durability are
 * dev stand-ins. Never selected unless `ARCDIO_DEV_IDENTITY=1`.
 */

const TOKEN_TTL_SECONDS_DEFAULT = 24 * 60 * 60
const GRANT_FILE_NAME = 'device-grants.json'

interface GrantRow {
  deviceId: string
  workspaceId: string
  userId: string
  generation: number
  status: 'active' | 'revoked'
  createdAt: number
}

export class GrantDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantDeniedError'
  }
}

/**
 * File-backed grant store for dev runs, mirroring the production `device_grants` semantics the
 * gateway actually enforces: first-claim ownership, deny-a-foreign-deviceId, and a generation that
 * moves on revoke so previously minted tokens stop authorizing. The lane therefore tests the real
 * enforcement, not a permissive stub.
 */
export class JsonFileGrantStore implements DeviceGrantStore {
  constructor(private readonly filePath: string) {}

  private read(): GrantRow[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return Array.isArray(parsed) ? (parsed as GrantRow[]) : []
    } catch {
      return []
    }
  }

  private write(rows: GrantRow[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(rows, null, 2) + '\n')
  }

  findActive(deviceId: string, workspaceId: string, userId: string): GrantRow | undefined {
    return this.read().find(
      (g) =>
        g.status === 'active' &&
        g.deviceId === deviceId &&
        g.workspaceId === workspaceId &&
        g.userId === userId
    )
  }

  /** Resolves the caller's grant, first-claiming one when the device has none at all. */
  claim(deviceId: string, workspaceId: string, userId: string): GrantRow {
    const rows = this.read()
    const own = rows.find(
      (g) =>
        g.status === 'active' &&
        g.deviceId === deviceId &&
        g.workspaceId === workspaceId &&
        g.userId === userId
    )
    if (own) return own

    if (rows.some((g) => g.status === 'active' && g.deviceId === deviceId)) {
      // Knowing a deviceId is never proof of permission — the abuse case the grant table exists to
      // close, so a dev store must deny it too or the lane would not be testing what ships.
      throw new GrantDeniedError(
        `Device "${deviceId}" is already granted to another workspace/user; this caller has no grant for it.`
      )
    }

    // Generation must move on every re-claim: validate() compares a token's grantGeneration to the
    // ACTIVE row, so reusing a number would silently re-authorize a token that was just revoked.
    const highest = rows
      .filter((g) => g.deviceId === deviceId && g.workspaceId === workspaceId && g.userId === userId)
      .reduce((max, g) => Math.max(max, g.generation), 0)
    const created: GrantRow = {
      deviceId,
      workspaceId,
      userId,
      generation: highest + 1,
      status: 'active',
      createdAt: Date.now()
    }
    this.write([...rows, created])
    return created
  }

  /** Revokes every active grant for the principal, moving its generation for the next claim. */
  revoke(deviceId: string, workspaceId: string, userId: string): boolean {
    const rows = this.read()
    let touched = false
    for (const g of rows) {
      if (
        g.status === 'active' &&
        g.deviceId === deviceId &&
        g.workspaceId === workspaceId &&
        g.userId === userId
      ) {
        g.status = 'revoked'
        touched = true
      }
    }
    if (touched) this.write(rows)
    return touched
  }

  async validate(
    deviceId: string,
    workspaceId: string,
    userId: string,
    expectedGeneration?: number
  ): Promise<boolean> {
    const grant = this.findActive(deviceId, workspaceId, userId)
    if (!grant) return false
    if (expectedGeneration !== undefined && grant.generation !== expectedGeneration) return false
    return true
  }
}

interface WirePayload {
  deviceId: string
  userId: string
  workspaceId: string
  grantGeneration?: number
  iat: number
  exp: number
}

/** Returns null for any payload that fails the shape check, so callers map it to `malformed`. */
function parseWirePayload(value: unknown): WirePayload | null {
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
    grantGeneration: o.grantGeneration,
    iat: o.iat,
    exp: o.exp
  }
}

export class DevBridgeTokenService implements DeviceCredentialService {
  constructor(
    private readonly jwtSecret: string,
    private readonly grants: JsonFileGrantStore
  ) {
    if (jwtSecret.trim().length < 16) {
      throw new Error(
        'ARCDIO_DEV_IDENTITY needs a JWT_SECRET of at least 16 characters — the dev lane still signs and verifies, it does not skip auth.'
      )
    }
  }

  /** The salt is load-bearing: the connector's credential is keyed on the secret PLUS this suffix,
   * so signing with the bare secret produces `invalid_token:signature` on the wire. */
  private sign(unsigned: string): Buffer {
    return createHmac('sha256', `${this.jwtSecret}:autocad-bridge-token`).update(unsigned).digest()
  }

  mint(
    identity: { deviceId: string; userId: string; workspaceId: string },
    ttlSeconds = TOKEN_TTL_SECONDS_DEFAULT
  ): { token: string; expiresAt: number; grantGeneration: number } {
    const grant = this.grants.claim(identity.deviceId, identity.workspaceId, identity.userId)
    const now = Math.floor(Date.now() / 1000)
    const payload: WirePayload = {
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

    let payload: WirePayload | null
    try {
      payload = parseWirePayload(JSON.parse(new TextDecoder().decode(payloadBytes)))
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (!payload) return { ok: false, reason: 'malformed' }
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' }

    let grantGeneration = payload.grantGeneration
    if (grantGeneration === undefined) {
      try {
        grantGeneration = this.grants.claim(payload.deviceId, payload.workspaceId, payload.userId)
          .generation
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

    const verified: DeviceCredentialPayload = {
      deviceId: payload.deviceId,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      grantGeneration,
      exp: payload.exp
    }
    return { ok: true, payload: verified }
  }
}

/**
 * Default dev grant file, derived from THIS module's location rather than the caller's cwd: the
 * mcp-server and the credential minter are separate processes started from the same app folder, and
 * a cwd-relative path let them land on different files, which surfaced as an unexplained 401 on the
 * connector's WSS dial (the server simply had no grant row to check).
 */
export function defaultDevGrantFile(): string {
  return fileURLToPath(new URL(`../../.arcdio-dev/${GRANT_FILE_NAME}`, import.meta.url))
}

/** Resolves the grant file: explicit override wins, else the module-derived default. */
export function devGrantFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ARCDIO_DEV_GRANT_FILE?.trim()
  return resolve(override || defaultDevGrantFile())
}
