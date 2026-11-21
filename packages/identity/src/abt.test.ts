import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { AbtTokenService } from './abt.js'
import { GrantDeniedError, MemoryDeviceGrantStore } from './grants.js'

const SECRET = 'unit-test-secret-at-least-16-chars'
const IDENTITY = { deviceId: 'device_abt_1', userId: 'user_abt', workspaceId: 'ws_abt' }

describe('AbtTokenService', () => {
  test('mints a typ:ABT token that verifies with the same grant generation', async () => {
    const grants = new MemoryDeviceGrantStore()
    const abt = new AbtTokenService(SECRET, grants)
    const minted = await abt.mint(IDENTITY)
    const parts = minted.token.split('.')
    expect(parts.length).toBe(3)
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
      alg: string
      typ: string
    }
    expect(header).toEqual({ alg: 'HS256', typ: 'ABT' })
    const result = await abt.verifyDetailed(minted.token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.grantGeneration).toBe(minted.grantGeneration)
    }
  })

  test('rejects a signature keyed on the bare JWT_SECRET', async () => {
    const grants = new MemoryDeviceGrantStore()
    const abt = new AbtTokenService(SECRET, grants)
    await abt.mint(IDENTITY)
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
    const forged = `${unsigned}.${createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`
    expect((await abt.verifyDetailed(forged)).ok).toBe(false)
  })

  test('denies claiming a device already granted to another principal', async () => {
    const grants = new MemoryDeviceGrantStore()
    const abt = new AbtTokenService(SECRET, grants)
    await abt.mint(IDENTITY)
    await expect(
      abt.mint({ deviceId: IDENTITY.deviceId, userId: 'other', workspaceId: 'ws-other' })
    ).rejects.toBeInstanceOf(GrantDeniedError)
  })
})
