import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

describe('view.setLive / view.getLive (autocad-mcp#67)', () => {
  test("defaults match today's behavior (follow off) before any setLive call", async () => {
    const bridge = new MockBridgeClient()
    const settings = await bridge.request(RpcMethod.ViewGetLive, {})
    expect(settings).toEqual({
      follow: 'off',
      margin: 0.25,
      minHeight: null,
      animate: true,
      progressive: false,
      paceMs: 0
    })
  })

  test('setLive merges given fields over the current settings and returns the effective result', async () => {
    const bridge = new MockBridgeClient()
    const first = await bridge.request(RpcMethod.ViewSetLive, { follow: 'fit', margin: 0.5 })
    expect(first).toMatchObject({ follow: 'fit', margin: 0.5 })

    // A second call that only changes one field keeps the rest from the first call.
    const second = await bridge.request(RpcMethod.ViewSetLive, { animate: false })
    expect(second).toMatchObject({ follow: 'fit', margin: 0.5, animate: false })

    const got = await bridge.request(RpcMethod.ViewGetLive, {})
    expect(got).toEqual(second)
  })

  test('live settings are isolated per document', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.ViewSetLive, { follow: 'pan', documentName: 'Drawing1.dwg' })
    const other = await bridge.request(RpcMethod.ViewGetLive, { documentName: 'Drawing2.dwg' })
    expect(other.follow).toBe('off')
  })

  test("a per-call `view` override on a mutating RPC does not mutate the document's stored live setting", async () => {
    const bridge = new MockBridgeClient()
    const before = await bridge.request(RpcMethod.ViewSetLive, { follow: 'fit' })

    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 1,
      view: { follow: 'off' }
    })

    const after = await bridge.request(RpcMethod.ViewGetLive, {})
    expect(after).toEqual(before)
  })
})

describe('view.zoom (autocad-mcp#67/#27/#63)', () => {
  test('window: echoes its center and height', async () => {
    const bridge = new MockBridgeClient()
    const result = await bridge.request(RpcMethod.ViewZoom, {
      window: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 0 } }
    })
    expect(result).toEqual({ center: { x: 5, y: 10, z: 0 }, height: 20 })
  })

  test('center + viewHeight: echoed back unchanged', async () => {
    const bridge = new MockBridgeClient()
    const result = await bridge.request(RpcMethod.ViewZoom, {
      center: { x: 3, y: 4, z: 0 },
      viewHeight: 12
    })
    expect(result).toEqual({ center: { x: 3, y: 4, z: 0 }, height: 12 })
  })

  test('an unresolvable handle is rejected', async () => {
    await expect(
      new MockBridgeClient().request(RpcMethod.ViewZoom, { handles: ['FFFFFF'] })
    ).rejects.toThrow()
  })
})

describe('drawing open / new / close / activate tabs (#30)', () => {
  test('drawing.open opens a new document and adds it to listOpen', async () => {
    const bridge = new MockBridgeClient()
    const res = await bridge.request(RpcMethod.DrawingOpen, { path: 'C:\\drawings\\floorplan.dwg' })
    expect(res.name).toBe('floorplan.dwg')
    expect(res.path).toBe('C:\\drawings\\floorplan.dwg')
    expect(res.documentId).toMatch(/^doc_mock_/)

    const list = await bridge.request(RpcMethod.DrawingListOpen, {})
    expect(list.documents.map((d) => d.name)).toContain('floorplan.dwg')
  })

  test('drawing.new creates a new tab with sequential name', async () => {
    const bridge = new MockBridgeClient()
    const res = await bridge.request(RpcMethod.DrawingNew, {})
    expect(res.name).toBe('Drawing3.dwg')
    expect(res.documentId).toMatch(/^doc_mock_/)

    const list = await bridge.request(RpcMethod.DrawingListOpen, {})
    expect(list.documents.map((d) => d.name)).toContain('Drawing3.dwg')
  })

  test('drawing.activate switches active document', async () => {
    const bridge = new MockBridgeClient()
    const res = await bridge.request(RpcMethod.DrawingActivate, { documentName: 'Drawing2.dwg' })
    expect(res.activated).toBe(true)
    expect(res.name).toBe('Drawing2.dwg')

    const list = await bridge.request(RpcMethod.DrawingListOpen, {})
    const active = list.documents.find((d) => d.isActive)
    expect(active?.name).toBe('Drawing2.dwg')
  })

  test('drawing.close closes an open tab', async () => {
    const bridge = new MockBridgeClient()
    const res = await bridge.request(RpcMethod.DrawingClose, { documentName: 'Drawing2.dwg' })
    expect(res.closed).toBe(true)
    expect(res.name).toBe('Drawing2.dwg')

    const list = await bridge.request(RpcMethod.DrawingListOpen, {})
    expect(list.documents.map((d) => d.name)).not.toContain('Drawing2.dwg')
  })
})
describe('operations.preview (PR C slice 02, #23)', () => {
  test('preview evaluates batch without committing entities to drawing', async () => {
    const bridge = new MockBridgeClient()
    const beforeList = await bridge.request(RpcMethod.EntityList, {})
    const initialCount = beforeList.entities.length

    const previewResult = await bridge.request(RpcMethod.OperationsPreview, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        },
        {
          op: 'create',
          entity: {
            kind: 'circle',
            center: { x: 5, y: 5, z: 0 },
            radius: 5
          }
        }
      ],
      taskId: 'task_dry_run_test'
    })

    expect(previewResult.valid).toBe(true)
    expect(previewResult.operationCount).toBe(2)
    expect(previewResult.entityRefs.length).toBe(2)
    expect(previewResult.extents).toBeDefined()

    // Verify drawing was NOT modified:
    const afterList = await bridge.request(RpcMethod.EntityList, {})
    expect(afterList.entities.length).toBe(initialCount)
  })

  test('preview reports failedStep index and causeCode on invalid operation', async () => {
    const bridge = new MockBridgeClient()

    const previewResult = await bridge.request(RpcMethod.OperationsPreview, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        },
        {
          op: 'create',
          entity: {
            kind: 'line',
            layer: 'NonExistentLayer_XYZ',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        }
      ]
    })

    expect(previewResult.valid).toBe(false)
    expect(previewResult.error).toBeDefined()
    expect(previewResult.error?.failedStep).toBe(1)
    expect(previewResult.error?.causeCode).toBe(-32004) // LayerNotFound
  })
})
describe('operations.revert (PR C slice 03, #282 / #23)', () => {
  test('revert selectively erases created entities non-LIFO without affecting later batches', async () => {
    const bridge = new MockBridgeClient()

    // Batch 1 (created by AI)
    const b1 = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        }
      ]
    })
    const lineHandle = b1.entityRefs[0]!.handle

    // Batch 2 (subsequent work, e.g. human or another tool)
    const b2 = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'circle',
            center: { x: 20, y: 20, z: 0 },
            radius: 5
          }
        }
      ]
    })
    const circleHandle = b2.entityRefs[0]!.handle

    // Non-LIFO revert of Batch 1!
    const revertResult = await bridge.request(RpcMethod.OperationsRevert, {
      batchId: b1.batchId
    })

    expect(revertResult.status).toBe('reverted')
    expect(revertResult.revertedChangeSetsCount).toBe(1)
    expect(revertResult.erasedHandles).toContain(lineHandle)

    // Verify Line A is erased, but Circle B is preserved!
    const listAfter = await bridge.request(RpcMethod.EntityList, {})
    const handlesAfter = listAfter.entities.map((e) => e.handle)
    expect(handlesAfter).not.toContain(lineHandle)
    expect(handlesAfter).toContain(circleHandle)
  })

  test('revert by taskId inverts all batches belonging to task', async () => {
    const bridge = new MockBridgeClient()

    const taskId = 'task_selective_recovery_101'
    const b1 = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 5, y: 5, z: 0 }
          }
        }
      ],
      taskId
    })
    const b2 = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 10, y: 10, z: 0 },
            end: { x: 15, y: 15, z: 0 }
          }
        }
      ],
      taskId
    })

    const revertResult = await bridge.request(RpcMethod.OperationsRevert, {
      taskId
    })

    expect(revertResult.status).toBe('reverted')
    expect(revertResult.revertedChangeSetsCount).toBe(2)
    expect(revertResult.erasedHandles).toContain(b1.entityRefs[0]!.handle)
    expect(revertResult.erasedHandles).toContain(b2.entityRefs[0]!.handle)

    const listAfter = await bridge.request(RpcMethod.EntityList, {})
    const handlesAfter = listAfter.entities.map((e) => e.handle)
    expect(handlesAfter).not.toContain(b1.entityRefs[0]!.handle)
    expect(handlesAfter).not.toContain(b2.entityRefs[0]!.handle)
  })

  test('revert refuses with RevertConflict (-32036) when created entity was deleted externally', async () => {
    const bridge = new MockBridgeClient()

    const b1 = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        }
      ]
    })
    const lineHandle = b1.entityRefs[0]!.handle

    // Human or external action deletes the entity
    await bridge.request(RpcMethod.EntityErase, {
      handles: [lineHandle]
    })

    // Now attempt to revert the batch -> must throw RevertConflict
    try {
      await bridge.request(RpcMethod.OperationsRevert, {
        batchId: b1.batchId
      })
      expect.unreachable('Should have thrown RevertConflict')
    } catch (err: any) {
      expect(err.code).toBe(BridgeErrorCode.RevertConflict)
      expect(err.message).toContain('has since been deleted')
    }
  })

  test('revert refuses already-reverted batch with RevertConflict', async () => {
    const bridge = new MockBridgeClient()

    const b1 = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        }
      ]
    })

    await bridge.request(RpcMethod.OperationsRevert, {
      batchId: b1.batchId
    })

    // Second revert attempt
    try {
      await bridge.request(RpcMethod.OperationsRevert, {
        batchId: b1.batchId
      })
      expect.unreachable('Should have thrown RevertConflict')
    } catch (err: any) {
      expect(err.code).toBe(BridgeErrorCode.RevertConflict)
      expect(err.message).toContain('already been reverted')
    }
  })
  test('operations.history filters by taskId on reconnect (PR D slice 02, #282)', async () => {
    const bridge = new MockBridgeClient()

    await bridge.request(RpcMethod.OperationsApply, {
      taskId: 'task_reconnect_1',
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 0, z: 0 }
          }
        }
      ]
    })

    await bridge.request(RpcMethod.OperationsApply, {
      taskId: 'task_other_2',
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 0, y: 10, z: 0 }
          }
        }
      ]
    })

    await bridge.request(RpcMethod.OperationsApply, {
      taskId: 'task_reconnect_1',
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            start: { x: 10, y: 0, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        }
      ]
    })

    // Query all history
    const allHistory = await bridge.request(RpcMethod.OperationsHistory, { limit: 10 })
    expect(allHistory.batches.length).toBe(3)

    // Query filtered by taskId
    const task1History = await bridge.request(RpcMethod.OperationsHistory, {
      taskId: 'task_reconnect_1',
      limit: 10
    })
    expect(task1History.batches.length).toBe(2)
    expect(task1History.batches.every((b) => b.taskId === 'task_reconnect_1')).toBe(true)

    const task2History = await bridge.request(RpcMethod.OperationsHistory, {
      taskId: 'task_other_2',
      limit: 10
    })
    expect(task2History.batches.length).toBe(1)
    expect(task2History.batches[0]!.taskId).toBe('task_other_2')
  })
})

describe('entity ownership enforcement (ProtectedEntity -32038)', () => {
  test('entity.erase throws ProtectedEntity on pre-existing user entity', async () => {
    const bridge = new MockBridgeClient()
    const userEnt = bridge.seedUserEntity({
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5
    })
    try {
      await bridge.request(RpcMethod.EntityErase, { handles: [userEnt.handle] })
      expect.unreachable('should have thrown ProtectedEntity')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.ProtectedEntity)
      expect(rpcErr.message).toContain(userEnt.handle)
    }
  })

  test('operations.apply erase step throws ProtectedEntity on pre-existing user entity', async () => {
    const bridge = new MockBridgeClient()
    const userEnt = bridge.seedUserEntity({
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })
    try {
      await bridge.request(RpcMethod.OperationsApply, {
        operations: [{ op: 'erase', handles: [userEnt.handle] }]
      })
      expect.unreachable('should have thrown ProtectedEntity')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.ProtectedEntity)
      expect(rpcErr.message).toContain(userEnt.handle)
    }
  })

  test('entity.erase and operations.apply erase succeed for CadAI-created entities', async () => {
    const bridge = new MockBridgeClient()
    const { entity: e1 } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 1, z: 0 }
    })
    const { entity: e2 } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 5, y: 5, z: 0 },
      radius: 2
    })

    const eraseRes = await bridge.request(RpcMethod.EntityErase, { handles: [e1.handle] })
    expect(eraseRes.erased).toEqual([e1.handle])

    const applyRes = await bridge.request(RpcMethod.OperationsApply, {
      operations: [{ op: 'erase', handles: [e2.handle] }]
    })
    expect(applyRes.status).toBe('committed')

    const list = await bridge.request(RpcMethod.EntityList, {})
    expect(list.total).toBe(0)
  })

  test('block.explode throws ProtectedEntity on pre-existing user block reference', async () => {
    const bridge = new MockBridgeClient()
    const userBlock = bridge.seedUserEntity({
      kind: 'blockReference',
      blockName: 'USER_BLOCK',
      position: { x: 0, y: 0, z: 0 }
    })
    try {
      await bridge.request(RpcMethod.BlockExplode, { handle: userBlock.handle })
      expect.unreachable('should have thrown ProtectedEntity')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.ProtectedEntity)
    }
  })

  test('mirror with erase: true throws ProtectedEntity on pre-existing user entity', async () => {
    const bridge = new MockBridgeClient()
    const userEnt = bridge.seedUserEntity({
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })
    try {
      await bridge.request(RpcMethod.EntityTransform, {
        op: 'mirror',
        handles: [userEnt.handle],
        axisStart: { x: 0, y: 0, z: 0 },
        axisEnd: { x: 0, y: 1, z: 0 },
        erase: true
      })
      expect.unreachable('should have thrown ProtectedEntity')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.ProtectedEntity)
    }
  })
})
