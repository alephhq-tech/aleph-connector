import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LocalCadStateService } from './local.js'

function freshDb(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE cad_snapshots (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    drawing_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  return db
}

describe('LocalCadStateService', () => {
  test('resolveAccess answers fresh at the recorded revision', async () => {
    const svc = new LocalCadStateService(freshDb())
    const snapshotId = svc.recordSnapshot('local', 'doc_1', 'rev-1')
    expect(snapshotId).toMatch(/^snap_/)
    const access = await svc.resolveAccess('local', 'doc_1', 'rev-1')
    expect(access).toEqual({ snapshot: { id: snapshotId }, mayUseForCurrentFacts: true })
  })

  test('a stale revision never resolves to a snapshot', async () => {
    const svc = new LocalCadStateService(freshDb())
    svc.recordSnapshot('local', 'doc_1', 'rev-1')
    expect(await svc.resolveAccess('local', 'doc_1', 'rev-2')).toBeNull()
  })

  test('a second recordSnapshot replaces the prior snapshot for the drawing', async () => {
    const svc = new LocalCadStateService(freshDb())
    const first = svc.recordSnapshot('local', 'doc_1', 'rev-1')
    const second = svc.recordSnapshot('local', 'doc_1', 'rev-2')
    expect(second).not.toBe(first)
    expect(await svc.resolveAccess('local', 'doc_1', 'rev-1')).toBeNull()
    const access = await svc.resolveAccess('local', 'doc_1', 'rev-2')
    expect(access?.snapshot?.id).toBe(second)
  })

  test('snapshotForRevision answers by exact revision', () => {
    const svc = new LocalCadStateService(freshDb())
    const id = svc.recordSnapshot('local', 'doc_1', 'rev-1')
    expect(svc.snapshotForRevision('local', 'doc_1', 'rev-1')).toBe(id)
    expect(svc.snapshotForRevision('local', 'doc_1', 'rev-9')).toBeNull()
  })
})
