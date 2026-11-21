import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server'
import { McpJwtService, resolveDeviceIdForCaller } from '@aleph-connector/identity'

/**
 * Verifies MCP access tokens minted by Aleph Gateway (shared JWT_SECRET, iss = gateway, aud = MCP resource).
 */
export class McpAccessTokenVerifier implements OAuthTokenVerifier {
  private readonly jwt: McpJwtService

  constructor(
    private readonly gatewayIssuerUrl: string,
    private readonly resourceUrl: string,
    jwtSecret: string
  ) {
    this.jwt = new McpJwtService(jwtSecret)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = this.jwt.verify(token, {
      issuer: this.gatewayIssuerUrl,
      audience: this.resourceUrl
    })
    if (!claims) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid_token')
    }

    let deviceId: string
    try {
      deviceId = await resolveDeviceIdForCaller(claims.workspace_id, claims.sub)
    } catch (err) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        err instanceof Error ? err.message : 'no_device_grant'
      )
    }

    return {
      token,
      clientId: claims.client_id,
      scopes: claims.scope.split(/\s+/).filter(Boolean),
      expiresAt: claims.exp,
      extra: {
        deviceId,
        userId: claims.sub,
        workspaceId: claims.workspace_id
      }
    }
  }
}

export { requireDeviceId, requireCallerIdentity } from './DeviceIdentityVerifier.js'
