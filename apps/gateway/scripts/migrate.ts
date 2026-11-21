#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'schema.sql')
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
