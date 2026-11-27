import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { registerPcccBoqTools, pcccBoqInputSchema } from './pcccBoq.js'

/**
 * pccc_boq (the THỐNG KÊ VẬT TƯ material statistics sheet) — the planner runs in-process, the
 * drawing receives ONE journaled batch, and every fail-closed gate (validation, unit resolution,
 * plan freshness/single-use, no fabricated design basis) is pinned here.
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
          max: { x: 19500, y: 7000, z: 0 }
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
  ctx: { mcpReq: { id: number; signal?: AbortSignal } }
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>

function boqHandler(bridge: BridgeClient): Handler {
  let handler!: Handler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: Handler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerPcccBoqTools>[0]
  registerPcccBoqTools(serverDouble, bridge)
  return handler
}

function ctxFor(id: number) {
  return { mcpReq: { id } }
}

function json(result: { content: { type: string; text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text)
}

const FLOORS = ['Hầm', 'T1', 'T2', 'Tum']

const VALID_SECTIONS = [
  {
    section: 'I — HỆ THỐNG BÁO CHÁY',
    rows: [
      { name: 'Trung tâm báo cháy', unit: 'Tủ', qty: { Hầm: 1, T1: 0, T2: 0, Tum: 0 } },
      { name: 'Chuông đèn báo cháy', unit: 'Cái', qty: { Hầm: 2, T1: 2, T2: 2, Tum: 1 } }
    ]
  }
]

function previewInput(extra: Record<string, unknown> = {}) {
  return {
    operation: 'preview',
    projectName: 'TÒA NHÀ SUNLAND',
    subtitle: 'TÒA NHÀ SUNLAND 20-10-2026',
    floors: FLOORS,
    sections: VALID_SECTIONS,
    ...extra
  }
}

describe('pccc_boq preview', () => {
  test('compiles a well-formed BoQ and does NOT touch the drawing', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = boqHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    expect(out.blocked).toBe(false)
    expect(out.status).toBe('PASS')
    expect(out.title).toBe('TÒA NHÀ SUNLAND')
    expect(out.floors).toEqual(FLOORS)
    expect(out.rowCount).toBe(2)
    expect((out.geometry as Record<string, unknown>).totalWidthMm).toBe(800 + 5600 + 900 + FLOORS.length * 1100 + 1300)
    expect(typeof out.planId).toBe('string')
    // PREVIEW WROTE NOTHING.
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
    expect(spy.methods()).not.toContain(RpcMethod.LayerEnsure)
  })

  test('a validation failure is a bounded FAIL plan, never a throw', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = boqHandler(spy)

    const out = json(
      await handler(
        previewInput({
          sections: [{ section: '', rows: [{ name: '', unit: '', qty: { Hầm: 1 } }] }]
        }),
        ctxFor(1)
      )
    )
    expect(out.status).toBe('FAIL')
    expect(out.blocked).toBe(true)
    const reasons = (out.blockedReasons as string[]).join(' ')
    expect(reasons).toContain('no title')
    expect(reasons).toContain('no name')
    expect(reasons).toContain('no unit')
    expect(reasons).toContain('missing qty for floor "T1"')
  })

  test('a unitless drawing blocks the plan', async () => {
    const spy = new SpyBridgeClient()
    const handler = boqHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    expect(out.blocked).toBe(true)
    expect((out.blockedReasons as string[]).join(' ')).toContain('no physical unit')
  })

  test('preview requires projectName + floors + sections through the schema', () => {
    const missing = pcccBoqInputSchema.safeParse({
      operation: 'preview',
      projectName: 'P',
      sections: VALID_SECTIONS
    })
    expect(missing.success).toBe(false)
    const noSections = pcccBoqInputSchema.safeParse({
      operation: 'preview',
      projectName: 'P',
      floors: FLOORS,
      sections: []
    })
    expect(noSections.success).toBe(false)
  })
})

describe('pccc_boq apply', () => {
  test('apply commits ONE journaled batch, reports the receipt, and verifies read-back', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = boqHandler(spy)

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
    const batchCalls = spy.calls.filter((c) => c.method === RpcMethod.OperationsApply)
    expect(batchCalls).toHaveLength(1)
  })

  test('apply refuses a FAIL plan (nothing is drawn)', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = boqHandler(spy)

    const out = json(
      await handler(
        previewInput({ sections: [{ section: '', rows: [{ name: 'X', unit: 'Cái', qty: { Hầm: 1, T1: 1, T2: 1, Tum: 1 } }] }] }),
        ctxFor(1)
      )
    )
    expect(out.blocked).toBe(true)
    const refused = await handler({ operation: 'apply', planId: out.planId as string }, ctxFor(2))
    expect(refused.isError).toBe(true)
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
  })

  test('apply is single-use: a consumed plan can never draw twice', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = boqHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    const first = json(
      await handler({ operation: 'apply', planId: out.planId as string, capture: 'changed' }, ctxFor(2))
    )
    expect(first.status).toBe('committed')
    const second = await handler({ operation: 'apply', planId: out.planId as string, capture: 'changed' }, ctxFor(3))
    expect(second.isError).toBe(true)
    expect(spy.methods().filter((m) => m === RpcMethod.OperationsApply)).toHaveLength(1)
  })
})

describe('pccc_boq status', () => {
  test('reports the plan state', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = boqHandler(spy)

    const out = json(await handler(previewInput(), ctxFor(1)))
    const status = json(
      await handler({ operation: 'status', planId: out.planId as string }, ctxFor(2))
    )
    expect(status.state).toBe('ready')
    expect(status.rowCount).toBe(2)

    await handler({ operation: 'apply', planId: out.planId as string, capture: 'changed' }, ctxFor(3))
    const applied = json(
      await handler({ operation: 'status', planId: out.planId as string }, ctxFor(4))
    )
    expect(applied.state).toBe('applied')
  })

  test('unknown planId reports unknown, not a crash', async () => {
    const spy = new SpyBridgeClient()
    const handler = boqHandler(spy)
    const out = json(await handler({ operation: 'status', planId: 'boq-does-not-exist' }, ctxFor(1)))
    expect(out.state).toBe('unknown')
  })
})
