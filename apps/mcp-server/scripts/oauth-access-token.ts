#!/usr/bin/env bun
/**
 * Obtains an MCP OAuth access token via authorization_code + PKCE against a running mcp-server.
 * Uses the dev-only POST /oauth/dev/code shortcut (still redeems at /oauth/token — not a static API key).
 *
 *   bun run scripts/oauth-access-token.ts --user-id user-e2e --workspace-id ws-e2e
 */
import { createHash, randomBytes } from 'node:crypto'

interface Args {
  baseUrl: string
  userId: string
  workspaceId: string
  scope: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: process.env.ALEPH_PUBLIC_URL?.replace(/\/$/, '') || 'http://127.0.0.1:8080',
    userId: 'user-e2e',
    workspaceId: 'ws-e2e',
    scope: 'cad:read cad:write'
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--base-url' && value) {
      args.baseUrl = value.replace(/\/$/, '')
      i += 1
    } else if (flag === '--user-id' && value) {
      args.userId = value
      i += 1
    } else if (flag === '--workspace-id' && value) {
      args.workspaceId = value
      i += 1
    } else if (flag === '--scope' && value) {
      args.scope = value
      i += 1
    }
  }
  return args
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const resource = `${args.baseUrl}/mcp`
  const redirectUri = 'http://127.0.0.1/oauth/callback'
  const { verifier, challenge } = pkce()

  const register = await fetch(`${args.baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'aleph-e2e',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  })
  if (!register.ok) {
    throw new Error(`register failed: ${register.status} ${await register.text()}`)
  }
  const registered = (await register.json()) as { client_id: string }

  const codeRes = await fetch(`${args.baseUrl}/oauth/dev/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      scope: args.scope,
      resource,
      user_id: args.userId,
      workspace_id: args.workspaceId
    })
  })
  if (!codeRes.ok) {
    throw new Error(`dev/code failed: ${codeRes.status} ${await codeRes.text()}`)
  }
  const { code } = (await codeRes.json()) as { code: string }

  const tokenRes = await fetch(`${args.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: registered.client_id,
      code_verifier: verifier,
      resource
    })
  })
  if (!tokenRes.ok) {
    throw new Error(`token failed: ${tokenRes.status} ${await tokenRes.text()}`)
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    token_type: string
    scope: string
  }

  console.log(
    JSON.stringify(
      {
        clientId: registered.client_id,
        userId: args.userId,
        workspaceId: args.workspaceId,
        resource,
        ...tokens
      },
      null,
      2
    )
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
