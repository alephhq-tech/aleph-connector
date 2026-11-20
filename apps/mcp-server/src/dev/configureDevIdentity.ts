import { configureIdentity } from '@arcdio/identity'
import type { Logger } from '@arcdio/observability'
import { DevBridgeTokenService, JsonFileGrantStore, devGrantFile } from './bridgeToken.js'

export const DEV_IDENTITY_ENV = 'ARCDIO_DEV_IDENTITY'

/**
 * Opt-in dev identity for the live AutoCAD E2E lane and local connector bring-up.
 *
 * Production identity stays fail-closed: with no `ARCDIO_DEV_IDENTITY=1`, this returns false and
 * `@arcdio/identity` keeps its unconfigured/deny-all default, so nothing in the lane can widen the
 * real trust boundary by accident. When enabled, it installs the dev-tier credential service and
 * file-backed grant store, which verify the same signed-credential wire format and enforce the same
 * grant-generation recheck the production gateway does.
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
