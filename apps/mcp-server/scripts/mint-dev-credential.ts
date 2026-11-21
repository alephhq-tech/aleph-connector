#!/usr/bin/env bun
/**
 * Mints a **device** credential into the connector's identity.json (WSS `/device` only).
 * MCP clients must use OAuth (`scripts/oauth-access-token.ts` or the browser authorize flow) —
 * this token is intentionally not accepted on `/mcp`.
 *
 * Development only — requires JWT_SECRET matching the running mcp-server, or the gateway rejects
 * the credential as `invalid_token:signature`.
 *
 *   bun run apps/mcp-server/scripts/mint-dev-credential.ts --workspace-id ws-e2e --user-id user-e2e
 *
 * The deviceId defaults to what %LOCALAPPDATA%/CadAI/bridge/identity.json already holds, so minting
 * first-claims a grant for the device the installed connector actually presents instead of inventing
 * a second identity it would never use. --device-id overrides that.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DevBridgeTokenService, JsonFileGrantStore, devGrantFile } from '../src/dev/bridgeToken.js'

interface PersistedIdentity {
  deviceId: string
  token?: string | null
  tokenExpiresAt?: number | null
}

interface MintOptions {
  workspaceId: string
  userId: string
  deviceId?: string
  ttlSeconds: number
  identityPath: string
}

function connectorIdentityPath(): string {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new Error(
      'LOCALAPPDATA is not set — run this on the Windows box where the CadAI connector is installed.'
    )
  }
  return join(localAppData, 'CadAI', 'bridge', 'identity.json')
}

const FLAGS = {
  '--workspace-id': 'workspaceId',
  '--user-id': 'userId',
  '--device-id': 'deviceId',
  '--ttl-seconds': 'ttlSeconds',
  '--identity-path': 'identityPath'
} as const satisfies Record<string, keyof MintOptions>

function parseArgs(argv: readonly string[]): MintOptions {
  const opts: MintOptions = {
    workspaceId: 'ws-e2e',
    userId: 'user-e2e',
    ttlSeconds: 86_400,
    identityPath: connectorIdentityPath()
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === undefined) continue
    const key = (FLAGS as Record<string, keyof MintOptions | undefined>)[flag]
    if (!key) throw new Error(`Unknown argument ${flag} (expected one of: ${Object.keys(FLAGS).join(', ')})`)
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    i += 1
    if (key === 'ttlSeconds') {
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--ttl-seconds must be a positive integer')
      opts.ttlSeconds = parsed
    } else {
      opts[key] = value
    }
  }
  return opts
}

function readIdentity(path: string): PersistedIdentity | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedIdentity
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const jwtSecret = process.env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    console.error('JWT_SECRET is required — it must match the secret the running mcp-server signs with.')
    process.exitCode = 1
    return
  }

  const opts = parseArgs(process.argv.slice(2))
  // Same resolved path the mcp-server uses (module-derived, or ALEPH_DEV_GRANT_FILE): a grant file
  // the server cannot see is indistinguishable from an invalid signature at the WSS upgrade.
  const grantFile = devGrantFile(process.env)
  const grants = new JsonFileGrantStore(grantFile)
  const tokens = new DevBridgeTokenService(jwtSecret, grants)

  const existing = readIdentity(opts.identityPath)
  const deviceId = opts.deviceId ?? existing?.deviceId ?? `device_${randomUUID().replace(/-/g, '')}`

  const minted = await tokens.mint(
    { deviceId, userId: opts.userId, workspaceId: opts.workspaceId },
    opts.ttlSeconds
  )

  mkdirSync(dirname(opts.identityPath), { recursive: true })
  const persisted: PersistedIdentity = {
    deviceId,
    token: minted.token,
    tokenExpiresAt: minted.expiresAt
  }
  writeFileSync(opts.identityPath, JSON.stringify(persisted, null, 2) + '\n')

  console.log(
    JSON.stringify(
      {
        deviceId,
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        grantGeneration: minted.grantGeneration,
        expiresAt: new Date(minted.expiresAt * 1000).toISOString(),
        identityPath: opts.identityPath,
        grantFile,
        // Device credential only — dial `/device`. MCP uses a separate OAuth access_token.
        token: minted.token
      },
      null,
      2
    )
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
