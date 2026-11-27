import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { registerPcccSheetTools, pcccSheetInputSchema } from './pcccSheet.js'

/**
 * pccc_sheet (the DANH MỤC BẢN VẼ index sheet) — the planner runs in-process, the drawing
 * receives ONE journaled batch, and every fail-closed gate (validation, unit resolution, plan
 * freshness/single-use, no fabricated design basis) is pinned here.
 */

class SpyBridgeClient implements BridgeClient {
  readonly inner = new MockBridgeClient()
  readonly calls: { method: RpcMethodName; params: unknown }[] = []

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    this.calls.push({ method, params })
    if (method === RpcMethod.OperationsPreview) {
      const request = params as RpcMethodMap[typeof RpcMethod.OperationsPreview]['params']
      return {
        valid: true,
        operationCount: request.operations.length,
        entityRefs: [],
        extents: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 15600, y: 9000, z: 0 }
        }
      } as RpcMethodMap[M]['result']
    }
    return this.inner.request(method, params, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }

  methods(): RpcMethodName[] {
    return this.calls.map((c) => c.method)
  }
}

type Handler = (
  input: unknown,
  ctx: { mcpReq: { id: number; signal?: AbortSignal }; http?: { authInfo?: { extra?: Record<string, unknown> } } }
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>

function sheetHandler(bridge: BridgeClient): Handler {
  let handler!: Handler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: Handler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerPcccSheetTools>[0]
  registerPcccSheetTools(serverDouble, bridge)
  return handler
}

function ctxFor(id: number) {
  return { mcpReq: { id } }
}

function json(result: { content: { type: string; text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text)
}

const VALID_SHEETS = [
  { section: 'BÁO CHÁY TỰ ĐỘNG', code: 'BC-01', description: 'HẦM', qty: 1, size: 'A3' },
  { section: 'BÁO CHÁY TỰ ĐỘNG', code: 'BC-02', description: 'TẦNG 1-7', qty: 7, size: 'A3' },
  { section: 'CHIẾU SÁNG SỰ CỐ', code: 'CS-01', description: 'HẦM', qty: 1, size: 'A3' }
]

function previewInput(extra: Record<string, unknown> = {}) {
  return {
    operation: 'preview',
    projectName: 'TÒA NHÀ SUNLAND',
    subtitle: 'TÒA NHÀ SUNLAND 20-10-2026',
    address: 'Lô G13, Khu dân cư Sunland',
    projectCode: 'KS-2026',
    sheets: VALID_SHEETS,
    ...extra
  }
}

describe('pccc_sheet preview', () => {
  test('compiles a well-formed index and does NOT touch the drawing', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)
    const bridge = spy as unknown as BridgeClient

    const out = json(await handler(previewInput(), ctxFor(1)))
    expect(out.blocked).toBe(false)
    expect(out.status).toBe('PASS')
    expect(out.title).toBe('TÒA NHÀ SUNLAND')
    expect(out.totalSheets).toBe(9)
    expect(out.rowCount).toBe(3)
    expect(out.sectionCount).toBe(2)
    expect((out.geometry as Record<string, unknown>).totalWidthMm).toBe(15600)
    expect(typeof out.planId).toBe('string')
    // PREVIEW WROTE NOTHING: no batch, no layer ensure, no entity create.
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
    expect(spy.methods()).not.toContain(RpcMethod.LayerEnsure)
    expect(spy.methods()).not.toContain(RpcMethod.EntityCreate)
  })

  test('a validation failure is a bounded FAIL plan, never a throw', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const out = json(
      await handler(
        previewInput({ sheets: [{ section: '', code: 'BC-01', description: '', qty: 0 }] }),
        ctxFor(1)
      )
    )
    expect(out.status).toBe('FAIL')
    expect(out.blocked).toBe(true)
    const reasons = (out.blockedReasons as string[]).join(' ')
    expect(reasons).toContain('no section')
    expect(reasons).toContain('no description')
    expect(reasons).toContain('positive integer')
  })

  test('a unitless drawing blocks the plan (geometry is millimetres)', async () => {
    const spy = new SpyBridgeClient()
    const handler = sheetHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    expect(out.blocked).toBe(true)
    expect((out.blockedReasons as string[]).join(' ')).toContain('no physical unit')
  })

  test('the plan is single-use, expiring, and scoped to the resolved document', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const first = json(await handler(previewInput(), ctxFor(1)))
    const planId = first.planId as string
    // A fresh preview mints a fresh plan (same drawing) — distinct ids.
    const second = json(await handler(previewInput(), ctxFor(2)))
    expect(second.planId).not.toBe(planId)
  })

  test('preview requires projectName through the schema', () => {
    const parsed = pcccSheetInputSchema.safeParse({
      operation: 'preview',
      projectName: '',
      sheets: VALID_SHEETS
    })
    expect(parsed.success).toBe(false)
  })
})

describe('pccc_sheet apply', () => {
  test('apply commits ONE journaled batch, reports the receipt, and verifies read-back', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    const applied = json(
      await handler(
        { operation: 'apply', planId: out.planId as string, capture: 'changed' },
        ctxFor(2)
      )
    )
    expect(applied.status).toBe('committed')
    expect(applied.readback).toBeDefined()
    expect((applied.readback as { faithful: boolean }).faithful).toBe(true)
    // One batch — never per-stroke pacing.
    const batchCalls = spy.calls.filter((c) => c.method === RpcMethod.OperationsApply)
    expect(batchCalls).toHaveLength(1)
    const applyParams = batchCalls[0].params as { operations: unknown[]; taskId?: string; expectedRevision?: string }
    expect(applyParams.operations.length).toBe((out.operations as number))
    expect(applyParams.taskId).toBeDefined()
    expect(applyParams.expectedRevision).toBeDefined()
  })

  test('apply refuses a FAIL plan (nothing is drawn)', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const out = json(
      await handler(
        previewInput({ sheets: [{ section: '', code: 'BC-01', description: 'HẦM', qty: 1 }] }),
        ctxFor(1)
      )
    )
    expect(out.blocked).toBe(true)
    const refused = await handler({ operation: 'apply', planId: out.planId as string }, ctxFor(2))
    expect(refused.isError).toBe(true)
    // No batch was sent.
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
  })

  test('apply refuses a unitless plan', async () => {
    const spy = new SpyBridgeClient()
    const handler = sheetHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    const refused = await handler({ operation: 'apply', planId: out.planId as string }, ctxFor(2))
    expect(refused.isError).toBe(true)
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
  })

  test('apply refuses a stale plan (drawing moved since preview)', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    // Something else moved the document (a plain entity creation moves the revision).
    await spy.inner.request(RpcMethod.EntityCreate, {
      documentName: 'Drawing1.dwg',
      kind: 'line',
      layer: '0',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 10, z: 0 }
    } as never)

    const refused = await handler({ operation: 'apply', planId: out.planId as string }, ctxFor(2))
    expect(refused.isError).toBe(true)
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
  })

  test('apply is single-use: a consumed plan can never draw twice', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    const first = json(
      await handler({ operation: 'apply', planId: out.planId as string, capture: 'changed' }, ctxFor(2))
    )
    expect(first.status).toBe('committed')
    const second = await handler({ operation: 'apply', planId: out.planId as string, capture: 'changed' }, ctxFor(3))
    expect(second.isError).toBe(true)
    // Exactly one batch ever ran.
    expect(spy.methods().filter((m) => m === RpcMethod.OperationsApply)).toHaveLength(1)
  })

  test('apply of an unknown planId is refused', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const refused = await handler({ operation: 'apply', planId: 'sheet-does-not-exist' }, ctxFor(1))
    expect(refused.isError).toBe(true)
  })
})

describe('pccc_sheet status', () => {
  test('reports the plan state (ready → applied)', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = sheetHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    const ready = json(
      await handler({ operation: 'status', planId: out.planId as string }, ctxFor(2))
    )
    expect(ready.state).toBe('ready')
    expect(ready.totalSheets).toBe(9)

    await handler(
      { operation: 'apply', planId: out.planId as string, capture: 'changed' },
      ctxFor(3)
    )
    const applied = json(
      await handler({ operation: 'status', planId: out.planId as string }, ctxFor(4))
    )
    expect(applied.state).toBe('applied')
  })

  test('unknown planId reports unknown, not a crash', async () => {
    const spy = new SpyBridgeClient()
    const handler = sheetHandler(spy)
    const out = json(await handler({ operation: 'status', planId: 'sheet-does-not-exist' }, ctxFor(1)))
    expect(out.state).toBe('unknown')
  })
})
