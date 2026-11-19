import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@arcdio/cad-protocol'
import type { EntityOperation, RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { applyOperationsBatch } from './refs.js'

/** Records every `operations.apply` wave actually sent, so a test can assert on the wire payload. */
class SpyBridgeClient implements BridgeClient {
  readonly inner = new MockBridgeClient()
  readonly applyCalls: RpcMethodMap[typeof RpcMethod.OperationsApply]['params'][] = []

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params']
  ): Promise<RpcMethodMap[M]['result']> {
    if (method === RpcMethod.OperationsApply) {
      this.applyCalls.push(params as RpcMethodMap[typeof RpcMethod.OperationsApply]['params'])
    }
    return this.inner.request(method, params)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

const circle = (id?: string): EntityOperation => ({
  op: 'create',
  entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 },
  ...(id != null && { id })
})

describe('operations.apply @ref resolution (#19)', () => {
  test('forward reference is rejected before anything reaches AutoCAD', async () => {
    const bridge = new SpyBridgeClient()
    const steps: EntityOperation[] = [{ op: 'erase', handles: ['@a'] }, circle('a')]
    await expect(applyOperationsBatch(bridge, steps, { documentName: undefined })).rejects.toThrow(
      /hasn't run yet|forward/
    )
    expect(bridge.applyCalls).toHaveLength(0)
    const list = await bridge.inner.request(RpcMethod.EntityList, {})
    expect(list.entities).toHaveLength(0)
  })

  test('an unknown id is rejected before anything reaches AutoCAD', async () => {
    const bridge = new SpyBridgeClient()
    const steps: EntityOperation[] = [{ op: 'erase', handles: ['@nope'] }]
    await expect(applyOperationsBatch(bridge, steps, { documentName: undefined })).rejects.toThrow(
      /unknown batch reference/
    )
    expect(bridge.applyCalls).toHaveLength(0)
  })

  test('a duplicate id is rejected before anything reaches AutoCAD', async () => {
    const bridge = new SpyBridgeClient()
    const steps: EntityOperation[] = [circle('a'), circle('a')]
    await expect(applyOperationsBatch(bridge, steps, { documentName: undefined })).rejects.toThrow(
      /duplicate id/
    )
    expect(bridge.applyCalls).toHaveLength(0)
  })

  test('an id that resolved to more than one entity is rejected where exactly one handle is required', async () => {
    const bridge = new SpyBridgeClient()
    const steps: EntityOperation[] = [
      circle('src'),
      {
        op: 'transform',
        id: 'grid',
        transform: {
          op: 'arrayRect',
          handles: ['@src'],
          rows: 2,
          columns: 2,
          rowSpacing: 5,
          columnSpacing: 5
        }
      },
      {
        op: 'transform',
        transform: {
          op: 'arrayPath',
          handles: ['@src'],
          path: { handle: '@grid' },
          count: 3
        }
      }
    ]
    const promise = applyOperationsBatch(bridge, steps, { documentName: undefined })
    await expect(promise).rejects.toThrow(/resolved to 3 entities/)
    const err = await promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BridgeRpcError)
    expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.InvalidOperation)
  })

  test('successful chain: create id a -> transform @a -> erase @a, real handles on the wire', async () => {
    const bridge = new SpyBridgeClient()
    const steps: EntityOperation[] = [
      circle('a'),
      { op: 'transform', transform: { op: 'move', handles: ['@a'], delta: { x: 1, y: 0, z: 0 } } },
      { op: 'erase', handles: ['@a'] }
    ]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })
    expect(result.status).toBe('committed')
    expect(result.entityRefs).toHaveLength(3) // create + move(affected) + erase

    const realHandle = result.entityRefs[0]!.handle
    expect(realHandle).toMatch(/^[0-9A-F]+$/i)
    expect(result.entityRefs.every((ref) => ref.handle === realHandle)).toBe(true)

    // The create (id "a") and the transform referencing "@a" can't share a transaction — the
    // transform needs a's real handle, which only exists once the create actually ran — so this
    // chain is exactly two `operations.apply` calls, every one with real handles, never "@a".
    expect(bridge.applyCalls).toHaveLength(2)
    expect(bridge.applyCalls[0]!.operations).toEqual([
      { op: 'create', entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 } }
    ])
    expect(bridge.applyCalls[1]!.operations).toEqual([
      {
        op: 'transform',
        transform: { op: 'move', handles: [realHandle], delta: { x: 1, y: 0, z: 0 } }
      },
      { op: 'erase', handles: [realHandle] }
    ])
    for (const call of bridge.applyCalls) {
      expect(JSON.stringify(call)).not.toContain('@a')
    }
  })

  test('a batch with no ids/refs is still exactly one operations.apply call', async () => {
    const bridge = new SpyBridgeClient()
    const steps: EntityOperation[] = [circle(), circle()]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })
    expect(result.status).toBe('committed')
    expect(bridge.applyCalls).toHaveLength(1)
  })

  test("referencing an id from an already-flushed earlier wave doesn't force another flush", async () => {
    const bridge = new SpyBridgeClient()
    const steps: EntityOperation[] = [
      circle('a'),
      { op: 'transform', transform: { op: 'move', handles: ['@a'], delta: { x: 1, y: 0, z: 0 } } },
      {
        op: 'transform',
        transform: { op: 'rotate', handles: ['@a'], center: { x: 0, y: 0, z: 0 }, angle: 1 }
      }
    ]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })
    expect(result.status).toBe('committed')
    // wave1: [create a]; wave2: [move @a, rotate @a] — rotate doesn't need a third wave since "a"
    // was already resolved by the time wave2 was built.
    expect(bridge.applyCalls).toHaveLength(2)
    expect(bridge.applyCalls[1]!.operations).toHaveLength(2)
  })

  test('multi-wave failure preserves truthful partial status and committed batch IDs', async () => {
    const bridge = new MockBridgeClient()
    let callCount = 0
    const originalRequest = bridge.request.bind(bridge)
    bridge.request = async (method, params, opts) => {
      if (method === RpcMethod.OperationsApply) {
        callCount++
        if (callCount === 2) {
          // Inject failure on wave 2
          return {
            status: 'aborted',
            entityRefs: [],
            error: {
              code: BridgeErrorCode.TransactionFailed,
              message: 'Simulated wave 2 crash',
              failedStep: 0
            }
          }
        }
      }
      return originalRequest(method, params, opts)
    }

    const steps: EntityOperation[] = [
      circle('w1'),
      { op: 'transform', transform: { op: 'move', handles: ['@w1'], delta: { x: 5, y: 0, z: 0 } } }
    ]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })

    expect(result.status).toBe('partial')
    expect(result.partial).toBe(true)
    expect(result.completedPhases).toBe(1)
    expect(result.totalPhases).toBe(2)
    expect(result.committedBatchIds).toHaveLength(1)
    expect(result.entityRefs).toHaveLength(1)
    expect(result.error?.failedStep).toBe(1) // Maps to original step index 1!
    expect(result.error?.message).toContain('Simulated wave 2 crash')
  })

  test('cancellation after wave 1 reports cancelled with partial: true', async () => {
    const bridge = new MockBridgeClient()
    const controller = new AbortController()
    let callCount = 0
    const originalRequest = bridge.request.bind(bridge)
    bridge.request = async (method, params, opts) => {
      if (method === RpcMethod.OperationsApply) {
        callCount++
        if (callCount === 1) {
          // Abort after wave 1 commits
          const res = await originalRequest(method, params, opts)
          controller.abort()
          return res
        }
      }
      return originalRequest(method, params, opts)
    }

    const steps: EntityOperation[] = [
      circle('w1'),
      { op: 'transform', transform: { op: 'move', handles: ['@w1'], delta: { x: 5, y: 0, z: 0 } } }
    ]
    const result = await applyOperationsBatch(bridge, steps, {
      documentName: undefined,
      signal: controller.signal
    })

    expect(result.status).toBe('cancelled')
    expect(result.partial).toBe(true)
    expect(result.completedPhases).toBe(1)
    expect(result.committedBatchIds).toHaveLength(1)
    expect(result.entityRefs).toHaveLength(1)
  })

  test('cancellation before wave 0 reports cancelled with partial: false', async () => {
    const bridge = new MockBridgeClient()
    const controller = new AbortController()
    controller.abort()

    const steps: EntityOperation[] = [circle()]
    const result = await applyOperationsBatch(bridge, steps, {
      documentName: undefined,
      signal: controller.signal
    })

    expect(result.status).toBe('cancelled')
    expect(result.partial).toBe(false)
    expect(result.completedPhases).toBe(0)
    expect(result.entityRefs).toHaveLength(0)
  })

  test('native committed with multiple committedBatchIds preserves all batch ids', async () => {
    const bridge = new MockBridgeClient()
    bridge.request = (async (method: any, params: any, opts: any): Promise<any> => {
      if (method === RpcMethod.OperationsApply) {
        return {
          status: 'committed',
          batchId: 'batch_2',
          committedBatchIds: ['batch_1', 'batch_2'],
          entityRefs: [
            { handle: '10', kind: 'circle', layer: '0' },
            { handle: '11', kind: 'circle', layer: '0' }
          ],
          phases: [
            { phase: 0, status: 'committed', batchId: 'batch_1', entityCount: 1 },
            { phase: 1, status: 'committed', batchId: 'batch_2', entityCount: 1 }
          ]
        }
      }
      return bridge.request(method, params, opts)
    }) as any

    const steps: EntityOperation[] = [circle(), circle()]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })

    expect(result.status).toBe('committed')
    expect(result.partial).toBe(false)
    expect(result.committedBatchIds).toEqual(['batch_1', 'batch_2'])
    expect(result.entityRefs).toHaveLength(2)
    expect(result.phases).toHaveLength(2)
  })

  test('native partial in first wave reports partial: true with committed state', async () => {
    const bridge = new MockBridgeClient()
    bridge.request = (async (method: any): Promise<any> => {
      if (method === RpcMethod.OperationsApply) {
        return {
          status: 'partial',
          batchId: 'batch_p1',
          committedBatchIds: ['batch_p1'],
          entityRefs: [{ handle: '20', kind: 'circle', layer: '0' }],
          completedPhases: 1,
          totalPhases: 2,
          error: {
            code: BridgeErrorCode.TransactionFailed,
            message: 'Phase 2 failed in native',
            failedStep: 1
          }
        }
      }
      throw new Error('unexpected method')
    }) as any

    const steps: EntityOperation[] = [circle(), circle()]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })

    expect(result.status).toBe('partial')
    expect(result.partial).toBe(true)
    expect(result.committedBatchIds).toEqual(['batch_p1'])
    expect(result.entityRefs).toHaveLength(1)
    expect(result.error?.message).toContain('Phase 2 failed in native')
    expect(result.error?.failedStep).toBe(1)
  })

  test('native requires_revalidation with prior commits preserves status and prior batches', async () => {
    const bridge = new MockBridgeClient()
    let call = 0
    bridge.request = (async (method: any): Promise<any> => {
      if (method === RpcMethod.OperationsApply) {
        call++
        if (call === 1) {
          return {
            status: 'committed',
            batchId: 'w1_batch',
            committedBatchIds: ['w1_batch'],
            entityRefs: [{ handle: '30', kind: 'circle', layer: '0' }]
          }
        }
        return {
          status: 'requires_revalidation',
          committedBatchIds: [],
          entityRefs: [],
          error: {
            code: BridgeErrorCode.DocumentNotFound,
            message: 'Document modified externally',
            failedStep: 0
          }
        }
      }
      throw new Error('unexpected method')
    }) as any

    const steps: EntityOperation[] = [
      circle('w1'),
      { op: 'transform', transform: { op: 'move', handles: ['@w1'], delta: { x: 1, y: 0, z: 0 } } }
    ]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })

    expect(result.status).toBe('requires_revalidation')
    expect(result.partial).toBe(true)
    expect(result.committedBatchIds).toEqual(['w1_batch'])
    expect(result.entityRefs).toHaveLength(1)
    expect(result.error?.message).toContain('Document modified externally')
  })

  test('unknown execution status fails closed as failed', async () => {
    const bridge = new MockBridgeClient()
    bridge.request = async (method) => {
      if (method === RpcMethod.OperationsApply) {
        return {
          status: 'something_unexpected' as any,
          entityRefs: [],
          error: { code: BridgeErrorCode.TransactionFailed, message: 'weird' }
        }
      }
      throw new Error('unexpected method')
    }

    const steps: EntityOperation[] = [circle()]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })

    expect(result.status).toBe('failed')
    expect(result.partial).toBe(false)
  })

  test('transport failure without prior commits reports outcome_unknown', async () => {
    const bridge = new MockBridgeClient()
    bridge.request = async (method) => {
      if (method === RpcMethod.OperationsApply) {
        throw new Error('Network timeout after dispatch')
      }
      throw new Error('unexpected method')
    }

    const steps: EntityOperation[] = [circle()]
    const result = await applyOperationsBatch(bridge, steps, { documentName: undefined })

    expect(result.status).toBe('outcome_unknown')
    expect(result.partial).toBe(false)
    expect(result.error?.message).toContain('Network timeout')
  })

  test('omitted view, progressive, and paceMs remain undefined on the wire', async () => {
    const spy = new SpyBridgeClient()
    const steps: EntityOperation[] = [circle()]
    await applyOperationsBatch(spy, steps, { documentName: undefined })

    expect(spy.applyCalls).toHaveLength(1)
    const callParams = spy.applyCalls[0]!
    expect(callParams.view).toBeUndefined()
    expect(callParams.progressive).toBeUndefined()
    expect(callParams.paceMs).toBeUndefined()
  })
})
