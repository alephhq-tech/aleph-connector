import type { Point2D } from '../schemas/semantic-model'
import {
  areaOf,
  bboxOf,
  bboxOverlap,
  distanceToRingBoundary,
  pointInPolygon,
  segmentDistance,
  type BBox
} from './geometry'
import type { SpatialFinding } from './constraints'
import type { CompiledCadPlan, CompiledStep } from './operations-compile'
import {
  evaluatePolicy,
  policySetVersion,
  type EngineeringPolicy,
  type PolicyAuthorization
} from './policy'

/**
 * Deterministic preflight for a COMPILED CAD plan.
 *
 * This is the layer that decides whether a fire-alarm route may physically pass through an
 * elevator shaft. Three invariants:
 *
 * 1. **Segments, not placements.** Every straight leg of every line/polyline/arc is tested. A wire
 *    whose endpoints both sit outside a zone but whose middle leg crosses it is the exact failure
 *    this exists to catch; an endpoint or bounding-box test waves it through.
 * 2. **Unknown is never a pass.** An unverified polygon, an unclassifiable region, an opaque
 *    (invisible) step, a degenerate ring, or partial spatial coverage yields FAIL/INSUFFICIENT_DATA.
 *    PASS is issued only over geometry that was actually read and actually cleared.
 * 3. **Permission is data, not payload.** Whether a device class may enter a zone comes from the
 *    project's policy set plus server-issued authorizations. A field in the mutation payload can
 *    never grant an exception.
 *
 * Boundary contact is policy-defined rather than hardcoded: `boundaryContact: 'block'` (the
 * default for engineering systems) treats a route that grazes or runs collinear with a zone
 * boundary as a violation; `'allow'` permits flush work up to `boundaryTolerance`.
 */

export interface RestrictedZone {
  id: string
  /** `elevator_shaft`, `stairwell`, `electrical_riser`, `fire_compartment`, `unknown`, ... */
  zoneClass: string
  outer: Point2D[]
  holes?: Point2D[][]
  /** True only when the ring came from verified native geometry. */
  verified: boolean
  sourceHandles: string[]
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  /** What the classification leaned on, for the audit trail. */
  evidence?: string
}

export interface PreflightOptions {
  /** Engineering system the batch belongs to; matched against policy `system` values. */
  system: string
  /** Boundary points this far from the ring count as ON it (drawing units). Default 0. */
  boundaryTolerance?: number
  /** Minimum distance a route or device must keep from a zone boundary. Applied only when
   * supplied — an invented clearance would be a fake regulation. */
  clearance?: number
  /** How to treat grazing/collinear contact with a boundary. Default 'block'. */
  boundaryContact?: 'block' | 'allow'
  /** Treat low/unknown-confidence zone classification as blocking. Default true. */
  blockOnUnverifiedZone?: boolean
}

/** The spatial evidence the verdict was reached over: coverage is part of the claim. */
export interface PreflightEvidence {
  /** False when the zone set came from a partial index/scan: absence of a zone is then not
   * evidence that no zone exists. */
  coverageSufficient: boolean
  documentRevision?: string
  sourceHandles?: string[]
}

export interface PreflightResult {
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
  findings: SpatialFinding[]
  /** Digest of the exact compiled operations this verdict covers. */
  planHash: string
  policyVersion: string
  zonesConsidered: number
  segmentsTested: number
}

interface ZoneViolation {
  code: string
  message: string
  measurements: Record<string, number>
  suggestedCorrection: string
}

/** Is `pt` strictly inside the polygon (boundary excluded within `tol`)? */
const insideZone = (pt: Point2D, zone: RestrictedZone, tol: number): boolean =>
  pointInPolygon(pt, zone.outer, zone.holes ?? [], tol)

/**
 * Does segment AB cross into the interior of the zone? Both endpoints outside is the case that
 * defeats endpoint and bounding-box tests, so it is checked by boundary crossing, not by sampling.
 */
function crossesInterior(a: Point2D, b: Point2D, zone: RestrictedZone): boolean {
  const rings = [zone.outer, ...(zone.holes ?? [])]
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const c = ring[i]!
      const d = ring[(i + 1) % n]!
      // A genuine crossing puts the endpoints on opposite sides of the edge line.
      const o1 = orient2d(c, d, a)
      const o2 = orient2d(c, d, b)
      const o3 = orient2d(a, b, c)
      const o4 = orient2d(a, b, d)
      const straddle =
        ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
      if (straddle) return true
    }
  }
  return false
}

const orient2d = (a: Point2D, b: Point2D, p: Point2D): number =>
  (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])

function segmentToRingDistance(a: Point2D, b: Point2D, ring: Point2D[]): number {
  let best = Infinity
  const n = ring.length
  for (let i = 0; i < n; i++) {
    best = Math.min(best, segmentDistance(a, b, ring[i]!, ring[(i + 1) % n]!))
    if (best === 0) return 0
  }
  return best
}

function stepBBox(step: CompiledStep): BBox | null {
  if (step.kind === 'segment') return bboxOf(step.segments.flatMap((s) => [s.start, s.end]))
  if (step.kind === 'placement') return bboxOf(step.footprint ?? [step.center])
  if (step.kind === 'point') {
    return {
      minX: step.position[0],
      minY: step.position[1],
      maxX: step.position[0],
      maxY: step.position[1]
    }
  }
  return null
}

const expandBox = (box: BBox, by: number): BBox => ({
  minX: box.minX - by,
  minY: box.minY - by,
  maxX: box.maxX + by,
  maxY: box.maxY + by
})

function checkStepAgainstZone(
  step: CompiledStep,
  zone: RestrictedZone,
  options: Required<Pick<PreflightOptions, 'boundaryTolerance' | 'boundaryContact'>> & {
    clearance?: number
  }
): ZoneViolation | null {
  const { boundaryTolerance: tol, boundaryContact, clearance } = options

  if (step.kind === 'segment') {
    for (const [segmentIndex, seg] of step.segments.entries()) {
      const aIn = insideZone(seg.start, zone, tol)
      const bIn = insideZone(seg.end, zone, tol)
      if (aIn || bIn || crossesInterior(seg.start, seg.end, zone)) {
        return {
          code: 'ROUTE_CROSSES_RESTRICTED_ZONE',
          message: `route segment ${segmentIndex} of step ${step.index} passes through restricted zone ${zone.id} (${zone.zoneClass})`,
          measurements: {
            segmentIndex,
            startX: seg.start[0],
            startY: seg.start[1],
            endX: seg.end[0],
            endY: seg.end[1],
            // 1 marks the bbox/endpoint-test defeat case: both ends outside, interior crossed.
            bothEndpointsOutside: aIn || bIn ? 0 : 1
          },
          suggestedCorrection: `reroute segment ${segmentIndex} around ${zone.id} (source geometry: ${zone.sourceHandles.join(', ') || 'unknown'})`
        }
      }
      const required = clearance ?? 0
      for (const ring of [zone.outer, ...(zone.holes ?? [])]) {
        const distance = segmentToRingDistance(seg.start, seg.end, ring)
        if (required > 0 && distance < required) {
          return {
            code: 'ROUTE_CLIPS_RESTRICTED_ZONE',
            message: `route segment ${segmentIndex} of step ${step.index} passes ${Math.round(distance)} units from the boundary of ${zone.id} (${required} required)`,
            measurements: { segmentIndex, boundaryDistance: distance, required },
            suggestedCorrection: `keep this segment at least ${required} units clear of ${zone.id}`
          }
        }
        if (boundaryContact === 'block' && distance <= tol) {
          return {
            code: 'ROUTE_TOUCHES_RESTRICTED_ZONE',
            message: `route segment ${segmentIndex} of step ${step.index} runs along or touches the boundary of ${zone.id} (contact policy: block)`,
            measurements: { segmentIndex, boundaryDistance: distance, tolerance: tol },
            suggestedCorrection: `offset the segment from ${zone.id}'s boundary, or set an explicit boundary-contact allowance in the policy`
          }
        }
      }
    }
    return null
  }

  if (step.kind === 'placement' || step.kind === 'point') {
    const center = step.kind === 'placement' ? step.center : step.position
    const pts = step.kind === 'placement' ? (step.footprint ?? [step.center]) : [step.position]
    // A stated footprint is inside only when all of it is; a bare point when it lands inside.
    const inside =
      step.kind === 'placement' && step.footprint
        ? pts.every((p) => insideZone(p, zone, tol))
        : pts.some((p) => insideZone(p, zone, tol))
    if (inside) {
      return {
        code: 'DEVICE_IN_RESTRICTED_ZONE',
        message: `${step.deviceType ?? step.entityKind} at step ${step.index} lies inside restricted zone ${zone.id} (${zone.zoneClass})`,
        measurements: { x: center[0], y: center[1] },
        suggestedCorrection: `move the device outside ${zone.id}, or obtain an explicit policy authorization for it`
      }
    }
    if (clearance !== undefined && clearance > 0) {
      const distance = Math.min(...pts.map((p) => distanceToRingBoundary(p, zone.outer)))
      if (distance < clearance) {
        return {
          code: 'DEVICE_CLEARANCE_VIOLATION',
          message: `${step.deviceType ?? step.entityKind} at step ${step.index} sits ${Math.round(distance)} units from ${zone.id} (${clearance} required)`,
          measurements: { boundaryDistance: distance, required: clearance },
          suggestedCorrection: `keep ${step.deviceType ?? 'the device'} at least ${clearance} units from ${zone.id}`
        }
      }
    }
  }
  return null
}

/**
 * Validate every geometric step of a compiled plan against the restricted zones of the region.
 *
 * `plan` MUST be the output of `compileCadPayload` over the payload that will actually be
 * dispatched — that is the only thing that makes the verdict say something about the drawing.
 */
export function preflightCompiledPlan(args: {
  plan: CompiledCadPlan
  planHash: string
  zones: RestrictedZone[]
  policies: EngineeringPolicy[]
  authorizations?: PolicyAuthorization[]
  binding: { runId: string; workspaceId: string }
  options: PreflightOptions
  evidence?: PreflightEvidence
}): PreflightResult {
  const { plan, planHash, zones, policies, options, binding } = args
  const tol = options.boundaryTolerance ?? 0
  const blockUnverified = options.blockOnUnverifiedZone ?? true
  const contact = options.boundaryContact ?? 'block'
  const findings: SpatialFinding[] = []
  let segmentsTested = 0

  // 0. An opaque step means the payload hides operations this preflight never saw. Never PASS.
  const opaqueSteps = plan.steps.filter((s) => s.kind === 'opaque')
  if (opaqueSteps.length > 0) {
    findings.push({
      code: 'PLAN_OPAQUE_OPERATIONS',
      severity: 'error',
      status: 'INSUFFICIENT_DATA',
      entityIds: opaqueSteps.map((s) => `step:${s.index}`),
      constraintId: 'restricted-zone',
      message: `this CAD payload compiles geometry the preflight cannot see: ${plan.opaqueReasons.slice(0, 3).join('; ')}`,
      suggestedCorrection:
        'validate the compiled operations themselves (construct/entity dryRun returns them), or use the task-level executor, which preflights internally before drawing'
    })
  }

  // 1. Coverage: a partial zone set cannot prove that no protected region is in the way.
  if (args.evidence && args.evidence.coverageSufficient === false) {
    findings.push({
      code: 'COVERAGE_INSUFFICIENT',
      severity: 'error',
      status: 'INSUFFICIENT_DATA',
      entityIds: zones.map((z) => z.id),
      constraintId: 'restricted-zone',
      message: `the zone set for this region came from partial CAD State coverage, so a "no zone here" conclusion is unsupported (${zones.length} zone(s) known)`,
      suggestedCorrection:
        're-read the region with entity.list detail:"full" over the affected window, or refresh CAD State and re-validate'
    })
  }

  // 2. Zone-quality gates: a zone we cannot trust may not be used to certify safety.
  for (const zone of zones) {
    const ids = [zone.id, ...(zone.sourceHandles ?? [])]
    if (
      !zone.verified ||
      (blockUnverified && (zone.confidence === 'low' || zone.confidence === 'unknown'))
    ) {
      findings.push({
        code: 'ZONE_GEOMETRY_UNVERIFIED',
        severity: 'error',
        status: 'INSUFFICIENT_DATA',
        entityIds: ids,
        constraintId: 'restricted-zone',
        message: `zone ${zone.id} (${zone.zoneClass}) is ${zone.verified ? 'low-confidence' : 'not geometry-verified'} — a safety-critical batch cannot be certified against it`,
        suggestedCorrection: `re-read the source entities (${zone.sourceHandles.join(', ') || 'unknown'}) with entity.get detail:"full" and rebuild the zone polygon`
      })
    }
    if (zone.outer.length < 3 || areaOf(zone.outer) === 0) {
      findings.push({
        code: 'ZONE_BOUNDARY_INVALID',
        severity: 'error',
        status: 'INSUFFICIENT_DATA',
        entityIds: ids,
        constraintId: 'restricted-zone',
        message: `zone ${zone.id} has an open or degenerate boundary (${zone.outer.length} vertices, area ${Math.round(areaOf(zone.outer))})`,
        suggestedCorrection:
          'reconstruct the boundary from its wall segments, or report insufficient data'
      })
    }
    if (zone.zoneClass === 'unknown') {
      findings.push({
        code: 'ZONE_CLASSIFICATION_UNKNOWN',
        severity: 'error',
        status: 'INSUFFICIENT_DATA',
        entityIds: ids,
        constraintId: 'restricted-zone',
        message: `region ${zone.id} could not be classified — drawing through an unclassified region is not authorized`,
        suggestedCorrection:
          'classify the region from its labels/layers with evidence, or route around it'
      })
    }
  }

  const usableZones = zones.filter((z) => z.outer.length >= 3)

  // 3. Every geometric step, against every zone whose (expanded) bbox it can reach.
  for (const step of plan.steps) {
    if (step.kind === 'annotation' || step.kind === 'opaque') continue
    const stepBox = stepBBox(step)
    if (!stepBox) {
      findings.push({
        code: 'STEP_GEOMETRY_UNREADABLE',
        severity: 'error',
        status: 'INSUFFICIENT_DATA',
        entityIds: [`step:${step.index}`],
        constraintId: 'restricted-zone',
        message: `step ${step.index} (${step.entityKind}) produced no usable coordinates`,
        suggestedCorrection: 'compile the plan from the exact payload that will be dispatched'
      })
      continue
    }
    for (const zone of usableZones) {
      const zoneBox = bboxOf(zone.outer)
      if (zoneBox && !bboxOverlap(stepBox, expandBox(zoneBox, tol + (options.clearance ?? 0))))
        continue

      const violation = checkStepAgainstZone(step, zone, {
        boundaryTolerance: tol,
        boundaryContact: contact,
        ...(options.clearance !== undefined && { clearance: options.clearance })
      })
      if (!violation) continue
      if (step.kind === 'segment') segmentsTested += step.segments.length

      const policyVerdict = evaluatePolicy(
        policies,
        {
          system: options.system,
          zoneClass: zone.zoneClass,
          deviceType: step.deviceType,
          operation: step.kind === 'segment' ? 'route_through' : 'place'
        },
        args.authorizations ?? [],
        binding
      )

      // No rule covering (system, zoneClass): silence is not permission for a protected batch.
      if (policyVerdict.decision === 'no_rule') {
        findings.push({
          code: 'POLICY_UNCOVERED_ZONE',
          severity: 'error',
          status: 'INSUFFICIENT_DATA',
          entityIds: [`step:${step.index}`, zone.id],
          constraintId: 'restricted-zone',
          measurements: violation.measurements,
          message: `${violation.message} No policy rule covers ${options.system} in a ${zone.zoneClass} zone, so the interaction cannot be judged either way.`,
          suggestedCorrection: `state a rule for ${options.system} x ${zone.zoneClass} in the project policy set, or route clear of ${zone.id}`
        })
        continue
      }
      if (policyVerdict.decision === 'allow') {
        findings.push({
          code: 'RESTRICTED_ZONE_AUTHORIZED',
          severity: 'info',
          status: 'PASS',
          entityIds: [`step:${step.index}`, zone.id],
          constraintId: 'restricted-zone',
          measurements: violation.measurements,
          message: `${violation.message} — permitted by ${policyVerdict.policyId}@${policyVerdict.policyVersion} rule ${policyVerdict.ruleId}`
        })
        continue
      }
      if (policyVerdict.decision === 'needs_authorization') {
        findings.push({
          code: 'POLICY_AUTHORIZATION_REQUIRED',
          severity: 'error',
          status: 'INSUFFICIENT_DATA',
          entityIds: [`step:${step.index}`, zone.id],
          constraintId: 'restricted-zone',
          measurements: violation.measurements,
          message: `${policyVerdict.reason}. ${violation.message}`,
          suggestedCorrection:
            'obtain an explicit user approval or Design-Basis authorization naming this rule, then re-validate'
        })
        continue
      }
      findings.push({
        code: violation.code,
        severity: 'error',
        status: 'FAIL',
        entityIds: [`step:${step.index}`, zone.id, ...zone.sourceHandles],
        constraintId: 'restricted-zone',
        measurements: violation.measurements,
        message: `${violation.message} ${policyVerdict.reason}.`,
        suggestedCorrection: violation.suggestedCorrection
      })
    }
  }

  const status: PreflightResult['status'] = findings.some((f) => f.status === 'FAIL')
    ? 'FAIL'
    : findings.some((f) => f.status === 'INSUFFICIENT_DATA')
      ? 'INSUFFICIENT_DATA'
      : 'PASS'

  return {
    status,
    findings,
    planHash,
    policyVersion: policySetVersion(policies),
    zonesConsidered: usableZones.length,
    segmentsTested
  }
}
