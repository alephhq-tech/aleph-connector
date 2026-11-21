export type DeviceCredentialRejectReason =
  | 'expired'
  | 'grant_stale'
  | 'grant_denied'
  | 'signature'
  | 'malformed'

export interface DeviceCredentialPayload {
  deviceId: string
  userId: string
  workspaceId: string
  grantGeneration: number
  exp: number
}

export type DeviceCredentialVerification =
  | { ok: true; payload: DeviceCredentialPayload }
  | { ok: false; reason: DeviceCredentialRejectReason }

export interface DeviceCredentialService {
  verify(token: string): Promise<DeviceCredentialPayload | null>
  verifyDetailed(token: string): Promise<DeviceCredentialVerification>
}

export interface DeviceGrantRecord {
  deviceId: string
  workspaceId: string
  userId: string
  generation: number
}

export interface DeviceGrantStore {
  validate(
    deviceId: string,
    workspaceId: string,
    userId: string,
    expectedGeneration?: number
  ): Promise<boolean>
  listForCaller(workspaceId: string, userId: string): Promise<DeviceGrantRecord[]>
}

class UnconfiguredDeviceCredentialService implements DeviceCredentialService {
  async verify(_token: string): Promise<DeviceCredentialPayload | null> {
    return null
  }

  async verifyDetailed(_token: string): Promise<DeviceCredentialVerification> {
    return { ok: false, reason: 'signature' }
  }
}

class DenyAllDeviceGrantStore implements DeviceGrantStore {
  async validate(
    _deviceId: string,
    _workspaceId: string,
    _userId: string,
    _expectedGeneration?: number
  ): Promise<boolean> {
    return false
  }

  async listForCaller(_workspaceId: string, _userId: string): Promise<DeviceGrantRecord[]> {
    return []
  }
}

let credentialService: DeviceCredentialService = new UnconfiguredDeviceCredentialService()
let grantStore: DeviceGrantStore = new DenyAllDeviceGrantStore()

export function configureIdentity(services: {
  credentialService: DeviceCredentialService
  grantStore: DeviceGrantStore
}): void {
  credentialService = services.credentialService
  grantStore = services.grantStore
}

export const deviceCredentialService: DeviceCredentialService = {
  verify: (token) => credentialService.verify(token),
  verifyDetailed: (token) => credentialService.verifyDetailed(token)
}

export function validateDeviceGrant(
  deviceId: string,
  workspaceId: string,
  userId: string,
  expectedGeneration?: number
): Promise<boolean> {
  return grantStore.validate(deviceId, workspaceId, userId, expectedGeneration)
}

export function listDeviceGrantsForCaller(
  workspaceId: string,
  userId: string
): Promise<DeviceGrantRecord[]> {
  return grantStore.listForCaller(workspaceId, userId)
}

export async function resolveDeviceIdForCaller(
  workspaceId: string,
  userId: string
): Promise<string> {
  const grants = await listDeviceGrantsForCaller(workspaceId, userId)
  if (grants.length === 0) {
    throw new Error(
      'No paired AutoCAD device for this account — pair a Connector before calling CAD tools.'
    )
  }
  if (grants.length > 1) {
    throw new Error(
      `Multiple paired devices (${grants.map((g) => g.deviceId).join(', ')}); multi-device select is not implemented yet.`
    )
  }
  return grants[0]!.deviceId
}
