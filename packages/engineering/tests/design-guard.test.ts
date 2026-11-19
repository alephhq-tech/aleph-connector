import { describe, expect, it } from 'bun:test'
import {
  ARCHITECTURAL_ARM_THRESHOLD,
  ValidationStore,
  guardCadMutation,
  operationFingerprint,
  type GuardContext,
  type IssueRecordInput
} from '../src/index'

/**
 * The preflight guard is the piece that turns "the engine can validate a layout" into "an
 * unvalidated layout never reaches AutoCAD". These tests pin the decisions, not the plumbing: what
 * arms a run, what authorizes a mutation, and what a caller cannot talk its way past.
 *
 * Units: millimetres, the Aleph drawing convention.
 */

const store = () => new ValidationStore()

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  risk: 'destructive',
  input: {},
  runId: 'run-1',
  workspaceId: 'ws-1',
  ...over
})

const createOp = (x: number, y: number) => ({
  operation: 'create',
  entity: { kind: 'blockReference', blockName: 'SOFA', position: { x, y } }
})

const batch = (n: number) => ({
  operation: 'apply',
  documentName: 'house.dwg',
  operations: Array.from({ length: n }, (_, i) => ({
    op: 'create',
    entity: createOp(i * 1000, 0)
  }))
})

function issuePass(s: ValidationStore, over: Partial<IssueRecordInput> = {}) {
  return s.issue({
    runId: 'run-1',
    workspaceId: 'ws-1',
    deviceId: null,
    documentName: 'house.dwg',
    documentRevision: 'tdu:100;saves:1',
    drawingFingerprint: 'draw_a',
    layoutFingerprint: 'lay_a',
    operationFingerprint: 'op_a',
    result: 'PASS',
    findings: [],
    ...over
  })
}

describe('design guard — arming', () => {
  it('CAD reads never arm a run, however many there are', async () => {
    const s = store()
    // The large-drawing workflow the drafting guide prescribes: several windowed entity.list calls.
    // `entity` is annotated destructive (the tool can erase), so classification by tool risk alone
    // would arm the run on pure reads.
    for (let i = 0; i < 6; i += 1) {
      const d = await guardCadMutation(
        ctx({
          input: {
            operation: 'list',
            detail: 'full',
            window: { min: { x: 0, y: i * 5000 }, max: { x: 5000, y: (i + 1) * 5000 } }
          }
        }),
        { store: s }
      )
      expect(d.blocked).toBe(false)
      expect(d.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
    expect(s.placementsFor('run-1')).toBe(0)
  })

  it('drawing.info and drawing.summary are reads too', async () => {
    const s = store()
    for (const operation of ['info', 'summary', 'check', 'status']) {
      const d = await guardCadMutation(ctx({ input: { operation, documentName: 'house.dwg' } }), {
        store: s
      })
      expect(d.blocked).toBe(false)
      expect(d.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
  })

  it('inspect, scan, changes, zoom, zoom_extents, get_live, and area_measure are reads too', async () => {
    const s = store()
    const reads: Array<Record<string, unknown>> = [
      { operation: 'inspect', handle: 'H1' },
      { operation: 'scan', kind: 'line', limit: 100 },
      { operation: 'changes', since: 1 },
      { operation: 'zoom', center: [100, 200], height: 500 },
      { operation: 'zoom_extents' },
      { operation: 'get_live' },
      { operation: 'area_measure', window: { min: [0, 0], max: [100, 100] } }
    ]
    for (const input of reads) {
      const d = await guardCadMutation(ctx({ input }), { store: s })
      expect(d.blocked).toBe(false)
      expect(d.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
    expect(s.placementsFor('run-1')).toBe(0)
  })

  it('drawing.cleanup with fixes counts as destructive placement even without handles, but dryRun counts 0', async () => {
    const s = store()
    // dryRun default or explicit true Preview touches nothing.
    const dry = await guardCadMutation(
      ctx({ input: { operation: 'cleanup', fixes: ['duplicates', 'zeroLength'], dryRun: true } }),
      { store: s }
    )
    expect(dry.blocked).toBe(false)
    expect(dry.placements).toBe(0)

    // dryRun: false is a whole-drawing destructive sweep — must be counted as a placement
    // so an architectural session cannot wipe user entities without a validation ticket.
    const sweep = await guardCadMutation(
      ctx({ input: { operation: 'cleanup', fixes: ['duplicates', 'zeroLength'], dryRun: false } }),
      { store: s }
    )
    expect(sweep.placements).toBe(1)
    expect(s.placementsFor('run-1')).toBe(1)
  })
  it('a run becomes protected once it has placed a layout, and that call is refused', async () => {
    const s = store()
    for (let i = 1; i < ARCHITECTURAL_ARM_THRESHOLD; i += 1) {
      const d = await guardCadMutation(ctx({ input: createOp(i * 1000, 0) }), { store: s })
      expect(d.blocked).toBe(false)
      expect(s.isProtected('run-1')).toBe(false)
    }
    const armed = await guardCadMutation(ctx({ input: createOp(9000, 0) }), { store: s })
    expect(armed.blocked).toBe(true)
    expect(armed.armed).toBe(true)
    expect(armed.code).toBe('ARCHITECTURAL_SESSION_ARMED')
    // The reason has to teach the validated path, not just deny.
    expect(armed.reason).toContain('spatial_validate_layout')
    expect(s.isProtected('run-1')).toBe(true)
  })

  it('arming is cumulative across calls, not per call', async () => {
    const s = store()
    await guardCadMutation(ctx({ input: createOp(0, 0) }), { store: s })
    await guardCadMutation(ctx({ input: createOp(1000, 0) }), { store: s })
    const third = await guardCadMutation(ctx({ input: batch(1) }), { store: s })
    expect(third.blocked).toBe(true)
    expect(s.placementsFor('run-1')).toBe(ARCHITECTURAL_ARM_THRESHOLD)
  })

  it('a read capability is never guarded, whatever it carries', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(
      ctx({
        risk: 'read',
        input: { operation: 'list', window: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } } }
      }),
      { store: s }
    )
    expect(d.blocked).toBe(false)
  })

  it('a dryRun preview draws nothing and never arms a run', async () => {
    const s = store()
    for (let i = 0; i < 5; i += 1) {
      const d = await guardCadMutation(
        ctx({
          input: {
            operation: 'walls',
            dryRun: true,
            centerline: [
              { x: 0, y: 0 },
              { x: 6000, y: 0 }
            ],
            thickness: 200
          }
        }),
        { store: s }
      )
      expect(d.blocked).toBe(false)
      expect(d.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
  })

  it('a CAD read is exempt by operation even when the provider labels the tool write', async () => {
    // Flow B reality: the Desktop Node advertises every MCP tool as `write`, including the drawing
    // metadata read. The revision probe re-enters the registry to call exactly that tool, so if the
    // exemption keyed on risk instead of operation, the probe would arm or block the run it serves.
    const s = store()
    for (const operation of ['info', 'summary', 'list']) {
      const d = await guardCadMutation(
        ctx({
          risk: 'write',
          input: {
            operation,
            documentName: 'house.dwg',
            ...(operation === 'list' ? { detail: 'full' } : {})
          }
        }),
        { store: s }
      )
      expect(d.blocked).toBe(false)
      expect(d.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
  })
})
describe('design guard — no self-declared exemptions (#282 slice 00)', () => {
  const eraseOnly = {
    operation: 'apply',
    documentName: 'house.dwg',
    operations: [{ id: 'e-1', op: 'erase', handles: ['1A', '1B'] }]
  }

  it('an erase-only batch is guarded, not read as "nothing changes"', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(ctx({ input: eraseOnly }), { store: s })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('VALIDATION_REQUIRED')
    expect(d.placements).toBe(1)
  })

  it('a single entity.erase counts as a destructive change', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(
      ctx({ input: { operation: 'erase', handles: ['1A'], documentName: 'house.dwg' } }),
      { store: s }
    )
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('VALIDATION_REQUIRED')
  })

  it('a workingCopy flag authorizes nothing', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(ctx({ input: { ...batch(1), workingCopy: true } }), {
      store: s
    })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('VALIDATION_REQUIRED')
  })

  it('a PCCC/wiring layer name authorizes nothing', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(
      ctx({
        input: {
          operation: 'apply',
          documentName: 'house.dwg',
          operations: Array.from({ length: 3 }, (_, i) => ({
            op: 'create',
            entity: {
              kind: 'line',
              layer: 'PCCC-PIPE',
              start: [i * 1000, 0],
              end: [i * 1000, 500]
            }
          }))
        }
      }),
      { store: s }
    )
    expect(d.blocked).toBe(true)
    expect(d.placements).toBe(3)
    expect(s.isProtected('run-1')).toBe(true)
  })

  it('erasing and drawing in one batch counts each step once', async () => {
    const s = store()
    const d = await guardCadMutation(
      ctx({
        input: {
          operation: 'apply',
          documentName: 'house.dwg',
          operations: [
            { id: 'e-1', op: 'erase', handles: ['1A'] },
            { id: 'e-2', op: 'erase', handles: ['1B'] },
            {
              id: 'c-1',
              op: 'create',
              entity: { kind: 'line', layer: 'W', start: [0, 0], end: [1, 1] }
            }
          ]
        }
      }),
      { store: s }
    )
    expect(d.placements).toBe(3)
    expect(s.placementsFor('run-1')).toBe(3)
    expect(d.blocked).toBe(true)
    expect(d.armed).toBe(true)
    expect(d.code).toBe('ARCHITECTURAL_SESSION_ARMED')
  })

  it('reads and dryRun previews stay free, including erase-shaped dryRun', async () => {
    const s = store()
    for (const input of [
      { operation: 'list', detail: 'full', documentName: 'house.dwg' },
      { operation: 'check', documentName: 'house.dwg' },
      { operation: 'cleanup', dryRun: true, fixes: ['duplicates'], documentName: 'house.dwg' },
      { operation: 'preview', editId: 'edit_1', documentName: 'house.dwg' },
      { operation: 'status', editId: 'edit_1', documentName: 'house.dwg' }
    ]) {
      const d = await guardCadMutation(ctx({ input }), { store: s })
      expect(d.blocked).toBe(false)
      expect(d.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
  })

  it('edit.apply in a protected run without a validation ticket is refused (PR B slice 03)', async () => {
    const s = store()
    s.arm('run-1')
    const applyInput = {
      operation: 'apply',
      editId: 'edit_1',
      documentName: 'house.dwg',
      operations: [
        {
          op: 'create',
          entity: { kind: 'blockReference', blockName: 'CHAIR', position: { x: 1000, y: 0 } }
        }
      ]
    }
    const d = await guardCadMutation(ctx({ input: applyInput }), { store: s })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('VALIDATION_REQUIRED')
  })
  it('adding workingCopy to a validated payload is a different payload', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const d = await guardCadMutation(
      ctx({ input: { ...payload, workingCopy: true, validationId: record.id } }),
      { store: s }
    )
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_OPERATION_MISMATCH')
  })
})

describe('design guard — authorization', () => {
  it('a protected run with no ticket is refused', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(ctx({ input: batch(4) }), { store: s })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('VALIDATION_REQUIRED')
  })

  it('a ticket the caller invented authorizes nothing', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(
      ctx({ input: { ...batch(4), validationId: 'svr_i_made_this_up' } }),
      {
        store: s
      }
    )
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_NOT_FOUND')
  })

  it('the exact validated batch goes through, and the ticket is spent', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(4)
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const ok = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(ok.blocked).toBe(false)
    // Dispatch authorization is a CLAIM, not a commit: the drawing has not been touched yet, so
    // nothing may report a commit before the provider's receipt arrives.
    expect(s.stateOf(record.id)).toBe('claimed')
    expect(s.isCommitted(record.id)).toBe(false)

    // One record, one batch: a second dispatch while the first is unsettled is refused.
    const replay = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(replay.blocked).toBe(true)
    expect(replay.code).toBe('RECORD_IN_FLIGHT')

    // The provider reported the commit; the record is now spent for good.
    s.markCommitted(record.id, 'batch_77')
    expect(s.isCommitted(record.id)).toBe(true)
    const afterCommit = await guardCadMutation(
      ctx({ input: { ...payload, validationId: record.id } }),
      { store: s }
    )
    expect(afterCommit.blocked).toBe(true)
    expect(afterCommit.code).toBe('RECORD_ALREADY_USED')
  })

  it('a different payload under a valid ticket is refused', async () => {
    const s = store()
    s.arm('run-1')
    const record = issuePass(s, { operationFingerprint: operationFingerprint(batch(4)) })
    const swapped = await guardCadMutation(
      ctx({ input: { ...batch(9), validationId: record.id } }),
      { store: s }
    )
    expect(swapped.blocked).toBe(true)
    expect(swapped.code).toBe('RECORD_OPERATION_MISMATCH')
  })

  it('the ticket field itself never changes the payload digest', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(3)
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(d.blocked).toBe(false)
  })

  it('a ticket for another document is refused', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const d = await guardCadMutation(
      ctx({ input: { ...payload, documentName: 'other.dwg', validationId: record.id } }),
      { store: s }
    )
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_DOCUMENT_MISMATCH')
  })

  it('a ticket minted for another run or workspace is refused', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const foreign = issuePass(s, {
      runId: 'run-somebody-else',
      operationFingerprint: operationFingerprint(payload)
    })
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: foreign.id } }), {
      store: s
    })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_SCOPE_MISMATCH')

    const otherWs = issuePass(s, {
      workspaceId: 'ws-other',
      operationFingerprint: operationFingerprint(payload)
    })
    const d2 = await guardCadMutation(ctx({ input: { ...payload, validationId: otherWs.id } }), {
      store: s
    })
    expect(d2.blocked).toBe(true)
    expect(d2.code).toBe('RECORD_SCOPE_MISMATCH')
  })

  it('a FAIL record can never authorize a mutation', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, {
      result: 'FAIL',
      operationFingerprint: operationFingerprint(payload),
      findings: [
        {
          code: 'DOOR_SWING_COLLISION',
          severity: 'error',
          status: 'FAIL',
          entityIds: ['d1'],
          constraintId: 'door-swing',
          message: 'sofa sits in the door sweep'
        }
      ]
    })
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_NOT_PASS')
    // The blocking finding is named, so the agent knows what to fix.
    expect(d.reason).toContain('DOOR_SWING_COLLISION')
  })

  it('an expired record is refused', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload), ttlMs: -1 })
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_EXPIRED')
  })
  it('reusing an already-committed ticket is refused (single-use guarantee)', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })

    const d1 = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(d1.blocked).toBe(false)
    s.markCommitted(record.id)

    const d2 = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(d2.blocked).toBe(true)
    expect(d2.code).toBe('RECORD_ALREADY_USED')
  })

  it('a payload whose operations or coordinates were modified is refused', async () => {
    const s = store()
    s.arm('run-1')
    const originalPayload = batch(2)
    const record = issuePass(s, { operationFingerprint: operationFingerprint(originalPayload) })

    const modifiedPayload = {
      ...originalPayload,
      operations: [...originalPayload.operations, { op: 'create', entity: createOp(9999, 9999) }]
    }
    const d = await guardCadMutation(
      ctx({ input: { ...modifiedPayload, validationId: record.id } }),
      { store: s }
    )
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_OPERATION_MISMATCH')
  })

  it('partial commit leaves spent ticket committed and invalidates other pending tickets', async () => {
    const s = store()
    s.arm('run-1')
    const phase1Payload = batch(2)
    const phase2Payload = batch(4)
    const ticket1 = issuePass(s, { operationFingerprint: operationFingerprint(phase1Payload) })
    const ticket2 = issuePass(s, { operationFingerprint: operationFingerprint(phase2Payload) })

    const d1 = await guardCadMutation(
      ctx({ input: { ...phase1Payload, validationId: ticket1.id } }),
      { store: s }
    )
    expect(d1.blocked).toBe(false)

    const d2 = await guardCadMutation(
      ctx({ input: { ...phase2Payload, validationId: ticket2.id } }),
      { store: s }
    )
    expect(d2.blocked).toBe(true)
    expect(d2.code).toBe('RECORD_NOT_FOUND')
  })
})

describe('design guard — staleness', () => {
  it('a drawing that moved since validation is refused', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, {
      documentRevision: 'tdu:100;saves:1',
      operationFingerprint: operationFingerprint(payload)
    })
    // The probe reads the live revision from AutoCAD itself; the caller's snapshot is not consulted.
    const probe = async () => 'tdu:240;saves:1'
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: probe
    })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_REVISION_STALE')
    expect(d.reason).toContain('tdu:100;saves:1')
    expect(d.reason).toContain('tdu:240;saves:1')
  })

  it('an unchanged revision passes the staleness check', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, {
      documentRevision: 'tdu:100;saves:1',
      operationFingerprint: operationFingerprint(payload)
    })
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: async () => 'tdu:100;saves:1'
    })
    expect(d.blocked).toBe(false)
  })

  it('no probe at all skips the revision comparison rather than failing it', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, {
      documentRevision: 'tdu:100;saves:1',
      operationFingerprint: operationFingerprint(payload)
    })
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s
    })
    expect(d.blocked).toBe(false)
  })

  it('a probe that cannot reach the drawing reports no signal, not a match', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const record = issuePass(s, {
      documentRevision: 'tdu:100;saves:1',
      operationFingerprint: operationFingerprint(payload)
    })
    const d = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: async () => null
    })
    expect(d.blocked).toBe(false)
  })

  it('committing a batch invalidates the run’s other records but keeps the spent one', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch(2)
    const used = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const stale = issuePass(s, { operationFingerprint: operationFingerprint(batch(5)) })
    await guardCadMutation(ctx({ input: { ...payload, validationId: used.id } }), { store: s })
    // The drawing changed, so the other verdict no longer describes it.
    const d = await guardCadMutation(ctx({ input: { ...batch(5), validationId: stale.id } }), {
      store: s
    })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('RECORD_NOT_FOUND')
    // The spent one survives so read-back verification can still name what was validated.
    expect(s.get(used.id)).toBeDefined()
  })
})

describe('design guard — direct in-place writes', () => {
  it('counts handle-only update, including property-only changes', async () => {
    const s = store()
    s.arm('run-1')
    const d = await guardCadMutation(
      ctx({
        input: {
          operation: 'apply',
          documentName: 'house.dwg',
          operations: [{ op: 'update', update: { handle: 'ABC', layer: 'PCCC' } }]
        }
      }),
      { store: s }
    )
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('VALIDATION_REQUIRED')
    expect(d.placements).toBe(1)
  })

  it('counts geometry-free transform and single entity.update', async () => {
    const s = store()
    s.arm('run-1')
    const transform = await guardCadMutation(
      ctx({
        input: {
          operation: 'apply',
          documentName: 'house.dwg',
          operations: [{ op: 'transform', transform: { op: 'move', handles: ['AAA'] } }]
        }
      }),
      { store: s }
    )
    expect(transform.blocked).toBe(true)
    expect(transform.code).toBe('VALIDATION_REQUIRED')
    const direct = await guardCadMutation(
      ctx({
        input: { operation: 'update', documentName: 'house.dwg', handle: 'AAA', color: { aci: 3 } }
      }),
      { store: s }
    )
    expect(direct.blocked).toBe(true)
    expect(direct.placements).toBe(1)
  })

  it('reads and operation.preview remain read-only despite handle and coordinates', async () => {
    const s = store()
    s.arm('run-1')
    for (const operation of ['get', 'preview', 'list']) {
      const result = await guardCadMutation(
        ctx({ input: { operation, documentName: 'house.dwg', handle: 'ABC' } }),
        { store: s }
      )
      expect(result.placements).toBe(0)
      expect(result.blocked).toBe(false)
    }
  })
})

describe('design guard — self-preflighting executor exemption (slice 05)', () => {
  // The apply{planId} shape a task-level overlay executor sends: its real writes sit behind a planId
  // the guard never compiles, so a validationId can never be produced for it.
  const planApply = { operation: 'apply', planId: 'fa_plan_1', documentName: 'basement.dwg' }
  const policies = () => [{ id: 'policy-fa', version: 'v1', rules: [] }]

  it('an opaque apply{planId} is blocked for an ordinary capability — the loop this fixes', async () => {
    const s = store()
    const d = await guardCadMutation(ctx({ input: planApply }), {
      store: s,
      designPolicies: policies
    })
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('ARCHITECTURAL_SESSION_ARMED')
  })

  it('a Cloud-declared self-preflighting executor dispatches without a validationId', async () => {
    const s = store()
    const d = await guardCadMutation(ctx({ input: planApply, selfPreflightingExecutor: true }), {
      store: s,
      designPolicies: policies
    })
    expect(d.blocked).toBe(false)
    expect(d.armed).toBe(true)
    // The exemption must still arm the run: this is per-call, not a session-wide unmask.
    expect(s.isProtected('run-1')).toBe(true)
    expect(s.placementsFor('run-1')).toBe(1)
  })

  it('the exemption does not leak: a later raw write in the same run is still gated', async () => {
    const s = store()
    const exempt = await guardCadMutation(
      ctx({ input: planApply, selfPreflightingExecutor: true }),
      { store: s, designPolicies: policies }
    )
    expect(exempt.blocked).toBe(false)
    // Same run, ordinary entity.create with real geometry — must now demand a validationId.
    const gated = await guardCadMutation(ctx({ input: createOp(9000, 0) }), {
      store: s,
      designPolicies: policies
    })
    expect(gated.blocked).toBe(true)
    expect(gated.code).toBe('VALIDATION_REQUIRED')
  })

  it('a payload cannot self-declare the exemption (#282 posture holds)', async () => {
    const s = store()
    // selfPreflightingExecutor is threaded from the provider tier, never read from the payload, so
    // putting it in the input is inert — the write is still gated exactly like an ordinary capability.
    const d = await guardCadMutation(
      ctx({ input: { ...planApply, selfPreflightingExecutor: true } }),
      {
        store: s,
        designPolicies: policies
      }
    )
    expect(d.blocked).toBe(true)
    expect(d.code).toBe('ARCHITECTURAL_SESSION_ARMED')
  })
})
