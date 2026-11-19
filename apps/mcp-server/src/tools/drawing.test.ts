import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import {
  DRAWING_INSPECT_TIMEOUT_MS,
  DRAWING_OPEN_TIMEOUT_MS,
  createCadStateSource,
  drawingInputSchema,
  drawingSetupOperationSchema,
  registerDrawingTools
} from './drawing.js'
import { portableInputSchema } from './portableSchema.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import { DocumentPin } from '../bridge/PinnedBridgeClient.js'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'

describe('drawing.setup allowlist (#62)', () => {
  test('accepts every allowlisted key', () => {
    const result = drawingSetupOperationSchema.safeParse({
      operation: 'setup',
      insUnits: 'mm',
      linearUnits: 'architectural',
      linearPrecision: 2,
      angularUnits: 'radians',
      ltScale: 50,
      celtScale: 1,
      dimScale: 100,
      lwDisplay: true,
      scale: 100,
      annotationScale: '1:100',
      documentName: 'Drawing1.dwg'
    })
    expect(result.success).toBe(true)
  })

  test('rejects an unknown key before it reaches the plugin', () => {
    const result = drawingSetupOperationSchema.safeParse({
      operation: 'setup',
      insUnits: 'mm',
      setvar: 'LUNITS'
    })
    expect(result.success).toBe(false)
  })

  test.each([
    ['insUnits', 'yards'],
    ['linearUnits', 'fractional'],
    ['angularUnits', 'gradians']
  ])('rejects an out-of-allowlist %s value', (field, value) => {
    const result = drawingSetupOperationSchema.safeParse({ operation: 'setup', [field]: value })
    expect(result.success).toBe(false)
  })

  test.each([
    ['linearPrecision', -1],
    ['linearPrecision', 9],
    ['ltScale', 0],
    ['ltScale', -5],
    ['celtScale', 0],
    ['dimScale', 0],
    ['scale', 0]
  ])('rejects out-of-range %s = %p', (field, value) => {
    const result = drawingSetupOperationSchema.safeParse({ operation: 'setup', [field]: value })
    expect(result.success).toBe(false)
  })

  test.each([
    ['annotationScale', 'abc'],
    ['annotationScale', '1-100'],
    ['annotationScale', '1:0']
  ])('rejects a malformed %s = %p', (field, value) => {
    const result = drawingSetupOperationSchema.safeParse({ operation: 'setup', [field]: value })
    expect(result.success).toBe(false)
  })

  test('accepts a well-formed annotationScale', () => {
    const result = drawingSetupOperationSchema.safeParse({
      operation: 'setup',
      annotationScale: '1:50'
    })
    expect(result.success).toBe(true)
  })

  test('linearPrecision must be an integer', () => {
    const result = drawingSetupOperationSchema.safeParse({
      operation: 'setup',
      linearPrecision: 2.5
    })
    expect(result.success).toBe(false)
  })
})

/**
 * Flattens the real `drawing` tool union the way tools/list does, so a test can assert the summary
 * operation is present and that adding it introduced no field-name collision (the flatten guard
 * throws at schema-build time — same posture as portableSchema.test.ts).
 */
function flattenDrawing(): Record<string, unknown> {
  const standard = portableInputSchema(drawingInputSchema)['~standard']
  return standard.jsonSchema.input({ target: 'draft-07' }) as Record<string, unknown>
}

describe('drawing.summary operation', () => {
  test('flattens without a field-name collision and advertises summary', () => {
    const schema = flattenDrawing()
    const properties = schema.properties as Record<string, { enum?: string[] }>
    expect(properties.operation?.enum).toContain('summary')
    // summary reuses only `documentName`, which every sibling operation already shares with the
    // same shape — flattening the whole union must not throw.
    expect(() => flattenDrawing()).not.toThrow()
  })

  test('the summary operation parses with just documentName', () => {
    const parsed = drawingInputSchema.safeParse({
      operation: 'summary',
      documentName: 'A-101.dwg'
    })
    expect(parsed.success).toBe(true)
  })
})

/**
 * Records the method + per-call options every request carries, wrapping MockBridgeClient so the
 * real handler runs against real mock behavior (same shape as refs.test.ts's SpyBridgeClient).
 */
class SpyBridgeClient implements BridgeClient {
  readonly inner = new MockBridgeClient()
  readonly calls: {
    method: RpcMethodName
    params: unknown
    options?: BridgeRequestOptions
  }[] = []

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    this.calls.push({ method, params, options })
    return this.inner.request(method, params, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

type DrawingHandler = (
  input: unknown,
  ctx: { mcpReq: { id: number; signal?: AbortSignal } }
) => Promise<unknown>

/**
 * Drives the real `drawing` tool handler (no transport): a test double for McpServer capturing the
 * callback registerDrawingTools passes. Only registerTool is exercised; McpServer's transport/
 * notification surface is irrelevant here, hence the named-const cast to the parameter type.
 */
function drawingHandler(spy: SpyBridgeClient): DrawingHandler {
  let handler!: DrawingHandler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: DrawingHandler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerDrawingTools>[0]
  registerDrawingTools(serverDouble, spy, new DocumentPin())
  return handler
}

/** Same driver as {@link drawingHandler}, for a bridge double that is not a {@link SpyBridgeClient}. */
function handlerForBridge(
  bridge: BridgeClient,
  cadState?: Parameters<typeof registerDrawingTools>[3]
): DrawingHandler {
  let handler!: DrawingHandler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: DrawingHandler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerDrawingTools>[0]
  registerDrawingTools(serverDouble, bridge, new DocumentPin(), cadState)
  return handler
}

describe('drawing.open per-call timeout + drawing.summary passthrough', () => {
  test("open passes DRAWING_OPEN_TIMEOUT_MS as the call's timeoutMs", async () => {
    const spy = new SpyBridgeClient()
    const handler = drawingHandler(spy)
    await handler({ operation: 'open', path: 'C:/drawings/big.dwg' }, { mcpReq: { id: 1 } })
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.method).toBe(RpcMethod.DrawingOpen)
    expect(spy.calls[0]!.options?.timeoutMs).toBe(DRAWING_OPEN_TIMEOUT_MS)
  })

  test('inspect_floorplan gets a timeout above the plugin walk budget, not the 15 s default', async () => {
    // Measured live: a sheet with ~2400 texts + ~1400 polylines blew through the gateway's 15 s
    // default, and because the plugin keeps walking inside one transaction on the main thread, every
    // later call on that instance timed out too — indistinguishable from a dead bridge. The caller
    // MUST outlast the plugin's own 30 s budget so the plugin, not the caller, decides when to stop.
    const spy = new SpyBridgeClient()
    const handler = drawingHandler(spy)
    await handler({ operation: 'inspect_floorplan', name: 'tầng hầm' }, { mcpReq: { id: 3 } })
    const inspect = spy.calls.find((c) => c.method === RpcMethod.DrawingInspectFloorplan)
    expect(inspect?.options?.timeoutMs).toBe(DRAWING_INSPECT_TIMEOUT_MS)
    expect(DRAWING_INSPECT_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  test('summary reaches the wire as drawing.summary with documentName only', async () => {
    const spy = new SpyBridgeClient()
    const handler = drawingHandler(spy)
    await handler({ operation: 'summary', documentName: 'Drawing2' }, { mcpReq: { id: 2 } })
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.method).toBe(RpcMethod.DrawingSummary)
    expect(spy.calls[0]!.params).toEqual({ documentName: 'Drawing2' })
    // No per-call timeout override: summary stays on the gateway default.
    expect(spy.calls[0]!.options).toBeUndefined()
  })

  test('inspect_floorplan delivers imageResult and passes parameters', async () => {
    const spy = new SpyBridgeClient()
    const handler = drawingHandler(spy)
    const result = (await handler(
      { operation: 'inspect_floorplan', name: 'tầng hầm' },
      { mcpReq: { id: 4 } }
    )) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }

    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.method).toBe(RpcMethod.DrawingInspectFloorplan)
    expect(spy.calls[0]!.params).toEqual({
      name: 'tầng hầm',
      documentName: undefined,
      layoutName: undefined,
      capture: true,
      width: undefined,
      height: undefined,
      // No selection: the plugin decides, and -1 is the wire's "not chosen" value.
      candidateIndex: -1
    })

    expect(result.content).toHaveLength(2)
    expect(result.content[0]!.type).toBe('text')
    expect(result.content[0]!.text).toContain('MẶT BẰNG TẦNG HẦM')
    expect(result.content[1]!.type).toBe('image')
    expect(result.content[1]!.mimeType).toBe('image/png')
    expect(result.content[1]!.data).toBeDefined()
  })

  test('inspect_floorplan forwards an explicit layoutName without switching tabs', async () => {
    const spy = new SpyBridgeClient()
    const handler = drawingHandler(spy)
    await handler(
      { operation: 'inspect_floorplan', name: 'Plan-A', layoutName: 'Plan-A', capture: false },
      { mcpReq: { id: 5 } }
    )
    const inspect = spy.calls.find((c) => c.method === RpcMethod.DrawingInspectFloorplan)
    expect(inspect?.params).toMatchObject({
      name: 'Plan-A',
      layoutName: 'Plan-A',
      capture: false
    })
  })

  describe('an unattributable floor plan stops instead of inviting a retry', () => {
    // What the plugin returns when it matched a title but the drawing gives no rectangle for it
    // (ambiguous: another plan's title shares the only geometry; unresolved: nothing is near
    // enough). Either way there are no bounds, so no capture and no image — and the tool must
    // answer with a stop instruction rather than a bare result that invites another inspect with
    // reworded input, which is how a run burns dozens of calls on one sheet.
    class UnattributableInspectBridge implements BridgeClient {
      constructor(private readonly regionBasis: string) {}

      async request<M extends RpcMethodName>(method: M): Promise<RpcMethodMap[M]['result']> {
        if (method !== RpcMethod.DrawingInspectFloorplan) throw new Error(`unexpected ${method}`)
        return {
          found: true,
          matchedName: 'MẶT BẰNG TẦNG HẦM',
          availableFloorplans: ['MẶT BẰNG TẦNG HẦM', 'MẶT BẰNG TẦNG 1'],
          layers: [],
          rooms: [],
          regionBasis: this.regionBasis,
          note: 'the only geometry containing this title also contains 1 other floor-plan title anchor(s)'
        } as RpcMethodMap[M]['result']
      }
      async close(): Promise<void> {}
    }

    for (const basis of ['ambiguous', 'unresolved']) {
      test(`regionBasis=${basis} yields text only, with candidates named`, async () => {
        let handler!: DrawingHandler
        const serverDouble = {
          registerTool: (_name: string, _defs: unknown, cb: DrawingHandler): void => {
            handler = cb
          }
        } as unknown as Parameters<typeof registerDrawingTools>[0]
        registerDrawingTools(
          serverDouble,
          new UnattributableInspectBridge(basis),
          new DocumentPin()
        )

        const result = (await handler(
          { operation: 'inspect_floorplan', name: 'tầng hầm' },
          { mcpReq: { id: 10 } }
        )) as { content: Array<{ type: string; text?: string }> }

        expect(result.content).toHaveLength(1)
        expect(result.content[0]!.type).toBe('text')
        const body = JSON.parse(result.content[0]!.text!) as {
          regionBasis: string
          bounds?: unknown
          note: string
          hint: string
        }
        expect(body.regionBasis).toBe(basis)
        expect(body.bounds).toBeUndefined()
        expect(body.note).toContain('other floor-plan title anchor(s)')
        expect(body.hint).toContain('Do not re-inspect')
        // The candidate list is what lets the model ask a precise question instead of guessing.
        expect(body.hint).toContain('MẶT BẰNG TẦNG 1')
      })
    }
  })

  describe('a plan title drawn several times on one sheet comes back as a choice, not a dead end', () => {
    // Measured live on the PCCC sheet: 10 plan names, each 5-6 merged block copies, boxes
    // 31367x23536 mm, zero pairwise overlap. The plugin can name every copy, so the tool must hand
    // the caller the frames and the way to pick one. Telling it to "ask the user which plan it is"
    // would be wrong (the plans are all identified) and re-searching with different wording changes
    // nothing, which is how a run burns calls on one sheet.
    class RepeatedPlanInspectBridge implements BridgeClient {
      constructor(private readonly candidateIndex = -1) {}
      readonly seen: number[] = []

      async request<M extends RpcMethodName>(
        method: M,
        params?: RpcMethodMap[M]['params']
      ): Promise<RpcMethodMap[M]['result']> {
        if (method !== RpcMethod.DrawingInspectFloorplan) throw new Error(`unexpected ${method}`)
        const p = (params ?? {}) as { candidateIndex?: number }
        this.seen.push(p.candidateIndex ?? -1)
        const copies: [number, number, number, number][] = [
          [3525, 450991, 34891, 474527],
          [73516, 450991, 104883, 474527],
          [143509, 450991, 174875, 474527]
        ]
        if (this.candidateIndex >= 0 && this.candidateIndex < copies.length)
          return {
            found: true,
            matchedName: 'MẶT BẰNG TẦNG HẦM',
            availableFloorplans: ['MẶT BẰNG TẦNG HẦM'],
            bounds: copies[this.candidateIndex],
            regionBasis: 'block-frame',
            layers: [],
            rooms: []
          } as RpcMethodMap[M]['result']
        return {
          found: true,
          matchedName: 'MẶT BẰNG TẦNG HẦM',
          availableFloorplans: ['MẶT BẰNG TẦNG HẦM'],
          regionBasis: 'ambiguous',
          regionCandidates: copies,
          note: "'MẶT BẰNG TẦNG HẦM' matches 3 copies of the same plan on this sheet",
          layers: [],
          rooms: []
        } as RpcMethodMap[M]['result']
      }
      async close(): Promise<void> {}
    }

    function handlerFor(bridge: RepeatedPlanInspectBridge): DrawingHandler {
      let handler!: DrawingHandler
      const serverDouble = {
        registerTool: (_name: string, _defs: unknown, cb: DrawingHandler): void => {
          handler = cb
        }
      } as unknown as Parameters<typeof registerDrawingTools>[0]
      registerDrawingTools(serverDouble, bridge, new DocumentPin())
      return handler
    }

    test('the candidates ride along, and the hint says pick one instead of re-searching', async () => {
      const result = (await handlerFor(new RepeatedPlanInspectBridge())(
        { operation: 'inspect_floorplan', name: 'tầng hầm' },
        { mcpReq: { id: 30 } }
      )) as { content: Array<{ text?: string }> }

      const body = JSON.parse(result.content[0]!.text!) as {
        regionBasis: string
        regionCandidates: [number, number, number, number][]
        hint: string
      }
      expect(body.regionBasis).toBe('ambiguous')
      expect(body.regionCandidates).toHaveLength(3)
      expect(body.hint).toContain('candidateIndex')
      expect(body.hint).toContain('3 separate copies')
      // The old wording told the model to ask the user which PLAN it is — wrong here: every copy is
      // the same identified plan.
      expect(body.hint).not.toContain('ask the user which plan')
    })

    test('candidateIndex is forwarded to the plugin and the chosen frame is attributed', async () => {
      const bridge = new RepeatedPlanInspectBridge(1)
      const result = (await handlerFor(bridge)(
        { operation: 'inspect_floorplan', name: 'tầng hầm', candidateIndex: 1 },
        { mcpReq: { id: 31 } }
      )) as { content: Array<{ text?: string }> }

      expect(bridge.seen).toEqual([1])
      const body = JSON.parse(result.content[0]!.text!) as {
        regionBasis: string
        bounds?: [number, number, number, number]
      }
      expect(body.regionBasis).toBe('block-frame')
      expect(body.bounds).toEqual([73516, 450991, 104883, 474527])
    })
    test('an out-of-range index comes back with the one usable frame, not a question for the user', async () => {
      // The plugin lists only frames it considers usable, so asking past the end can leave exactly
      // one choice. Withholding it (the old Count > 1 filter) made the tool fall back to "ask the
      // user which plan it is" - the dead end this contract exists to remove.
      class OneFrameLeftBridge implements BridgeClient {
        async request<M extends RpcMethodName>(method: M): Promise<RpcMethodMap[M]['result']> {
          if (method !== RpcMethod.DrawingInspectFloorplan) throw new Error(`unexpected ${method}`)
          return {
            found: true,
            matchedName: 'MẶT BẰNG TẦNG HẦM',
            availableFloorplans: ['MẶT BẰNG TẦNG HẦM'],
            regionBasis: 'ambiguous',
            regionCandidates: [[1000, 200000, 32367, 223536]],
            note: 'this title has 1 usable frame(s) on the sheet; candidateIndex 5 is out of range',
            layers: [],
            rooms: []
          } as RpcMethodMap[M]['result']
        }
        async close(): Promise<void> {}
      }

      const result = (await handlerForBridge(new OneFrameLeftBridge())(
        { operation: 'inspect_floorplan', name: 'tầng hầm', candidateIndex: 5 },
        { mcpReq: { id: 32 } }
      )) as { content: Array<{ text?: string }> }
      const body = JSON.parse(result.content[0]!.text!) as { regionCandidates: unknown[]; hint: string }

      expect(body.regionCandidates).toHaveLength(1)
      expect(body.hint).toContain('candidateIndex: 0')
      expect(body.hint).not.toContain('ask the user')
    })
  })

  describe('a region walk that ran out of its budget is not reported as a missing plan', () => {
    // On a sheet too large to walk in time the plugin stops itself and returns this shape: no bounds,
    // no rooms, `stoppedReason: 'budget'`. The generic unattributable hint would claim "Titles found:
    // (none)" — false, since the walk never finished reading them — and would push the model to ask
    // the user about a plan that may be there. The tool must name the real limit instead.
    class BudgetStoppedInspectBridge implements BridgeClient {
      async request<M extends RpcMethodName>(method: M): Promise<RpcMethodMap[M]['result']> {
        if (method !== RpcMethod.DrawingInspectFloorplan) throw new Error(`unexpected ${method}`)
        return {
          found: false,
          availableFloorplans: [],
          layers: [],
          rooms: [],
          regionBasis: 'unresolved',
          stoppedReason: 'budget',
          note: 'The floor-plan region walk exceeded its 30s budget on this drawing and stopped without choosing a region.'
        } as RpcMethodMap[M]['result']
      }
      async close(): Promise<void> {}
    }

    test('stoppedReason=budget yields a shrink-the-read hint, not "no titles found"', async () => {
      const result = (await handlerForBridge(new BudgetStoppedInspectBridge())(
        { operation: 'inspect_floorplan', name: 'tầng hầm' },
        { mcpReq: { id: 12 } }
      )) as { content: Array<{ type: string; text?: string }> }

      expect(result.content).toHaveLength(1)
      const body = JSON.parse(result.content[0]!.text!) as {
        regionBasis: string
        bounds?: unknown
        rooms?: unknown[]
        stoppedReason: string
        hint: string
      }
      expect(body.regionBasis).toBe('unresolved')
      expect(body.stoppedReason).toBe('budget')
      expect(body.bounds).toBeUndefined()
      expect(body.rooms).toHaveLength(0)
      expect(body.hint).toContain('stoppedReason: budget')
      expect(body.hint).toContain('do not design over the whole drawing')
      expect(body.hint).toContain('Shrink the read')
      // The claim the old hint would have made is exactly what must NOT be asserted here.
      expect(body.hint).not.toContain('Titles found: (none)')
    })
  })

  describe('a failed capture keeps the CAD data instead of inviting a re-inspect', () => {
    // The region WAS attributed (so bounds + rooms are valid) but the off-screen PNG render threw.
    // The plugin now reports that as capture.status:'failed' rather than failing the whole RPC. The
    // tool must still hand back every room it read and must NOT tell the model to re-inspect — a
    // missing image is not a reason to repeat the entire read.
    class CaptureFailedInspectBridge implements BridgeClient {
      async request<M extends RpcMethodName>(method: M): Promise<RpcMethodMap[M]['result']> {
        if (method !== RpcMethod.DrawingInspectFloorplan) throw new Error(`unexpected ${method}`)
        return {
          found: true,
          matchedName: 'MẶT BẰNG TẦNG HẦM',
          availableFloorplans: ['MẶT BẰNG TẦNG HẦM', 'MẶT BẰNG TẦNG 1'],
          bounds: [-1616.93, 98162.68, 34155.21, 124054.92],
          layers: ['A-WALL', 'S-COLS'],
          rooms: [{ name: 'GARA', labelPosition: [10000, 105000] }],
          regionBasis: 'connected-geometry',
          data: undefined,
          mimeType: undefined,
          capture: { status: 'failed', source: 'offscreen', error: 'Operation is not valid' }
        } as RpcMethodMap[M]['result']
      }
      async close(): Promise<void> {}
    }

    test('textResult carries rooms + failed capture, with a proceed (not re-inspect) hint', async () => {
      const result = (await handlerForBridge(new CaptureFailedInspectBridge())(
        { operation: 'inspect_floorplan', name: 'tầng hầm' },
        { mcpReq: { id: 11 } }
      )) as { content: Array<{ type: string; text?: string; data?: string }> }

      // No image part: capture failed.
      expect(result.content).toHaveLength(1)
      expect(result.content[0]!.type).toBe('text')
      const body = JSON.parse(result.content[0]!.text!) as {
        bounds: unknown
        rooms: Array<{ name: string; labelPosition: [number, number] }>
        capture: { status: string; error?: string }
        hint: string
      }
      // The CAD the same pass read survives.
      expect(body.bounds).toBeDefined()
      expect(body.rooms).toHaveLength(1)
      expect(body.rooms[0]!.name).toBe('GARA')
      expect(body.capture.status).toBe('failed')
      expect(body.capture.error).toContain('not valid')
      // The hint must steer forward, and must NOT invite another read.
      expect(body.hint).toContain('The CAD data above is complete')
      expect(body.hint).toContain('do not re-inspect')
    })
  })

  describe('Slice 02 one-call geometry over CAD State', () => {
    // An attributed region (regionBasis + bounds + a labelled room) as the plugin now reports it,
    // carrying the identity/unit fields that let the Cloud tool bind the snapshot without a probe.
    class AttributedInspectBridge implements BridgeClient {
      constructor(private readonly units: string = 'mm', private readonly basis: string = 'connected-geometry') {}
      async request<M extends RpcMethodName>(method: M): Promise<RpcMethodMap[M]['result']> {
        if (method !== RpcMethod.DrawingInspectFloorplan) throw new Error(`unexpected ${method}`)
        return {
          found: true,
          matchedName: 'MẶT BẰNG TẦNG HẦM',
          availableFloorplans: ['MẶT BẰNG TẦNG HẦM'],
          bounds: [0, 0, 10000, 10000],
          layers: ['A-WALL'],
          rooms: [{ name: 'GARA', labelPosition: [2000, 2500] }],
          regionBasis: this.basis,
          documentId: 'doc_1',
          revision: 'tdu:100;saves:1',
          fingerprintGuid: 'abc',
          units: this.units,
          capture: { status: 'ok', source: 'offscreen' }
        } as RpcMethodMap[M]['result']
      }
      async close(): Promise<void> {}
    }

    // A closed 4000x5000 ring that contains the GARA label (2000,2500).
    const ringGeom = {
      closed: true,
      vertices: [
        { point: { x: 0, y: 0 } },
        { point: { x: 4000, y: 0 } },
        { point: { x: 4000, y: 5000 } },
        { point: { x: 0, y: 5000 } }
      ]
    }

    type CadState = Parameters<typeof registerDrawingTools>[3]
    function fakeSource(overrides: Partial<NonNullable<CadState>> = {}) {
      let hydrateCalls = 0
      const base: NonNullable<CadState> = {
        async snapshotFor() {
          return { snapshotId: 'snap_1', fresh: true }
        },
        async rowsInWindow() {
          return [{ handle: 'A1', kind: 'polyline', geometry: ringGeom }]
        },
        async hydrate() {
          return []
        },
        ...overrides
      }
      // Wrap so the counter tracks every hydrate call, whether the default or an override ran.
      const inner = base.hydrate
      const source: NonNullable<CadState> = {
        ...base,
        hydrate: (handles, identity) => {
          hydrateCalls++
          return inner(handles, identity)
        }
      }
      return { source, hydrateCalls: () => hydrateCalls }
    }

    async function inspectBody(cadState: CadState) {
      const result = (await handlerForBridge(new AttributedInspectBridge(), cadState)(
        { operation: 'inspect_floorplan', name: 'tầng hầm' },
        { mcpReq: { id: 20 } }
      )) as { content: Array<{ type: string; text?: string }> }
      // This bridge returns no PNG, so the payload is a single text result.
      return JSON.parse(result.content[0]!.text!) as {
        rooms: Array<{
          name: string
          boundaryStatus: string
          boundary?: unknown
          ref?: string
          areaM2?: number
        }>
        geometryComplete?: boolean
        coordinateSystem?: string
        geometryNote?: string
      }
    }

    test('a block-frame region is attributed too: boundaries assemble the same way', async () => {
      // `attributed` is one shared boolean gating both the CAD State enrichment and the capture hint.
      // Without this case, narrowing it back to title-frame/connected-geometry would silently stop
      // assembling boundaries on one-block-per-floor drawings - the shape real PCCC sheets arrive in.
      const { source, hydrateCalls } = fakeSource()
      const result = (await handlerForBridge(new AttributedInspectBridge('mm', 'block-frame'), source)(
        { operation: 'inspect_floorplan', name: 'tầng hầm' },
        { mcpReq: { id: 22 } }
      )) as { content: Array<{ text?: string }> }
      const body = JSON.parse(result.content[0]!.text!) as {
        regionBasis: string
        rooms: Array<{ boundaryStatus: string; boundary?: unknown; ref?: string }>
        geometryComplete?: boolean
      }
      expect(body.regionBasis).toBe('block-frame')
      expect(body.rooms[0]!.boundaryStatus).toBe('verified')
      expect(body.rooms[0]!.boundary).toBeDefined()
      expect(body.geometryComplete).toBe(true)
      expect(hydrateCalls()).toBe(0)
    })

    test('warm snapshot: room boundary verified, ZERO extra cad.scan', async () => {
      const { source, hydrateCalls } = fakeSource()
      const body = await inspectBody(source)
      expect(body.rooms[0]!.boundaryStatus).toBe('verified')
      expect(body.rooms[0]!.boundary).toBeDefined()
      expect(body.rooms[0]!.ref).toBe('fp_tdu:100;saves:1:GARA')
      expect(body.geometryComplete).toBe(true)
      expect(body.coordinateSystem).toBe('WCS')
      // Summary rows already carry geometry -> no hydrate round trip at all.
      expect(hydrateCalls()).toBe(0)
    })

    test('region rows lack geometry: exactly ONE bounded cad.scan hydrate', async () => {
      const { source, hydrateCalls } = fakeSource({
        rowsInWindow: async () => [{ handle: 'A1', kind: 'polyline', geometry: null }],
        hydrate: async () => [{ handle: 'A1', kind: 'polyline', geometry: ringGeom }]
      })
      const body = await inspectBody(source)
      expect(hydrateCalls()).toBe(1)
      expect(body.rooms[0]!.boundaryStatus).toBe('verified')
      expect(body.rooms[0]!.areaM2).toBeCloseTo(20, 1)
    })

    test('no verified snapshot: rooms unresolved, NO fabricated polygon, no scan', async () => {
      const { source, hydrateCalls } = fakeSource({ snapshotFor: async () => null })
      const body = await inspectBody(source)
      expect(body.rooms[0]!.boundaryStatus).toBe('unresolved')
      expect(body.rooms[0]!.boundary).toBeUndefined()
      expect(body.geometryComplete).toBe(false)
      expect(body.geometryNote).toBeDefined()
      // A snapshot that is not current must not even trigger a region scan.
      expect(hydrateCalls()).toBe(0)
    })

    test('no source wired at all still fails closed (rooms unresolved)', async () => {
      const body = await inspectBody(undefined)
      expect(body.rooms[0]!.boundaryStatus).toBe('unresolved')
      expect(body.rooms[0]!.boundary).toBeUndefined()
    })

    test('a framed region with no room labels still states why', async () => {
      // Measured live on BOTH real sheets: the frame resolves (`title-frame` / `block-frame`) and
      // `rooms` is empty, because a block-merged drawing carries no room text in model space at any
      // depth. Gating the enrichment on rooms.length > 0 dropped geometryComplete, coordinateSystem
      // and geometryNote for exactly those results, so a caller could not tell "this drawing has no
      // labels" from "the CAD State index was unusable".
      class LabellessInspectBridge extends AttributedInspectBridge {
        override async request<M extends RpcMethodName>(method: M): Promise<RpcMethodMap[M]['result']> {
          const base = await super.request(method)
          return { ...base, rooms: [] } as RpcMethodMap[M]['result']
        }
      }
      const { source, hydrateCalls } = fakeSource()
      const result = (await handlerForBridge(new LabellessInspectBridge(), source)(
        { operation: 'inspect_floorplan', name: 'mặt bằng mái' },
        { mcpReq: { id: 23 } }
      )) as { content: Array<{ text?: string }> }
      const body = JSON.parse(result.content[0]!.text!) as {
        rooms: unknown[]
        geometryComplete?: boolean
        coordinateSystem?: string
        geometryNote?: string
      }
      expect(body.rooms).toHaveLength(0)
      expect(body.coordinateSystem).toBe('WCS')
      expect(body.geometryComplete).toBe(false)
      expect(body.geometryNote).toContain('no room labels')
      // A label-less region must not spend an index query either.
      expect(hydrateCalls()).toBe(0)
    })

    test('areas use the drawing units the plugin reported, not a mm assumption', async () => {
      // Live SUNLAND reports INSUNITS = "in". A ring of 4000x5000 drawing units is 20 m² in mm but
      // 12903 m² in inches; pinning the conversion prevents a ~39x area error feeding sprinkler
      // hazard-group selection.
      const { source } = fakeSource()
      const result = (await handlerForBridge(new AttributedInspectBridge('in'), source)(
        { operation: 'inspect_floorplan', name: 'tầng hầm' },
        { mcpReq: { id: 21 } }
      )) as { content: Array<{ text?: string }> }
      const body = JSON.parse(result.content[0]!.text!) as {
        rooms: Array<{ boundaryStatus: string; areaM2?: number }>
      }
      expect(body.rooms[0]!.boundaryStatus).toBe('verified')
      expect(body.rooms[0]!.areaM2).toBeCloseTo(4000 * 5000 * 0.0254 * 0.0254, 0)
    })
  })

  test('info stays on the default timeout (no options)', async () => {
    const spy = new SpyBridgeClient()
    const handler = drawingHandler(spy)
    await handler({ operation: 'info' }, { mcpReq: { id: 3 } })
    expect(spy.calls[0]!.method).toBe(RpcMethod.DrawingInfo)
    expect(spy.calls[0]!.options).toBeUndefined()
  })
})

describe('layout-scoped CAD geometry scan', () => {
  test('filters to polylines and reads every page at the inspected layout/document revision', async () => {
    class LayoutScanBridge extends SpyBridgeClient {
      override async request<M extends RpcMethodName>(
        method: M,
        params: RpcMethodMap[M]['params'],
        options?: BridgeRequestOptions
      ): Promise<RpcMethodMap[M]['result']> {
        this.calls.push({ method, params, options })
        if (method !== RpcMethod.CadScan) throw new Error(`unexpected ${method}`)
        const request = params as RpcMethodMap[typeof RpcMethod.CadScan]['params']
        const offset = request.offset
        return {
          documentId: 'doc-1',
          name: 'A.dwg',
          path: null,
          fingerprintGuid: null,
          layoutName: 'Plan-A',
          revisionBefore: 'rev-1',
          revisionAfter: 'rev-1',
          insUnits: 'mm',
          total: 3,
          offset,
          hasMore: offset === 0,
          entities:
            offset === 0
              ? [
                  { handle: 'A1', kind: 'polyline', layer: 'ROOM', geometry: { closed: true } },
                  { handle: 'A2', kind: 'polyline', layer: 'ROOM', geometry: { closed: true } }
                ]
              : [{ handle: 'A3', kind: 'polyline', layer: 'ROOM', geometry: { closed: true } }]
        } as RpcMethodMap[M]['result']
      }
    }
    const bridge = new LayoutScanBridge()
    const source = createCadStateSource('workspace-1', bridge)
    const scan = await source.scanLayout?.(
      'Plan-A',
      { documentId: 'doc-1', documentName: 'A.dwg', revision: 'rev-1' },
      2
    )

    expect(scan?.complete).toBe(true)
    expect(scan?.rows.map((row) => row.handle)).toEqual(['A1', 'A2', 'A3'])
    expect(bridge.calls).toHaveLength(2)
    expect(bridge.calls.map((call) => call.options?.timeoutMs)).toEqual([
      DRAWING_INSPECT_TIMEOUT_MS,
      DRAWING_INSPECT_TIMEOUT_MS
    ])
    expect(bridge.calls.map((call) => call.params)).toEqual([
      {
        documentName: 'doc-1',
        layoutName: 'Plan-A',
        kind: 'polyline',
        offset: 0,
        limit: 2,
        detail: 'full'
      },
      {
        documentName: 'doc-1',
        layoutName: 'Plan-A',
        kind: 'polyline',
        offset: 2,
        limit: 2,
        detail: 'full'
      }
    ])
  })

  test('rejects a partial or revision-mismatched layout scan', async () => {
    class ChangedLayoutBridge extends SpyBridgeClient {
      override async request<M extends RpcMethodName>(
        method: M,
        params: RpcMethodMap[M]['params'],
        options?: BridgeRequestOptions
      ): Promise<RpcMethodMap[M]['result']> {
        this.calls.push({ method, params, options })
        return {
          documentId: 'doc-1',
          layoutName: 'Plan-A',
          revisionBefore: 'rev-1',
          revisionAfter: 'rev-2',
          total: 2001,
          offset: 0,
          hasMore: true,
          entities: []
        } as RpcMethodMap[M]['result']
      }
    }
    const source = createCadStateSource('workspace-1', new ChangedLayoutBridge())
    const scan = await source.scanLayout?.(
      'Plan-A',
      { documentId: 'doc-1', revision: 'rev-1' },
      2000
    )
    expect(scan?.complete).toBe(false)
    expect(scan?.rows).toEqual([])
    expect(scan?.note).toContain('changed during or after the scan')
  })

  test('discards all rows if the drawing changes between layout pages', async () => {
    class MidScanEditBridge extends SpyBridgeClient {
      override async request<M extends RpcMethodName>(
        method: M,
        params: RpcMethodMap[M]['params'],
        options?: BridgeRequestOptions
      ): Promise<RpcMethodMap[M]['result']> {
        this.calls.push({ method, params, options })
        if (method !== RpcMethod.CadScan) throw new Error(`unexpected ${method}`)
        const request = params as RpcMethodMap[typeof RpcMethod.CadScan]['params']
        const offset = request.offset ?? 0
        const firstPage = offset === 0
        const revision = firstPage ? 'rev-1' : 'rev-2'
        return {
          documentId: 'doc-1',
          name: 'A.dwg',
          path: null,
          fingerprintGuid: null,
          layoutName: 'Plan-A',
          revisionBefore: revision,
          revisionAfter: revision,
          insUnits: 'mm',
          total: 3,
          offset,
          hasMore: firstPage,
          entities: firstPage
            ? [
                { handle: 'A1', kind: 'polyline', layer: 'ROOM', geometry: { closed: true } },
                { handle: 'A2', kind: 'polyline', layer: 'ROOM', geometry: { closed: true } }
              ]
            : [{ handle: 'A3', kind: 'polyline', layer: 'ROOM', geometry: { closed: true } }]
        } as RpcMethodMap[M]['result']
      }
    }
    const bridge = new MidScanEditBridge()
    const source = createCadStateSource('workspace-1', bridge)
    const scan = await source.scanLayout?.('Plan-A', { documentId: 'doc-1', revision: 'rev-1' }, 2)

    expect(scan?.complete).toBe(false)
    expect(scan?.rows).toEqual([])
    expect(scan?.note).toContain('changed during or after the scan')
    expect(bridge.calls).toHaveLength(2)
  })
})
