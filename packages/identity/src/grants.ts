import type { DeviceGrantRecord, DeviceGrantStore } from './device.js'

export class GrantDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantDeniedError'
  }
}

/**
 * Grant store that can first-claim a device for a workspace/user (portal pairing + ABT mint).
 */
export interface MutableDeviceGrantStore extends DeviceGrantStore {
  claim(deviceId: string, workspaceId: string, userId: string): Promise<DeviceGrantRecord>
  revoke(deviceId: string, workspaceId: string, userId: string): Promise<boolean>
}

interface GrantRow {
  deviceId: string
  workspaceId: string
  userId: string
  generation: number
  status: 'active' | 'revoked'
  createdAt: number
}

/** In-memory grant store for tests and local runs without Postgres. */
export class MemoryDeviceGrantStore implements MutableDeviceGrantStore {
  private rows: GrantRow[] = []

  async claim(deviceId: string, workspaceId: string, userId: string): Promise<DeviceGrantRecord> {
    const own = this.rows.find(
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
    if (this.rows.some((g) => g.status === 'active' && g.deviceId === deviceId)) {
      throw new GrantDeniedError(
        `Device "${deviceId}" is already granted to another workspace/user; this caller has no grant for it.`
      )
    }
    const highest = this.rows
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
    this.rows.push(created)
    return {
      deviceId: created.deviceId,
      workspaceId: created.workspaceId,
      userId: created.userId,
      generation: created.generation
    }
  }

  async revoke(deviceId: string, workspaceId: string, userId: string): Promise<boolean> {
    let touched = false
    for (const g of this.rows) {
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
    return touched
  }

  async validate(
    deviceId: string,
    workspaceId: string,
    userId: string,
    expectedGeneration?: number
  ): Promise<boolean> {
    const grant = this.rows.find(
      (g) =>
        g.status === 'active' &&
        g.deviceId === deviceId &&
        g.workspaceId === workspaceId &&
        g.userId === userId
    )
    if (!grant) return false
    if (expectedGeneration !== undefined && grant.generation !== expectedGeneration) return false
    return true
  }

  async listForCaller(workspaceId: string, userId: string): Promise<DeviceGrantRecord[]> {
    return this.rows
      .filter((g) => g.status === 'active' && g.workspaceId === workspaceId && g.userId === userId)
      .map((g) => ({
        deviceId: g.deviceId,
        workspaceId: g.workspaceId,
        userId: g.userId,
        generation: g.generation
      }))
  }
}

/**
 * Minimal SQL executor so portal and mcp-server can plug Bun.sql / postgres.js without coupling
 * `@aleph-connector/identity` to a specific driver.
 */
export interface SqlExecutor {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

/**
 * Postgres-backed `device_grants` (see apps/portal/sql/schema.sql). Same first-claim / generation
 * semantics as the in-memory and JSON-file stores.
 */
export class PostgresDeviceGrantStore implements MutableDeviceGrantStore {
  constructor(private readonly sql: SqlExecutor) {}

  async claim(deviceId: string, workspaceId: string, userId: string): Promise<DeviceGrantRecord> {
    const own = await this.sql.query<{
      device_id: string
      workspace_id: string
      user_id: string
      generation: number
    }>(
      `SELECT device_id, workspace_id, user_id, generation FROM device_grants
       WHERE status = 'active' AND device_id = $1 AND workspace_id = $2 AND user_id = $3
       LIMIT 1`,
      [deviceId, workspaceId, userId]
    )
    if (own[0]) {
      return {
        deviceId: own[0].device_id,
        workspaceId: own[0].workspace_id,
        userId: own[0].user_id,
        generation: own[0].generation
      }
    }

    const foreign = await this.sql.query<{ device_id: string }>(
      `SELECT device_id FROM device_grants WHERE status = 'active' AND device_id = $1 LIMIT 1`,
      [deviceId]
    )
    if (foreign[0]) {
      throw new GrantDeniedError(
        `Device "${deviceId}" is already granted to another workspace/user; this caller has no grant for it.`
      )
    }

    const gens = await this.sql.query<{ generation: number }>(
      `SELECT COALESCE(MAX(generation), 0)::int AS generation FROM device_grants
       WHERE device_id = $1 AND workspace_id = $2 AND user_id = $3`,
      [deviceId, workspaceId, userId]
    )
    const generation = (gens[0]?.generation ?? 0) + 1
    await this.sql.query(
      `INSERT INTO device_grants (device_id, workspace_id, user_id, generation, status, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [deviceId, workspaceId, userId, generation, Date.now()]
    )
    return { deviceId, workspaceId, userId, generation }
  }

  async revoke(deviceId: string, workspaceId: string, userId: string): Promise<boolean> {
    const updated = await this.sql.query<{ device_id: string }>(
      `UPDATE device_grants SET status = 'revoked'
       WHERE status = 'active' AND device_id = $1 AND workspace_id = $2 AND user_id = $3
       RETURNING device_id`,
      [deviceId, workspaceId, userId]
    )
    return updated.length > 0
  }

  async validate(
    deviceId: string,
    workspaceId: string,
    userId: string,
    expectedGeneration?: number
  ): Promise<boolean> {
    const rows = await this.sql.query<{ generation: number }>(
      `SELECT generation FROM device_grants
       WHERE status = 'active' AND device_id = $1 AND workspace_id = $2 AND user_id = $3
       LIMIT 1`,
      [deviceId, workspaceId, userId]
    )
    const grant = rows[0]
    if (!grant) return false
    if (expectedGeneration !== undefined && grant.generation !== expectedGeneration) return false
    return true
  }

  async listForCaller(workspaceId: string, userId: string): Promise<DeviceGrantRecord[]> {
    const rows = await this.sql.query<{
      device_id: string
      workspace_id: string
      user_id: string
      generation: number
    }>(
      `SELECT device_id, workspace_id, user_id, generation FROM device_grants
       WHERE status = 'active' AND workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    )
    return rows.map((g) => ({
      deviceId: g.device_id,
      workspaceId: g.workspace_id,
      userId: g.user_id,
      generation: g.generation
    }))
  }
}
