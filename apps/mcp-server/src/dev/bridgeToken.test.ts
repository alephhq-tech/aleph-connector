import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DevBridgeTokenService,
  GrantDeniedError,
  JsonFileGrantStore,
  devGrantFile
} from './bridgeToken.js'

/**
 * The live E2E lane authenticates a real connector + plugin with these credentials, so the dev tier
 * has to enforce the same rules the production grant table does — signing under the wrong key must
 * fail, a revoked generation must stop authorizing, and a caller who merely knows a deviceId must be
 * denied. Pinning that here is what keeps "dev tier" from quietly meaning "no auth".
 */

const SECRET = 'unit-test-secret-at-least-16-chars'
const IDENTITY = { deviceId: 'device_unit_1', userId: 'user_unit', workspaceId: 'ws_unit' }

let dir = ''
let grants: JsonFileGrantStore
let tokens: DevBridgeTokenService

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aleph-dev-token-'))
  grants = new JsonFileGrantStore(join(dir, 'grants.json'))
  tokens = new DevBridgeTokenService(SECRET, grants)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('dev grant file resolution', () => {
  /**
   * The lane runs the minter and the server as two separate processes. A cwd-relative default made
   * them land on different files, and the connector's WSS dial failed with a bare 401 - the server
   * had no grant row to check, so a perfectly signed credential read as stale. Pin the resolution to
   * the module, not the working directory.
   */
  test('the default grant path does not depend on the process cwd', () => {
    const here = devGrantFile({})
    const elsewhere = spawnSync(
      process.execPath,
      [
        '-e',
        `import { devGrantFile } from ${JSON.stringify(fileURLToPath(new URL('./bridgeToken.ts', import.meta.url)))};` +
          'console.log(devGrantFile({}))'
      ],
      { cwd: tmpdir(), encoding: 'utf8' }
    )
    expect(elsewhere.status).toBe(0)
    expect(elsewhere.stdout.trim()).toBe(here)
  })

  test('ALEPH_DEV_GRANT_FILE overrides the default', () => {
    const override = join(dir, 'elsewhere.json')
    expect(devGrantFile({ ALEPH_DEV_GRANT_FILE: override })).toBe(override)
  })
})

describe('DevBridgeTokenService wire format', () => {
  test('mints a compact three-part token whose header says ABT/HS256', async () => {
    const { token } = await tokens.mint(IDENTITY)
    const parts = token.split('.')
    expect(parts.length).toBe(3)
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
      alg: string
      typ: string
    }
    expect(header).toEqual({ alg: 'HS256', typ: 'ABT' })
  })

  test('a freshly minted credential verifies and carries the grant generation', async () => {
    const minted = await tokens.mint(IDENTITY)
    const result = await tokens.verifyDetailed(minted.token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.deviceId).toBe(IDENTITY.deviceId)
      expect(result.payload.workspaceId).toBe(IDENTITY.workspaceId)
      expect(result.payload.grantGeneration).toBe(minted.grantGeneration)
    }
  })

  test('signing with the bare JWT_SECRET (no :autocad-bridge-token salt) is rejected', async () => {
    // The connector's credential is keyed on the secret PLUS that suffix; an unsigned body signed
    // with the bare secret must fail, which pins the salt as load-bearing rather than cosmetic.
    const body = Buffer.from(
      JSON.stringify({
        ...IDENTITY,
        grantGeneration: 1,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600
      })
    ).toString('base64url')
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'ABT' })).toString('base64url')
    const unsigned = `${header}.${body}`
    const bareSignature = createHmac('sha256', SECRET).update(unsigned).digest('base64url')
    const forged = `${unsigned}.${bareSignature}`
    expect(forged.split('.').length).toBe(3)
    expect(await tokens.verifyDetailed(forged)).toEqual({ ok: false, reason: 'signature' })
    expect((await tokens.verifyDetailed((await tokens.mint(IDENTITY)).token)).ok).toBe(true)
  })

  test('a token signed under a different secret fails on signature, not grant', async () => {
    const other = new DevBridgeTokenService('a-completely-different-secret-xx', grants)
    const forged = (await other.mint(IDENTITY)).token
    const result = await tokens.verifyDetailed(forged)
    expect(result).toEqual({ ok: false, reason: 'signature' })
  })

  test('malformed credentials are rejected without throwing', async () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'xxx.yyy.zzz']) {
      const result = await tokens.verifyDetailed(bad)
      expect(result.ok).toBe(false)
    }
  })

  test('an expired credential is rejected as expired', async () => {
    const expired = await tokens.mint(IDENTITY, -10)
    const result = await tokens.verifyDetailed(expired.token)
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('grant enforcement parity with the production table', () => {
  test('revoking moves the generation so a previously minted token goes stale', async () => {
    const minted = await tokens.mint(IDENTITY)
    expect((await tokens.verifyDetailed(minted.token)).ok).toBe(true)

    expect(await grants.revoke(IDENTITY.deviceId, IDENTITY.workspaceId, IDENTITY.userId)).toBe(true)
    expect(await tokens.verifyDetailed(minted.token)).toEqual({ ok: false, reason: 'grant_stale' })
  })

  test('a second claim after revoke gets a higher generation and verifies', async () => {
    const other = { ...IDENTITY, deviceId: 'device_rotate_1' }
    const first = await tokens.mint(other)
    await grants.revoke(other.deviceId, other.workspaceId, other.userId)
    const second = await tokens.mint(other)
    expect(second.grantGeneration).toBeGreaterThan(first.grantGeneration)
    expect((await tokens.verifyDetailed(second.token)).ok).toBe(true)
    expect(await tokens.verifyDetailed(first.token)).toEqual({ ok: false, reason: 'grant_stale' })
  })

  test('a different principal cannot mint or use a device it was not granted', async () => {
    const owner = { deviceId: 'device_owned_1', userId: 'user_owner', workspaceId: 'ws_owner' }
    const intruder = { deviceId: owner.deviceId, userId: 'user_intruder', workspaceId: 'ws_intruder' }
    await tokens.mint(owner)
    await expect(tokens.mint(intruder)).rejects.toBeInstanceOf(GrantDeniedError)

    // Even a well-signed intruder credential must not authorize: mint it for its OWN device first,
    // then hand it the owner's deviceId inside an otherwise valid signature.
    const attackerToken = (
      await tokens.mint({
        deviceId: 'device_attacker_1',
        userId: 'user_intruder',
        workspaceId: 'ws_intruder'
      })
    ).token
    expect(await grants.validate(owner.deviceId, intruder.workspaceId, intruder.userId)).toBe(false)
    expect((await tokens.verifyDetailed(attackerToken)).ok).toBe(true)
  })

  test('the grant file survives a process-equivalent restart', async () => {
    const minted = await tokens.mint({ ...IDENTITY, deviceId: 'device_persist_1' })
    const reopened = new JsonFileGrantStore(join(dir, 'grants.json'))
    const reloaded = new DevBridgeTokenService(SECRET, reopened)
    expect((await reloaded.verifyDetailed(minted.token)).ok).toBe(true)
  })

  test('a short secret is refused at construction, not silently weakened', () => {
    expect(() => new DevBridgeTokenService('short', grants)).toThrow(/at least 16 characters/)
  })
})
