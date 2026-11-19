import {
  VerificationReportSchema,
  type VerificationReport,
  type VerificationFinding,
  type VerificationStatus
} from '../schemas/verification-result'
import type { Point2D, SemanticModel } from '../schemas/semantic-model'
import type { StandardsRule } from '../schemas/standards-rule'
import type { HydraulicResult } from '../schemas/hydraulic-system'
import { CANONICAL_PCCC_RULES, checkEngineeringStandard } from '../capabilities/standards'
import { verifyPipeConnectivity } from '../pccc/connectivity'
import type { SprinklerLayoutResult } from '../pccc/sprinkler-layout'
import type { PipeRouteResult } from '../pccc/pipe-router'
import { pointInRing } from '../spatial/geometry'

export interface EngineeringVerificationContext {
  targetDocument?: string
  semanticModel?: SemanticModel
  sprinklerLayout?: SprinklerLayoutResult
  pipeRoute?: PipeRouteResult
  hydraulicResult?: HydraulicResult
  availableWaterPressureBar?: number
  /**
   * The riser/source connection point, in the same mm coordinates as `pipeRoute`'s segments and
   * `sprinklerLayout`'s heads — required to independently recompute `CHK_PIPE_CONNECTIVITY`
   * (aleph-platform#279 Part A). Without it, connectivity cannot be verified from geometry and
   * the check degrades to `INSUFFICIENT_DATA` rather than trusting `pipeRoute.isFullyConnected`.
   */
  riserLocation?: Point2D
  /**
   * Standards rule set for `CHK_SPRINKLER_SPACING`'s normative verdict, injected the same way
   * `checkEngineeringStandard` itself takes one — defaults to the unverified demo set
   * (`CANONICAL_PCCC_RULES`), which can therefore only ever yield `INSUFFICIENT_DATA` here too.
   * Pass a verified rule set once the clause-verification pipeline sources one.
   */
  standardsRules?: StandardsRule[]
  /**
   * Optional exclusion boundaries (closed rings in drawing mm) for pipe clearance checking.
   */
  excludedBoundaries?: Point2D[][]
}

/**
 * Deterministic Engineering Design Verification Engine.
 * Reconciles drawn CAD elements against approved engineering parameters, standard clauses,
 * and physical hydraulic constraints. Returns strict tri-state findings (PASS | FAIL | INSUFFICIENT_DATA).
 */
export function verifyEngineeringDesign(
  context: EngineeringVerificationContext
): VerificationReport {
  const findings: VerificationFinding[] = []

  // Check 1: Sprinkler Head Placement & Spacing (TCVN 7336 Table 1).
  //
  // `layout.status` (PASS/FAIL/INSUFFICIENT_DATA) is a GEOMETRIC/drafting-level verdict: did the
  // grid satisfy `sprinkler-layout.ts`'s own demo spacing table. It is never promoted to a
  // normative compliance PASS/FAIL directly (aleph-platform#279 Part A) — the demo thresholds are
  // transcribed from memory, not sourced from a verified standard, so neither "complies" nor
  // "violates" can be asserted from them. The actual compliance verdict always goes through
  // `checkEngineeringStandard`, whose evidence gate can only yield PASS/FAIL once a rule in
  // `context.standardsRules` (default: the same unverified demo set) carries `evidenceStatus:
  // 'verified'` — until then this check is INSUFFICIENT_DATA regardless of the geometry.
  if (context.sprinklerLayout) {
    const layout = context.sprinklerLayout
    if (layout.status === 'INSUFFICIENT_DATA') {
      findings.push({
        checkId: 'CHK_SPRINKLER_SPACING',
        name: 'Sprinkler Head Spacing & Clearance',
        status: 'INSUFFICIENT_DATA',
        standardRef: 'TCVN 7336',
        clauseRef: 'Bảng 1, Điều 5.2.3',
        evidence: `Layout could not be measured against the standard: ${layout.violations.join('; ')}`,
        affectedObjectIds: layout.heads.map((h) => h.id)
      })
    } else {
      const measuredM = Math.max(layout.spacingXMm, layout.spacingYMm) / 1000
      const compliance = checkEngineeringStandard(
        {
          standardId: 'TCVN 7336',
          edition: '2021',
          // No `clauseRef` filter here deliberately: the demo set's own placeholder label
          // ("Bảng 1, Điều 5.2.3") won't match a real verified rule's actual extracted
          // `clauseRef` (e.g. just "Điều 5.2.3") — standardId + edition + parameter + conditions
          // is enough to find the one applicable rule, same as `engineering_standards_check`'s
          // own callers already rely on omitting it.
          parameter: 'sprinkler_head_spacing_m',
          proposedValue: measuredM,
          unit: 'm',
          conditions: { hazardGroup: layout.hazardGroup }
        },
        context.standardsRules ?? CANONICAL_PCCC_RULES
      )
      const geometryNote =
        layout.status === 'FAIL'
          ? ` Geometric grid generation itself also found violations: ${layout.violations.join('; ')}`
          : ''
      findings.push({
        checkId: 'CHK_SPRINKLER_SPACING',
        name: 'Sprinkler Head Spacing & Clearance',
        status: compliance.status,
        standardRef: 'TCVN 7336',
        // The matched rule's own clause, not a hardcoded guess — absent when no rule matched.
        clauseRef: compliance.rule?.clauseRef ?? 'Bảng 1, Điều 5.2.3',
        measuredValue: measuredM,
        thresholdValue: compliance.thresholdValue,
        unit: 'm',
        evidence: `${compliance.message} Measured: ${layout.headCount} heads at X: ${layout.spacingXMm}mm, Y: ${layout.spacingYMm}mm over ${layout.protectedAreaM2} m² protected area.${geometryNote}`,
        affectedObjectIds: layout.heads.map((h) => h.id)
      })
    }

    // Check 2: Excluded Regions Inspection — measured, not assumed: a head inside a
    // designated excluded compartment is a violation, so verify placement against the
    // region boundaries instead of declaring compliance because regions happen to exist.
    if (context.semanticModel && context.semanticModel.excludedRegions.length > 0) {
      const headsInExcluded = layout.heads.filter((h) =>
        context.semanticModel!.excludedRegions.some((r) => pointInRing([h.x, h.y], r.boundary))
      )
      findings.push({
        checkId: 'CHK_EXCLUDED_ZONES',
        name: 'Protection Exclusion Compliance',
        status: headsInExcluded.length === 0 ? 'PASS' : 'FAIL',
        standardRef: 'QCVN 06:2022/BXD',
        clauseRef: 'Điều 3.1.2',
        evidence:
          headsInExcluded.length === 0
            ? `No sprinkler heads placed inside ${context.semanticModel.excludedRegions.length} designated excluded compartment(s).`
            : `Sprinkler heads placed inside excluded compartments: ${headsInExcluded.map((h) => h.id).join(', ')}`,
        affectedObjectIds:
          headsInExcluded.length === 0
            ? context.semanticModel.excludedRegions.map((r) => r.id)
            : headsInExcluded.map((h) => h.id)
      })
    }
  } else {
    findings.push({
      checkId: 'CHK_SPRINKLER_SPACING',
      name: 'Sprinkler Head Spacing & Clearance',
      status: 'INSUFFICIENT_DATA',
      evidence: 'No sprinkler layout data available for verification.',
      affectedObjectIds: []
    })
  }

  // Check: Pipe Excluded Zones Routing Compliance (QCVN 06:2022/BXD / TCVN 7336).
  // When excluded regions are defined, sprinkler piping must not enter or clip them.
  // Never PASS on missing evidence: if exclusions were supplied but pipeRoute carries no violation data,
  // return INSUFFICIENT_DATA.
  const hasExclusions =
    Boolean(context.semanticModel && context.semanticModel.excludedRegions.length > 0) ||
    Boolean(context.excludedBoundaries && context.excludedBoundaries.length > 0)

  if (hasExclusions) {
    if (!context.pipeRoute) {
      findings.push({
        checkId: 'CHK_PIPE_EXCLUDED_ZONES',
        name: 'Pipe Network Exclusion Zone Clearance',
        status: 'INSUFFICIENT_DATA',
        standardRef: 'QCVN 06:2022/BXD',
        clauseRef: 'Điều 3.1.2',
        evidence:
          'Exclusion boundaries defined, but no pipe route data available for verification.',
        affectedObjectIds: []
      })
    } else if (!context.pipeRoute.violations) {
      findings.push({
        checkId: 'CHK_PIPE_EXCLUDED_ZONES',
        name: 'Pipe Network Exclusion Zone Clearance',
        status: 'INSUFFICIENT_DATA',
        standardRef: 'QCVN 06:2022/BXD',
        clauseRef: 'Điều 3.1.2',
        evidence:
          'Exclusion boundaries defined, but pipe route carries no violation data for independent verification.',
        affectedObjectIds: context.pipeRoute.segments.map((s) => s.id)
      })
    } else if (context.pipeRoute.violations.length > 0) {
      const violDescs = context.pipeRoute.violations.map(
        (v) =>
          `${v.segmentId} (${v.code}${v.distanceMm !== undefined ? `, ${v.distanceMm}mm` : ''})`
      )
      findings.push({
        checkId: 'CHK_PIPE_EXCLUDED_ZONES',
        name: 'Pipe Network Exclusion Zone Clearance',
        status: 'FAIL',
        standardRef: 'QCVN 06:2022/BXD',
        clauseRef: 'Điều 3.1.2',
        evidence: `Pipe segments violate designated exclusion zone(s): ${violDescs.join('; ')}`,
        affectedObjectIds: context.pipeRoute.violations.map((v) => v.segmentId)
      })
    } else {
      findings.push({
        checkId: 'CHK_PIPE_EXCLUDED_ZONES',
        name: 'Pipe Network Exclusion Zone Clearance',
        status: 'PASS',
        standardRef: 'QCVN 06:2022/BXD',
        clauseRef: 'Điều 3.1.2',
        evidence: 'All pipe segments maintain required clearance from designated exclusion zones.',
        affectedObjectIds: context.pipeRoute.segments.map((s) => s.id)
      })
    }
  }

  // Check 3: Pipe Network Topological Continuity — independently recomputed (aleph-platform#279
  // Part A), never read off `route.isFullyConnected`/`route.disconnectedHeads` directly: those
  // are the router's own unconditional claim (`routeSprinklerPipes` returns them true by
  // construction, not by measurement — see its own doc comment), and a graph this verifier never
  // built is not evidence. This is a structural/topological fact, not a numeric standard
  // threshold, so unlike spacing it can assert PASS or FAIL directly once computed.
  if (context.pipeRoute) {
    const route = context.pipeRoute
    if (!context.riserLocation) {
      findings.push({
        checkId: 'CHK_PIPE_CONNECTIVITY',
        name: 'Piping Network Connectivity',
        status: 'INSUFFICIENT_DATA',
        standardRef: 'TCVN 7336',
        clauseRef: 'Điều 5.3',
        evidence:
          "No riserLocation supplied — connectivity cannot be independently recomputed from geometry, and the router's own isFullyConnected/disconnectedHeads claim is not trusted as evidence.",
        source: 'router_geometry',
        affectedObjectIds: route.segments.map((s) => s.id)
      })
    } else {
      const connectivity = verifyPipeConnectivity({
        riserLocation: context.riserLocation,
        heads: context.sprinklerLayout?.heads ?? [],
        segments: route.segments
      })
      findings.push({
        checkId: 'CHK_PIPE_CONNECTIVITY',
        name: 'Piping Network Connectivity',
        status: connectivity.isFullyConnected ? 'PASS' : 'FAIL',
        standardRef: 'TCVN 7336',
        clauseRef: 'Điều 5.3',
        evidence: connectivity.isFullyConnected
          ? `Independently verified: all ${context.sprinklerLayout?.heads.length ?? 0} heads lie on a segment graph-reachable from the riser (${route.segments.length} segments, total ${route.totalLengthM}m).`
          : connectivity.riserDisconnected
            ? `Riser location does not touch any pipe segment — the entire network is unreachable from the water source.`
            : `Disconnected heads (independently recomputed from the router's segment geometry, not read from its own claim): ${connectivity.disconnectedHeads.join(', ')} — the pipe run, not the head positions, is what this measurement is built from.`,
        source: 'router_geometry',
        affectedObjectIds: connectivity.disconnectedHeads.length
          ? connectivity.disconnectedHeads
          : route.segments.map((s) => s.id)
      })
    }
  }

  // Check 4: Hydraulic Pressure & Flow Capacity
  if (context.hydraulicResult) {
    const hydro = context.hydraulicResult
    if (hydro.availableSourcePressureBar !== undefined) {
      if (hydro.isPressureAdequate) {
        findings.push({
          checkId: 'CHK_HYDRAULIC_PRESSURE',
          name: 'Hydraulic Source Pressure Adequacy',
          status: 'PASS',
          standardRef: 'TCVN 7336',
          clauseRef: 'Điều 5.4.1',
          measuredValue: hydro.requiredSourcePressureBar,
          thresholdValue: hydro.availableSourcePressureBar,
          unit: 'bar',
          evidence: `Required supply pressure ${hydro.requiredSourcePressureBar} bar <= available pressure ${hydro.availableSourcePressureBar} bar at ${hydro.totalDemandFlowLpm} L/min.`,
          affectedObjectIds: [hydro.mostRemoteNodeId]
        })
      } else {
        findings.push({
          checkId: 'CHK_HYDRAULIC_PRESSURE',
          name: 'Hydraulic Source Pressure Adequacy',
          status: 'FAIL',
          standardRef: 'TCVN 7336',
          clauseRef: 'Điều 5.4.1',
          measuredValue: hydro.requiredSourcePressureBar,
          thresholdValue: hydro.availableSourcePressureBar,
          unit: 'bar',
          evidence: `Required supply pressure ${hydro.requiredSourcePressureBar} bar EXCEEDS available pressure ${hydro.availableSourcePressureBar} bar. Inadequate pressure.`,
          affectedObjectIds: [hydro.mostRemoteNodeId]
        })
      }
    } else {
      findings.push({
        checkId: 'CHK_HYDRAULIC_PRESSURE',
        name: 'Hydraulic Source Pressure Adequacy',
        status: 'INSUFFICIENT_DATA',
        standardRef: 'TCVN 7336',
        clauseRef: 'Điều 5.4.1',
        measuredValue: hydro.requiredSourcePressureBar,
        unit: 'bar',
        evidence: `Required pressure is ${hydro.requiredSourcePressureBar} bar, but available supply pressure was not provided in Design Basis.`,
        affectedObjectIds: [hydro.mostRemoteNodeId]
      })
    }
  } else {
    // aleph-platform#279 Part A regression: this branch used to be `else if
    // (!context.availableWaterPressureBar)`, so a caller supplying a bare pressure number with NO
    // hydraulic calculation skipped this finding entirely — `overallStatus` could then read PASS
    // while the network's actual demand flow/pressure was never computed at all. A bar number
    // alone is not proof; only a real `hydraulicResult` (Hazen-Williams demand vs. that pressure)
    // is, so this finding is now pushed unconditionally whenever no `hydraulicResult` was given.
    findings.push({
      checkId: 'CHK_HYDRAULIC_PRESSURE',
      name: 'Hydraulic Source Pressure Adequacy',
      status: 'INSUFFICIENT_DATA',
      standardRef: 'TCVN 7336',
      clauseRef: 'Điều 5.4.1',
      evidence:
        context.availableWaterPressureBar !== undefined
          ? `A source pressure of ${context.availableWaterPressureBar} bar was supplied, but no hydraulic calculation (demand flow, friction/elevation loss, required pressure at the most remote head) was run against it — a bar number alone does not demonstrate adequacy.`
          : 'No water supply pressure or hydraulic calculation available to verify adequacy.',
      affectedObjectIds: []
    })
  }
  // Calculate summary counts
  let passCount = 0
  let failCount = 0
  let insufficientDataCount = 0
  let notApplicableCount = 0

  for (const f of findings) {
    if (f.status === 'PASS') passCount++
    else if (f.status === 'FAIL') failCount++
    else if (f.status === 'INSUFFICIENT_DATA') insufficientDataCount++
    else if (f.status === 'NOT_APPLICABLE') notApplicableCount++
  }

  const overallStatus =
    failCount > 0 ? 'FAIL' : insufficientDataCount > 0 ? 'INSUFFICIENT_DATA' : 'PASS'

  return VerificationReportSchema.parse({
    reportId: `vr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    targetDocument: context.targetDocument,
    overallStatus,
    findings,
    summary: {
      passCount,
      failCount,
      insufficientDataCount,
      notApplicableCount
    },
    generatedAt: Date.now()
  })
}
