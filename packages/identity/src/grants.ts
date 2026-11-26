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
  /** Revoke every active grant for a device (Connector re-pair / machine takeover). */
  revokeAllActive(deviceId: string): Promise<number>
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

  async revokeAllActive(deviceId: string): Promise<number> {
    let n = 0
    for (const g of this.rows) {
      if (g.status === 'active' && g.deviceId === deviceId) {
        g.status = 'revoked'
        n += 1
      }
    }
    return n
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
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({
        deviceId: g.deviceId,
        workspaceId: g.workspaceId,
        userId: g.userId,
        generation: g.generation
      }))
  }
}

