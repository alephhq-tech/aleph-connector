#!/usr/bin/env bun
/**
 * Generates a cryptographically random JWT_SECRET (32 bytes → 64 hex chars, well above the
 * 16-character minimum enforced by @aleph-connector/identity).
 *
 *   bun run gen:jwt-secret
 *   bun run gen:jwt-secret --write   # upsert JWT_SECRET in apps/mcp-server/.env
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BYTE_LENGTH = 32
const ENV_KEY = 'JWT_SECRET'

function generateSecret(): string {
  return randomBytes(BYTE_LENGTH).toString('hex')
}

function envPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
}

function upsertEnv(path: string, secret: string): void {
  const line = `${ENV_KEY}=${secret}`
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, 'utf8')
    return
  }
  const raw = readFileSync(path, 'utf8')
  const pattern = new RegExp(`^${ENV_KEY}=.*$`, 'm')
  const next = pattern.test(raw) ? raw.replace(pattern, line) : `${raw.replace(/\s*$/, '')}\n${line}\n`
  writeFileSync(path, next, 'utf8')
}

function main(): void {
  const write = process.argv.slice(2).includes('--write')
  const secret = generateSecret()
  const line = `${ENV_KEY}=${secret}`

  if (write) {
    const path = envPath()
    upsertEnv(path, secret)
    console.log(`wrote ${ENV_KEY} (${secret.length} chars) to ${path}`)
    return
  }

  console.log(line)
}

main()
