import { AbtTokenService, PostgresDeviceGrantStore } from '@aleph-connector/identity'
import { portalConfig } from './config'
import { sqlExecutor } from './db'

export interface DeviceListItem {
  deviceId: string
  generation: number
}

export async function listDevices(workspaceId: string, userId: string): Promise<DeviceListItem[]> {
  const grants = new PostgresDeviceGrantStore(sqlExecutor())
  const rows = await grants.listForCaller(workspaceId, userId)
  return rows.map((r) => ({ deviceId: r.deviceId, generation: r.generation }))
}

export async function pairDevice(input: {
  deviceId: string
  workspaceId: string
  userId: string
}): Promise<{ token: string; expiresAt: number; grantGeneration: number; deviceId: string }> {
  const deviceId = input.deviceId.trim()
  if (!deviceId) throw new Error('deviceId is required')
  const { jwtSecret } = portalConfig()
  const grants = new PostgresDeviceGrantStore(sqlExecutor())
  const abt = new AbtTokenService(jwtSecret, grants)
  const minted = await abt.mint({
    deviceId,
    userId: input.userId,
    workspaceId: input.workspaceId
  })
  return { ...minted, deviceId }
}

export async function revokeDevice(
  deviceId: string,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const grants = new PostgresDeviceGrantStore(sqlExecutor())
  return grants.revoke(deviceId, workspaceId, userId)
}
