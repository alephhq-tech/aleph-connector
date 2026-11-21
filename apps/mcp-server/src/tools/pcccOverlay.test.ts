import { describe, expect, test } from 'bun:test'
import { db } from '@aleph-connector/data'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { registerPcccOverlayTools, pcccOverlayInputSchema } from './pcccOverlay.js'
import { roomRef } from './floorplanCadState.js'

/**
 * Task-level PCCC overlay executor (Epic #413 §11.3/§13.3): the planners run in-process, the
 * drawing receives ONE machine batch, and every fail-closed gate (approved symbol present,
 * geometry verdict, plan freshness/single-use, no fabricated design basis) is pinned here.
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
          min: { x: 9.08, y: 99339.6, z: 0 },
          max: { x: 32529.21, y: 122878, z: 0 }
        }
      } as RpcMethodMap[M]['result']
    }
    return this.inner.request(method, params, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }

  applyCalls(): RpcMethodMap[typeof RpcMethod.OperationsApply]['params'][] {
    return this.calls
      .filter((c) => c.method === RpcMethod.OperationsApply)
      .map((c) => c.params as RpcMethodMap[typeof RpcMethod.OperationsApply]['params'])
  }

  methods(): RpcMethodName[] {
    return this.calls.map((c) => c.method)
  }
}

type Handler = (
  input: unknown,
  ctx: {
    mcpReq: { id: number; signal?: AbortSignal }
    http?: { authInfo?: { extra?: Record<string, unknown> } }
  }
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>

/** #413 §14 B/C: catalog resolution is workspace-scoped from the authenticated caller. */
function ctxFor(workspaceId: string, id: number) {
  return { mcpReq: { id }, http: { authInfo: { extra: { workspaceId } } } }
}

function overlayHandler(
  bridge: BridgeClient,
  cadState?: Parameters<typeof registerPcccOverlayTools>[2]
): Handler {
  let handler!: Handler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: Handler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerPcccOverlayTools>[0]
  registerPcccOverlayTools(serverDouble, bridge, cadState)
  return handler
}

test('refuses roomBoundary without acceptCallerGeometry', async () => {
  const bridge = new SpyBridgeClient()
  await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
  const handler = overlayHandler(bridge as unknown as BridgeClient)
  const { acceptCallerGeometry: _drop, ...withoutAccept } = previewInput()
  const out = JSON.parse(
    (
      await handler(withoutAccept, ctxFor('ws-caller-gate', 1))
    ).content.find((c) => c.type === 'text')!.text
  ) as { status: string; blockedReasons: string[] }
  expect(out.status).toBe('BLOCKED')
  expect(out.blockedReasons.join(' ')).toContain('CALLER_GEOMETRY_REQUIRES_ACCEPT')
})

async function seedSymbol(bridge: BridgeClient, blockName: string): Promise<void> {
  await bridge.request(RpcMethod.EntityCreate, {
    kind: 'blockReference',
    blockName,
    position: { x: 1, y: 1, z: 0 }
  })
  // The probe reference must not count toward the overlay's entity totals.
  await bridge.request(RpcMethod.EntityErase, {
    handles: [(await bridge.request(RpcMethod.EntityList, { layer: '0' })).entities.at(-1)!.handle]
  })
}

// Every preview names a plan and must land inside it: the mock's inspect attributes the basement
// frame at [9.08, 99339.6, 32529.21, 122878]. ROOM keeps its 12000x8000 footprint (the pinned head
// count depends on it), translated onto that sheet.
const ROOM: Array<[number, number]> = [
  [10000, 100000],
  [22000, 100000],
  [22000, 108000],
  [10000, 108000]
]

function previewInput(extra: Record<string, unknown> = {}) {
  return {
    operation: 'preview',
    floorplanName: 'MẶT BẰNG TẦNG HẦM',
    roomBoundary: ROOM,
    acceptCallerGeometry: true as const,
    hazardGroup: 'Group 1',
    riserLocation: [10000, 104000],
    sprinklerSymbol: 'fire_sprinkler_pendant',
    ...extra
  }
}

let catalogSeq = 0
/** Seed a catalog entry for the workspace (approved unless overridden). */
async function seedCatalogEntry(
  workspaceId: string,
  overrides: Partial<import('@aleph-connector/data').CadSymbolCatalogItem> = {}
): Promise<void> {
  const now = Date.now()
  await db.cadSymbolCatalog.insert({
    id: `cadsym_${workspaceId}_${++catalogSeq}_${now}`,
    workspaceId,
    key: 'fire_sprinkler_pendant',
    category: 'sprinkler',
    blockName: 'SPRK_HEAD',
    libraryPath: 'C:\\libs\\pccc_symbols.dwg',
    libraryHandle: '2A',
    status: 'approved',
    createdAt: now,
    updatedAt: now,
    ...overrides
  })
}

function json(res: Awaited<ReturnType<Handler>>): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>
}

describe('pccc_overlay executor', () => {
  test('preview plans the whole overlay in-process and reports bounded counts, not coordinates', async () => {
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRK_HEAD')
    await seedCatalogEntry('ws-1')
    const handler = overlayHandler(bridge)

    const out = json(await handler(previewInput(), ctxFor('ws-1', 1)))
    expect(out.status).toBe('ready')
    expect(out.headCount).toBe(12)
    expect(out.pipeSegmentCount).toBe(4)
    expect(out.totalOperations).toBe(16)
    // Geometry verdicts travel verbatim: the unverified TCVN rule stays INSUFFICIENT_DATA and
    // connectivity is independently PASS — never promoted to "compliant".
    const findings = out.findings as Array<{ checkId: string; status: string }>
    expect(findings.find((f) => f.checkId === 'CHK_PIPE_CONNECTIVITY')?.status).toBe('PASS')
    expect(findings.find((f) => f.checkId === 'CHK_SPRINKLER_SPACING')?.status).toBe(
      'INSUFFICIENT_DATA'
    )
    expect(out.overallVerification).toBe('INSUFFICIENT_DATA')
    // No drawing happened during preview.
    expect(bridge.applyCalls()).toHaveLength(0)
  })

  test('blocks a plan when AutoCAD extents cross the frame despite an inside block anchor', async () => {
    class EscapingFootprintBridge extends SpyBridgeClient {
      override async request<M extends RpcMethodName>(
        method: M,
        params: RpcMethodMap[M]['params'],
        options?: BridgeRequestOptions
      ): Promise<RpcMethodMap[M]['result']> {
        if (method !== RpcMethod.OperationsPreview) return super.request(method, params, options)
        this.calls.push({ method, params })
        const request = params as RpcMethodMap[typeof RpcMethod.OperationsPreview]['params']
        return {
          valid: true,
          operationCount: request.operations.length,
          entityRefs: [],
          extents: {
            min: { x: 10000, y: 100000, z: 0 },
            max: { x: 32530.21, y: 108000, z: 0 }
          }
        } as RpcMethodMap[M]['result']
      }
    }
    const bridge = new EscapingFootprintBridge()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'fire_sprinkler_pendant')
    const out = json(await overlayHandler(bridge)(previewInput(), { mcpReq: { id: 9 } }))
    const blockedReasons = out.blockedReasons as string[]
    const preview = bridge.calls.find((call) => call.method === RpcMethod.OperationsPreview)
    const previewParams =
      preview?.params as RpcMethodMap[typeof RpcMethod.OperationsPreview]['params']

    expect(out.status).toBe('BLOCKED')
    expect(
      blockedReasons.some((reason) => reason.startsWith('BLOCK_FOOTPRINT_OUTSIDE_FLOORPLAN'))
    ).toBe(true)
    expect(
      previewParams.operations.some(
        (operation) => operation.op === 'create' && operation.entity.kind === 'blockReference'
      )
    ).toBe(true)
    expect(bridge.applyCalls()).toHaveLength(0)
  })

  test('apply draws the plan as ONE batch with progressive:false and paceMs:0 (§13.2)', async () => {
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRK_HEAD')
    await seedCatalogEntry('ws-1')
    const handler = overlayHandler(bridge)

    const plan = json(await handler(previewInput(), ctxFor('ws-1', 1)))
    const applied = json(
      await handler(
        { operation: 'apply', planId: plan.planId, result: 'summary' },
        ctxFor('ws-1', 2)
      )
    )
    expect(applied.status).toBe('committed')

    const applies = bridge.applyCalls()
    expect(applies).toHaveLength(1)
    expect(applies[0]!.operations).toHaveLength(16)
    expect(applies[0]!.progressive).toBe(false)
    expect(applies[0]!.paceMs).toBe(0)
    // The TS staleness refusal is only one round trip; the captured revision must also ride the
    // wire so the plugin re-checks it atomically just before its transaction opens (#413 phase A).
    expect(typeof plan.revision).toBe('string')
    expect(applies[0]!.expectedRevision).toBe(plan.revision as string)
  })

  test('apply sends every head as a blockReference of the APPROVED symbol, pipes as lines', async () => {
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRK_HEAD')
    await seedCatalogEntry('ws-1')
    const handler = overlayHandler(bridge)

    const plan = json(await handler(previewInput(), ctxFor('ws-1', 1)))
    await handler({ operation: 'apply', planId: plan.planId }, ctxFor('ws-1', 2))

    const ops = bridge.applyCalls()[0]!.operations as Array<Record<string, unknown>>
    const refs = ops.filter((o) => (o.entity as { kind?: string }).kind === 'blockReference')
    const lines = ops.filter((o) => (o.entity as { kind?: string }).kind === 'line')
    expect(refs).toHaveLength(12)
    expect(lines).toHaveLength(4)
    for (const r of refs) {
      expect((r.entity as { blockName: string }).blockName).toBe('SPRK_HEAD')
    }
  })

  test('a missing symbol block fails closed and lists candidates instead of drawing primitives', async () => {
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRK_HEAD')
    // No catalog entry seeded at all: preview must block with the catalog-naming message.
    const handler = overlayHandler(bridge)

    const out = json(await handler(previewInput(), ctxFor('ws-nocat', 1)))
    expect(out.status).toBe('BLOCKED')
    const reasons = out.blockedReasons as string[]
    expect(reasons[0]).toContain('No APPROVED symbol-catalog entry "fire_sprinkler_pendant"')
    expect(reasons[0]).toContain('SPRK_HEAD')

    const blocked = await handler({ operation: 'apply', planId: out.planId }, ctxFor('ws-nocat', 2))
    expect(blocked.isError).toBe(true)
    expect(bridge.applyCalls()).toHaveLength(0)
  })

  test('a block already in the drawing plans without a catalog entry, flagged drafting-only', async () => {
    // report §5 item 9: a hard BLOCKED on a missing catalog row stopped nothing (the model just drew
    // the same 141 entities by hand) while blocking honest use of the user's own block. Library
    // imports still fail closed; a name matching no block still blocks.
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRINKLER_HEAD')
    const handler = overlayHandler(bridge)

    const out = json(
      await handler(previewInput({ sprinklerSymbol: 'SPRINKLER_HEAD' }), ctxFor('ws-plain', 1))
    )
    expect(out.status).toBe('ready')
    expect(out.draftingOnly).toBe(true)
    expect(out.draftingOnlyNote as string).toContain('SPRINKLER_HEAD')

    const applied = json(
      await handler(
        { operation: 'apply', planId: out.planId, result: 'summary' },
        ctxFor('ws-plain', 2)
      )
    )
    expect(applied.status).toBe('committed')
    const ops = bridge.applyCalls()[0]!.operations as Array<Record<string, unknown>>
    const refs = ops.filter((o) => (o.entity as { kind?: string }).kind === 'blockReference')
    for (const r of refs)
      expect((r.entity as { blockName: string }).blockName).toBe('SPRINKLER_HEAD')
  })

  test('an applied plan cannot draw twice', async () => {
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRK_HEAD')
    await seedCatalogEntry('ws-1')
    const handler = overlayHandler(bridge)

    const plan = json(await handler(previewInput(), ctxFor('ws-1', 1)))
    await handler({ operation: 'apply', planId: plan.planId }, ctxFor('ws-1', 2))
    const second = await handler({ operation: 'apply', planId: plan.planId }, ctxFor('ws-1', 3))
    expect(second.isError).toBe(true)
    expect(second.content[0]!.text).toContain('already applied')
    expect(bridge.applyCalls()).toHaveLength(1)
  })

  test('a stale plan is refused when the drawing revision moved after preview', async () => {
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRK_HEAD')
    await seedCatalogEntry('ws-1')
    const handler = overlayHandler(bridge)

    const plan = json(await handler(previewInput(), ctxFor('ws-1', 1)))
    // Someone (user or another run) mutates the drawing between preview and apply.
    await bridge.inner.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 5, y: 5, z: 0 }
    })

    const stale = await handler({ operation: 'apply', planId: plan.planId }, ctxFor('ws-1', 2))
    expect(stale.isError).toBe(true)
    expect(stale.content[0]!.text).toContain('changed since preview')
    expect(bridge.applyCalls()).toHaveLength(0)
  })

  test('status reports plan state and the apply receipt', async () => {
    const bridge = new SpyBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedSymbol(bridge.inner, 'SPRK_HEAD')
    await seedCatalogEntry('ws-1')
    const handler = overlayHandler(bridge)

    const plan = json(await handler(previewInput(), ctxFor('ws-1', 1)))
    expect(
      json(await handler({ operation: 'status', planId: plan.planId }, ctxFor('ws-1', 2))).state
    ).toBe('ready')
    await handler({ operation: 'apply', planId: plan.planId }, ctxFor('ws-1', 3))
    const after = json(
      await handler({ operation: 'status', planId: plan.planId }, ctxFor('ws-1', 4))
    )
    expect(after.state).toBe('applied')
    expect((after.lastApplyReceipt as { status: string }).status).toBe('committed')
  })

  test('the schema never defaults the design basis: hazardGroup, riserLocation and the symbol key are required (§11.2)', () => {
    const withoutBasis = { ...previewInput() } as Record<string, unknown>
    delete withoutBasis.hazardGroup
    expect(pcccOverlayInputSchema.safeParse(withoutBasis).success).toBe(false)
    const withoutRiser = { ...previewInput() } as Record<string, unknown>
    delete withoutRiser.riserLocation
    expect(pcccOverlayInputSchema.safeParse(withoutRiser).success).toBe(false)
    const withoutSymbol = { ...previewInput() } as Record<string, unknown>
    delete withoutSymbol.sprinklerSymbol
    expect(pcccOverlayInputSchema.safeParse(withoutSymbol).success).toBe(false)
  })

  // #413 §14 roadmap B/C: an approved catalog entry makes pccc_overlay IMPORT the missing
  // symbol itself (drawing open → entity copy_to → close) instead of blocking on manual import.
  describe('symbol-catalog auto-import', () => {
    /**
     * Library DWG fixture: open it, activate it so `entity.create` lands there (creating a
     * reference auto-defines the block in the mock), plant the probe, then hand the target tab
     * back as the active document. The library stays OPEN here. Preview and apply each open the
     * same path separately; the mock parks a closed path's state so the reopen reads it back,
     * which is what real AutoCAD does with a saved DWG.
     */
    async function seedLibraryDoc(
      bridge: BridgeClient,
      path: string,
      blockName: string
    ): Promise<string> {
      const opened = await bridge.request(RpcMethod.DrawingOpen, { path, readOnly: true })
      await bridge.request(RpcMethod.DrawingActivate, { documentName: opened.name })
      const created = await bridge.request(RpcMethod.EntityCreate, {
        kind: 'blockReference',
        blockName,
        position: { x: 0, y: 0, z: 0 }
      })
      await bridge.request(RpcMethod.DrawingActivate, { documentName: 'Drawing1.dwg' })
      return created.entity.handle
    }

    test('approved entry + missing block: preview proves the library, apply imports then draws', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      const handle = await seedLibraryDoc(bridge, 'C:\\libs\\pccc_symbols.dwg', 'SPRK_HEAD')
      // Target starts WITHOUT the block.
      const listBefore = await bridge.request(RpcMethod.BlockList, {})
      expect(listBefore.blocks.map((b) => b.name)).not.toContain('SPRK_HEAD')

      await seedCatalogEntry('ws-auto', { libraryHandle: handle })
      const handler = overlayHandler(bridge)

      const out = json(await handler(previewInput(), ctxFor('ws-auto', 1)))
      expect(out.status).toBe('ready')
      expect(out.importAtApply).toEqual(['SPRK_HEAD'])

      // PREVIEW WROTE NOTHING: it probed the library (block.inspect) and closed the tab; the
      // target gained no definition and no entity.
      const previewMethods = bridge.methods()
      expect(previewMethods).not.toContain(RpcMethod.EntityCopyTo)
      expect(
        (await bridge.request(RpcMethod.BlockList, {})).blocks.map((b) => b.name)
      ).not.toContain('SPRK_HEAD')

      // The import happens at apply: open(readOnly) → copyTo (unjournaled) → erase sample → close.
      const plan = json(
        await handler(
          { operation: 'apply', planId: out.planId, result: 'summary' },
          ctxFor('ws-auto', 2)
        )
      )
      expect(plan.status).toBe('committed')
      expect(plan.importedFromLibrary).toEqual(['SPRK_HEAD'])
      expect(bridge.applyCalls()).toHaveLength(1)

      const methods = bridge.methods()
      const copyAt = methods.lastIndexOf(RpcMethod.EntityCopyTo)
      const openAt = methods.lastIndexOf(RpcMethod.DrawingOpen)
      const closeAt = methods.indexOf(RpcMethod.DrawingClose, copyAt)
      expect(copyAt).toBeGreaterThan(openAt)
      expect(closeAt).toBeGreaterThan(copyAt)
      const copy = bridge.calls[copyAt]!
        .params as RpcMethodMap[typeof RpcMethod.EntityCopyTo]['params']
      expect(copy.documentName).toBe('pccc_symbols.dwg')
      expect(copy.targetDocumentName).toBe('Drawing1.dwg')
      // The import is NOT journaled: its sample instance is erased right away, and a ledger
      // receipt naming an already-erased handle makes operations.revert(taskId) refuse the whole
      // overlay with RevertConflict. Only the drawn batch carries the task id (#413 §11.5).
      expect(copy.taskId).toBeUndefined()
      expect(bridge.applyCalls()[0]!.taskId).toBe('2')
      // The sample instance that carried the definition was erased: the drawing holds exactly the
      // planned heads, not one extra symbol at the library's coordinates.
      const placed = await bridge.request(RpcMethod.EntityList, {
        documentName: 'Drawing1.dwg',
        kind: 'blockReference',
        limit: 500
      })
      const plannedHeads = out.headCount as number
      expect(placed.total).toBe(plannedHeads)
      // Reverting the apply's task rolls the overlay back cleanly.
      const reverted = await bridge.request(RpcMethod.OperationsRevert, {
        documentName: 'Drawing1.dwg',
        taskId: '2'
      })
      expect(reverted.status).toBe('reverted')
    })

    test('a catalog handle pointing at the wrong block is refused and never imported', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      const handle = await seedLibraryDoc(bridge, 'C:\\libs\\pccc_symbols.dwg', 'OTHER_BLOCK')
      // The entry names SPRK_HEAD but its stored handle references a different block.
      await seedCatalogEntry('ws-wrong', { libraryHandle: handle })
      const handler = overlayHandler(bridge)

      const out = json(await handler(previewInput(), ctxFor('ws-wrong', 1)))
      expect(out.status).toBe('BLOCKED')
      const reasons = out.blockedReasons as string[]
      expect(reasons.some((r) => r.includes('OTHER_BLOCK') && r.includes('SPRK_HEAD'))).toBe(true)
      expect(bridge.methods()).not.toContain(RpcMethod.EntityCopyTo)
    })

    test('a DRAFT catalog entry is never auto-imported — blocked with a clear reason', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      await seedLibraryDoc(bridge, 'C:\\libs\\pccc_symbols.dwg', 'SPRK_HEAD')
      await seedCatalogEntry('ws-draft', { status: 'draft' })
      const handler = overlayHandler(bridge)

      const out = json(await handler(previewInput(), ctxFor('ws-draft', 1)))
      expect(out.status).toBe('BLOCKED')
      expect((out.blockedReasons as string[])[0]).toContain(
        'No APPROVED symbol-catalog entry "fire_sprinkler_pendant"'
      )
      // No import attempt at all: copy_to was never dialed.
      expect(bridge.methods()).not.toContain(RpcMethod.EntityCopyTo)
    })

    test('a bad libraryPath blocks with the catalog entry named — the tool never crashes', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      await seedCatalogEntry('ws-badpath', { libraryPath: 'C:\\libs\\does_not_exist.dwg' })
      const handler = overlayHandler(bridge)

      const out = json(await handler(previewInput(), ctxFor('ws-badpath', 1)))
      expect(out.status).toBe('BLOCKED')
      const reasons = out.blockedReasons as string[]
      expect(
        reasons.some(
          (r) => r.includes('could not be read from') && r.includes('does_not_exist.dwg')
        )
      ).toBe(true)
      expect(bridge.applyCalls()).toHaveLength(0)
    })

    test('a wrong libraryHandle blocks with the entry named — the library tab is still closed', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      await seedLibraryDoc(bridge, 'C:\\libs\\pccc_symbols.dwg', 'SPRK_HEAD')
      await seedCatalogEntry('ws-badhandle', { libraryHandle: 'DEAD' })
      const handler = overlayHandler(bridge)

      const out = json(await handler(previewInput(), ctxFor('ws-badhandle', 1)))
      expect(out.status).toBe('BLOCKED')
      const reasons = out.blockedReasons as string[]
      expect(reasons.some((r) => r.includes('could not be read from') && r.includes('DEAD'))).toBe(
        true
      )
      // finally-closed: the library tab did not leak open.
      const open = await bridge.request(RpcMethod.DrawingListOpen, {})
      expect(open.documents.map((d) => d.name)).not.toContain('pccc_symbols.dwg')
    })

    test('preview with an excludedBoundary that the pipe network crosses returns status BLOCKED with pipe finding in blockedReasons', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      await seedSymbol(bridge.inner, 'SPRK_HEAD')
      await seedCatalogEntry('ws-1')
      const handler = overlayHandler(bridge)

      const excludedServerRoom: Array<[number, number]> = [
        [12000, 103500],
        [14000, 103500],
        [14000, 104500],
        [12000, 104500]
      ]

      const out = json(
        await handler(previewInput({ excludedBoundaries: [excludedServerRoom] }), ctxFor('ws-1', 1))
      )

      expect(out.status).toBe('BLOCKED')
      const reasons = out.blockedReasons as string[]
      expect(
        reasons.some(
          (r) => r.includes('CHK_PIPE_EXCLUDED_ZONES') || r.includes('PIPE_CROSSES_EXCLUDED_ZONE')
        )
      ).toBe(true)
    })

    test('E8: unknown drawing units block preview with UNKNOWN_DRAWING_UNITS, never assumed mm', async () => {
      const bridge = new SpyBridgeClient()
      // Deliberately NO DrawingSetup: the mock defaults to insUnits 'unitless'.
      await seedSymbol(bridge.inner, 'SPRK_HEAD')
      await seedCatalogEntry('ws-1')
      const handler = overlayHandler(bridge)

      const out = json(await handler(previewInput(), ctxFor('ws-1', 1)))
      expect(out.status).toBe('INSUFFICIENT_DATA')
      expect((out.violations as string[]).join(' ')).toContain('UNKNOWN_DRAWING_UNITS')
      expect(bridge.applyCalls()).toHaveLength(0)
    })

    test('E8: a 12x8 m room measures the same 96 m2 and 12 heads as the 12000x8000 mm room', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'm' })
      await seedSymbol(bridge.inner, 'SPRK_HEAD')
      await seedCatalogEntry('ws-1')
      const handler = overlayHandler(bridge)

      const metreRoom: Array<[number, number]> = [
        [10000, 100000],
        [10012, 100000],
        [10012, 100008],
        [10000, 100008]
      ]
      const out = json(
        await handler(
          previewInput({ roomBoundary: metreRoom, riserLocation: [10000, 100004] }),
          ctxFor('ws-1', 1)
        )
      )
      expect(out.status).toBe('ready')
      expect(out.headCount).toBe(12)
      expect(out.protectedAreaM2).toBe(96)
      expect(out.totalOperations).toBe(16)
    })

    test('verify after apply: a faithful batch reports readback matched == total steps', async () => {
      const bridge = new SpyBridgeClient()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      await seedSymbol(bridge.inner, 'SPRK_HEAD')
      await seedCatalogEntry('ws-1')
      const handler = overlayHandler(bridge)

      const plan = json(await handler(previewInput(), ctxFor('ws-1', 1)))
      const applied = json(
        await handler({ operation: 'apply', planId: plan.planId }, ctxFor('ws-1', 2))
      )
      expect(applied.status).toBe('committed')
      const readback = applied.readback as {
        faithful: boolean
        matchedSteps: number
        totalSteps: number
      }
      expect(readback.faithful).toBe(true)
      expect(readback.totalSteps).toBe(16)
      expect(readback.matchedSteps).toBe(16)
    })

    test('verify after apply: an aborted batch is an error, never committed', async () => {
      class AbortingBridge extends SpyBridgeClient {
        override async request<M extends RpcMethodName>(
          method: M,
          params: RpcMethodMap[M]['params'],
          options?: BridgeRequestOptions
        ): Promise<RpcMethodMap[M]['result']> {
          if (method === RpcMethod.OperationsApply) {
            return {
              status: 'aborted',
              entityRefs: [],
              error: { code: 1, message: 'simulated plugin failure' }
            } as unknown as RpcMethodMap[M]['result']
          }
          return super.request(method, params, options)
        }
      }
      const bridge = new AbortingBridge()
      await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
      await seedSymbol(bridge.inner, 'SPRK_HEAD')
      await seedCatalogEntry('ws-1')
      const handler = overlayHandler(bridge)

      const plan = json(await handler(previewInput(), ctxFor('ws-1', 1)))
      const applied = await handler({ operation: 'apply', planId: plan.planId }, ctxFor('ws-1', 2))
      expect(applied.isError).toBe(true)
      expect(applied.content[0]!.text).toContain('was not committed')
      expect(applied.content[0]!.text).toContain('aborted')
    })
  })

  /**
   * The room the grid fills has to come from the sheet, not from coordinates the caller typed —
   * the same posture `pccc_fire_alarm_overlay` takes, implemented in the one shared region module.
   */
  describe('room geometry from the drawing', () => {
    // Naming the sheet keeps the handle, the preview and the read-back on one tab.
    const TARGET_DOC = 'Drawing1.dwg'

    // A closed 5500x10000 ring containing the GARA label [10000, 105000] the mock reports, and well
    // under 85% of the frame — a room, not the sheet border.
    const GARAGE_RING = {
      closed: true,
      vertices: [
        { point: { x: 9500, y: 100000 } },
        { point: { x: 15000, y: 100000 } },
        { point: { x: 15000, y: 110000 } },
        { point: { x: 9500, y: 110000 } }
      ]
    }

    // A 2000x2000 ring inside the garage ring, containing the meter-room label [13000, 105000].
    const METER_RING = {
      closed: true,
      vertices: [
        { point: { x: 12000, y: 104000 } },
        { point: { x: 14000, y: 104000 } },
        { point: { x: 14000, y: 106000 } },
        { point: { x: 12000, y: 106000 } }
      ]
    }

    type CadState = Parameters<typeof registerPcccOverlayTools>[2]
    function ringSource(overrides: Partial<NonNullable<CadState>> = {}): NonNullable<CadState> {
      return {
        async snapshotFor() {
          return { snapshotId: 'snap_1', fresh: true }
        },
        async rowsInWindow() {
          return [{ handle: 'A1', kind: 'polyline', geometry: GARAGE_RING }]
        },
        async hydrate() {
          return []
        },
        ...overrides
      }
    }

    /**
     * The mock's inspect omits `regionBasis`, which the plugin always sends with `bounds`, and reports
     * one room. `extraRooms` adds labelled spaces so a forbidden zone can be named by ref.
     */
    class AttributedBridge extends MockBridgeClient {
      readonly seen: RpcMethodName[] = []

      constructor(
        private readonly extraRooms: Array<{
          name: string
          labelPosition: [number, number]
        }> = []
      ) {
        super()
      }

      override async request<M extends RpcMethodName>(
        method: M,
        params: RpcMethodMap[M]['params'],
        options?: BridgeRequestOptions
      ): Promise<RpcMethodMap[M]['result']> {
        this.seen.push(method)
        const result = await super.request(method, params, options)
        if (method === RpcMethod.DrawingInspectFloorplan) {
          const inspect = result as RpcMethodMap[typeof RpcMethod.DrawingInspectFloorplan]['result']
          return {
            ...inspect,
            regionBasis: 'block-frame',
            rooms: [...inspect.rooms, ...this.extraRooms]
          } as RpcMethodMap[M]['result']
        }
        if (method === RpcMethod.DrawingSummary) {
          const summary = result as { insUnits?: string }
          return {
            ...summary,
            insUnits: summary.insUnits === 'unitless' ? 'mm' : summary.insUnits
          } as RpcMethodMap[M]['result']
        }
        return result
      }
    }
    // from the drawing and built with the same `roomRef` the tools use.
    async function liveRef(bridge: BridgeClient): Promise<string> {
      const info = await bridge.request(RpcMethod.DrawingInfo, { documentName: TARGET_DOC })
      return roomRef(info.revision, 'GARA ĐỂ XE TẦNG HẦM')
    }

    const refPreview = async (bridge: BridgeClient, extra: Record<string, unknown> = {}) => ({
      operation: 'preview',
      documentName: TARGET_DOC,
      floorplanName: 'MẶT BẰNG TẦNG HẦM',
      roomRef: await liveRef(bridge),
      hazardGroup: 'Group 1',
      // On the ring's edge: a plan built on the ring keeps every entity inside it.
      riserLocation: [9500, 104000],
      sprinklerSymbol: 'fire_sprinkler_pendant',
      ...extra
    })

    test('a room named by ref gets the outline the drawing has, not a typed box', async () => {
      const bridge = new AttributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-ref')
      const handler = overlayHandler(asClient, ringSource())

      const out = json(await handler(await refPreview(bridge), ctxFor('ws-ref', 1)))
      expect(out.blockedReasons ?? []).toEqual([])
      expect(out.status).toBe('ready')
      expect(out.room).toMatchObject({
        floorplanName: 'MẶT BẰNG TẦNG HẦM',
        boundarySource: 'cad',
        basis: 'block-frame'
      })

      const applied = json(
        await handler(
          { operation: 'apply', planId: out.planId as string, documentName: TARGET_DOC },
          ctxFor('ws-ref', 2)
        )
      )
      expect(applied.status).toBe('committed')
      // Discriminating check: the ring is 5500x10000, the frame 32520x23538. Heads spread over the
      // frame would mean a placeholder box was used; they stay inside the drawing's own outline.
      const placed = (
        await asClient.request(RpcMethod.EntityList, {
          documentName: TARGET_DOC,
          kind: 'blockReference',
          detail: 'full',
          limit: 500
        })
      ).entities as Array<{ geometry?: { position?: { x?: number; y?: number } } }>
      expect(placed.length).toBe(out.headCount as number)
      const xs = placed.map((e) => e.geometry!.position!.x!)
      const ys = placed.map((e) => e.geometry!.position!.y!)
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(6000)
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(10500)
    })

    test('a ref the sheet cannot bound blocks the plan without planning anything', async () => {
      const bridge = new AttributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-cold')
      // Same handle, cold index: the label is known, the outline is not.
      const handler = overlayHandler(asClient, ringSource({ snapshotFor: async () => null }))

      const out = json(await handler(await refPreview(bridge), ctxFor('ws-cold', 1)))
      expect(out.status).toBe('BLOCKED')
      const reasons = (out.blockedReasons as string[]).join(' ')
      expect(reasons).toContain('ROOM_REF_UNRESOLVED')
      expect(reasons).toContain('unresolved')
      // Blocked before any planning: no batch was ever sent.
      expect(bridge.seen).not.toContain(RpcMethod.OperationsApply)
    })

    test('a polygon outside the named plan is refused even when it is a real shape', async () => {
      const bridge = new AttributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-off')
      const handler = overlayHandler(asClient, ringSource())

      const out = json(
        await handler(
          previewInput({
            // Same 12000x8000 footprint, parked to the right of the basement frame.
            roomBoundary: [
              [35000, 100000],
              [47000, 100000],
              [47000, 108000],
              [35000, 108000]
            ],
            riserLocation: [35500, 104000]
          }),
          ctxFor('ws-off', 1)
        )
      )
      expect(out.status).toBe('BLOCKED')
      expect((out.blockedReasons as string[]).join(' ')).toContain('ROOM_OUTSIDE_FLOORPLAN')
    })

    test('a plan title the sheet does not attribute blocks instead of designing over everything', async () => {
      class UnattributedBridge extends MockBridgeClient {
        override async request<M extends RpcMethodName>(
          method: M,
          params: RpcMethodMap[M]['params'],
          options?: BridgeRequestOptions
        ): Promise<RpcMethodMap[M]['result']> {
          if (method === RpcMethod.DrawingInspectFloorplan) {
            return {
              found: true,
              matchedName: 'MẶT BẰNG KHÔNG CÓ THẬT',
              availableFloorplans: ['MẶT BẰNG TẦNG HẦM', 'MẶT BẰNG TẦNG 1'],
              regionBasis: 'unresolved',
              layers: [],
              rooms: []
            } as RpcMethodMap[M]['result']
          }
          return super.request(method, params, options)
        }
      }
      const bridge = new UnattributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-none')
      const handler = overlayHandler(asClient, ringSource())

      const out = json(
        await handler(
          previewInput({ floorplanName: 'MẶT BẰNG KHÔNG CÓ THẬT' }),
          ctxFor('ws-none', 1)
        )
      )
      expect(out.status).toBe('BLOCKED')
      expect((out.blockedReasons as string[]).join(' ')).toContain('FLOORPLAN_REGION_UNRESOLVED')
    })

    test('a riser outside the named plan blocks the entities it would drag there', async () => {
      const bridge = new AttributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-riser')
      const handler = overlayHandler(asClient, ringSource())

      // The room is legitimately inside the frame; only the riser anchor is parked to the right of it,
      // which pulls the main run off the plan. Checking room polygons alone would have passed this.
      const out = json(
        await handler(previewInput({ riserLocation: [40000, 104000] }), ctxFor('ws-riser', 1))
      )
      expect(out.status).toBe('BLOCKED')
      expect((out.blockedReasons as string[]).join(' ')).toContain('DRAWN_OUTSIDE_FLOORPLAN')
    })

    test("a forbidden zone named by ref carves the drawing's own area out of coverage", async () => {
      // The sheet reports the garage AND a meter room inside it; the snapshot carries both rings.
      const bridge = new AttributedBridge([
        { name: 'PHONG DO LUONG', labelPosition: [13000, 105000] }
      ])
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-excl')
      const garageRef = await liveRef(bridge)
      const meterRef = roomRef(
        (await asClient.request(RpcMethod.DrawingInfo, { documentName: TARGET_DOC })).revision,
        'PHONG DO LUONG'
      )

      const source = ringSource({
        rowsInWindow: async () => [
          { handle: 'A1', kind: 'polyline', geometry: GARAGE_RING },
          { handle: 'A2', kind: 'polyline', geometry: METER_RING }
        ]
      })
      const handler = overlayHandler(asClient, source)

      const base = json(
        await handler(await refPreview(bridge, { roomRef: garageRef }), ctxFor('ws-excl', 1))
      )
      const excluded = json(
        await handler(
          await refPreview(bridge, { roomRef: garageRef, excludedRefs: [{ ref: meterRef }] }),
          ctxFor('ws-excl', 2)
        )
      )

      expect(base.status).toBe('ready')
      expect(excluded.status).toBe('ready')
      // The garage ring is 5500x10000 (55 m2); the meter room ring is 2000x2000 (4 m2). Those areas
      // only appear if the exclusion came from the drawing's polygon — a typed box would change them.
      expect(base.protectedAreaM2).toBeCloseTo(55, 1)
      expect(excluded.protectedAreaM2).toBeCloseTo(51, 1)
      expect((excluded.headCount as number) ?? 0).toBeLessThan(base.headCount as number)
      expect(excluded.room).toMatchObject({
        boundarySource: 'cad',
        excludedFromRefs: 1,
        excludedFromCaller: 0
      })
    })

    test('a forbidden zone the drawing cannot outline blocks instead of guessing a box', async () => {
      const bridge = new AttributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-excl-miss')
      const garage = await liveRef(bridge)
      const handler = overlayHandler(asClient, ringSource())

      const out = json(
        await handler(
          await refPreview(bridge, {
            roomRef: garage,
            excludedRefs: [{ name: 'PHONG KY THUAT KHONG TEN' }]
          }),
          ctxFor('ws-excl-miss', 1)
        )
      )
      expect(out.status).toBe('BLOCKED')
      const reasons = (out.blockedReasons as string[]).join(' ')
      expect(reasons).toContain('EXCLUDED_REF_UNRESOLVED')
      // The refs that WOULD work are named, so the caller fixes it by copying, not by rewording.
      expect(reasons).toContain(garage)
      expect(bridge.seen).not.toContain(RpcMethod.OperationsApply)
    })

    test('an excluded zone that misses the protected room blocks instead of skewing its area', async () => {
      const bridge = new AttributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-excl-far')
      const handler = overlayHandler(asClient, ringSource())

      // Inside the basement frame but outside the 12000x8000 room being protected. The planner
      // subtracts an exclusion's whole area from protectedAreaM2 wherever it sits, so accepting this
      // would report a smaller protected area while still placing heads in the space it named.
      const out = json(
        await handler(
          previewInput({
            excludedBoundaries: [
              [
                [24000, 100000],
                [26000, 100000],
                [26000, 102000],
                [24000, 102000]
              ]
            ]
          }),
          ctxFor('ws-excl-far', 1)
        )
      )
      expect(out.status).toBe('BLOCKED')
      expect((out.blockedReasons as string[]).join(' ')).toContain('EXCLUDED_OUTSIDE_ROOM')
      expect(bridge.seen).not.toContain(RpcMethod.OperationsApply)
    })

    test('an excluded zone sharing a wall with the room is kept, not refused', async () => {
      // The gate must reject a *disjoint* zone without refusing a legitimate adjacent void. This ring
      // sits to the right of the room and shares its x=22000 wall, so it carves ~nothing but is not a
      // mistake, and `segmentsIntersect` counts the shared edge as contact.
      const bridge = new AttributedBridge()
      const asClient = bridge as unknown as BridgeClient
      await seedSymbol(asClient, 'SPRK_HEAD')
      await seedCatalogEntry('ws-excl-abut')
      const handler = overlayHandler(asClient, ringSource())

      const out = json(
        await handler(
          previewInput({
            excludedBoundaries: [
              [
                [22000, 100000],
                [26000, 100000],
                [26000, 104000],
                [22000, 104000]
              ]
            ]
          }),
          ctxFor('ws-excl-abut', 1)
        )
      )
      expect(((out.blockedReasons as string[]) ?? []).join(' ')).not.toContain(
        'EXCLUDED_OUTSIDE_ROOM'
      )
      expect(out.status).toBe('ready')
    })

    test('the schema rejects an excluded entry that names nothing', async () => {
      const parsed = pcccOverlayInputSchema.safeParse({
        operation: 'preview',
        floorplanName: 'MẶT BẰNG TẦNG HẦM',
        roomRef: 'fp_x:y',
        excludedRefs: [{}],
        hazardGroup: 'Group 1',
        riserLocation: [10000, 104000],
        sprinklerSymbol: 'fire_sprinkler_pendant'
      })
      expect(parsed.success).toBe(false)
      expect(parsed.error!.issues[0]!.message).toContain('an excluded room needs `ref` or `name`')
    })

    test('the schema rejects a request that names no room at all', async () => {
      const parsed = pcccOverlayInputSchema.safeParse({
        operation: 'preview',
        floorplanName: 'MẶT BẰNG TẦNG HẦM',
        hazardGroup: 'Group 1',
        riserLocation: [10000, 104000],
        sprinklerSymbol: 'fire_sprinkler_pendant'
      })
      expect(parsed.success).toBe(false)
      expect(parsed.error!.issues[0]!.message).toContain('a room needs `roomRef`')
    })
  })
})
