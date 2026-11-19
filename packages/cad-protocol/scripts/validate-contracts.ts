#!/usr/bin/env bun
/**
 * Validates every fixture in schemas/fixtures/*.json against device-protocol.schema.json, and
 * asserts the parsed shape matches what @arcdio/device-protocol's device-protocol.ts expects
 * (via parseDeviceMessage's ajv-compiled validator). Run via `bun run validate`.
 *
 * This is the regression net for the hand-authored TS/C# mirrors of the schema: if someone edits
 * the schema without updating a fixture, or edits a fixture to something the schema no longer
 * allows, this fails loudly instead of drifting silently. It does not (and cannot) prove the C#
 * side matches — that mirror is exercised by
 * windows/generated/csharp.Tests/DeviceProtocolFixtureTests.cs.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeviceMessageValidationError, parseDeviceMessage } from '@arcdio/cad-protocol'

const fixturesDir = join(import.meta.dirname, '..', 'schemas', 'fixtures')
const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))

if (files.length === 0) {
  console.error(`No fixtures found in ${fixturesDir}`)
  process.exit(1)
}

let failures = 0
for (const file of files) {
  const raw = readFileSync(join(fixturesDir, file), 'utf8')
  try {
    const message = parseDeviceMessage(raw)
    console.log(`ok   ${file} -> type=${message.type}`)
  } catch (err) {
    failures += 1
    const detail = err instanceof DeviceMessageValidationError ? err.issues : String(err)
    console.error(`FAIL ${file}: ${detail}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${files.length} fixture(s) failed schema validation.`)
  process.exit(1)
}
console.log(`\nAll ${files.length} fixtures validate against device-protocol.schema.json.`)
