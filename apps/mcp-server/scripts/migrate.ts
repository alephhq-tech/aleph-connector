#!/usr/bin/env bun
/**
 * Applies the shared Postgres schema (apps/gateway/sql/schema.sql) against this app's
 * DATABASE_URL (device_grants for Postgres identity). Prefer `cd apps/gateway && bun run db:migrate`.
 *
 *   cd apps/mcp-server && bun run db:migrate
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required — set it in apps/mcp-server/.env')
  }
  const schemaPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'gateway',
    'sql',
    'schema.sql'
  )
  const sqlText = readFileSync(schemaPath, 'utf8')
  const client = postgres(databaseUrl, { max: 1 })
  try {
    await client.unsafe(sqlText)
    console.log('applied', schemaPath)
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
