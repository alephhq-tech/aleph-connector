import { describe, expect, it } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { DocumentPin } from '../bridge/PinnedBridgeClient.js'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import {
  registerPcccFireAlarmTools,
  pcccFireAlarmInputSchema,
  deriveBeamYHighways
} from './pcccFireAlarm.js'
import { registerDrawingTools } from './drawing.js'
import { roomRef, type SnapshotRow } from './floorplanCadState.js'

/** Records every RPC the tool issued, so "preview wrote nothing" is provable, not assumed. */
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

function fireAlarmHandler(
  bridge: BridgeClient,
  cadState?: Parameters<typeof registerPcccFireAlarmTools>[2]
): Handler {
  let handler!: Handler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: Handler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerPcccFireAlarmTools>[0]
  registerPcccFireAlarmTools(serverDouble, bridge, cadState)
  return handler
}

function json(res: Awaited<ReturnType<Handler>>): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>
}

const LIBRARY_PATH = 'C:\\libs\\ki hieu.dwg'
const LIBRARY_BLOCKS = [
  'ĐẦU BÁO KHÓI',
  'ĐẦU BÁO NHIỆT',
  'NÚT NHẤN KHẨN CẤP',
  'CHUÔNG BÁO CHÁY',
  'HỘP NỐI DÂY',
  'ĐIỆN TRỞ'
]

/**
 * Seed the symbol library the way a real one looks: an open DWG whose model space carries one
 * block reference per definition. `entity.copyTo` deep-clones the definition, so these instances are
 * what makes the import work.
 */
async function seedLibrary(bridge: BridgeClient): Promise<void> {
  await bridge.request(RpcMethod.DrawingOpen, { path: LIBRARY_PATH, readOnly: true })
  for (const blockName of LIBRARY_BLOCKS) {
    await bridge.request(RpcMethod.EntityCreate, {
      documentName: 'ki hieu.dwg',
      kind: 'blockReference',
      blockName,
      position: { x: 100, y: 100, z: 0 }
    })
  }
}

const ROOMS = [
  {
    id: 'garage',
    name: 'Gara xe',
    usage: 'garage',
    boundary: [
      [10000, 100000],
      [28000, 100000],
      [28000, 112000],
      [10000, 112000]
    ]
  },
  {
    id: 'lift',
    name: 'Thang máy',
    usage: 'elevator',
    boundary: [
      [16500, 109800],
      [20500, 109800],
      [20500, 113500],
      [16500, 113500]
    ]
  }
]

// The mock's inspect attributes the basement frame at [9.08, 99339.6, 32529.21, 122878] (the real
// SUNLAND block extents); ROOMS sit inside it.
function previewInput(extra: Record<string, unknown> = {}) {
  return {
    operation: 'preview',
    rooms: ROOMS,
    acceptCallerGeometry: true as const,
    floorplanName: 'MẶT BẰNG TẦNG HẦM',
    beamYHighways: [105500, 117000],
    junctionBoxLocation: [11000, 101000],
    ...extra
  }
}

describe('pccc_fire_alarm_overlay symbol resolution', () => {
  it('preview probes the library without writing, and apply imports then draws real blocks', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const bridge = spy as unknown as BridgeClient
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(spy)

    const before = await spy.inner.request(RpcMethod.EntityList, { documentName: 'Drawing1.dwg' })

    const out = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH }), { mcpReq: { id: 1 } })
    )
    expect(out.status).toBe('PASS')
    expect(out.violations).toEqual([])
    expect((out.symbols as Record<string, string>)['SMOKE_DETECTOR']).toBe('ĐẦU BÁO KHÓI')
    // The plan names what apply will clone; nothing has been imported yet.
    expect(out.importAtApply).toEqual(expect.arrayContaining(LIBRARY_BLOCKS))

    // PREVIEW WROTE NOTHING: no clone, no erase, same entity count, same revision.
    expect(spy.methods()).not.toContain(RpcMethod.EntityCopyTo)
    expect(spy.methods()).not.toContain(RpcMethod.EntityErase)
    const afterPreview = await spy.inner.request(RpcMethod.EntityList, {
      documentName: 'Drawing1.dwg'
    })
    expect(afterPreview.total).toBe(before.total)
    const revAfterPreview = await spy.inner.request(RpcMethod.DrawingInfo, {
      documentName: 'Drawing1.dwg'
    })

    const applied = json(
      await handler(
        { operation: 'apply', planId: out.planId as string, capture: 'changed' },
        { mcpReq: { id: 2 } }
      )
    )
    expect(applied.status).toBe('committed')
    expect(applied.importedFromLibrary).toEqual(expect.arrayContaining(LIBRARY_BLOCKS))
    // Post-apply verification: devices and wire landed (labels are annotations,
    // auto-matched in read-back rather than geometrically verified).
    const readback = applied.readback as {
      faithful: boolean
      matchedSteps: number
      totalSteps: number
    }
    expect(readback.faithful).toBe(true)
    expect(readback.totalSteps).toBe(22)
    expect(readback.matchedSteps).toBe(22)

    // The import now happened. It is deliberately NOT journaled under the apply's task id: its
    // cloned instances are erased right away (only the block DEFINITION needs to arrive), and a
    // ledger receipt naming an already-erased handle makes operations.revert(taskId) refuse the
    // whole overlay with RevertConflict. The drawing batch alone carries the task id.
    const copyCalls = spy.calls
      .filter((c) => c.method === RpcMethod.EntityCopyTo)
      .map((c) => c.params as RpcMethodMap[typeof RpcMethod.EntityCopyTo]['params'])
    expect(copyCalls).toHaveLength(1)
    expect(copyCalls[0]!.taskId).toBeUndefined()
    expect(copyCalls[0]!.targetDocumentName).toBe('Drawing1.dwg')

    // The drawing gained block references — not circles, not hand-drawn stand-ins.
    const entities = (
      await spy.inner.request(RpcMethod.EntityList, {
        documentName: 'Drawing1.dwg',
        kind: 'blockReference',
        detail: 'full',
        limit: 500
      })
    ).entities as Array<{ geometry?: { blockName?: string } }>
    expect(entities.length).toBeGreaterThan(0)
    const drawnNames = entities.map((entity) => entity.geometry?.blockName)
    for (const name of drawnNames) {
      expect(typeof name).toBe('string')
      expect(LIBRARY_BLOCKS).toContain(name as string)
    }
    // The batch ran against a live revision that only moved because of this apply's own import.
    const revAfterApply = await spy.inner.request(RpcMethod.DrawingInfo, {
      documentName: 'Drawing1.dwg'
    })
    expect(revAfterApply.revision).not.toBe(revAfterPreview.revision)
    // The library tab never stays open in the user's AutoCAD.
    const open = await spy.inner.request(RpcMethod.DrawingListOpen, {})
    expect(open.documents.map((d) => d.name)).not.toContain('ki hieu.dwg')

    // Reverting the apply's task rolls the drawn overlay back — proof the import left no
    // half-revertable receipt naming an already-erased handle.
    const reverted = await spy.inner.request(RpcMethod.OperationsRevert, {
      documentName: 'Drawing1.dwg',
      taskId: '2'
    })
    expect(reverted.status).toBe('reverted')
    expect(reverted.erasedHandles.length).toBeGreaterThan(0)
  })

  it('blocks when an imported symbol footprint leaves the frame even if its anchor is inside', async () => {
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
            max: { x: 32530.21, y: 112000, z: 0 }
          }
        } as RpcMethodMap[M]['result']
      }
    }
    const bridge = new EscapingFootprintBridge()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)
    const out = json(
      await fireAlarmHandler(bridge)(previewInput({ symbolLibraryPath: LIBRARY_PATH }), {
        mcpReq: { id: 4 }
      })
    )
    const violations = out.violations as string[]
    const preview = bridge.calls.find((call) => call.method === RpcMethod.OperationsPreview)
    const previewParams =
      preview?.params as RpcMethodMap[typeof RpcMethod.OperationsPreview]['params']

    expect(out.status).toBe('FAIL')
    expect(
      violations.some((reason) => reason.startsWith('BLOCK_FOOTPRINT_OUTSIDE_FLOORPLAN'))
    ).toBe(true)
    expect(previewParams.documentName).toBe('ki hieu.dwg')
    expect(bridge.methods()).not.toContain(RpcMethod.OperationsApply)
  })

  it('execute compiles and draws in one call, drawing nothing when a gate blocks', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const bridge = spy as unknown as BridgeClient
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(spy)

    // A blocked request: room polygon lies outside the floor plan region, so the
    // plan must block exactly as preview would — and NOTHING may be drawn.
    const badRoom = [
      [35000, 100000],
      [47000, 100000],
      [47000, 108000],
      [35000, 108000]
    ]
    const blocked = json(
      await handler(
        {
          ...previewInput({
            rooms: [{ id: 'bad', name: 'Ngoai mat bang', usage: 'garage', boundary: badRoom }]
          }),
          operation: 'execute'
        },
        { mcpReq: { id: 1 } }
      )
    )
    expect(blocked.drawn).toBe(false)
    expect(
      (blocked.violations as string[]).some((v) => v.startsWith('ROOM_OUTSIDE_FLOORPLAN'))
    ).toBe(true)
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
    expect(spy.methods()).not.toContain(RpcMethod.EntityCopyTo)

    // The same request, now satisfiable: one call compiles, passes every gate, and draws. No second
    // apply call exists — the single dispatch is the point.
    const ok = json(
      await handler(
        {
          ...previewInput({ symbolLibraryPath: LIBRARY_PATH }),
          operation: 'execute',
          capture: 'changed'
        },
        { mcpReq: { id: 2 } }
      )
    )
    expect(ok.drawn).toBe(true)
    expect(ok.status).toBe('committed')
    expect(ok.importedFromLibrary).toEqual(expect.arrayContaining(LIBRARY_BLOCKS))
    // The compile report rides on the receipt, not dropped: geometry provenance + counts.
    expect(ok.deviceCount).toBeGreaterThan(0)
    expect(ok.rooms).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'garage', boundarySource: 'caller' })])
    )
    expect(spy.methods()).toContain(RpcMethod.OperationsApply)
    // Revert rolls the execute-drawn overlay back under its own task id, same as apply's batch.
    const reverted = await spy.inner.request(RpcMethod.OperationsRevert, {
      documentName: 'Drawing1.dwg',
      taskId: '2'
    })
    expect(reverted.status).toBe('reverted')
    expect(reverted.erasedHandles.length).toBeGreaterThan(0)
  })

  it('refuses apply when the drawing moved after preview, leaving nothing drawn', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const bridge = spy as unknown as BridgeClient
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(spy)

    const out = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH }), { mcpReq: { id: 1 } })
    )
    expect(out.status).toBe('PASS')

    // A concurrent edit — the user, or another tool — between preview and apply.
    await spy.inner.request(RpcMethod.EntityCreate, {
      documentName: 'Drawing1.dwg',
      kind: 'circle',
      center: { x: 1, y: 1, z: 0 },
      radius: 10
    })

    const applied = await handler(
      { operation: 'apply', planId: out.planId as string, capture: 'changed' },
      { mcpReq: { id: 2 } }
    )
    expect(applied.isError).toBe(true)
    expect(applied.content[0]!.text).toContain('changed between preview and apply')
    // Refused before any write: not even the symbol import was attempted.
    expect(spy.methods()).not.toContain(RpcMethod.EntityCopyTo)
  })

  it("resolves every symbol from Aleph's built-in default geometry when no library is named", async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const handler = fireAlarmHandler(bridge)

    const out = json(await handler(previewInput(), { mcpReq: { id: 1 } }))
    // No symbolLibraryPath, no cad_symbol_catalog row, no workspaceId on this transport — every
    // required device type still resolves via DEFAULT_PCCC_SYMBOL_GEOMETRY (Slice 06), so the
    // plan is never blocked on symbols the way it used to be.
    expect(out.status).toBe('PASS')
    const violations = out.violations as string[]
    expect(violations.some((v) => v.startsWith('MISSING_SYMBOL:'))).toBe(false)
    expect(out.importAtApply).toEqual([
      'ALEPH_PCCC_SMOKE_DETECTOR',
      'ALEPH_PCCC_HEAT_DETECTOR',
      'ALEPH_PCCC_MANUAL_CALL_POINT',
      'ALEPH_PCCC_COMBINATION_ALARM',
      'ALEPH_PCCC_JUNCTION_BOX',
      'ALEPH_PCCC_EOL_RESISTOR'
    ])

    const before = await bridge.request(RpcMethod.EntityList, { documentName: 'Drawing1.dwg' })
    const applied = await handler(
      { operation: 'apply', planId: out.planId as string, capture: 'changed' },
      { mcpReq: { id: 2 } }
    )
    expect(applied.isError).toBeFalsy()
    const applyBody = json(applied)
    expect(applyBody.importedFromLibrary).toEqual([
      'ALEPH_PCCC_SMOKE_DETECTOR',
      'ALEPH_PCCC_HEAT_DETECTOR',
      'ALEPH_PCCC_MANUAL_CALL_POINT',
      'ALEPH_PCCC_COMBINATION_ALARM',
      'ALEPH_PCCC_JUNCTION_BOX',
      'ALEPH_PCCC_EOL_RESISTOR'
    ])

    const after = await bridge.request(RpcMethod.EntityList, { documentName: 'Drawing1.dwg' })
    expect(after.total).toBeGreaterThan(before.total)

    // Zero DrawingOpen to any symbol library: block.ensureDefinition builds every definition in
    // the already-open document, the whole point of Slice 06.
    const definitions = await bridge.request(RpcMethod.BlockList, { documentName: 'Drawing1.dwg' })
    expect(definitions.blocks.some((b) => b.name === 'ALEPH_PCCC_SMOKE_DETECTOR')).toBe(true)
  })

  it('names what the library is missing when its blocks do not match the vocabulary', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await bridge.request(RpcMethod.DrawingOpen, { path: LIBRARY_PATH, readOnly: true })
    await bridge.request(RpcMethod.EntityCreate, {
      documentName: 'ki hieu.dwg',
      kind: 'blockReference',
      blockName: 'COT_DIEN',
      position: { x: 1, y: 1, z: 0 }
    })
    const handler = fireAlarmHandler(bridge)

    const out = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH }), { mcpReq: { id: 1 } })
    )
    expect(out.status).toBe('FAIL')
    const text = (out.violations as string[]).join(' ')
    expect(text).toContain('no block definition matching')
    expect(text).toContain('COT_DIEN')
  })

  it('traces an elevator polygon from one interior point and keeps devices and wiring out of it', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)

    // The architecture gives us nothing semantic: only one closed ring exists for the shaft, and the
    // caller supplies just a point inside it.
    const shaft: Array<[number, number]> = [
      [16500, 109800],
      [20500, 109800],
      [20500, 113500],
      [16500, 113500]
    ]
    await bridge.request(RpcMethod.LayerCreate, { name: 'A-WALL' })
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'polyline',
      layer: 'A-WALL',
      points: shaft.map(([x, y]) => ({ x, y, z: 0 })),
      closed: true
    })

    const garageOnly = {
      operation: 'preview',
      rooms: [ROOMS[0]!],
      acceptCallerGeometry: true as const,
      floorplanName: 'MẶT BẰNG TẦNG HẦM',
      beamYHighways: [105500, 117000],
      symbolLibraryPath: LIBRARY_PATH,
      junctionBoxLocation: [11000, 101000],
      elevatorPickPoints: [[18500, 111650]]
    }
    const out = json(await fireAlarmHandler(bridge)(garageOnly, { mcpReq: { id: 1 } }))

    expect(out.status).toBe('PASS')
    expect(out.elevatorZones).toBe(1)

    // Nothing was drawn inside the traced shaft, and no wire crosses it.
    const created = await bridge.request(RpcMethod.EntityList, {
      documentName: 'Drawing1.dwg',
      detail: 'full',
      limit: 500
    })
    for (const entity of created.entities as Array<{
      kind: string
      geometry?: { position?: { x: number; y: number }; points?: Array<{ x: number; y: number }> }
    }>) {
      if (entity.kind === 'blockReference') {
        const p = entity.geometry?.position!
        const inside = p.x >= 16500 && p.x <= 20500 && p.y >= 109800 && p.y <= 113500
        expect(inside).toBe(false)
      }
      if (entity.kind === 'polyline') {
        for (const pt of entity.geometry?.points ?? []) {
          const inside = pt.x >= 16500 && pt.x <= 20500 && pt.y >= 109800 && pt.y <= 113500
          expect(inside).toBe(false)
        }
      }
    }
  })

  it('blocks the plan when an elevator pick point yields no closed boundary', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)

    const out = json(
      await fireAlarmHandler(bridge)(
        {
          operation: 'preview',
          rooms: [ROOMS[0]!],
          acceptCallerGeometry: true as const,
          floorplanName: 'MẶT BẰNG TẦNG HẦM',
          symbolLibraryPath: LIBRARY_PATH,
          elevatorPickPoints: [[18500, 111650]]
        },
        { mcpReq: { id: 1 } }
      )
    )

    expect(out.status).toBe('FAIL')
    expect((out.violations as string[]).join(' ')).toContain('ELEVATOR_UNTRACED')
  })

  it('refuses a room polygon that falls outside the floor plan the sheet reports', async () => {
    // The exact failure mode seen on SUNLAND: the symbol schedule was drawn at x[35000..46000],
    // beside the basement frame rather than inside it. Nothing in the planner can tell that apart —
    // the grid, the routing and the schedule are all consistent with the box they were handed — so
    // the region has to come from the drawing.
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const bridge = spy as unknown as BridgeClient
    await seedLibrary(bridge)

    const out = json(
      await fireAlarmHandler(bridge)(
        previewInput({
          symbolLibraryPath: LIBRARY_PATH,
          rooms: [
            {
              id: 'legend',
              name: 'BANG KY HIEU',
              usage: 'general',
              boundary: [
                [35000, 106900],
                [46000, 106900],
                [46000, 118300],
                [35000, 118300]
              ]
            }
          ]
        }),
        { mcpReq: { id: 1 } }
      )
    )

    expect(out.status).toBe('FAIL')
    expect((out.violations as string[]).join(' ')).toContain('ROOM_OUTSIDE_FLOORPLAN')

    // The plan is still recorded, and apply is what refuses it — nothing reaches the drawing.
    const before = await spy.inner.request(RpcMethod.EntityList, { documentName: 'Drawing1.dwg' })
    const applied = await fireAlarmHandler(spy)(
      { operation: 'apply', planId: out.planId as string },
      { mcpReq: { id: 2 } }
    )
    expect(applied.isError).toBe(true)
    expect(applied.content[0]!.text).toContain('ROOM_OUTSIDE_FLOORPLAN')
    expect(spy.methods()).not.toContain(RpcMethod.OperationsApply)
    const after = await spy.inner.request(RpcMethod.EntityList, { documentName: 'Drawing1.dwg' })
    expect(after.total).toBe(before.total)
  })

  it('refuses a placeholder square that does not correspond to any real room', async () => {
    // 12 of the 23 preview calls in the observed run supplied [0,0]→[1000,1000]: a unit square that
    // matched no geometry on the sheet, and produced devices at negative drawing coordinates.
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })

    const out = json(
      await fireAlarmHandler(bridge)(
        previewInput({
          symbolLibraryPath: LIBRARY_PATH,
          rooms: [
            {
              id: 'r1',
              name: 'Gara',
              usage: 'garage',
              boundary: [
                [0, 0],
                [1000, 0],
                [1000, 1000],
                [0, 1000]
              ]
            }
          ]
        }),
        { mcpReq: { id: 1 } }
      )
    )

    expect(out.status).toBe('FAIL')
    expect((out.violations as string[]).join(' ')).toContain('ROOM_OUTSIDE_FLOORPLAN')
  })

  it('names a plan whose title resolves to several copies instead of guessing one', async () => {
    class AmbiguousBridge extends SpyBridgeClient {
      override async request<M extends RpcMethodName>(
        method: M,
        params: RpcMethodMap[M]['params'],
        options?: BridgeRequestOptions
      ): Promise<RpcMethodMap[M]['result']> {
        if (method === RpcMethod.DrawingInspectFloorplan) {
          return {
            found: false,
            availableFloorplans: ['MẶT BẰNG TẦNG HẦM'],
            regionBasis: 'ambiguous',
            regionCandidates: [
              [9.08, 99339.6, 32529.21, 122878],
              [73516, 450991, 104883, 474527]
            ],
            layers: [],
            rooms: []
          } as RpcMethodMap[M]['result']
        }
        return super.request(method, params, options)
      }
    }
    const spy = new AmbiguousBridge()
    await seedLibrary(spy as unknown as BridgeClient)

    const out = json(
      await fireAlarmHandler(spy as unknown as BridgeClient)(
        previewInput({ symbolLibraryPath: LIBRARY_PATH }),
        { mcpReq: { id: 1 } }
      )
    )

    // No frame means no room geometry can be admitted, so the planner has nothing to design with
    // (INSUFFICIENT_DATA) rather than a design carrying a violation — either way the plan is blocked.
    expect(out.status).not.toBe('PASS')
    const text = (out.violations as string[]).join(' ')
    expect(text).toContain('FLOORPLAN_REGION_UNRESOLVED')
    expect(text).toContain('candidateIndex')
  })

  it('blocks a plan whose rooms are inside the frame but whose drawn entities are not', async () => {
    // Checking only rooms[].boundary left the real escape hatch open: a call point typed at a door
    // point out in the margin draws beside the plan even though every room polygon is legitimate.
    // The batch that would actually be written is what has to stay inside the frame.
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const bridge = spy as unknown as BridgeClient
    await seedLibrary(bridge)

    const out = json(
      await fireAlarmHandler(bridge)(
        previewInput({
          symbolLibraryPath: LIBRARY_PATH,
          // the mock reports the basement frame ending at x = 32529.21
          stairDoors: [{ doorPoint: [38000, 110000], stairName: 'Buong thang canh' }]
        }),
        { mcpReq: { id: 1 } }
      )
    )

    expect(out.status).toBe('FAIL')
    const text = (out.violations as string[]).join(' ')
    expect(text).toContain('DRAWN_OUTSIDE_FLOORPLAN')
    expect(text).toContain('stairDoors')

    const before = await spy.inner.request(RpcMethod.EntityList, { documentName: 'Drawing1.dwg' })
    const applied = await fireAlarmHandler(bridge)(
      { operation: 'apply', planId: out.planId as string },
      { mcpReq: { id: 2 } }
    )
    expect(applied.isError).toBe(true)
    expect(applied.content[0]!.text).toContain('DRAWN_OUTSIDE_FLOORPLAN')
    const after = await spy.inner.request(RpcMethod.EntityList, { documentName: 'Drawing1.dwg' })
    expect(after.total).toBe(before.total)
  })

  it('reads the floor-plan frame once per revision, not once per retry', async () => {
    // inspect_floorplan walks every text and polyline on the sheet — measured over 15 s on a
    // ~2400-text drawing — so an agent that previews, fixes its room input, and previews again
    // should not pay that walk twice for a sheet that has not changed. The region gate still has to
    // run (it is what rejects the bad polygons); only the CAD read is skipped.
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const bridge = spy as unknown as BridgeClient
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(bridge)

    const inspectCalls = () =>
      spy.calls.filter((c) => c.method === RpcMethod.DrawingInspectFloorplan).length

    const first = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH }), { mcpReq: { id: 1 } })
    )
    expect(first.status).toBe('PASS')
    expect(inspectCalls()).toBe(1)

    const second = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH, beamYHighways: [106000] }), {
        mcpReq: { id: 2 }
      })
    )
    expect(second.status).toBe('PASS')
    expect(inspectCalls()).toBe(1)

    // A mutation (the user, or this tool's own apply) moves the revision: the next preview reads the
    // sheet again rather than designing inside a frame that may no longer describe the drawing.
    await spy.inner.request(RpcMethod.EntityCreate, {
      documentName: 'Drawing1.dwg',
      kind: 'circle',
      center: { x: 1, y: 1, z: 0 },
      radius: 10
    })
    const third = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH }), { mcpReq: { id: 3 } })
    )
    expect(third.status).toBe('PASS')
    expect(inspectCalls()).toBe(2)
  })

  it('does not cache a region that failed to resolve, and keeps its gate on a cached one', async () => {
    const spy = new SpyBridgeClient()
    await spy.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const bridge = spy as unknown as BridgeClient
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(bridge)

    const good = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH }), { mcpReq: { id: 1 } })
    )
    expect(good.status).toBe('PASS')

    // Same revision, bad polygons: the cached frame must still be the thing they are checked
    // against, so caching cannot weaken the gate it feeds.
    const bad = json(
      await handler(
        previewInput({
          symbolLibraryPath: LIBRARY_PATH,
          rooms: [
            {
              id: 'legend',
              name: 'BANG KY HIEU',
              usage: 'general',
              boundary: [
                [35000, 106900],
                [46000, 106900],
                [46000, 118300],
                [35000, 118300]
              ]
            }
          ]
        }),
        { mcpReq: { id: 2 } }
      )
    )
    expect(bad.status).toBe('FAIL')
    expect((bad.violations as string[]).join(' ')).toContain('ROOM_OUTSIDE_FLOORPLAN')
    expect(spy.calls.filter((c) => c.method === RpcMethod.DrawingInspectFloorplan)).toHaveLength(1)
  })
})

/**
 * Rooms addressed by the handle the sheet publishes, instead of coordinates the caller types.
 *
 * The plugin's mock inspect attributes a frame but the mock has no CAD State snapshot, so the
 * boundary half of the contract needs an injected `RegionGeometrySource`: one closed ring containing
 * the GARA label. That is the seam between "the drawing says this room is here" and "the model wrote
 * a box", and every case below turns on it.
 */
describe('pccc_fire_alarm_overlay rooms by CAD reference', () => {
  // The mock reports the basement frame at [9.08, 99339.6, 32529.21, 122878] and one label
  // GARA ĐỂ XE TẦNG HẦM at [10000, 105000]. This 5500x10000 ring contains the label and covers ~7%
  // of the frame, so it is a room, not the sheet border.
  const GARAGE_RING = {
    closed: true,
    vertices: [
      { point: { x: 9500, y: 100000 } },
      { point: { x: 15000, y: 100000 } },
      { point: { x: 15000, y: 110000 } },
      { point: { x: 9500, y: 110000 } }
    ]
  }

  type CadState = Parameters<typeof registerPcccFireAlarmTools>[2]
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
   * The mock's inspect omits `regionBasis`, which the plugin always sends alongside `bounds`. Adding
   * it here keeps these cases on the attributed path (where ref resolution is allowed at all)
   * without touching the shared mock that other suites assert against.
   */
  class AttributedBridge extends MockBridgeClient {
    readonly seen: RpcMethodName[] = []

    override async request<M extends RpcMethodName>(
      method: M,
      params: RpcMethodMap[M]['params'],
      options?: BridgeRequestOptions
    ): Promise<RpcMethodMap[M]['result']> {
      this.seen.push(method)
      const result = await super.request(method, params, options)
      if (method === RpcMethod.DrawingInspectFloorplan)
        return { ...result, regionBasis: 'block-frame' } as RpcMethodMap[M]['result']
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

  // The sheet every case below designs on; naming it keeps the handle, the preview and the entity
  // read-back pointed at the same tab even after `seedLibrary` opens another one.
  const TARGET_DOC = 'Drawing1.dwg'

  async function publishedRef(bridge: BridgeClient, cadState: CadState): Promise<string> {
    // The ref the overlay must accept is the ref the drawing tool publishes — taken from that tool,
    // never recomputed here, so the two cannot drift apart unnoticed. The document is named so the
    // handle is bound to the sheet the preview will also target (the library tab, opened by
    // `seedLibrary`, would otherwise be the active document).
    let inspect!: (
      input: unknown,
      ctx: { mcpReq: { id: number } }
    ) => Promise<{ content: { text?: string }[] }>
    const serverDouble = {
      registerTool: (_n: string, _d: unknown, cb: typeof inspect): void => {
        inspect = cb
      }
    } as unknown as Parameters<typeof registerDrawingTools>[0]
    registerDrawingTools(serverDouble, bridge, new DocumentPin(), cadState)
    const result = await inspect(
      { operation: 'inspect_floorplan', name: 'MẶT BẰNG TẦNG HẦM', documentName: TARGET_DOC },
      { mcpReq: { id: 900 } }
    )
    const body = JSON.parse(result.content[0]!.text!) as {
      rooms: Array<{ ref?: string; name: string; boundaryStatus: string }>
    }
    return body.rooms[0]!.ref!
  }

  const refPreview = (rooms: unknown[], extra: Record<string, unknown> = {}) => ({
    operation: 'preview',
    rooms,
    floorplanName: 'MẶT BẰNG TẦNG HẦM',
    beamYHighways: [105500],
    junctionBoxLocation: [11000, 101000],
    symbolLibraryPath: LIBRARY_PATH,
    documentName: TARGET_DOC,
    ...extra
  })

  it("draws the drawing's own outline for a room named only by ref", async () => {
    const bridge = new AttributedBridge()
    const asClient = bridge as unknown as BridgeClient
    await seedLibrary(asClient)
    const cadState = ringSource()
    const ref = await publishedRef(asClient, cadState)

    const handler = fireAlarmHandler(asClient, cadState)
    // No boundary, no coordinates: a handle plus an engineering decision.
    const out = json(
      await handler(refPreview([{ id: 'garage', ref, usage: 'garage' }]), { mcpReq: { id: 1 } })
    )
    expect(out.violations).toEqual([])
    expect(out.status).toBe('PASS')
    expect((out.rooms as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'garage',
      name: 'GARA ĐỂ XE TẦNG HẦM',
      boundarySource: 'cad',
      ref
    })

    expect((out.deviceCount as number) ?? 0).toBeGreaterThan(0)
    const applied = json(
      await handler(
        { operation: 'apply', planId: out.planId as string, documentName: TARGET_DOC },
        { mcpReq: { id: 2 } }
      )
    )
    expect(applied.status).toBe('committed')
    const drawn = (
      await asClient.request(RpcMethod.EntityList, {
        documentName: TARGET_DOC,
        kind: 'blockReference',
        detail: 'full',
        limit: 500
      })
    ).entities as Array<{ geometry?: { position?: { x?: number; y?: number } } }>
    expect(drawn.length).toBeGreaterThan(0)
    // Discriminating check: the CAD ring is 5500x10000 while the frame is 32520x23538. Devices spread
    // over the frame would mean a placeholder box was used; they fit inside the ring instead.
    const xs = drawn.map((e) => e.geometry!.position!.x!)
    const ys = drawn.map((e) => e.geometry!.position!.y!)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(6500)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(11500)
  })

  it('blocks instead of inventing an outline when the snapshot cannot confirm the room', async () => {
    const bridge = new AttributedBridge()
    const asClient = bridge as unknown as BridgeClient
    await seedLibrary(asClient)
    // The handle exists and names the right label, but no verified snapshot backs its outline. The
    // ref is still the one the drawing tool published for this exact state, so the failure is purely
    // about geometry — not about a typo the caller could fix by rewording.
    const cadState = ringSource({ snapshotFor: async () => null })
    const ref = await publishedRef(asClient, cadState)
    const handler = fireAlarmHandler(asClient, cadState)

    const out = json(
      await handler(refPreview([{ id: 'garage', ref, usage: 'garage' }]), { mcpReq: { id: 1 } })
    )
    // A room with no geometry is not a design: INSUFFICIENT_DATA (planner got no rooms) plus the
    // named violation, and both block apply.
    expect(out.status).toBe('INSUFFICIENT_DATA')
    const text = (out.violations as string[]).join(' ')
    expect(text).toContain('ROOM_REF_UNRESOLVED')
    expect(text).toContain('unresolved')
    // Nothing drawn: the plan is blocked before apply, and apply refuses it outright.
    expect(
      json(
        await handler({ operation: 'status', planId: out.planId as string }, { mcpReq: { id: 2 } })
      ).state
    ).toBe('blocked')
    const applied = await handler(
      { operation: 'apply', planId: out.planId as string },
      { mcpReq: { id: 3 } }
    )
    expect(applied.isError).toBe(true)
    expect(bridge.seen).not.toContain(RpcMethod.OperationsApply)
  })

  it('a ref from an earlier revision misses rather than binding to a different room', async () => {
    const bridge = new AttributedBridge()
    const asClient = bridge as unknown as BridgeClient
    await seedLibrary(asClient)
    const cadState = ringSource()
    const stale = await publishedRef(asClient, cadState)

    // The user (or another tool) edits the sheet: the revision moves, and the handle the earlier read
    // published no longer names anything on this drawing.
    await asClient.request(RpcMethod.EntityCreate, {
      documentName: 'Drawing1.dwg',
      kind: 'circle',
      center: { x: 1, y: 1, z: 0 },
      radius: 10
    })
    const handler = fireAlarmHandler(asClient, cadState)
    const out = json(
      await handler(refPreview([{ id: 'garage', ref: stale, usage: 'garage' }]), {
        mcpReq: { id: 1 }
      })
    )
    expect(out.status).not.toBe('PASS')
    const text = (out.violations as string[]).join(' ')
    expect(text).toContain('no room on this sheet has the ref')
    // The live handle is named, so the caller can copy the right one instead of rewording a guess.
    expect(text).toContain(roomRef('tdu:2;saves:0', 'GARA ĐỂ XE TẦNG HẦM'))
  })

  it('a bare room label resolves when it is the only one the sheet reports', async () => {
    const bridge = new AttributedBridge()
    const asClient = bridge as unknown as BridgeClient
    await seedLibrary(asClient)
    const handler = fireAlarmHandler(asClient, ringSource())

    // Case and spacing differ from the label; the sheet has exactly one match, so it is not a guess.
    const out = json(
      await handler(
        refPreview([{ id: 'garage', name: 'gara   để xe tầng hầm', usage: 'garage' }]),
        {
          mcpReq: { id: 1 }
        }
      )
    )
    expect(out.violations).toEqual([])
    expect((out.rooms as Array<Record<string, unknown>>)[0]!.boundarySource).toBe('cad')
  })

  it('a room with neither an address nor a polygon is rejected by the input schema', async () => {
    // The transport validates with this schema before the handler runs, so this costs no AutoCAD call.
    const parsed = pcccFireAlarmInputSchema.safeParse(
      refPreview([{ id: 'garage', usage: 'garage' }])
    )
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues[0]!.message).toContain('a room needs `ref`')
  })
})

describe('pccc_fire_alarm_overlay drawing units and the panel anchor (E7/E8)', () => {
  it('E8: unknown drawing units block preview with UNKNOWN_DRAWING_UNITS, never assumed mm', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    // Deliberately NO DrawingSetup: the mock defaults to insUnits 'unitless'.
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(bridge)

    const out = json(
      await handler(previewInput({ symbolLibraryPath: LIBRARY_PATH }), { mcpReq: { id: 1 } })
    )
    expect(out.status).toBe('INSUFFICIENT_DATA')
    expect((out.violations as string[]).join(' ')).toContain('UNKNOWN_DRAWING_UNITS')
  })

  it('E7: preview without a junction-box location fails with NO_PANEL_ANCHOR, never invents one', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(bridge)

    const { junctionBoxLocation: _dropped, ...withoutAnchor } = previewInput({
      symbolLibraryPath: LIBRARY_PATH
    })
    const out = json(await handler(withoutAnchor, { mcpReq: { id: 1 } }))
    expect(out.status).toBe('FAIL')
    expect((out.violations as string[]).join(' ')).toContain('NO_PANEL_ANCHOR')
    expect(JSON.stringify(out)).not.toContain('17000')
  })
})

describe('pccc_fire_alarm_overlay CAD-derived junction box / beam axis / floor-envelope guard', () => {
  const TARGET_DOC = 'Drawing1.dwg'
  type CadState = Parameters<typeof registerPcccFireAlarmTools>[2]

  class AttributedBridge extends MockBridgeClient {
    override async request<M extends RpcMethodName>(
      method: M,
      params: RpcMethodMap[M]['params'],
      options?: BridgeRequestOptions
    ): Promise<RpcMethodMap[M]['result']> {
      const result = await super.request(method, params, options)
      if (method === RpcMethod.DrawingInspectFloorplan)
        return { ...result, regionBasis: 'block-frame' } as RpcMethodMap[M]['result']
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

  // Frame the mock's inspect attributes to "MẶT BẰNG TẦNG HẦM" — comment above `GARAGE_RING`
  // in the sibling describe block (same fixture).
  const FRAME: [number, number, number, number] = [9.08, 99339.6, 32529.21, 122878]

  function sourceWithRows(rows: SnapshotRow[]): NonNullable<CadState> {
    return {
      async snapshotFor() {
        return { snapshotId: 'snap_1', fresh: true }
      },
      async rowsInWindow() {
        return rows
      },
      async hydrate() {
        return []
      }
    }
  }

  const preview = (extra: Record<string, unknown>) => ({
    operation: 'preview',
    floorplanName: 'MẶT BẰNG TẦNG HẦM',
    symbolLibraryPath: LIBRARY_PATH,
    documentName: TARGET_DOC,
    acceptCallerGeometry: true as const,
    ...extra
  })

  it('rejects a caller "room" whose boundary is the floor-plan frame itself', async () => {
    const bridge = new AttributedBridge() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(bridge, sourceWithRows([]))

    const out = json(
      await handler(
        preview({
          rooms: [
            {
              id: 'whole_floor',
              usage: 'garage',
              boundary: [
                [FRAME[0], FRAME[1]],
                [FRAME[2], FRAME[1]],
                [FRAME[2], FRAME[3]],
                [FRAME[0], FRAME[3]]
              ]
            }
          ],
          junctionBoxLocation: [11000, 101000],
          beamYHighways: [105500]
        }),
        { mcpReq: { id: 1 } }
      )
    )
    expect(out.status).not.toBe('PASS')
    expect((out.violations as string[]).join(' ')).toContain('ROOM_IS_FLOOR_ENVELOPE')
  })

  it('refuses caller roomBoundary without acceptCallerGeometry', async () => {
    const bridge = new AttributedBridge() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)
    const handler = fireAlarmHandler(bridge, sourceWithRows([]))

    const out = json(
      await handler(
        {
          operation: 'preview',
          floorplanName: 'MẶT BẰNG TẦNG HẦM',
          symbolLibraryPath: LIBRARY_PATH,
          documentName: TARGET_DOC,
          rooms: [
            {
              id: 'garage',
              usage: 'garage',
              boundary: [
                [10000, 100000],
                [28000, 100000],
                [28000, 112000],
                [10000, 112000]
              ]
            }
          ],
          junctionBoxLocation: [11000, 101000],
          beamYHighways: [105500]
        },
        { mcpReq: { id: 1 } }
      )
    )
    expect((out.violations as string[]).join(' ')).toContain('CALLER_GEOMETRY_REQUIRES_ACCEPT')
  })

  it('auto-derives the junction-box location from the one real block instance in the region', async () => {
    const bridge = new AttributedBridge() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)
    const cadState = sourceWithRows([
      {
        handle: 'JB1',
        kind: 'blockReference',
        layer: 'PCCC',
        blockName: 'HỘP NỐI DÂY',
        geometry: { blockName: 'HỘP NỐI DÂY', position: { x: 11000, y: 101000 } }
      }
    ])
    const handler = fireAlarmHandler(bridge, cadState)

    const { junctionBoxLocation: _dropped, ...withoutAnchor } = previewInput({
      symbolLibraryPath: LIBRARY_PATH,
      documentName: TARGET_DOC
    })
    const out = json(await handler(withoutAnchor, { mcpReq: { id: 1 } }))
    const text = (out.violations as string[]).join(' ')
    expect(text).not.toContain('NO_PANEL_ANCHOR')
    expect(text).not.toContain('PANEL_ANCHOR_AMBIGUOUS')
  })

  it('refuses to pick between two real junction-box instances, never auto-selecting one', async () => {
    const bridge = new AttributedBridge() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await seedLibrary(bridge)
    const cadState = sourceWithRows([
      {
        handle: 'JB1',
        kind: 'blockReference',
        layer: 'PCCC',
        blockName: 'HỘP NỐI DÂY',
        geometry: { blockName: 'HỘP NỐI DÂY', position: { x: 11000, y: 101000 } }
      },
      {
        handle: 'JB2',
        kind: 'blockReference',
        layer: 'PCCC',
        blockName: 'HỘP NỐI DÂY',
        geometry: { blockName: 'HỘP NỐI DÂY', position: { x: 20000, y: 101000 } }
      }
    ])
    const handler = fireAlarmHandler(bridge, cadState)

    const { junctionBoxLocation: _dropped, ...withoutAnchor } = previewInput({
      symbolLibraryPath: LIBRARY_PATH,
      documentName: TARGET_DOC
    })
    const out = json(await handler(withoutAnchor, { mcpReq: { id: 1 } }))
    const text = (out.violations as string[]).join(' ')
    expect(text).toContain('PANEL_ANCHOR_AMBIGUOUS')
    expect(text).toContain('JB1')
    expect(text).toContain('JB2')
  })

  it('derives a real structural beam axis from beam-layer geometry', () => {
    const derived = deriveBeamYHighways(
      [
        {
          handle: 'BEAM1',
          kind: 'line',
          layer: 'S-BEAM',
          geometry: { start: { x: 10000, y: 105500 }, end: { x: 30000, y: 105500 } }
        }
      ],
      0.001
    )
    expect(derived).toEqual([105500])
  })

  it('derives no beam axis when no layer in the region names a structural beam (regression guard)', () => {
    const derived = deriveBeamYHighways(
      [
        {
          handle: 'L1',
          kind: 'line',
          layer: 'A-WALL',
          geometry: { start: { x: 10000, y: 105500 }, end: { x: 30000, y: 105500 } }
        }
      ],
      0.001
    )
    expect(derived).toEqual([])
  })
})
