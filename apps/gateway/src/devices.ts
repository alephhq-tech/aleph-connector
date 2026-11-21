import {
  AbtTokenService,
  GrantDeniedError,
  PostgresDeviceGrantStore
} from '@aleph-connector/identity'
import type { GatewayConfig } from './config.js'
import { sqlExecutor } from './db.js'

export interface DeviceListItem {
  deviceId: string
  generation: number
}

export async function listDevices(
  config: GatewayConfig,
  workspaceId: string,
  userId: string
): Promise<DeviceListItem[]> {
  const grants = new PostgresDeviceGrantStore(sqlExecutor(config))
  const rows = await grants.listForCaller(workspaceId, userId)
  return rows.map((r) => ({ deviceId: r.deviceId, generation: r.generation }))
}

export async function pairDevice(
  config: GatewayConfig,
  input: { deviceId: string; workspaceId: string; userId: string }
): Promise<{ token: string; expiresAt: number; grantGeneration: number; deviceId: string }> {
  const deviceId = input.deviceId.trim()
  if (!deviceId) throw new Error('deviceId is required')
  const grants = new PostgresDeviceGrantStore(sqlExecutor(config))
  const abt = new AbtTokenService(config.jwtSecret, grants)
  const mint = () =>
    abt.mint({
      deviceId,
      userId: input.userId,
      workspaceId: input.workspaceId
    })
  const mintWithReclaim = async () => {
    try {
      return await mint()
    } catch (err) {
      // Connector is the machine UI: signing in here takes over a stale/smoke grant on this device.
      if (!(err instanceof GrantDeniedError)) throw err
      await grants.revokeAllActive(deviceId)
      return mint()
    }
  }
  const minted = await mintWithReclaim()
  // Single-device until multi-select: this machine is the active CAD target for the user.
  const siblings = await grants.listForCaller(input.workspaceId, input.userId)
  for (const g of siblings) {
    if (g.deviceId !== deviceId) {
      await grants.revoke(g.deviceId, input.workspaceId, input.userId)
    }
  }
  return { ...minted, deviceId }
}

export async function revokeDevice(
  config: GatewayConfig,
  deviceId: string,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const grants = new PostgresDeviceGrantStore(sqlExecutor(config))
  return grants.revoke(deviceId, workspaceId, userId)
}
