import { portalConfig } from './config'

export interface ApproveInput {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope?: string
  resource?: string
  state?: string
  userId: string
  workspaceId: string
}

/**
 * Completes the OAuth authorize loop: portal → mcp-server POST /oauth/portal/approve →
 * `{ redirect_to }` with authorization code for the MCP client.
 */
export async function approveViaMcp(input: ApproveInput): Promise<{ redirectTo: string }> {
  const { mcpPublicUrl, portalApproveSecret } = portalConfig()
  const res = await fetch(`${mcpPublicUrl}/oauth/portal/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${portalApproveSecret}`
    },
    body: JSON.stringify({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
      ...(input.state ? { state: input.state } : {}),
      user_id: input.userId,
      workspace_id: input.workspaceId
    })
  })
  const body = (await res.json().catch(() => ({}))) as {
    redirect_to?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.redirect_to) {
    throw new Error(body.error_description || body.error || `Portal approve failed (${res.status})`)
  }
  return { redirectTo: body.redirect_to }
}

/** Parse authorize query params out of the mcp-server `return_to` URL. */
export function parseReturnTo(returnTo: string): {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope?: string
  resource?: string
  state?: string
} {
  let url: URL
  try {
    url = new URL(returnTo)
  } catch {
    throw new Error('Invalid return_to URL')
  }
  const clientId = url.searchParams.get('client_id') ?? ''
  const redirectUri = url.searchParams.get('redirect_uri') ?? ''
  const codeChallenge = url.searchParams.get('code_challenge') ?? ''
  if (!clientId || !redirectUri || !codeChallenge) {
    throw new Error('return_to is missing client_id, redirect_uri, or code_challenge')
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    ...(url.searchParams.get('scope') ? { scope: url.searchParams.get('scope')! } : {}),
    ...(url.searchParams.get('resource') ? { resource: url.searchParams.get('resource')! } : {}),
    ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {})
  }
}
