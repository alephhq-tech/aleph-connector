import { describe, expect, it } from 'bun:test'
import {
  ValidationStore,
  compileCadPayload,
  guardCadMutation,
  planHashOf,
  preflightCompiledPlan,
  operationFingerprint,
  type GuardContext,
  type IssueRecordInput,
  type RestrictedZone
} from '../src/index'
import {
  basementZones,
  deviceInShaft,
  emergencyLightInStairwell,
  speakerInStairwell,
  wireAroundShaft,
  wireThroughShaft
} from './fixtures/basement-fire-alarm'

/**
 * P0 of CAD semantic grounding: an unvalidated or geometrically invalid engineering write must
 * never reach AutoCAD, whatever entry point the model used, and a PASS must mean the COMPILED
 * geometry was checked — not that a wrapper payload happened to carry coordinates.
 *
 * Units: millimetres. Zones come from the basement fixture's real polyline rings.
 */

const store = () => new ValidationStore()

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  risk: 'destructive',
  input: {},
  runId: 'run-1',
  workspaceId: 'ws-1',
  ...over
})

const batch = (operations: unknown[]) => ({
  operation: 'apply',
  documentName: 'basement.dwg',
  operations
})

const fireAlarmPolicies = () => [
  {
    id: 'policy-sunland-basement-fa',
    version: 'v1',
    projectRef: 'sunland-basement',
    designBasisId: 'db-basement-fa',
    rules: [
      {
        id: 'rule-elev-prohibit',
        zoneClass: 'elevator_shaft',
        system: 'fire_alarm',
        effect: 'prohibit' as const,
        authority: { source: 'project_config' as const, ref: 'design-basis:db-basement-fa' }
      },
      {
        id: 'rule-stair-prohibit',
        zoneClass: 'stairwell',
        system: 'fire_alarm',
        effect: 'prohibit' as const,
        authority: { source: 'project_config' as const, ref: 'design-basis:db-basement-fa' }
      },
      {
        id: 'rule-stair-emergency-light',
        zoneClass: 'stairwell',
        system: 'fire_alarm',
        effect: 'conditional' as const,
        permits: { deviceTypes: ['FA_EMERGENCY_LIGHT'] },
        authority: { source: 'project_config' as const, ref: 'design-basis:db-basement-fa' }
      }
    ]
  }
]

const runPreflight = (
  payload: Record<string, unknown>,
  opts: { zones?: RestrictedZone[]; authorizations?: PolicyGrant[] } = {}
) => {
  const plan = compileCadPayload(payload)
  return preflightCompiledPlan({
    plan,
    planHash: planHashOf(plan),
    zones: opts.zones ?? basementZones(),
    policies: fireAlarmPolicies(),
    ...(opts.authorizations && { authorizations: opts.authorizations }),
    binding: { runId: 'run-1', workspaceId: 'ws-1' },
    options: { system: 'fire_alarm' }
  })
}

type PolicyGrant = {
  id: string
  ruleId: string
  grantedBy: 'user' | 'design_basis'
  provenance: string
  runId: string
  workspaceId: string
}

const grantFor = (ruleId: string, over: Partial<PolicyGrant> = {}): PolicyGrant => ({
  id: `auth-${ruleId}`,
  ruleId,
  grantedBy: 'user',
  provenance: 'user-approval:apv_basement',
  runId: 'run-1',
  workspaceId: 'ws-1',
  ...over
})

describe('P0 segment-to-zone geometry (#1, #8)', () => {
  it('blocks a wire whose endpoints are both outside the shaft but whose leg crosses the interior', () => {
    const result = runPreflight(batch([wireThroughShaft()]))
    expect(result.status).toBe('FAIL')
    const crossing = result.findings.find((f) => f.code === 'ROUTE_CROSSES_RESTRICTED_ZONE')
    expect(crossing).toBeDefined()
    expect(crossing!.status).toBe('FAIL')
    expect(crossing!.entityIds).toContain('zone-elev-1')
    expect(crossing!.entityIds).toContain('ELEV_SHAFT_1')
    // The signature of the endpoint/bbox-test defeat case: both ends outside, interior crossed.
    expect(crossing!.measurements?.bothEndpointsOutside).toBe(1)
    expect(crossing!.message).toContain('elevator_shaft')
    expect(crossing!.suggestedCorrection).toContain('reroute')
  })

  it('passes the same connection routed around the shaft', () => {
    const result = runPreflight(batch([wireAroundShaft()]))
    expect(result.status).toBe('PASS')
    expect(result.findings.filter((f) => f.status === 'FAIL')).toEqual([])
  })

  it('checks EVERY leg of a polyline route, not just its extremes', () => {
    const result = runPreflight(
      batch([
        {
          op: 'create',
          entity: {
            kind: 'polyline',
            layer: 'FA-Wiring',
            closed: false,
            points: [
              { x: 10000, y: 6000, z: 0 },
              { x: 14000, y: 6000, z: 0 },
              { x: 17500, y: 6000, z: 0 },
              { x: 17500, y: 10000, z: 0 },
              { x: 25000, y: 10000, z: 0 }
            ]
          }
        }
      ])
    )
    expect(result.status).toBe('FAIL')
    const crossing = result.findings.find((f) => f.code === 'ROUTE_CROSSES_RESTRICTED_ZONE')
    // Legs 0-1 run below the shaft; leg 2 climbs at x=17500 straight into it.
    expect(crossing?.measurements?.segmentIndex).toBe(2)
  })

  it('honours an explicit clearance band around a zone', () => {
    const plan = compileCadPayload(batch([wireAroundShaft()]))
    const result = preflightCompiledPlan({
      plan,
      planHash: planHashOf(plan),
      zones: basementZones(),
      policies: fireAlarmPolicies(),
      binding: { runId: 'run-1', workspaceId: 'ws-1' },
      options: { system: 'fire_alarm', clearance: 3000 }
    })
    expect(result.status).toBe('FAIL')
    expect(result.findings.some((f) => f.code === 'ROUTE_CLIPS_RESTRICTED_ZONE')).toBe(true)
  })
})

describe('P0 device placement vs restricted zone (#2, #3, #4)', () => {
  it('blocks a device placed inside a prohibited elevator zone', () => {
    const result = runPreflight(batch([deviceInShaft()]))
    expect(result.status).toBe('FAIL')
    const finding = result.findings.find((f) => f.code === 'DEVICE_IN_RESTRICTED_ZONE')
    expect(finding?.entityIds).toEqual(
      expect.arrayContaining(['step:0', 'zone-elev-1', 'ELEV_SHAFT_1'])
    )
  })

  it('passes a conditionally permitted emergency light holding a valid authorization', () => {
    const result = runPreflight(batch([emergencyLightInStairwell()]), {
      authorizations: [grantFor('rule-stair-emergency-light')]
    })
    expect(result.status).toBe('PASS')
    expect(result.findings.some((f) => f.code === 'RESTRICTED_ZONE_AUTHORIZED')).toBe(true)
  })

  it('blocks the same emergency light when the authorization belongs to another run', () => {
    const result = runPreflight(batch([emergencyLightInStairwell()]), {
      authorizations: [grantFor('rule-stair-emergency-light', { runId: 'run-OTHER' })]
    })
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.findings.some((f) => f.code === 'POLICY_AUTHORIZATION_REQUIRED')).toBe(true)
  })

  it('blocks a non-permitted device in the same stairwell', () => {
    const result = runPreflight(batch([speakerInStairwell()]), {
      authorizations: [grantFor('rule-stair-emergency-light')]
    })
    expect(result.status).toBe('FAIL')
    expect(result.findings.some((f) => f.code === 'DEVICE_IN_RESTRICTED_ZONE')).toBe(true)
  })

  it('a model-authored exemption field grants nothing', () => {
    const payload = batch([{ ...deviceInShaft(), exemptions: ['fire_alarm_allowed'] }])
    expect(runPreflight(payload).status).toBe('FAIL')
  })
})

describe('P0 unknown geometry is never a pass (#6, #7, #19)', () => {
  it('an unverified zone polygon yields INSUFFICIENT_DATA, not permission', () => {
    const zones = basementZones().map((z) => ({ ...z, verified: false }))
    const result = runPreflight(batch([wireAroundShaft()]), { zones })
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.findings.some((f) => f.code === 'ZONE_GEOMETRY_UNVERIFIED')).toBe(true)
  })

  it('a degenerate/open boundary yields INSUFFICIENT_DATA', () => {
    const zones = basementZones().map((z) => ({ ...z, outer: z.outer.slice(0, 2) }))
    const result = runPreflight(batch([wireAroundShaft()]), { zones })
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.findings.some((f) => f.code === 'ZONE_BOUNDARY_INVALID')).toBe(true)
  })

  it('an unknown zone classification cannot be drawn through', () => {
    const zones = basementZones().map((z) => ({ ...z, zoneClass: 'unknown' }))
    const result = runPreflight(batch([wireThroughShaft()]), { zones })
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.findings.some((f) => f.code === 'ZONE_CLASSIFICATION_UNKNOWN')).toBe(true)
  })

  it('partial spatial coverage cannot support a safety conclusion', () => {
    const plan = compileCadPayload(batch([wireAroundShaft()]))
    const result = preflightCompiledPlan({
      plan,
      planHash: planHashOf(plan),
      zones: [],
      policies: fireAlarmPolicies(),
      binding: { runId: 'run-1', workspaceId: 'ws-1' },
      options: { system: 'fire_alarm' },
      evidence: { coverageSufficient: false }
    })
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.findings.some((f) => f.code === 'COVERAGE_INSUFFICIENT')).toBe(true)
  })

  it('a zone with no policy rule is undecided, not allowed', () => {
    const zones: RestrictedZone[] = [{ ...basementZones()[0]!, zoneClass: 'electrical_riser' }]
    const result = runPreflight(batch([wireThroughShaft()]), { zones })
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.findings.some((f) => f.code === 'POLICY_UNCOVERED_ZONE')).toBe(true)
  })
})

describe('P0 opaque compiled operations are still gated (#13)', () => {
  it('a payload hiding operations behind a planId compiles to an opaque step', () => {
    const result = runPreflight({
      operation: 'apply',
      planId: 'pcccplan_x',
      documentName: 'basement.dwg'
    })
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.findings.some((f) => f.code === 'PLAN_OPAQUE_OPERATIONS')).toBe(true)
  })

  it('a generator spec (construct walls) is opaque rather than empty', () => {
    const plan = compileCadPayload({
      operation: 'walls',
      documentName: 'basement.dwg',
      centerline: [
        { x: 0, y: 0, z: 0 },
        { x: 40000, y: 0, z: 0 }
      ],
      thickness: 200
    })
    expect(plan.opaque).toBe(true)
    expect(plan.steps.some((s) => s.kind === 'opaque')).toBe(true)
  })

  it('a transform of existing handles is opaque, not "nothing to check"', () => {
    const plan = compileCadPayload({
      operation: 'apply',
      documentName: 'basement.dwg',
      operations: [
        { op: 'transform', transform: { handles: ['7A3', '7A4'], delta: { x: 100, y: 0, z: 0 } } }
      ]
    })
    expect(plan.opaque).toBe(true)
  })

  it('line start/end, polyline points and block inserts all compile to geometry', () => {
    const plan = compileCadPayload(batch([wireThroughShaft(), wireAroundShaft(), deviceInShaft()]))
    expect(plan.opaque).toBe(false)
    expect(plan.steps.map((s) => s.kind)).toEqual(['segment', 'segment', 'placement'])
    const legs = plan.steps[1]
    expect(legs!.kind).toBe('segment')
    expect(legs!.kind === 'segment' ? legs!.segments.length : 0).toBe(5)
  })
})

describe('P0 compiled-plan hash binds the authorization (#10, #12)', () => {
  it('the same payload shape with different compiled geometry hashes differently', () => {
    const through = planHashOf(compileCadPayload(batch([wireThroughShaft()])))
    const around = planHashOf(compileCadPayload(batch([wireAroundShaft()])))
    expect(through).not.toBe(around)
  })

  it('a plan issued over explicit ops cannot authorize a hidden (opaque) payload', async () => {
    const s = store()
    s.arm('run-1')
    const explicit = batch([wireAroundShaft()])
    const plan = compileCadPayload(explicit)
    const record = issuePass(s, {
      operationFingerprint: operationFingerprint(explicit),
      planHash: planHashOf(plan)
    })
    // The wrapper is a valid-looking apply, but its operations are hidden behind a planId.
    const decision = await guardCadMutation(
      ctx({
        input: {
          operation: 'apply',
          planId: 'pcccplan_x',
          documentName: 'basement.dwg',
          validationId: record.id
        }
      }),
      { store: s, revisionProbe: async () => 'tdu:100;saves:1' }
    )
    expect(decision.blocked).toBe(true)
    expect(
      decision.code === 'RECORD_OPERATION_MISMATCH' || decision.code === 'RECORD_PLAN_MISMATCH'
    ).toBe(true)
  })

  it('a validated plan altered to cross a shaft before apply is refused', async () => {
    const s = store()
    s.arm('run-1')
    const validated = batch([wireAroundShaft()])
    const record = issuePass(s, {
      operationFingerprint: operationFingerprint(validated),
      planHash: planHashOf(compileCadPayload(validated))
    })
    const swapped = await guardCadMutation(
      ctx({ input: { ...batch([wireThroughShaft()]), validationId: record.id } }),
      { store: s, revisionProbe: async () => 'tdu:100;saves:1' }
    )
    expect(swapped.blocked).toBe(true)
    expect(swapped.code).toBe('RECORD_OPERATION_MISMATCH')
  })
})

describe('P0 drawing revision binding (#11)', () => {
  it('a drawing that moved after preflight forces revalidation', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch([wireAroundShaft()])
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const decision = await guardCadMutation(
      ctx({ input: { ...payload, validationId: record.id } }),
      { store: s, revisionProbe: async () => 'tdu:250;saves:1' }
    )
    expect(decision.blocked).toBe(true)
    expect(decision.code).toBe('RECORD_REVISION_STALE')
  })
})

describe('P0 single-use claim is race-safe (#14)', () => {
  it('one authorization cannot be spent by two concurrent dispatches', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch([wireAroundShaft()])
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const decisions = await Promise.all(
      [0, 1].map(() =>
        guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
          store: s,
          revisionProbe: async () => 'tdu:100;saves:1'
        })
      )
    )
    expect(decisions.filter((d) => !d.blocked)).toHaveLength(1)
    expect(decisions.find((d) => d.blocked)?.code).toBe('RECORD_IN_FLIGHT')
  })

  it('a claim is never marked committed before the provider reports one', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch([wireAroundShaft()])
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    const decision = await guardCadMutation(
      ctx({ input: { ...payload, validationId: record.id } }),
      { store: s, revisionProbe: async () => 'tdu:100;saves:1' }
    )
    expect(decision.blocked).toBe(false)
    expect(decision.claimedRecordId).toBe(record.id)
    expect(s.stateOf(record.id)).toBe('claimed')
    expect(s.isCommitted(record.id)).toBe(false)
    s.markCommitted(record.id, 'batch_9')
    expect(s.stateOf(record.id)).toBe('committed')
    expect(s.isCommitted(record.id)).toBe(true)
  })

  it('a settled-failed record is spent, never silently retried', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch([wireAroundShaft()])
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: async () => 'tdu:100;saves:1'
    })
    s.markFailed(record.id)
    const again = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: async () => 'tdu:100;saves:1'
    })
    expect(again.blocked).toBe(true)
    expect(again.code).toBe('RECORD_ALREADY_USED')
  })

  it('an outcome-unknown dispatch is never replayed on the same record (#15)', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch([wireAroundShaft()])
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: async () => 'tdu:100;saves:1'
    })
    s.markOutcomeUnknown(record.id)
    expect(s.stateOf(record.id)).toBe('outcome_unknown')
    const again = await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: async () => 'tdu:100;saves:1'
    })
    expect(again.blocked).toBe(true)
    expect(again.code).toBe('RECORD_OUTCOME_UNRECONCILED')
    expect(again.reason).toContain('commit outcome is unknown')
  })

  it('an unsettled claim is observable for reconciliation', async () => {
    const s = store()
    s.arm('run-1')
    const payload = batch([wireAroundShaft()])
    const record = issuePass(s, { operationFingerprint: operationFingerprint(payload) })
    await guardCadMutation(ctx({ input: { ...payload, validationId: record.id } }), {
      store: s,
      revisionProbe: async () => 'tdu:100;saves:1'
    })
    expect(s.staleClaims(0, Date.now() + 1000).map((r) => r.id)).toContain(record.id)
  })
})

describe('P0 protected by policy configuration, not by a count (#2)', () => {
  const designPolicies = () => fireAlarmPolicies()

  it('a workspace with configured policies is protected from its first geometric write', async () => {
    const s = store()
    const decision = await guardCadMutation(ctx({ input: batch([wireThroughShaft()]) }), {
      store: s,
      designPolicies
    })
    expect(decision.blocked).toBe(true)
    expect(decision.code).toBe('ARCHITECTURAL_SESSION_ARMED')
    expect(s.isProtected('run-1')).toBe(true)
  })

  it('a single wire segment in an already-protected run needs a record', async () => {
    const s = store()
    s.arm('run-1')
    const decision = await guardCadMutation(ctx({ input: batch([wireThroughShaft()]) }), {
      store: s
    })
    expect(decision.blocked).toBe(true)
    expect(decision.code).toBe('VALIDATION_REQUIRED')
    expect(decision.placements).toBe(1)
  })

  it('reads are still free', async () => {
    const s = store()
    for (const input of [
      { operation: 'list', detail: 'full' },
      { operation: 'get', handle: '2F1' },
      { operation: 'info', documentName: 'basement.dwg' },
      { operation: 'summary' },
      { operation: 'capture' },
      { operation: 'zoom_extents' }
    ]) {
      const decision = await guardCadMutation(ctx({ input }), { store: s, designPolicies })
      expect(decision.blocked).toBe(false)
      expect(decision.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
  })

  it('a dryRun preview draws nothing and never arms a run', async () => {
    const s = store()
    for (let i = 0; i < 5; i++) {
      const decision = await guardCadMutation(
        ctx({
          input: {
            operation: 'apply',
            dryRun: true,
            documentName: 'basement.dwg',
            operations: [wireThroughShaft()]
          }
        }),
        { store: s, designPolicies }
      )
      expect(decision.blocked).toBe(false)
      expect(decision.placements).toBe(0)
    }
    expect(s.isProtected('run-1')).toBe(false)
  })

  it('an unrelated ordinary annotation edit is not gated as a design batch', async () => {
    const s = store()
    const decision = await guardCadMutation(
      ctx({
        input: {
          operation: 'apply',
          documentName: 'note.dwg',
          operations: [
            {
              op: 'create',
              entity: { kind: 'mtext', text: 'hi', insertion: { x: 1, y: 1, z: 0 } }
            }
          ]
        }
      }),
      { store: s }
    )
    // Text still changes geometry (one placement), but it cannot cross a zone: it counts, never
    // blocks on its own, and one annotation is not yet a layout.
    expect(decision.blocked).toBe(false)
    expect(decision.placements).toBe(1)
  })
})

const issuePass = (s: ValidationStore, over: Partial<IssueRecordInput> = {}) =>
  s.issue({
    runId: 'run-1',
    workspaceId: 'ws-1',
    deviceId: null,
    documentName: 'basement.dwg',
    documentRevision: 'tdu:100;saves:1',
    drawingFingerprint: 'draw_a',
    layoutFingerprint: 'lay_a',
    operationFingerprint: 'op_a',
    result: 'PASS',
    findings: [],
    ...over
  })
