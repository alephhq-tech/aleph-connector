import type { AuthInfo } from '@modelcontextprotocol/server'

export const MCP_REQUIRED_SCOPE = 'cad:read'
export const AUTOCAD_CONTROL_SCOPE = MCP_REQUIRED_SCOPE

export function requireDeviceId(authInfo: AuthInfo | undefined): string {
  const deviceId = authInfo?.extra?.deviceId
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error(
      'Request has no authenticated deviceId — this is a bug in the auth wiring, not a client error.'
    )
  }
  return deviceId
}

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
