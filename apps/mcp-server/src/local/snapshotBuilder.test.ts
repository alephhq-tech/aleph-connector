import { describe, expect, test } from 'bun:test'
import { openLocalStore } from '@aleph-connector/data'
import { LocalCadStateService } from '@aleph-connector/cad-state'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { buildSnapshot } from './snapshotBuilder.js'

async function identityOf(bridge: MockBridgeClient, documentName?: string) {
  const info = await bridge.request(RpcMethod.DrawingInfo, { documentName })
  return {
    documentId: info.documentId,
    documentName: info.name,
    fingerprintGuid: info.fingerprintGuid,
    revision: info.revision
  }
}

describe('buildSnapshot (on-demand revision-bound index)', () => {
  test('scans the live revision, indexes entities, and answers fresh at that revision', async () => {
    const bridge = new MockBridgeClient()
    bridge.seedUserEntity({ kind: 'line', layer: 'A-WALL', start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } }, { handle: 'AA1' })
    bridge.seedUserEntity({ kind: 'polyline', layer: 'A-DOOR', points: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }, { handle: 'AA2' })

    const store = openLocalStore(':memory:')
    const cadState = new LocalCadStateService(store.db)
    try {
      const identity = await identityOf(bridge, 'Drawing1.dwg')
      const snapshotId = await buildSnapshot(bridge, { cadState, data: store.data }, 'local', identity)
      expect(snapshotId).toMatch(/^snap_/)

      const drawing = (await store.data.cadDocuments.findBySession('local', identity.documentId!))[0]
      expect(drawing).not.toBeNull()

      const access = await cadState.resolveAccess('local', drawing!.id, identity.revision)
      expect(access?.mayUseForCurrentFacts).toBe(true)
      expect(access?.snapshot?.id).toBe(snapshotId)

      const rows = await store.data.cadSnapshotEntities.query(snapshotId!, { window: null, limit: 100 })
      const handles = rows.map((r) => r.handle)
      expect(handles).toContain('AA1')
      expect(handles).toContain('AA2')
      const line = rows.find((r) => r.handle === 'AA1')
      expect(line?.layer).toBe('A-WALL')
      expect(line?.geometry).toMatchObject({ start: { x: 0, y: 0 } })
    } finally {
      store.close()
    }
  })

  test('a write that bumps the revision makes the snapshot stale for the new revision', async () => {
    const bridge = new MockBridgeClient()
    bridge.seedUserEntity({ kind: 'line', layer: 'A-WALL', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })

    const store = openLocalStore(':memory:')
    const cadState = new LocalCadStateService(store.db)
    try {
      const identity = await identityOf(bridge, 'Drawing1.dwg')
      const snapshotId = await buildSnapshot(bridge, { cadState, data: store.data }, 'local', identity)
      const drawing = (await store.data.cadDocuments.findBySession('local', identity.documentId!))[0]
      expect(await cadState.resolveAccess('local', drawing!.id, identity.revision)).not.toBeNull()

      await bridge.request(RpcMethod.EntityCreate, { kind: 'line', layer: 'A-WALL', start: { x: 0, y: 0 }, end: { x: 2, y: 0 } })
      const moved = await identityOf(bridge, 'Drawing1.dwg')
      expect(moved.revision).not.toBe(identity.revision)

      expect(await cadState.resolveAccess('local', drawing!.id, moved.revision)).toBeNull()
      // Rebuild at the new revision replaces the stale snapshot.
      const rebuilt = await buildSnapshot(bridge, { cadState, data: store.data }, 'local', moved)
      expect(rebuilt).not.toBe(snapshotId)
      expect(await cadState.resolveAccess('local', drawing!.id, moved.revision)).not.toBeNull()
    } finally {
      store.close()
    }
  })

  test('an identity without a revision builds nothing', async () => {
    const bridge = new MockBridgeClient()
    const store = openLocalStore(':memory:')
    const cadState = new LocalCadStateService(store.db)
    try {
      const snapshotId = await buildSnapshot(bridge, { cadState, data: store.data }, 'local', {
        documentName: 'Drawing1.dwg',
        revision: ''
      })
      expect(snapshotId).toBeNull()
    } finally {
      store.close()
    }
  })
})
