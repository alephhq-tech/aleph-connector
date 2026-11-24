import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLocalStore, type LocalStoreHandle } from './local.js'
import { hashApprovalToken } from './index.js'

function tempStore(): LocalStoreHandle {
  const dir = mkdtempSync(join(tmpdir(), 'aleph-local-store-'))
  return { ...openLocalStore(join(dir, 'cad-state.db')), dir }
}

describe('LocalDataStore (SQLite)', () => {
  let store: LocalStoreHandle

  beforeEach(() => {
    store = tempStore()
  })
  afterEach(() => {
    store.close()
    rmSync(store.dir, { recursive: true, force: true })
  })

  test('snapshot entity rows round-trip handle, kind, layer, block, geometry', async () => {
    store.data.insertSnapshotEntities('snap_1', [
      { handle: 'A1', kind: 'polyline', layer: 'WALL', geometry: { points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] } },
      { handle: 'B2', kind: 'blockReference', layer: 'ELEC', blockName: 'PANEL-1' }
    ])
    expect(store.data.snapshotEntityCount('snap_1')).toBe(2)

    const rows = await store.data.cadSnapshotEntities.query('snap_1', { window: null, limit: 10 })
    expect(rows).toHaveLength(2)
    const a1 = rows.find((r) => r.handle === 'A1')
    expect(a1?.kind).toBe('polyline')
    expect(a1?.layer).toBe('WALL')
    expect(a1?.blockName).toBeNull()
    expect(a1?.geometry).toEqual({ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] })
    const b2 = rows.find((r) => r.handle === 'B2')
    expect(b2?.blockName).toBe('PANEL-1')
    expect(b2?.geometry).toBeNull()
  })

  test('query honors the limit', async () => {
    store.data.insertSnapshotEntities('snap_2', [
      { handle: 'A', kind: 'line', layer: '0' },
      { handle: 'B', kind: 'line', layer: '0' },
      { handle: 'C', kind: 'line', layer: '0' }
    ])
    const rows = await store.data.cadSnapshotEntities.query('snap_2', { window: null, limit: 2 })
    expect(rows).toHaveLength(2)
  })

  test('symbol catalog returns only approved items', async () => {
    await store.data.cadSymbolCatalog.insert({
      id: 'cadsym_1',
      workspaceId: 'local',
      key: 'pccc_fire_alarm.smoke_detector',
      category: 'detector',
      blockName: 'SMOKE-DET',
      status: 'approved',
      createdAt: 1,
      updatedAt: 1
    })
    await store.data.cadSymbolCatalog.insert({
      id: 'cadsym_2',
      workspaceId: 'local',
      key: 'pccc_fire_alarm.manual_call_point',
      category: 'call_point',
      blockName: 'MCP-1',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1
    })
    const approved = await store.data.cadSymbolCatalog.findByKey('local', 'pccc_fire_alarm.smoke_detector')
    expect(approved?.blockName).toBe('SMOKE-DET')
    expect(await store.data.cadSymbolCatalog.findByKey('local', 'pccc_fire_alarm.manual_call_point')).toBeNull()
    expect(await store.data.cadSymbolCatalog.findByKey('other', 'pccc_fire_alarm.smoke_detector')).toBeNull()
  })

  test('approval token state machine matches the in-memory tier', async () => {
    await store.data.editApprovals.createPending({
      runId: 'run_1',
      workspaceId: 'local',
      editId: 'edit_1',
      diffDigest: 'digest-1',
      expiresAt: Date.now() + 60_000
    })
    await store.data.editApprovals.resolve('run_1', {
      approved: true,
      tokenHash: hashApprovalToken('tok-1'),
      expiresAt: Date.now() + 60_000
    })

    const wrongEdit = await store.data.editApprovals.consumeToken({ token: 'tok-1', editId: 'other' })
    expect(wrongEdit.success).toBe(false)

    const wrongDigest = await store.data.editApprovals.consumeToken({
      token: 'tok-1',
      editId: 'edit_1',
      diffDigest: 'other-digest'
    })
    expect(wrongDigest.success).toBe(false)

    const ok = await store.data.editApprovals.consumeToken({ token: 'tok-1', editId: 'edit_1', diffDigest: 'digest-1' })
    expect(ok.success).toBe(true)

    const reused = await store.data.editApprovals.consumeToken({ token: 'tok-1', editId: 'edit_1' })
    expect(reused.success).toBe(false)
    expect(reused.reason).toMatch(/already been consumed/)
  })

  test('document lookups find a registered document by fingerprint and session', async () => {
    const drawingId = store.data.registerDocument({ fingerprintGuid: 'fp-1', documentId: 'doc-1' })
    expect((await store.data.cadDocuments.findByFingerprint('local', 'fp-1'))?.id).toBe(drawingId)
    expect((await store.data.cadDocuments.findBySession('local', 'doc-1'))[0]?.id).toBe(drawingId)
    expect(await store.data.cadDocuments.findByFingerprint('local', 'fp-missing')).toBeNull()
  })
})
