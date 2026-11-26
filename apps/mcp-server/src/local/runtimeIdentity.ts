import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureIdentity } from '@aleph-connector/identity'
import type { Logger } from '@aleph-connector/observability'
import { JsonFileGrantStore, LocalBridgeTokenService } from './bridgeToken.js'

/**
 * Local runtime identity custody.
 *
 * The local-first runtime replaces Aleph Gateway as the issuer of the Bridge's device
 * credential: it owns a secret, a grant file, and a stable deviceId under its state
 * directory, first-claims the grant at startup, mints a long-lived ABT token, and writes
 * it to the identity.json the Windows Bridge already reads. "Socket reachability is never
 * authorization" still holds — the Bridge authenticates on /device with this credential,
 * and the grant-generation recheck rejects revoked tokens.
 */

const LOCAL_CALLER = { workspaceId: 'local', userId: 'local' } as const

/** 400 days: the local credential rotates by re-mint, not by calendar pressure. */
const DEVICE_TOKEN_TTL_SECONDS = 400 * 86_400

export interface LocalRuntimeContext {
  deviceId: string
  caller: { workspaceId: string; userId: string }
  /** Directory holding the runtime secret, grants, identity, and the CAD-state DB. */
  stateDir: string
}

interface PersistedIdentity {
  deviceId: string
  token?: string | null
  tokenExpiresAt?: number | null
}

function localAppData(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.LOCALAPPDATA?.trim()
  return value ? value : undefined
}

/** State dir: explicit override, else %LOCALAPPDATA%/CadAI/connector, else module-derived .local/state. */
export function localStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ALEPH_LOCAL_STATE_DIR?.trim()
  if (override) return resolve(override)
  const appData = localAppData(env)
  if (appData) return join(appData, 'CadAI', 'connector')
  return fileURLToPath(new URL('../../.local/state', import.meta.url))
}

/** Identity file the Bridge reads: explicit override, else %LOCALAPPDATA%/CadAI/bridge/identity.json. */
export function localIdentityPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ALEPH_LOCAL_IDENTITY_PATH?.trim()
  if (override) return resolve(override)
  const appData = localAppData(env)
  if (appData) return join(appData, 'CadAI', 'bridge', 'identity.json')
  return join(fileURLToPath(new URL('../../.local/state', import.meta.url)), 'identity.json')
}

function readSecretFile(secretPath: string): string | null {
  if (!existsSync(secretPath)) return null
  try {
    const secret = readFileSync(secretPath, 'utf8').trim()
    return secret.length >= 16 ? secret : null
  } catch {
    return null
  }
}

function readIdentityFile(path: string): PersistedIdentity | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedIdentity
  } catch {
    return null
  }
}

/**
 * Installs the local credential service + grant store into `@aleph-connector/identity`,
 * first-claims the local device grant, mints the Bridge credential, and writes
 * identity.json. Call once at startup, before createApp.
 */
export async function configureLocalRuntime(
  env: NodeJS.ProcessEnv = process.env,
  log: Logger
): Promise<LocalRuntimeContext> {
  const stateDir = localStateDir(env)
  mkdirSync(stateDir, { recursive: true })

  const secretOverride = env.JWT_SECRET?.trim()
  const secretPath = join(stateDir, 'runtime-secret.json')
  let secret = secretOverride ?? readSecretFile(secretPath)
  if (!secret) {
    secret = randomBytes(32).toString('hex')
    writeFileSync(secretPath, secret + '\n')
    log.info('created local runtime secret', { secretPath })
  }

  const grants = new JsonFileGrantStore(join(stateDir, 'device-grants.json'))
  const credentialService = new LocalBridgeTokenService(secret, grants)
  configureIdentity({ credentialService, grantStore: grants })

  const identityPath = localIdentityPath(env)
  const existing = readIdentityFile(identityPath)
  const deviceId =
    existing?.deviceId && existing.deviceId.length > 0
      ? existing.deviceId
      : `device_${randomUUID().replace(/-/g, '')}`

  const minted = await credentialService.mint({ deviceId, ...LOCAL_CALLER }, DEVICE_TOKEN_TTL_SECONDS)

  mkdirSync(dirname(identityPath), { recursive: true })
  const persisted: PersistedIdentity = {
    deviceId,
    token: minted.token,
    tokenExpiresAt: minted.expiresAt
  }
  writeFileSync(identityPath, JSON.stringify(persisted, null, 2) + '\n')

  log.info('local runtime identity active', {
    deviceId,
    stateDir,
    identityPath,
    grantGeneration: minted.grantGeneration
  })

  return { deviceId, caller: { ...LOCAL_CALLER }, stateDir }
}
