import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * #413 phase A — after the per-mutation Design Guard was retired, `operations.apply` gained an
 * optional, native, caller-supplied revision precondition: nothing about it is a model-facing
 * ticket (no round trip is required unless the caller wants the check), and a mismatch has zero
 * side effects — the batch never opens a transaction.
 */
describe('operations.apply expectedRevision precondition (#413 phase A)', () => {
  test('omitted expectedRevision: no check, behaves exactly as before', async () => {
    const bridge = new MockBridgeClient()
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        { op: 'create', entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 } }
      ]
    })
    expect(result.status).toBe('committed')
  })

  test('matching expectedRevision: proceeds normally', async () => {
    const bridge = new MockBridgeClient()
    const info = await bridge.request(RpcMethod.DrawingInfo, {})
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        { op: 'create', entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 } }
      ],
      expectedRevision: info.revision
    })
    expect(result.status).toBe('committed')
  })

  test('stale expectedRevision: refuses with zero side effects', async () => {
    const bridge = new MockBridgeClient()
    const info = await bridge.request(RpcMethod.DrawingInfo, {})
    // A concurrent mutation (another tool call, or the user in AutoCAD) advances the revision.
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 100, y: 100, z: 0 },
      radius: 1
    })
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        { op: 'create', entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 } }
      ],
      expectedRevision: info.revision
    })
    expect(result.status).toBe('requires_revalidation')
    expect(result.error?.code).toBe(BridgeErrorCode.RevisionConflict)
    expect(result.entityRefs).toHaveLength(0)
    // Nothing from the refused batch landed — only the earlier concurrent circle exists.
    const list = await bridge.request(RpcMethod.EntityList, {})
    expect(list.entities).toHaveLength(1)
  })

  test('multi-wave @ref batch: the check applies only to the first wire call, not every wave', async () => {
    const bridge = new MockBridgeClient()
    const info = await bridge.request(RpcMethod.DrawingInfo, {})
    // A ref chain forces `applyOperationsBatch` to split into >1 wave; the document's own
    // revision legitimately advances between waves — re-checking the ORIGINAL expectedRevision
    // on wave 2+ must not spuriously fail the whole batch.
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'create',
          id: 'c1',
          entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 }
        },
        { op: 'erase', handles: ['@c1'] }
      ],
      expectedRevision: info.revision
    })
    expect(result.status).toBe('committed')
  })
})
