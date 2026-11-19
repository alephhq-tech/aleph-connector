import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * #413 §11.5 — approved symbol import must be journaled as a revert-able unit. entity.copy_to with
 * a taskId writes a compensating-erase receipt (operations.revert(taskId) erases the copies as one
 * unit) WITHOUT putting it on the native undo stack, so the apply batch drawn afterwards still
 * undoes correctly (#388). Verified against the mock; the plugin mirrors this in CadTaskLedger.
 */
async function seedSymbol(bridge: MockBridgeClient): Promise<string> {
  const { entity } = await bridge.request(RpcMethod.EntityCreate, {
    documentName: 'Drawing1.dwg',
    kind: 'blockReference',
    blockName: 'SPRK_HEAD',
    position: { x: 0, y: 0, z: 0 }
  })
  return entity.handle
}

describe('entity.copy_to task receipt (#413 §11.5)', () => {
  test('a taskId-tagged copy returns a receipt and reverts as one unit', async () => {
    const bridge = new MockBridgeClient()
    const srcHandle = await seedSymbol(bridge)

    const copy = await bridge.request(RpcMethod.EntityCopyTo, {
      documentName: 'Drawing1.dwg',
      handles: [srcHandle],
      targetDocumentName: 'Drawing2.dwg',
      taskId: 'task_symbol_import'
    })
    expect(copy.copied).toHaveLength(1)
    const copyHandle = copy.copied[0]!.handle
    expect(typeof copy.receiptBatchId).toBe('string')

    // The copy landed in the target.
    const listBefore = await bridge.request(RpcMethod.EntityList, { documentName: 'Drawing2.dwg' })
    expect(listBefore.entities.map((e) => e.handle)).toContain(copyHandle)

    // One revert(taskId) rolls the whole import back.
    const revert = await bridge.request(RpcMethod.OperationsRevert, {
      documentName: 'Drawing2.dwg',
      taskId: 'task_symbol_import'
    })
    expect(revert.status).toBe('reverted')
    expect(revert.erasedHandles).toContain(copyHandle)

    const listAfter = await bridge.request(RpcMethod.EntityList, { documentName: 'Drawing2.dwg' })
    expect(listAfter.entities.map((e) => e.handle)).not.toContain(copyHandle)
  })

  test('a bare copy (no taskId) gets no receipt — reverse by erasing the handle', async () => {
    const bridge = new MockBridgeClient()
    const srcHandle = await seedSymbol(bridge)

    const copy = await bridge.request(RpcMethod.EntityCopyTo, {
      documentName: 'Drawing1.dwg',
      handles: [srcHandle],
      targetDocumentName: 'Drawing2.dwg'
    })
    expect(copy.receiptBatchId).toBeUndefined()

    const revert = await bridge
      .request(RpcMethod.OperationsRevert, {
        documentName: 'Drawing2.dwg',
        taskId: 'task_none'
      })
      .catch((e) => e)
    expect(revert.code).toBeDefined() // no such task — nothing journaled
  })

  test('a receipt does not hijack operations.undo of the apply batch drawn after it (#388)', async () => {
    const bridge = new MockBridgeClient()
    // Make Drawing2.dwg active so native undo is allowed there.
    await bridge.request(RpcMethod.DrawingActivate, { documentName: 'Drawing2.dwg' })
    const srcHandle = await seedSymbol(bridge)

    // 1) journal a symbol import (receipt, undo-ineligible)
    await bridge.request(RpcMethod.EntityCopyTo, {
      documentName: 'Drawing1.dwg',
      handles: [srcHandle],
      targetDocumentName: 'Drawing2.dwg',
      taskId: 'task_lib'
    })
    // 2) draw an apply batch on top of it (undo-eligible)
    const apply = await bridge.request(RpcMethod.OperationsApply, {
      documentName: 'Drawing2.dwg',
      operations: [
        {
          op: 'create',
          entity: { kind: 'line', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 10, z: 0 } }
        }
      ]
    })
    expect(apply.status).toBe('committed')
    const batchId = apply.batchId!

    // Undo targets the apply batch, NOT the copy receipt that was written more recently.
    const undone = await bridge.request(RpcMethod.OperationsUndo, {
      documentName: 'Drawing2.dwg',
      batchId
    })
    expect(undone.status).toBe('undone')
  })
})
