import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@aleph-connector/cad-protocol'
import type { EntityOperation } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { applyOperationsBatch } from './refs.js'

const circle = (radius: number, x = 0): EntityOperation => ({
  op: 'create',
  entity: { kind: 'circle', center: { x, y: 0, z: 0 }, radius }
})

async function createCircle(bridge: MockBridgeClient, radius = 10, x = 0): Promise<string> {
  const result = await applyOperationsBatch(bridge, [circle(radius, x)], {
    documentName: 'Drawing1.dwg'
  })
  expect(result.status).toBe('committed')
  return result.entityRefs[0]!.handle
}

function radiusOf(bridge: MockBridgeClient, handle: string): number | undefined {
  const geometry = bridge.inspectState('Drawing1.dwg').entityGeometry.get(handle)
  return geometry?.kind === 'circle' ? geometry.radius : undefined
}

describe('direct in-place CAD editing (issue #282)', () => {
  test('update preserves the original handle and never duplicates geometry', async () => {
    const bridge = new MockBridgeClient()
    const handle = await createCircle(bridge)
    const result = await applyOperationsBatch(
      bridge,
      [{ op: 'update', update: { handle, geometry: { kind: 'circle', radius: 25 } } }],
      { documentName: 'Drawing1.dwg', taskId: 'task_direct_1' }
    )
    expect(result.status).toBe('committed')
    expect(result.entityRefs.map((ref) => ref.handle)).toEqual([handle])
    expect(radiusOf(bridge, handle)).toBe(25)
    const state = bridge.inspectState('Drawing1.dwg')
    expect(state.entities.size).toBe(1)
    expect([...state.layers.keys()].some((name) => name.startsWith('CadAI-Candidate-'))).toBe(false)
  })

  test('create followed by update @ref edits exactly the created entity', async () => {
    const bridge = new MockBridgeClient()
    const result = await applyOperationsBatch(
      bridge,
      [
        { ...circle(4), id: 'circleA' },
        { op: 'update', update: { handle: '@circleA', geometry: { kind: 'circle', radius: 8 } } }
      ],
      { documentName: 'Drawing1.dwg' }
    )
    expect(result.status).toBe('committed')
    expect(result.entityRefs).toHaveLength(2)
    expect(result.entityRefs[0]!.handle).toBe(result.entityRefs[1]!.handle)
    expect(radiusOf(bridge, result.entityRefs[0]!.handle)).toBe(8)
    expect(bridge.inspectState('Drawing1.dwg').entities.size).toBe(1)
  })

  test('dry-run preview restores geometry, revision and entity count', async () => {
    const bridge = new MockBridgeClient()
    const handle = await createCircle(bridge)
    const state = bridge.inspectState('Drawing1.dwg')
    const revision = state.revision
    const preview = await bridge.request(RpcMethod.OperationsPreview, {
      documentName: 'Drawing1.dwg',
      operations: [{ op: 'update', update: { handle, geometry: { kind: 'circle', radius: 50 } } }]
    })
    expect(preview.valid).toBe(true)
    expect(preview.entityRefs[0]!.handle).toBe(handle)
    expect(radiusOf(bridge, handle)).toBe(10)
    expect(state.revision).toBe(revision)
    expect(state.entities.size).toBe(1)
    expect(state.pendingChanges.size).toBe(0)
  })

  test('a failing second update aborts without changing the first update', async () => {
    const bridge = new MockBridgeClient()
    const handle = await createCircle(bridge)
    const result = await bridge.request(RpcMethod.OperationsApply, {
      documentName: 'Drawing1.dwg',
      operations: [
        { op: 'update', update: { handle, geometry: { kind: 'circle', radius: 22 } } },
        { op: 'update', update: { handle, geometry: { kind: 'line' } } }
      ]
    })
    expect(result.status).toBe('aborted')
    expect(result.error?.failedStep).toBe(1)
    expect(radiusOf(bridge, handle)).toBe(10)
  })

  test('revert of AI task A preserves subsequent independent human edit B', async () => {
    const bridge = new MockBridgeClient()
    const a = await createCircle(bridge, 10, 0)
    const b = await createCircle(bridge, 10, 200)
    const editA = await bridge.request(RpcMethod.OperationsApply, {
      documentName: 'Drawing1.dwg',
      taskId: 'task_ai_A',
      operations: [
        { op: 'update', update: { handle: a, geometry: { kind: 'circle', radius: 30 } } }
      ]
    })
    expect(editA.status).toBe('committed')
    await bridge.request(RpcMethod.EntityUpdate, {
      documentName: 'Drawing1.dwg',
      handle: b,
      geometry: { kind: 'circle', radius: 40 }
    })
    const restored = await bridge.request(RpcMethod.OperationsRevert, {
      documentName: 'Drawing1.dwg',
      batchId: editA.batchId
    })
    expect(restored.status).toBe('reverted')
    expect(restored.restoredHandles).toContain(a)
    expect(radiusOf(bridge, a)).toBe(10)
    expect(radiusOf(bridge, b)).toBe(40)
    expect(bridge.inspectState('Drawing1.dwg').entities.size).toBe(2)
  })

  test('revert refuses to erase a subsequent human style change on the AI-edited entity', async () => {
    const bridge = new MockBridgeClient()
    const handle = await createCircle(bridge)
    const ai = await bridge.request(RpcMethod.OperationsApply, {
      documentName: 'Drawing1.dwg',
      taskId: 'ai_geometry',
      operations: [{ op: 'update', update: { handle, geometry: { kind: 'circle', radius: 20 } } }]
    })
    await bridge.request(RpcMethod.EntityUpdate, {
      documentName: 'Drawing1.dwg',
      handle,
      color: { aci: 3 }
    })
    const failure = await bridge
      .request(RpcMethod.OperationsRevert, {
        documentName: 'Drawing1.dwg',
        batchId: ai.batchId
      })
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(BridgeRpcError)
    expect((failure as BridgeRpcError).code).toBe(BridgeErrorCode.RevertConflict)
    expect(radiusOf(bridge, handle)).toBe(20)
    expect(bridge.inspectState('Drawing1.dwg').entityStyle.get(handle)?.color).toEqual({ aci: 3 })
  })

  test('revert refuses to overwrite a later human change to the same entity', async () => {
    const bridge = new MockBridgeClient()
    const handle = await createCircle(bridge)
    const edit = await bridge.request(RpcMethod.OperationsApply, {
      documentName: 'Drawing1.dwg',
      operations: [{ op: 'update', update: { handle, geometry: { kind: 'circle', radius: 30 } } }]
    })
    await bridge.request(RpcMethod.EntityUpdate, {
      documentName: 'Drawing1.dwg',
      handle,
      geometry: { kind: 'circle', radius: 32 }
    })
    const failure = await bridge
      .request(RpcMethod.OperationsRevert, {
        documentName: 'Drawing1.dwg',
        batchId: edit.batchId
      })
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(BridgeRpcError)
    expect((failure as BridgeRpcError).code).toBe(BridgeErrorCode.RevertConflict)
    expect(radiusOf(bridge, handle)).toBe(32)
  })

  test('operations.apply erase step refuses pre-existing user geometry with ProtectedEntity', async () => {
    const bridge = new MockBridgeClient()
    const userEnt = bridge.seedUserEntity({
      kind: 'circle',
      center: { x: 50, y: 50, z: 0 },
      radius: 15
    })
    const failure = await bridge
      .request(RpcMethod.OperationsApply, {
        documentName: 'Drawing1.dwg',
        operations: [{ op: 'erase', handles: [userEnt.handle] }]
      })
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(BridgeRpcError)
    expect((failure as BridgeRpcError).code).toBe(BridgeErrorCode.ProtectedEntity)
    expect((failure as BridgeRpcError).message).toContain(userEnt.handle)
  })
})
