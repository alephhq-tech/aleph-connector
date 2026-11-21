import type { SqlExecutor } from '@aleph-connector/identity'
import postgres from 'postgres'

/**
 * Adapts `postgres` (postgres.js) to the `@aleph-connector/identity` SqlExecutor used by
 * PostgresDeviceGrantStore. Callers own the connection lifetime.
 */
export function createPostgresSqlExecutor(databaseUrl: string): {
  sql: SqlExecutor
  close: () => Promise<void>
} {
  const client = postgres(databaseUrl, { max: 5 })
  const sql: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await client.unsafe(text, params as (string | number | boolean | null)[])
      return rows as unknown as T[]
    }
  }
  return {
    sql,
    close: async () => {
      await client.end({ timeout: 5 })
    }
  }
}
