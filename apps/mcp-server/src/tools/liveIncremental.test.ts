import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, RpcMethod } from '@arcdio/cad-protocol'
import type { EntityOperation } from '@arcdio/cad-protocol'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { applyBatch } from './applyBatch.js'
import { applyOperationsBatch } from './refs.js'

const lineOp = (id?: string): EntityOperation => ({
  op: 'create',
  entity: {
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  },
  ...(id != null && { id })
})

describe('Live Incremental Engine & Settings Precedence (PR A)', () => {
  test('view.setLive preserves unspecified fields on partial updates', async () => {
    const bridge = new MockBridgeClient()
    const doc = 'Drawing1.dwg'

    // Step 1: Set progressive = true and paceMs = 35
    const r1 = await bridge.request(RpcMethod.ViewSetLive, {
      documentName: doc,
      progressive: true,
      paceMs: 35
    })
    expect(r1.progressive).toBe(true)
    expect(r1.paceMs).toBe(35)
    expect(r1.follow).toBe('off') // default preserved
    expect(r1.margin).toBe(0.25) // default preserved

    // Step 2: Partial update setting only follow = "pan"
    const r2 = await bridge.request(RpcMethod.ViewSetLive, {
      documentName: doc,
      follow: 'pan'
    })
    expect(r2.follow).toBe('pan')
    expect(r2.progressive).toBe(true) // preserved from step 1!
    expect(r2.paceMs).toBe(35) // preserved from step 1!

    // Step 3: Get confirms persisted settings
    const got = await bridge.request(RpcMethod.ViewGetLive, { documentName: doc })
    expect(got).toEqual(r2)
  })

  test('live settings remain isolated across different open documents', async () => {
    const bridge = new MockBridgeClient()
    const docA = 'Drawing1.dwg'
    const docB = 'Drawing2.dwg'

    await bridge.request(RpcMethod.ViewSetLive, {
      documentName: docA,
      progressive: true,
      paceMs: 50,
      follow: 'fit'
    })
    await bridge.request(RpcMethod.ViewSetLive, {
      documentName: docB,
      progressive: false,
      paceMs: 0,
      follow: 'off'
    })

    const settingsA = await bridge.request(RpcMethod.ViewGetLive, { documentName: docA })
    const settingsB = await bridge.request(RpcMethod.ViewGetLive, { documentName: docB })

    expect(settingsA.progressive).toBe(true)
    expect(settingsA.paceMs).toBe(50)
    expect(settingsA.follow).toBe('fit')

    expect(settingsB.progressive).toBe(false)
    expect(settingsB.paceMs).toBe(0)
    expect(settingsB.follow).toBe('off')
  })

  test('applyBatch propagates per-call options and returns structured batch result', async () => {
    const bridge = new MockBridgeClient()
    const doc = 'Drawing1.dwg'

    const { refs, payload } = await applyBatch(bridge, [lineOp('l1'), lineOp('l2')], {
      documentName: doc,
      ensureLayer: false,
      result: 'full',
      progressive: true,
      paceMs: 20,
      view: { follow: 'pan' },
      idempotencyKey: 'test-batch-1'
    })

    expect(refs).toHaveLength(2)
    expect(payload.status).toBe('committed')
    expect(payload.partial).toBe(false)
    expect(payload.committedBatchIds).toHaveLength(1)
    expect(payload.completedPhases).toBe(1)
    // The commit is in the open drawing, not on disk: the tool result has to say so.
    expect(payload.savedToFile).toBe(false)
    expect(payload.saveHint).toContain('drawing → save')
  })

  test('multi-wave failure returns truthful partial commit information', async () => {
    const bridge = new MockBridgeClient()
    let callCount = 0
    const originalRequest = bridge.request.bind(bridge)

    bridge.request = async (method, params, opts) => {
      if (method === RpcMethod.OperationsApply) {
        callCount++
        if (callCount === 2) {
          // Force wave 2 failure
          return {
            status: 'aborted',
            entityRefs: [],
            error: {
              code: BridgeErrorCode.TransactionFailed,
              message: 'Object lock conflict in wave 2',
              failedStep: 0
            }
          }
        }
      }
      return originalRequest(method, params, opts)
    }

    const steps: EntityOperation[] = [
      lineOp('first'),
      {
        op: 'transform',
        transform: { op: 'move', handles: ['@first'], delta: { x: 5, y: 0, z: 0 } }
      }
    ]

    const result = await applyOperationsBatch(bridge, steps, {
      documentName: undefined,
      idempotencyKey: 'multi-wave-task'
    })

    expect(result.status).toBe('partial')
    expect(result.partial).toBe(true)
    expect(result.completedPhases).toBe(1)
    expect(result.totalPhases).toBe(2)
    expect(result.committedBatchIds).toHaveLength(1)
    expect(result.entityRefs).toHaveLength(1)
    expect(result.error?.failedStep).toBe(1)
    expect(result.error?.message).toContain('Object lock conflict in wave 2')
  })

  test('cancellation after first wave reports cancelled with partial: true', async () => {
    const bridge = new MockBridgeClient()
    const controller = new AbortController()
    let callCount = 0
    const originalRequest = bridge.request.bind(bridge)

    bridge.request = async (method, params, opts) => {
      if (method === RpcMethod.OperationsApply) {
        callCount++
        if (callCount === 1) {
          const res = await originalRequest(method, params, opts)
          controller.abort()
          return res
        }
      }
      return originalRequest(method, params, opts)
    }

    const steps: EntityOperation[] = [
      lineOp('first'),
      {
        op: 'transform',
        transform: { op: 'move', handles: ['@first'], delta: { x: 10, y: 0, z: 0 } }
      }
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
})
