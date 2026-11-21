import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server'
import {
  McpOAuthAuthorizationServer,
  resolveDeviceIdForCaller
} from '@aleph-connector/identity'

export class McpAccessTokenVerifier implements OAuthTokenVerifier {
  constructor(private readonly oauth: McpOAuthAuthorizationServer) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verified = this.oauth.verifyAccessToken(token)
    if (!verified) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid_token')
    }

    let deviceId: string
    try {
      deviceId = await resolveDeviceIdForCaller(verified.workspaceId, verified.userId)
    } catch (err) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        err instanceof Error ? err.message : 'no_device_grant'
      )
    }

    return {
      token,
      clientId: verified.clientId,
      scopes: verified.scopes,
      expiresAt: verified.expiresAt,
      extra: {
        deviceId,
        userId: verified.userId,
        workspaceId: verified.workspaceId
      }
    }
  }
}

export { requireDeviceId, requireCallerIdentity } from './DeviceIdentityVerifier.js'
