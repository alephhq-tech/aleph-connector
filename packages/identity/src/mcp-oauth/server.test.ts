import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { McpOAuthAuthorizationServer } from './server.js'

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

describe('McpOAuthAuthorizationServer', () => {
  const issuer = 'http://127.0.0.1:8080'
  const resource = 'http://127.0.0.1:8080/mcp'

  test('authorization_code + PKCE yields a verifiable access token', async () => {
    const oauth = new McpOAuthAuthorizationServer({
      issuer,
      resource,
      jwtSecret: 'test-secret-at-least-16',
      allowDevCodeIssuance: true
    })
    const client = oauth.registerPublicClient({
      redirectUris: ['http://127.0.0.1/cb'],
      clientName: 'test'
    })
    const { verifier, challenge } = pkce()
    const { code } = oauth.approveAuthorization({
      clientId: client.clientId,
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: challenge,
      userId: 'user-1',
      workspaceId: 'ws-1',
      scope: 'cad:read cad:write'
    })

    const tokenRes = await oauth.handleRequest(
      new Request(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://127.0.0.1/cb',
          client_id: client.clientId,
          code_verifier: verifier,
          resource
        })
      })
    )
    expect(tokenRes).not.toBeNull()
    expect(tokenRes!.status).toBe(200)
    const body = (await tokenRes!.json()) as { access_token: string; refresh_token: string }
    const verified = oauth.verifyAccessToken(body.access_token)
    expect(verified).toEqual({
      userId: 'user-1',
      workspaceId: 'ws-1',
      clientId: client.clientId,
      scopes: ['cad:read', 'cad:write'],
      expiresAt: expect.any(Number)
    })

    // Device ABT-shaped tokens must not verify as MCP access tokens.
    expect(oauth.verifyAccessToken('a.b.c')).toBeNull()
  })

  test('serves authorization-server metadata', async () => {
    const oauth = new McpOAuthAuthorizationServer({
      issuer,
      resource,
      jwtSecret: 'test-secret-at-least-16'
    })
    const res = await oauth.handleRequest(
      new Request(`${issuer}/.well-known/oauth-authorization-server`)
    )
    expect(res?.status).toBe(200)
    const meta = (await res!.json()) as { code_challenge_methods_supported: string[] }
    expect(meta.code_challenge_methods_supported).toContain('S256')
  })

  test('POST /oauth/portal/approve issues a code when Bearer secret matches', async () => {
    const oauth = new McpOAuthAuthorizationServer({
      issuer,
      resource,
      jwtSecret: 'test-secret-at-least-16',
      portalApproveSecret: 'portal-approve-secret'
    })
    const client = oauth.registerPublicClient({
      redirectUris: ['http://127.0.0.1/cb'],
      clientName: 'portal-test'
    })
    const { challenge } = pkce()
    const res = await oauth.handleRequest(
      new Request(`${issuer}/oauth/portal/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer portal-approve-secret'
        },
        body: JSON.stringify({
          client_id: client.clientId,
          redirect_uri: 'http://127.0.0.1/cb',
          code_challenge: challenge,
          user_id: 'user-portal',
          workspace_id: 'ws-portal',
          state: 'xyz'
        })
      })
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { code: string; redirect_to: string }
    expect(body.code.length).toBeGreaterThan(10)
    expect(body.redirect_to).toContain('code=')
    expect(body.redirect_to).toContain('state=xyz')
  })

  test('POST /oauth/portal/approve rejects a bad Bearer secret', async () => {
    const oauth = new McpOAuthAuthorizationServer({
      issuer,
      resource,
      jwtSecret: 'test-secret-at-least-16',
      portalApproveSecret: 'portal-approve-secret'
    })
    const res = await oauth.handleRequest(
      new Request(`${issuer}/oauth/portal/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong'
        },
        body: JSON.stringify({
          client_id: 'x',
          redirect_uri: 'http://127.0.0.1/cb',
          code_challenge: 'y',
          user_id: 'u',
          workspace_id: 'w'
        })
      })
    )
    expect(res?.status).toBe(401)
  })
})
