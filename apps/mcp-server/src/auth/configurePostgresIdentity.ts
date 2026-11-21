import {
  AbtTokenService,
  PostgresDeviceGrantStore,
  configureIdentity
} from '@aleph-connector/identity'
import type { Logger } from '@aleph-connector/observability'
import { createPostgresSqlExecutor } from '../db/sql.js'

/**
 * Production-style device identity: ABT verifier + Postgres `device_grants` (portal pairing writes
 * the same table). Used when `DATABASE_URL` is set and `ALEPH_DEV_IDENTITY` is not `1`.
 */
export function configurePostgresIdentity(env: NodeJS.ProcessEnv, log: Logger): boolean {
  if (env.ALEPH_DEV_IDENTITY === '1') return false
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl || !databaseUrl.startsWith('postgres')) return false

  const jwtSecret = env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    throw new Error('DATABASE_URL device identity requires JWT_SECRET')
  }

  const { sql } = createPostgresSqlExecutor(databaseUrl)
  const grants = new PostgresDeviceGrantStore(sql)
  configureIdentity({
    credentialService: new AbtTokenService(jwtSecret, grants),
    grantStore: grants
  })
  log.info('Postgres device identity active', { database: 'device_grants' })
  return true
}
