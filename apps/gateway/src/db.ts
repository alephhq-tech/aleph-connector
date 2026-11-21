import type { SqlExecutor } from '@aleph-connector/identity'
import postgres from 'postgres'
import type { GatewayConfig } from './config.js'

let client: ReturnType<typeof postgres> | null = null

export function getSql(config: GatewayConfig) {
  if (!client) {
    client = postgres(config.databaseUrl, { max: 5 })
  }
  return client
}

export function sqlExecutor(config: GatewayConfig): SqlExecutor {
  const sql = getSql(config)
  return {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as (string | number | boolean | null)[])
      return rows as unknown as T[]
    }
  }
}
