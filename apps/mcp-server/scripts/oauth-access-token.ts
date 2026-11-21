#!/usr/bin/env bun
/**
 * Obtains an MCP OAuth access token via authorization_code + PKCE against Aleph Gateway.
 * Uses the dev-only POST /oauth/dev/code shortcut (still redeems at /oauth/token).
 *
 *   bun run scripts/oauth-access-token.ts --user-id user-e2e --workspace-id ws-e2e
 */
import { createHash, randomBytes } from 'node:crypto'

interface Args {
  gatewayUrl: string
  resourceUrl: string
  userId: string
  workspaceId: string
  scope: string
}

function parseArgs(argv: string[]): Args {
  const mcpPublic = (process.env.ALEPH_PUBLIC_URL?.replace(/\/$/, '') || 'http://127.0.0.1:8080')
  const args: Args = {
    gatewayUrl:
      process.env.ALEPH_GATEWAY_URL?.replace(/\/$/, '') || 'http://127.0.0.1:8090',
    resourceUrl: `${mcpPublic}/mcp`,
    userId: 'user-e2e',
    workspaceId: 'ws-e2e',
    scope: 'cad:read cad:write'
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--gateway-url' && value) {
      args.gatewayUrl = value.replace(/\/$/, '')
      i += 1
    } else if (flag === '--base-url' && value) {
      // Legacy alias: treat as gateway.
      args.gatewayUrl = value.replace(/\/$/, '')
      i += 1
    } else if (flag === '--resource' && value) {
      args.resourceUrl = value.replace(/\/$/, '')
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
  const redirectUri = 'http://127.0.0.1/oauth/callback'
  const { verifier, challenge } = pkce()

  const register = await fetch(`${args.gatewayUrl}/oauth/register`, {
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

  const codeRes = await fetch(`${args.gatewayUrl}/oauth/dev/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      scope: args.scope,
      resource: args.resourceUrl,
      user_id: args.userId,
      workspace_id: args.workspaceId
    })
  })
  if (!codeRes.ok) {
    throw new Error(`dev code failed: ${codeRes.status} ${await codeRes.text()}`)
  }
  const issued = (await codeRes.json()) as { code: string }

  const tokenRes = await fetch(`${args.gatewayUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: issued.code,
      redirect_uri: redirectUri,
      client_id: registered.client_id,
      code_verifier: verifier
    })
  })
  if (!tokenRes.ok) {
    throw new Error(`token failed: ${tokenRes.status} ${await tokenRes.text()}`)
  }
  const tokens = (await tokenRes.json()) as { access_token: string; expires_in?: number }
  console.log(JSON.stringify(tokens, null, 2))
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
