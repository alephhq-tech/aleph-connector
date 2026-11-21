import type { SqlExecutor } from '@aleph-connector/identity'
import postgres from 'postgres'
import { portalConfig } from './config'

let client: ReturnType<typeof postgres> | null = null

export function getSql() {
  if (!client) {
    client = postgres(portalConfig().databaseUrl, { max: 5 })
  }
  return client
}

export function sqlExecutor(): SqlExecutor {
  const sql = getSql()
  return {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as (string | number | boolean | null)[])
      return rows as unknown as T[]
    }
  }
}
