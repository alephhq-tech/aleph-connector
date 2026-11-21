import { configureIdentity } from '@aleph-connector/identity'
import type { Logger } from '@aleph-connector/observability'
import { DevBridgeTokenService, JsonFileGrantStore, devGrantFile } from './bridgeToken.js'

export const DEV_IDENTITY_ENV = 'ALEPH_DEV_IDENTITY'

/**
 * Opt-in **device** identity for Connector WSS (`/device`) during local bring-up / live E2E.
 *
 * MCP clients authenticate via OAuth access tokens (separate issuer/audience), never with this ABT.
 * Production device identity stays fail-closed without `ALEPH_DEV_IDENTITY=1`. When enabled, it
 * installs the dev-tier device credential service and file-backed grant store (same wire format and
 * grant-generation recheck the production gateway enforces).
 */
export function configureDevIdentity(env: NodeJS.ProcessEnv, log: Logger): boolean {
  if (env[DEV_IDENTITY_ENV] !== '1') return false

  const jwtSecret = env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    throw new Error(
      `${DEV_IDENTITY_ENV}=1 requires JWT_SECRET — the dev lane signs and verifies credentials, it never skips authentication.`
    )
  }

  // One path for every process that touches the dev tier: the minter and the server must read and
  // write the SAME grant file, or the server denies a perfectly signed credential as grant_stale.
  const grantFile = devGrantFile(env)
  const grants = new JsonFileGrantStore(grantFile)
  configureIdentity({
    credentialService: new DevBridgeTokenService(jwtSecret, grants),
    grantStore: grants
  })
  log.warn(
    'DEV identity active - credentials are signed with JWT_SECRET and grants live in a local file',
    { grantFile }
  )
  return true
}
