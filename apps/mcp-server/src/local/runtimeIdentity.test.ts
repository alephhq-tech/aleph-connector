import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceCredentialService, validateDeviceGrant } from '@aleph-connector/identity'
import { configureLocalRuntime } from './runtimeIdentity.js'

describe('configureLocalRuntime', () => {
  let dir: string
  let identityPath: string
  let env: NodeJS.ProcessEnv

  const log = { info() {}, warn() {}, error() {} } as never

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aleph-local-identity-'))
    identityPath = join(dir, 'bridge', 'identity.json')
    env = { ALEPH_LOCAL_STATE_DIR: dir, ALEPH_LOCAL_IDENTITY_PATH: identityPath }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('first run creates secret, grants, and the Bridge identity.json', async () => {
    const ctx = await configureLocalRuntime(env, log)
    expect(ctx.caller).toEqual({ workspaceId: 'local', userId: 'local' })

    const persisted = JSON.parse(readFileSync(identityPath, 'utf8')) as {
      deviceId: string
      token: string
      tokenExpiresAt: number
    }
    expect(persisted.deviceId).toBe(ctx.deviceId)
    expect(persisted.token.length).toBeGreaterThan(20)
    expect(persisted.tokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // The runtime's own credential service accepts the token it just minted.
    const verified = await deviceCredentialService.verify(persisted.token)
    expect(verified).not.toBeNull()
    expect(verified!.deviceId).toBe(ctx.deviceId)

    // And the grant store answers for the local caller.
    expect(await validateDeviceGrant(ctx.deviceId, 'local', 'local')).toBe(true)
  })

  test('second run reuses the deviceId and keeps a valid token', async () => {
    const first = await configureLocalRuntime(env, log)
    const firstToken = (JSON.parse(readFileSync(identityPath, 'utf8')) as { token: string }).token
    const second = await configureLocalRuntime(env, log)
    expect(second.deviceId).toBe(first.deviceId)

    const secondToken = (JSON.parse(readFileSync(identityPath, 'utf8')) as { token: string }).token
    expect(secondToken.length).toBeGreaterThan(20)
    expect(await deviceCredentialService.verify(secondToken)).not.toBeNull()
    expect(firstToken.length).toBeGreaterThan(20)
  })

  test('a JWT_SECRET env override is honored', async () => {
    const ctx = await configureLocalRuntime({ ...env, JWT_SECRET: 'unit-test-secret-at-least-16-chars' }, log)
    const persisted = JSON.parse(readFileSync(identityPath, 'utf8')) as { token: string }
    expect(await deviceCredentialService.verify(persisted.token)).not.toBeNull()
    expect(ctx.deviceId).toMatch(/^device_/)
  })
})
