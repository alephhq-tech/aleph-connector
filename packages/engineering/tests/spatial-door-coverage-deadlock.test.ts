import { describe, expect, it } from 'bun:test'
import {
  extractSpatialModel,
  validateSpatialLayout,
  validateBatch,
  checkAccessibility,
  checkContainment,
  guardCadMutation,
  operationFingerprint,
  ValidationStore,
  type GuardContext,
  type GuardDecision,
  type ProposedPlacement,
  type SpatialRawEntity,
  type SpatialValidationRecord,
  type SpatialValidateResult,
  type ValidateOptions,
  type ValidationVerdict
} from '../src/index'

/**
 * The door-coverage deadlock (aleph-platform#282, door-only batch slice).
 *
 * The reported live run: a drawing whose only detected closed boundary is the outer wall — no
 * interior rooms, no door entities. `sp_wall_outer` has no modelled door, so the constraint engine
 * reported `SPACE_DOOR_GEOMETRY_MISSING` = INSUFFICIENT_DATA, the verdict was therefore non-PASS, the
 * record minted for it was non-PASS, and the design guard refused the batch (`RECORD_NOT_PASS`) —
 * even though the refused batch was the one that DREW the missing doors. Six re-validations later the
 * run had drawn nothing: re-sending the same payload reproduces the same refusal, so nothing in the
 * response was actionable.
 *
 * The semantics fixed here: preflight judges the drawing AS IT WILL BE once the batch commits, so an
 * opening the batch itself supplies is the answer to a doorless space. Only openings that actually sit
 * on that space's boundary ring are credited — measured, never taken from the caller's `spaceId` — and
 * every credited opening is still validated as a placement in its own right, so a leaf that collides,
 * pinches circulation, floats off every wall, or sits outside the space still fails.
 *
 * Units: millimetres, the Aleph drawing convention.
 */

const ring = (x: number, y: number, w: number, h: number) => [
  { point: { x, y } },
  { point: { x: x + w, y } },
  { point: { x: x + w, y: y + h } },
  { point: { x, y: y + h } }
]

const closedRing = (
  handle: string,
  layer: string,
  x: number,
  y: number,
  w: number,
  h: number
): SpatialRawEntity => ({
  handle,
  kind: 'polyline',
  layer,
  geometry: { closed: true, vertices: ring(x, y, w, h) },
  bounds: { min: { x, y }, max: { x: x + w, y: y + h } }
})

/**
 * The deadlock's drawing: ONE closed boundary — the envelope, on a layer that also names a room, which
 * is how such a ring reaches the extractor as a usable space — and no door entity anywhere.
 */
const envelopeOnly = (layer = 'A-WALL-PHONG_HANH_LANG'): SpatialRawEntity[] => [
  closedRing('wall_outer', layer, 0, 0, 12000, 3000)
]

/** A leaf set into the south wall of that envelope: inside the wall band, not floating in the room. */
const entryDoor: ProposedPlacement = {
  id: 'd-entry',
  kind: 'door',
  center: [6000, 100],
  width: 1000,
  depth: 200
}
const cabinet: ProposedPlacement = {
  id: 'UNIT01',
  kind: 'cabinet',
  center: [3000, 1500],
  width: 600,
  depth: 1800
}

const cadPayload = (placements: ProposedPlacement[]) => ({
  operation: 'apply',
  documentName: 'house.dwg',
  operations: placements.map((p) => ({
    op: 'create',
    entity: {
      kind: 'blockReference',
      blockName: p.kind === 'door' ? 'DOOR_1000' : 'CABINET',
      position: { x: p.center[0], y: p.center[1] }
    }
  }))
})

interface DeadlockRun {
  verdict: SpatialValidateResult
  record: SpatialValidationRecord
  decision: GuardDecision
  store: ValidationStore
}

/**
 * The real chain, with no stubbed verdict: `validateSpatialLayout` computes it, the record is minted
 * for every status (the guard refuses any record that is not PASS), and the guard re-derives the
 * operation digest from the payload actually being dispatched.
 */
async function runValidatedBatch(
  runId: string,
  entities: SpatialRawEntity[],
  placements: ProposedPlacement[],
  options: ValidateOptions = {}
): Promise<DeadlockRun> {
  const store = new ValidationStore()
  store.arm(runId)
  const payload = cadPayload(placements)
  const verdict = validateSpatialLayout({
    entities,
    placements,
    documentName: 'house.dwg',
    documentRevision: 'tdu:100;saves:1',
    unitsPerMetre: 1000,
    options,
    plannedOperation: { capability: 'mcp_autocad_operations', input: payload }
  })
  const record = store.issue({
    runId,
    workspaceId: 'ws-door',
    deviceId: null,
    documentName: 'house.dwg',
    documentRevision: 'tdu:100;saves:1',
    drawingFingerprint: verdict.drawingFingerprint ?? '',
    layoutFingerprint: verdict.layoutFingerprint ?? '',
    operationFingerprint: verdict.operationFingerprint ?? '',
    result: (verdict.status ?? 'INSUFFICIENT_DATA') as ValidationVerdict,
    findings: verdict.findings
  })
  const context: GuardContext = {
    risk: 'destructive',
    input: { ...payload, validationId: record.id },
    runId,
    workspaceId: 'ws-door',
    deviceId: null
  }
  return { verdict, record, decision: await guardCadMutation(context, { store }), store }
}

describe('door-coverage deadlock — a batch that draws the door must be able to draw it', () => {
  it('reproduces the non-PASS chain when the payload supplies no opening, and the finding names the unlocking call', async () => {
    const { verdict, decision } = await runValidatedBatch('run-loop', envelopeOnly(), [cabinet])

    // finding -> verdict -> refused dispatch, exactly as reported.
    const finding = verdict.findings.find((f) => f.code === 'SPACE_DOOR_GEOMETRY_MISSING')
    expect(finding?.status).toBe('INSUFFICIENT_DATA')
    expect(verdict.status).toBe('INSUFFICIENT_DATA')
    expect(decision.blocked).toBe(true)
    expect(decision.code).toBe('RECORD_NOT_PASS')
    expect(decision.reason).toContain('INSUFFICIENT_DATA, not PASS')

    // Re-sending the same payload reproduces the same refusal: that is the loop, and it is only
    // survivable if the finding itself carries the next call.
    const retry = await runValidatedBatch('run-loop-retry', envelopeOnly(), [cabinet])
    expect(retry.verdict.status).toBe('INSUFFICIENT_DATA')
    expect(retry.decision.code).toBe('RECORD_NOT_PASS')

    const correction = finding?.suggestedCorrection ?? ''
    expect(correction).toContain('spatial_validate_layout')
    expect(correction).toContain('kind:"door"')
    expect(correction).toContain('sp_wall_outer')
  })

  it('same drawing, same furniture, PLUS the opening in the same batch: PASS, dispatch allowed', async () => {
    const { verdict, decision, store, record } = await runValidatedBatch(
      'run-door',
      envelopeOnly(),
      [cabinet, entryDoor]
    )
    expect(verdict.status).toBe('PASS')
    // Credited, not hidden: the finding is still reported, as not-applicable, naming the planned
    // opening and where the swing check runs instead.
    const finding = verdict.findings.find((f) => f.code === 'SPACE_DOOR_GEOMETRY_MISSING')
    expect(finding?.status).toBe('NOT_APPLICABLE')
    expect(finding?.measurements?.plannedOpenings).toBe(1)
    expect(finding?.entityIds).toContain('d-entry')
    expect(finding?.suggestedCorrection).toContain('spatial_readback_verify')
    expect(verdict.findings.some((f) => f.status === 'FAIL')).toBe(false)
    expect(verdict.findings.some((f) => f.code === 'FURNITURE_OUTSIDE_SPACE')).toBe(false)

    expect(decision.blocked).toBe(false)
    // Claimed, not committed: the guard authorizes the dispatch; only a provider receipt
    // (which this unit test does not simulate) moves the record to committed.
    expect(store.stateOf(record.id)).toBe('claimed')
  })

  it('a leaf set into the wall band is not a containment false-FAIL; an opening clear of every ring is', () => {
    const model = extractSpatialModel(envelopeOnly(), { unitsPerMetre: 1000 })
    const space = model.spaces[0]!
    for (const center of [
      [6000, 0],
      [6000, 100]
    ] as Array<[number, number]>) {
      expect(checkContainment({ ...entryDoor, center }, space).code).toBe('CONTAINMENT_OK')
    }
    // An opening pushed 500 mm past the wall into open air fails containment like anything else.
    const outside = checkContainment({ ...entryDoor, center: [6000, -500] }, space)
    expect(outside.code).toBe('FURNITURE_OUTSIDE_SPACE')
    expect(outside.status).toBe('FAIL')
  })
})

describe('door-coverage deadlock — the fix costs the guard none of its teeth', () => {
  it('the opening may clear the coverage finding, but a colliding door still FAILs the batch', async () => {
    const { verdict, decision } = await runValidatedBatch('run-collide', envelopeOnly(), [
      cabinet,
      entryDoor,
      // A second leaf standing on the cabinet: each item is fine alone, together they are not.
      { id: 'd-jam', kind: 'door', center: [3000, 1500], width: 1000, depth: 200 }
    ])
    expect(verdict.status).toBe('FAIL')
    expect(
      verdict.findings.some((f) => f.code === 'PLACEMENT_COLLISION' && f.status === 'FAIL')
    ).toBe(true)
    expect(decision.blocked).toBe(true)
    expect(decision.code).toBe('RECORD_NOT_PASS')
    expect(decision.reason).toContain('PLACEMENT_COLLISION')
  })

  it('an opening that sits on no ring opens nothing: the space stays doorless and sealed', () => {
    const model = extractSpatialModel(envelopeOnly('A-WALL-PHONG_NGU'), { unitsPerMetre: 1000 })
    const batch = validateBatch({
      model,
      placements: [
        cabinet,
        { id: 'd-symbol', kind: 'door', center: [6000, 1500], width: 1000, depth: 200 }
      ]
    })
    expect(
      batch.findings.some(
        (f) => f.code === 'SPACE_DOOR_GEOMETRY_MISSING' && f.status === 'INSUFFICIENT_DATA'
      )
    ).toBe(true)
    expect(batch.findings.some((f) => f.code === 'ROOM_INACCESSIBLE' && f.status === 'FAIL')).toBe(
      true
    )
    expect(batch.status).toBe('FAIL')
  })

  it('a credited opening links only the rings it sits on — a door elsewhere cannot unseal a room', () => {
    // Hall + bedroom sharing a boundary at x=6000. A door on the OUTSIDE wall of the hall must not
    // make the bedroom reachable; the same door on the shared boundary must.
    const model = extractSpatialModel(
      [
        closedRing('rmHall', 'A-ROOM-HANH_LANG', 0, 0, 6000, 6000),
        closedRing('rmBed', 'A-ROOM-PHONG_NGU', 6000, 0, 6000, 6000)
      ],
      { unitsPerMetre: 1000 }
    )
    expect(model.spaces.map((s) => s.id)).toEqual(['sp_rmHall', 'sp_rmBed'])

    const frontDoor: ProposedPlacement = {
      id: 'd-front',
      kind: 'door',
      center: [3000, 0],
      width: 1000,
      depth: 200
    }
    const access = checkAccessibility(model, {}, [frontDoor])
    const sealed = access.findings.find((f) => f.code === 'ROOM_INACCESSIBLE')
    expect(sealed).toBeDefined()
    expect(sealed!.entityIds).toContain('sp_rmBed')
    expect(sealed!.suggestedCorrection).toContain('spatial_validate_layout')
    expect(sealed!.suggestedCorrection).toContain('sp_rmBed')

    const linkDoor: ProposedPlacement = { ...frontDoor, id: 'd-link', center: [6000, 3000] }
    const linked = checkAccessibility(model, {}, [frontDoor, linkDoor])
    expect(linked.findings.some((f) => f.code === 'ROOM_INACCESSIBLE')).toBe(false)
    expect(linked.findings.some((f) => f.code === 'ACCESSIBILITY_OK')).toBe(true)
  })

  it('an opening that pinches the required circulation width still FAILs', () => {
    const model = extractSpatialModel(envelopeOnly(), { unitsPerMetre: 1000 })
    const result = validateBatch({
      model,
      placements: [
        { id: 'd-wall', kind: 'door', center: [6000, 100], width: 1000, depth: 200 },
        // 2800 of a 3000-deep hall stands in the route: far below the 1500 the caller supplied.
        { id: 'UNIT99', kind: 'cabinet', center: [9000, 1600], width: 400, depth: 2800 }
      ],
      options: { requiredCirculationWidth: 1500 }
    })
    expect(result.status).toBe('FAIL')
    expect(
      result.findings.some((f) => f.code === 'CIRCULATION_BLOCKED' && f.status === 'FAIL')
    ).toBe(true)
  })

  it('a drawing with no evaluable space says so AND names the call that unlocks it', async () => {
    // A-WALL alone: a closed ring with nothing but a wall layer to go on is a low-confidence
    // candidate, so nothing can be certified. That is still not a dead end.
    const blocked = await runValidatedBatch('run-blind', envelopeOnly('A-WALL'), [
      cabinet,
      entryDoor
    ])
    expect(blocked.verdict.status).toBe('INSUFFICIENT_DATA')
    expect(blocked.decision.blocked).toBe(true)
    const correction =
      blocked.verdict.findings.find((f) => f.code === 'MODEL_INSUFFICIENT_DATA')
        ?.suggestedCorrection ?? ''
    expect(correction).toContain('spatial_analyze')
    expect(correction).toContain('entity.list')
    expect(correction).toContain('spaceHints')
    expect(correction).toContain('acceptLowConfidence')

    // The named option is the one call that unlocks it: same payload, knowingly validated -> PASS.
    const unlocked = await runValidatedBatch(
      'run-blind-unlocked',
      envelopeOnly('A-WALL'),
      [cabinet, entryDoor],
      { acceptLowConfidence: true }
    )
    expect(unlocked.verdict.status).toBe('PASS')
    expect(unlocked.decision.blocked).toBe(false)
  })

  it('the ticket still binds the exact batch: a door-only payload cannot authorize a different one', async () => {
    const store = new ValidationStore()
    const placements = [cabinet, entryDoor]
    const validated = validateSpatialLayout({
      entities: envelopeOnly(),
      placements,
      documentName: 'house.dwg',
      documentRevision: 'tdu:100;saves:1',
      unitsPerMetre: 1000,
      plannedOperation: { capability: 'mcp_autocad_operations', input: cadPayload(placements) }
    })
    expect(validated.status).toBe('PASS')
    const record = store.issue({
      runId: 'run-swap',
      workspaceId: 'ws-door',
      deviceId: null,
      documentName: 'house.dwg',
      documentRevision: 'tdu:100;saves:1',
      drawingFingerprint: validated.drawingFingerprint ?? '',
      layoutFingerprint: validated.layoutFingerprint ?? '',
      operationFingerprint: validated.operationFingerprint ?? '',
      result: 'PASS',
      findings: validated.findings
    })
    store.arm('run-swap')
    const swapped = cadPayload(placements.slice(1))
    const context: GuardContext = {
      risk: 'destructive',
      input: { ...swapped, validationId: record.id },
      runId: 'run-swap',
      workspaceId: 'ws-door',
      deviceId: null
    }
    const decision = await guardCadMutation(context, { store })
    expect(decision.blocked).toBe(true)
    expect(decision.code).toBe('RECORD_OPERATION_MISMATCH')
    expect(operationFingerprint(swapped)).not.toBe(validated.operationFingerprint)
  })
})
