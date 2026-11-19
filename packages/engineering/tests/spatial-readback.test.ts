import { describe, expect, it } from 'bun:test'
import {
  verifyDrawnLayout,
  verifyCompiledPlanReadback,
  compileCadPayload,
  reviewEngineeringPlan,
  createEngineeringPlan,
  issueValidationRecord,
  type PlannedItem,
  type SpatialRawEntity
} from '../src/index'
import { rect, polyline, wall, block } from './fixtures/spatial-entities'

/**
 * Post-mutation read-back tests. Units: millimetres. The property under test is independence: the
 * verdict comes from what is ACTUALLY on the drawing, never from the plan's earlier PASS. A fixture
 * where the plan and the drawing agree proves the happy path; the failure fixtures (a snapped
 * coordinate, a dropped entity, an extra block) are the ones that matter, because they are exactly
 * what a preflight verdict cannot see.
 */

/** A 6×6 m bedroom with an exterior door on the bottom wall at (5000,0). */
function bedroomScene(bedHandle = 'bedActual', bedX = 1000, bedY = 1000): SpatialRawEntity[] {
  return [
    polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(0, 0, 6000, 6000)),
    wall('wBottom', [0, 0], [6000, 0]),
    block('dBed', 'A-DOOR', 'DOOR_900', 5000, 0, 900, 200),
    block(bedHandle, 'A-NOI_THAT', 'BED_2000x1600', bedX, bedY, 2000, 1600)
  ]
}

const plannedBed: PlannedItem = {
  id: 'bed1',
  kind: 'bed',
  center: [1000, 1000],
  width: 2000,
  depth: 1600,
  spaceId: 'sp_rmBed'
}

describe('verifyDrawnLayout maps planned to actual and re-validates', () => {
  it('a drawing that matches the plan is faithful', () => {
    const report = verifyDrawnLayout([plannedBed], bedroomScene(), { unitsPerMetre: 1000 })
    expect(report.faithful).toBe(true)
    expect(report.status).toBe('PASS')
    expect(report.matches).toHaveLength(1)
    expect(report.matches[0]!.state).toBe('matched')
    expect(report.matches[0]!.actualHandle).toBe('bedActual')
    expect(report.discrepancies).toHaveLength(0)
  })

  it('a coordinate snapped by the tool is DRIFTED, not matched', () => {
    // Planned at (1000,1000); the drawing has it at (1200,1000) — 200 units off, beyond the 50-unit
    // tolerance. The preflight PASS was about (1000,1000); the drawing is not that.
    const report = verifyDrawnLayout([plannedBed], bedroomScene('bedActual', 1200, 1000), {
      unitsPerMetre: 1000
    })
    expect(report.matches[0]!.state).toBe('drifted')
    expect(report.matches[0]!.positionDelta).toBeCloseTo(200, 0)
    expect(report.faithful).toBe(false)
    expect(report.discrepancies.some((d) => d.startsWith('DRIFTED'))).toBe(true)
  })

  it('a dropped entity is MISSING', () => {
    // The plan had a bed and a wardrobe; the drawing only got the bed.
    const plannedWardrobe: PlannedItem = {
      id: 'wardrobe1',
      kind: 'wardrobe',
      center: [5000, 5000],
      width: 2000,
      depth: 600,
      spaceId: 'sp_rmBed'
    }
    const report = verifyDrawnLayout([plannedBed, plannedWardrobe], bedroomScene(), {
      unitsPerMetre: 1000
    })
    const wardrobe = report.matches.find((m) => m.plannedId === 'wardrobe1')
    expect(wardrobe!.state).toBe('missing')
    expect(report.faithful).toBe(false)
    expect(report.discrepancies.some((d) => d.startsWith('MISSING'))).toBe(true)
  })

  it('an entity the plan never asked for is EXTRA', () => {
    const scene = [
      ...bedroomScene(),
      block('sofaExtra', 'A-NOI_THAT', 'SOFA_2200', 3000, 3000, 2200, 900)
    ]
    const report = verifyDrawnLayout([plannedBed], scene, { unitsPerMetre: 1000 })
    const extra = report.matches.find((m) => m.plannedId === 'sofaExtra')
    expect(extra!.state).toBe('extra')
    expect(report.faithful).toBe(false)
    expect(report.discrepancies.some((d) => d.startsWith('EXTRA'))).toBe(true)
  })

  it('a snap that pushes furniture out of its room turns a PASS plan into a FAIL drawing', () => {
    // The plan put the bed at (4800,1400) — fully inside the 6000×6000 room. The tool drew it at
    // (4800,700): a 700-unit drift that drops the 1600-deep footprint to y=-100, outside the room.
    // The preflight PASS was about the in-room position; the drawing is not in the room. This is the
    // failure mode a preflight verdict structurally cannot see.
    const plannedClear: PlannedItem = {
      id: 'bed1',
      kind: 'bed',
      center: [4800, 1400],
      width: 2000,
      depth: 1600,
      spaceId: 'sp_rmBed'
    }
    const report = verifyDrawnLayout([plannedClear], bedroomScene('bedActual', 4800, 700), {
      unitsPerMetre: 1000
    })
    expect(report.matches[0]!.state).toBe('drifted')
    expect(report.status).toBe('FAIL')
    expect(
      report.findings.some((f) => f.code === 'FURNITURE_OUTSIDE_SPACE' && f.status === 'FAIL')
    ).toBe(true)
    expect(report.faithful).toBe(false)
  })

  it('a reported handle is authoritative over nearest-distance matching', () => {
    // Two beds swapped positions on the drawing. Matching by nearest centre would call both
    // "matched"; matching by the handle the mutation reported correctly calls both drifted.
    const p1: PlannedItem = {
      id: 'bed1',
      kind: 'bed',
      center: [1000, 1000],
      width: 2000,
      depth: 1600,
      handle: 'H1'
    }
    const p2: PlannedItem = {
      id: 'bed2',
      kind: 'bed',
      center: [4000, 1000],
      width: 2000,
      depth: 1600,
      handle: 'H2'
    }
    const scene = [
      polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(0, 0, 6000, 6000)),
      wall('wBottom', [0, 0], [6000, 0]),
      block('dBed', 'A-DOOR', 'DOOR_900', 5000, 0, 900, 200),
      block('H1', 'A-NOI_THAT', 'BED_2000x1600', 4000, 1000, 2000, 1600),
      block('H2', 'A-NOI_THAT', 'BED_2000x1600', 1000, 1000, 2000, 1600)
    ]
    const report = verifyDrawnLayout([p1, p2], scene, { unitsPerMetre: 1000 })
    expect(report.matches.find((m) => m.plannedId === 'bed1')!.state).toBe('drifted')
    expect(report.matches.find((m) => m.plannedId === 'bed2')!.state).toBe('drifted')
    expect(report.faithful).toBe(false)
  })

  it('the same plan and drawing produce the same report (determinism)', () => {
    const a = verifyDrawnLayout([plannedBed], bedroomScene(), { unitsPerMetre: 1000 })
    const b = verifyDrawnLayout([plannedBed], bedroomScene(), { unitsPerMetre: 1000 })
    expect(JSON.stringify(a.matches)).toBe(JSON.stringify(b.matches))
    expect(a.faithful).toBe(b.faithful)
  })
})

describe('the repair plan is bounded and honest about what it can fix', () => {
  it('a faithful drawing has nothing to repair', () => {
    const report = verifyDrawnLayout([plannedBed], bedroomScene(), { unitsPerMetre: 1000 })
    expect(report.repair.steps).toHaveLength(0)
    expect(report.repair.escalate).toBe(false)
  })

  it('a drifted item gets a move back to its planned centre', () => {
    const report = verifyDrawnLayout([plannedBed], bedroomScene('bedActual', 1200, 1000), {
      unitsPerMetre: 1000
    })
    expect(report.repair.escalate).toBe(false)
    expect(report.repair.steps).toEqual([
      {
        action: 'move',
        target: 'bedActual',
        to: [1000, 1000],
        reason: 'landed 200 units from its planned position'
      }
    ])
  })

  it('missing and extra items get draw and erase steps', () => {
    const plannedWardrobe: PlannedItem = {
      id: 'wardrobe1',
      kind: 'wardrobe',
      center: [5000, 5000],
      width: 2000,
      depth: 600,
      spaceId: 'sp_rmBed'
    }
    const scene = [
      ...bedroomScene(),
      block('sofaExtra', 'A-NOI_THAT', 'SOFA_2200', 3000, 3000, 2200, 900)
    ]
    const report = verifyDrawnLayout([plannedBed, plannedWardrobe], scene, { unitsPerMetre: 1000 })
    const actions = report.repair.steps.map((s) => `${s.action}:${s.target}`)
    expect(actions).toContain('draw:wardrobe1')
    expect(actions).toContain('erase:sofaExtra')
  })

  it('the bound escalates instead of offering a third round of edits', () => {
    // Same drift, but the caller has already spent the default 2 rounds: the engine must stop
    // proposing edits. Without this, a fix→drift→fix loop grinds until the turn budget dies.
    const report = verifyDrawnLayout(
      [plannedBed],
      bedroomScene('bedActual', 1200, 1000),
      {
        unitsPerMetre: 1000
      },
      { repairAttempt: 2 }
    )
    expect(report.repair.escalate).toBe(true)
    expect(report.repair.steps).toEqual([
      { action: 'escalate', target: '*', reason: '2 repair rounds already spent' }
    ])
    expect(report.repair.note).toContain('report the remaining discrepancies')
  })

  it('a plan-level FAIL escalates immediately — editing entities cannot fix a bad plan', () => {
    // The drawing faithfully implements the plan, but the plan itself is invalid (bed pokes out of
    // the room). There is no planned-vs-drawn discrepancy, so a "repair edit" would be a blind guess.
    const plannedOutside: PlannedItem = {
      id: 'bed1',
      kind: 'bed',
      center: [1000, -100],
      width: 2000,
      depth: 1600,
      spaceId: 'sp_rmBed'
    }
    const report = verifyDrawnLayout([plannedOutside], bedroomScene('bedActual', 1000, -100), {
      unitsPerMetre: 1000
    })
    expect(report.faithful).toBe(false)
    expect(report.repair.escalate).toBe(true)
    expect(report.repair.steps.every((s) => s.action === 'escalate')).toBe(true)
    expect(report.repair.note).toContain('spatial_validate_layout')
  })
})

describe('reviewEngineeringPlan gates completion on a faithful read-back', () => {
  const drafted = () => {
    // #208 made drafting authorization non-forgeable: a plan is ready only when it names a
    // validationId the server actually issued from a PASS record. Mint one and resolve it.
    const record = issueValidationRecord({
      runId: 'run-1',
      workspaceId: 'ws-1',
      documentName: 'flat.dwg',
      documentRevision: '7',
      drawingFingerprint: 'fp-d',
      layoutFingerprint: 'fp-l',
      operationFingerprint: 'fp-o',
      result: 'PASS',
      findings: []
    })
    const created = createEngineeringPlan(
      {
        designBasisId: 'db1',
        title: 'flat',
        stages: [
          {
            stageNumber: 1,
            name: 'draw',
            description: 'd',
            operations: ['entity.create'],
            stoppingCondition: 'done'
          }
        ],
        validationId: record.id
      },
      { resolveValidation: (id) => (id === record.id ? record : undefined) }
    )
    // ready_for_drafting → drafting (the batch committed).
    return { ...created.plan!, status: 'drafting' as const }
  }

  it('a faithful read-back moves a drafted plan to reviewed', () => {
    const out = reviewEngineeringPlan(drafted(), {
      faithful: true,
      status: 'PASS',
      discrepancies: []
    })
    expect(out.success).toBe(true)
    expect(out.plan!.status).toBe('reviewed')
  })

  it('a read-back that finds drift leaves the plan at verification_required with the reason', () => {
    const out = reviewEngineeringPlan(drafted(), {
      faithful: false,
      status: 'FAIL',
      discrepancies: ['DRIFTED: bed1 landed 200 units from where it was planned']
    })
    expect(out.plan!.status).toBe('verification_required')
    expect(out.plan!.blockedReason).toContain('DRIFTED')
  })

  it('a plan that has not been drafted cannot be reviewed', () => {
    const created = createEngineeringPlan({
      designBasisId: 'db1',
      title: 'flat',
      stages: [
        {
          stageNumber: 1,
          name: 'draw',
          description: 'd',
          operations: ['x'],
          stoppingCondition: 'done'
        }
      ]
    })
    const out = reviewEngineeringPlan(created.plan!, {
      faithful: true,
      status: 'PASS',
      discrepancies: []
    })
    expect(out.success).toBe(false)
    expect(out.error).toContain('drafting')
  })
})

describe('verifyCompiledPlanReadback validates native CAD readback against compiled operations', () => {
  it('a drawn line matching the compiled plan is faithful', () => {
    const plan = compileCadPayload({
      documentName: 'draw.dwg',
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            layer: 'FA-Wiring',
            start: { x: 1000, y: 2000 },
            end: { x: 5000, y: 2000 }
          }
        }
      ]
    })

    const readbackEntities: SpatialRawEntity[] = [
      {
        handle: 'H_LINE_1',
        kind: 'line',
        layer: 'FA-Wiring',
        geometry: {
          start: { x: 1000, y: 2000 },
          end: { x: 5000, y: 2000 }
        }
      }
    ]

    const report = verifyCompiledPlanReadback(plan, readbackEntities, { positionTolerance: 50 })
    expect(report.status).toBe('PASS')
    expect(report.faithful).toBe(true)
    expect(report.discrepancies).toHaveLength(0)
    expect(report.stats.matchedSteps).toBe(1)
  })

  it('a missing line segment causes FAIL and reports discrepancy', () => {
    const plan = compileCadPayload({
      documentName: 'draw.dwg',
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'line',
            layer: 'FA-Wiring',
            start: { x: 1000, y: 2000 },
            end: { x: 5000, y: 2000 }
          }
        }
      ]
    })

    const readbackEntities: SpatialRawEntity[] = [] // Nothing was drawn!

    const report = verifyCompiledPlanReadback(plan, readbackEntities, { positionTolerance: 50 })
    expect(report.status).toBe('FAIL')
    expect(report.faithful).toBe(false)
    expect(report.discrepancies.length).toBeGreaterThan(0)
    expect(report.discrepancies[0]).toContain('MISSING')
  })

  it('a drifted placement beyond positionTolerance causes FAIL and reports drifted', () => {
    const plan = compileCadPayload({
      documentName: 'draw.dwg',
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'insert',
            blockName: 'SMOKE_DETECTOR',
            layer: 'FA-Devices',
            position: { x: 5000, y: 5000 }
          }
        }
      ]
    })

    // Landed 200 units away from planned location
    const readbackEntities: SpatialRawEntity[] = [
      {
        handle: 'H_DEV_1',
        kind: 'blockReference',
        layer: 'FA-Devices',
        geometry: {
          blockName: 'SMOKE_DETECTOR',
          position: { x: 5200, y: 5000 }
        }
      }
    ]

    const report = verifyCompiledPlanReadback(plan, readbackEntities, { positionTolerance: 50 })
    expect(report.status).toBe('FAIL')
    expect(report.faithful).toBe(false)
    expect(report.stats.driftedSteps).toBe(1)
    expect(report.discrepancies[0]).toContain('DRIFTED')
  })

  it('an opaque plan cannot be verified and returns INSUFFICIENT_DATA', () => {
    const opaquePlan = {
      documentName: 'draw.dwg',
      steps: [
        {
          index: 0,
          kind: 'opaque' as const,
          entityKind: 'walls',
          reason: 'generator expands server-side',
          field: 'operation'
        }
      ],
      opaque: true,
      opaqueReasons: ['generator expands server-side']
    }

    const report = verifyCompiledPlanReadback(opaquePlan, [])
    expect(report.status).toBe('INSUFFICIENT_DATA')
    expect(report.faithful).toBe(false)
  })
})
