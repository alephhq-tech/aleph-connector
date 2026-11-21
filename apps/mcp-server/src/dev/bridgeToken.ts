import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AbtTokenService,
  GrantDeniedError,
  type DeviceCredentialPayload,
  type DeviceCredentialService,
  type DeviceCredentialVerification,
  type DeviceGrantRecord,
  type MutableDeviceGrantStore
} from '@aleph-connector/identity'

/**
 * Development credential issuer/verifier for the live AutoCAD E2E lane.
 *
 * Opt-in via `ALEPH_DEV_IDENTITY=1`. Wire format and grant-generation recheck come from
 * `@aleph-connector/identity` `AbtTokenService`; only secret custody and grant durability are file-backed
 * stand-ins for local bring-up.
 */

const GRANT_FILE_NAME = 'device-grants.json'

interface GrantRow {
  deviceId: string
  workspaceId: string
  userId: string
  generation: number
  status: 'active' | 'revoked'
  createdAt: number
}

export { GrantDeniedError }

/**
 * File-backed grant store for dev runs, mirroring the production `device_grants` semantics the
 * gateway actually enforces: first-claim ownership, deny-a-foreign-deviceId, and a generation that
 * moves on revoke so previously minted tokens stop authorizing.
 */
export class JsonFileGrantStore implements MutableDeviceGrantStore {
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
  async claim(deviceId: string, workspaceId: string, userId: string): Promise<DeviceGrantRecord> {
    const rows = this.read()
    const own = rows.find(
      (g) =>
        g.status === 'active' &&
        g.deviceId === deviceId &&
        g.workspaceId === workspaceId &&
        g.userId === userId
    )
    if (own) {
      return {
        deviceId: own.deviceId,
        workspaceId: own.workspaceId,
        userId: own.userId,
        generation: own.generation
      }
    }

    if (rows.some((g) => g.status === 'active' && g.deviceId === deviceId)) {
      throw new GrantDeniedError(
        `Device "${deviceId}" is already granted to another workspace/user; this caller has no grant for it.`
      )
    }

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
    return {
      deviceId: created.deviceId,
      workspaceId: created.workspaceId,
      userId: created.userId,
      generation: created.generation
    }
  }

  async revoke(deviceId: string, workspaceId: string, userId: string): Promise<boolean> {
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

  async revokeAllActive(deviceId: string): Promise<number> {
    const rows = this.read()
    let n = 0
    for (const g of rows) {
      if (g.status === 'active' && g.deviceId === deviceId) {
        g.status = 'revoked'
        n += 1
      }
    }
    if (n > 0) this.write(rows)
    return n
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

  async listForCaller(workspaceId: string, userId: string): Promise<DeviceGrantRecord[]> {
    return this.read()
      .filter((g) => g.status === 'active' && g.workspaceId === workspaceId && g.userId === userId)
      .map((g) => ({
        deviceId: g.deviceId,
        workspaceId: g.workspaceId,
        userId: g.userId,
        generation: g.generation
      }))
  }
}

/** Thin wrapper: ABT crypto from identity + file-backed grants for the live E2E lane. */
export class DevBridgeTokenService implements DeviceCredentialService {
  private readonly abt: AbtTokenService

  constructor(
    jwtSecret: string,
    grants: JsonFileGrantStore
  ) {
    if (jwtSecret.trim().length < 16) {
      throw new Error(
        'ALEPH_DEV_IDENTITY needs a JWT_SECRET of at least 16 characters — the dev lane still signs and verifies, it does not skip auth.'
      )
    }
    this.abt = new AbtTokenService(jwtSecret, grants)
  }

  mint(
    identity: { deviceId: string; userId: string; workspaceId: string },
    ttlSeconds?: number
  ): Promise<{ token: string; expiresAt: number; grantGeneration: number }> {
    return this.abt.mint(identity, ttlSeconds)
  }

  async verify(token: string): Promise<DeviceCredentialPayload | null> {
    return this.abt.verify(token)
  }

  async verifyDetailed(token: string): Promise<DeviceCredentialVerification> {
    return this.abt.verifyDetailed(token)
  }
}

/**
 * Default dev grant file, derived from THIS module's location rather than the caller's cwd.
 */
export function defaultDevGrantFile(): string {
  return fileURLToPath(new URL(`../../.aleph-dev/${GRANT_FILE_NAME}`, import.meta.url))
}

/** Resolves the grant file: explicit override wins, else the module-derived default. */
export function devGrantFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ALEPH_DEV_GRANT_FILE?.trim()
  return resolve(override || defaultDevGrantFile())
}
