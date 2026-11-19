import {
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  type AuthInfo
} from '@modelcontextprotocol/server'
import { deviceCredentialService, type DeviceCredentialRejectReason } from '@arcdio/identity'

/** Scope every AI-Desktop-issued token must carry to call AutoCAD tools. */
export const AUTOCAD_CONTROL_SCOPE = 'autocad:control'

/**
 * The `error_description` for a rejected Bridge credential. Always begins with the literal
 * `invalid_token` so any consumer matching that substring (the sidecar's connection-status error
 * string, Desktop's auto-heal gate) keeps firing, then names the specific reason so the client can
 * distinguish a recoverable stale credential from a server-side secret mismatch.
 */
function describeInvalidToken(reason: DeviceCredentialRejectReason): string {
  switch (reason) {
    case 'expired':
      return 'invalid_token:expired'
    case 'grant_stale':
      return 'invalid_token:grant_stale'
    case 'grant_denied':
      return 'invalid_token:grant_denied'
    case 'signature':
      return 'invalid_token:signature'
    case 'malformed':
      return 'invalid_token:malformed'
  }
}

/**
 * Temporary extraction-compatible verifier. ARCDIO's dedicated MCP OAuth issuer will replace this
 * device-bound verifier; until then the configured identity service is fail-closed and re-checks
 * the live grant on every request.
 */
export class DeviceIdentityVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = await deviceCredentialService.verifyDetailed(token)
    if (result.ok === false) {
      // Preserve the machine-readable invalid_token reason while failing closed.
      throw new OAuthError(OAuthErrorCode.InvalidToken, describeInvalidToken(result.reason))
    }
    const credential = result.payload
    return {
      token,
      clientId: credential.deviceId,
      scopes: [AUTOCAD_CONTROL_SCOPE],
      expiresAt: credential.exp,
      extra: {
        deviceId: credential.deviceId,
        userId: credential.userId,
        workspaceId: credential.workspaceId
      }
    }
  }
}

/** Reads the deviceId this request was authenticated for, or throws — every tool call needs one. */
export function requireDeviceId(authInfo: AuthInfo | undefined): string {
  const deviceId = authInfo?.extra?.deviceId
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error(
      'Request has no authenticated deviceId — this is a bug in the auth wiring, not a client error.'
    )
  }
  return deviceId
}

/** Reads the authenticated caller's (workspaceId, userId) — threaded into
 * `DeviceExecutionRequest.callerWorkspaceId`/`callerUserId` so `DeviceGatewayService.execute` can
 * re-validate the grant once more at the actual dispatch point (issue #349 requirement 3),
 * independent of this HTTP request's own already-passed auth gate. */
export function requireCallerIdentity(authInfo: AuthInfo | undefined): {
  workspaceId: string
  userId: string
} {
  const workspaceId = authInfo?.extra?.workspaceId
  const userId = authInfo?.extra?.userId
  if (typeof workspaceId !== 'string' || typeof userId !== 'string') {
    throw new Error(
      'Request has no authenticated caller identity — this is a bug in the auth wiring, not a client error.'
    )
  }
  return { workspaceId, userId }
}
