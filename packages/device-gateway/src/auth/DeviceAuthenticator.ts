import { deviceCredentialService, validateDeviceGrant } from '@aleph-connector/identity'

export interface DeviceAuthenticator {
  authenticate(deviceId: string, token: string): Promise<string | null>
}

/** Authenticates an inbound Connector WSS session and revalidates the live grant generation.
 * Fails closed: socket reachability is never authorization. */
export class AutoCadBridgeTokenAuthenticator implements DeviceAuthenticator {
  async authenticate(deviceId: string, token: string): Promise<string | null> {
    const payload = await deviceCredentialService.verify(token)
    if (!payload || payload.deviceId !== deviceId) return null
    const stillAuthorized = await validateDeviceGrant(
      payload.deviceId,
      payload.workspaceId,
      payload.userId,
      payload.grantGeneration
    )
    return stillAuthorized ? deviceId : null
  }
}
