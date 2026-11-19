import type { CompiledCadPlan } from './operations-compile'
import type { Point2D } from '../schemas/semantic-model'
import type { SpatialModel, Furniture } from './spatial-schema'
import {
  validateBatch,
  checkAccessibility,
  type FindingStatus,
  type ProposedPlacement,
  type SpatialFinding,
  type ValidateOptions
} from './constraints'
import { extractSpatialModel, type SpatialRawEntity, type SpatialExtractOptions } from './extract'

/**
 * Post-mutation read-back verification.
 *
 * The preflight gate (`validateBatch`) proves a layout is valid BEFORE it is drawn. This module
 * answers the different, harder question: after the CAD batch committed, is what is ACTUALLY on the
 * drawing still the layout that was validated? A validated plan and a drawn drawing are not the same
 * object — a tool that rounds a coordinate, snaps to a grid, drops one entity, or draws a slightly
 * different block than requested turns a PASS plan into a FAIL drawing, and the preflight verdict
 * cannot see any of that because it ran on the plan, not the result.
 *
 * So this re-reads the drawing (the caller supplies the entity snapshot it just read back with
 * `entity.list`), maps each planned placement to the entity that actually landed, and re-runs the
 * SAME constraint engine on the actual geometry. The verdict is computed from what is on the drawing,
 * never from the plan's earlier PASS — that independence is the whole point. A read-back that trusted
 * the pre-validation would be a rubber stamp.
 *
 * Deterministic and pure: same planned set + same actual snapshot → same report. No CAD dialing, no
 * randomness.
 */

export interface PlannedItem {
  /** The id the caller gave the placement in the validated batch. */
  id: string
  kind: ProposedPlacement['kind']
  center: Point2D
  width: number
  depth: number
  rotationDeg?: number
  /** The CAD handle the mutation reported for this item, when the caller has it. */
  handle?: string
  spaceId?: string
  intent?: ProposedPlacement['intent']
}

export interface ReadbackOptions extends ValidateOptions {
  /**
   * A planned item whose actual centre sits more than this many drawing units from where it was
   * planned counts as DRIFTED (not merely matched). Default 50 (mm) — well above float noise, well
   * below anything a drafter would accept as "the same placement".
   */
  positionTolerance?: number
  /** A planned item with no actual entity within this distance is MISSING. Default 2000. */
  matchRadius?: number
  /**
   * How many repair rounds this run has ALREADY spent on this drawing (0 = first read-back).
   * The engine is pure, so it cannot count rounds itself — the caller supplies the number, and the
   * engine enforces the bound. That is what stops a fix→drift→fix loop from running forever.
   */
  repairAttempt?: number
  /** Hard bound on repair rounds. Default 2. At or above it the plan escalates instead of fixing. */
  maxRepairAttempts?: number
}

export type RepairAction = 'move' | 'draw' | 'erase' | 'escalate'

export interface RepairStep {
  action: RepairAction
  /** Drawing handle to act on (move/erase), or the planned id to draw. */
  target: string
  /** Where to put it (move/draw); absent for erase. */
  to?: Point2D
  reason: string
}

/**
 * The bounded repair plan: what to do about a non-faithful read-back, and whether the engine is
 * still willing to try at all. Mechanical fixes (move/draw/erase) are only offered for discrepancies
 * the read-back can name exactly. Once the round bound is spent, or the failure has no mechanical
 * cause (the PLAN was wrong, not the drawing), the honest answer is escalate: re-run the preflight
 * with fresh geometry and tell the user — not another blind edit.
 */
export interface RepairPlan {
  attempt: number
  maxAttempts: number
  /** True when the bound is spent or the failure is not mechanically fixable. */
  escalate: boolean
  steps: RepairStep[]
  note: string
}

export type MatchState = 'matched' | 'drifted' | 'missing' | 'extra'

export interface ItemMatch {
  plannedId: string
  state: MatchState
  /** The actual furniture handle the planned item was matched to, when there is one. */
  actualHandle: string | null
  /** Planned centre vs actual centre distance (drawing units); null when missing. */
  positionDelta: number | null
  /** Planned footprint vs actual footprint area delta (drawing units²); null when missing. */
  areaDelta: number | null
  /** Where the plan put it; null for an EXTRA (never planned). */
  plannedCenter: Point2D | null
  /** Where the drawing has it; null for a MISSING (never drawn). */
  actualCenter: Point2D | null
  confidence: 'high' | 'medium' | 'low'
  detail: string
}

export interface ReadbackReport {
  /** The verdict on the DRAWING as it actually is now — independent of the plan's earlier PASS. */
  status: FindingStatus
  /** Per planned item: did it land, and did it land where it was planned. */
  matches: ItemMatch[]
  /** Planned items that are absent or drifted beyond tolerance. */
  discrepancies: string[]
  /** Findings from re-running the constraint engine on the actual geometry. */
  findings: SpatialFinding[]
  /** True when the drawing matches the plan AND the re-validated layout passes. */
  faithful: boolean
  /** What to do about it — bounded so a fix→drift→fix loop cannot run forever. */
  repair: RepairPlan
}

/** Match a planned placement to the actual furniture entity that best corresponds to it. */
function matchOne(
  planned: PlannedItem,
  actual: Furniture[],
  used: Set<string>,
  opts: ReadbackOptions
): { furniture: Furniture | null; distance: number } {
  const matchRadius = opts.matchRadius ?? 2000
  // A reported handle is the strongest signal: the mutation told us which entity this became.
  if (planned.handle) {
    const byHandle = actual.find((f) => f.handle === planned.handle && !used.has(f.handle))
    if (byHandle) {
      return {
        furniture: byHandle,
        distance: Math.hypot(
          byHandle.insertion[0] - planned.center[0],
          byHandle.insertion[1] - planned.center[1]
        )
      }
    }
  }
  // Otherwise nearest unused furniture whose centre is within the match radius.
  let best: Furniture | null = null
  let bestD = Infinity
  for (const f of actual) {
    if (used.has(f.handle)) continue
    const d = Math.hypot(f.insertion[0] - planned.center[0], f.insertion[1] - planned.center[1])
    if (d < bestD) {
      bestD = d
      best = f
    }
  }
  if (best && bestD <= matchRadius) return { furniture: best, distance: bestD }
  return { furniture: null, distance: bestD }
}

/**
 * Decide what to do about a non-faithful read-back, and whether the engine is still willing to try.
 *
 * Mechanical fixes are only offered for discrepancies the read-back can name exactly: a drifted item
 * moves back to its planned centre, a missing item gets drawn there, an extra one gets erased. A
 * failure with NO mechanical discrepancy — the drawing faithfully implements the plan and the plan
 * itself is invalid, or the data is insufficient — is not fixable by editing the drawing; the honest
 * move is to re-run the preflight with fresh geometry, so it escalates immediately rather than
 * burning a round on a blind edit.
 *
 * The bound is the point: `repairAttempt` is how many rounds the CALLER has already spent (the engine
 * is pure and stateless, so it cannot count them), and at `maxRepairAttempts` the plan escalates no
 * matter what. A fix→drift→fix loop therefore terminates on its own instead of grinding until the
 * turn's tool-call budget runs out.
 */
function planRepair(
  matches: ItemMatch[],
  status: FindingStatus,
  faithful: boolean,
  opts: ReadbackOptions
): RepairPlan {
  const attempt = opts.repairAttempt ?? 0
  const maxAttempts = opts.maxRepairAttempts ?? 2

  if (faithful) {
    return {
      attempt,
      maxAttempts,
      escalate: false,
      steps: [],
      note: 'drawing is faithful — nothing to repair'
    }
  }

  const steps: RepairStep[] = []
  for (const m of matches) {
    if (m.state === 'drifted' && m.actualHandle && m.plannedCenter) {
      steps.push({
        action: 'move',
        target: m.actualHandle,
        to: m.plannedCenter,
        reason: `landed ${Math.round(m.positionDelta ?? 0)} units from its planned position`
      })
    } else if (m.state === 'missing' && m.plannedCenter) {
      steps.push({
        action: 'draw',
        target: m.plannedId,
        to: m.plannedCenter,
        reason: 'planned but never drawn'
      })
    } else if (m.state === 'extra' && m.actualHandle) {
      steps.push({
        action: 'erase',
        target: m.actualHandle,
        reason: 'on the drawing but not in the plan'
      })
    }
  }

  if (steps.length === 0) {
    // Nothing mechanical to fix: the drawing matches the plan, so the PLAN is the problem (or the
    // geometry is too uncertain to judge). Editing entities cannot repair that.
    return {
      attempt,
      maxAttempts,
      escalate: true,
      steps: [
        {
          action: 'escalate',
          target: '*',
          reason: `re-validation says ${status} with no planned-vs-drawn discrepancy`
        }
      ],
      note:
        status === 'INSUFFICIENT_DATA'
          ? 'the drawing cannot be judged from the geometry available — read more of the drawing (entity.list with a window/layer filter) and re-run spatial_validate_layout'
          : 'the drawing faithfully implements the plan but the plan itself fails validation — re-run spatial_validate_layout with corrected placements before drawing again'
    }
  }

  if (attempt >= maxAttempts) {
    return {
      attempt,
      maxAttempts,
      escalate: true,
      steps: [
        { action: 'escalate', target: '*', reason: `${maxAttempts} repair rounds already spent` }
      ],
      note: `repair bound reached (${attempt}/${maxAttempts} rounds) — stop editing and report the remaining discrepancies to the user with the standard/geometry that blocks them`
    }
  }

  return {
    attempt,
    maxAttempts,
    escalate: false,
    steps,
    note: `repair round ${attempt + 1}/${maxAttempts}: apply these edits, then read the drawing back and verify again`
  }
}

/**
 * Verify a drawn layout against the plan it was supposed to implement.
 *
 * `entities` is the snapshot read back AFTER the mutation (entity.list detail:"full"). The actual
 * furniture is extracted from it, matched to the planned items, and the whole actual layout is
 * re-validated with the same engine the preflight used. `faithful` is true only when every planned
 * item matched within tolerance AND the re-validated verdict is PASS.
 */
export function verifyDrawnLayout(
  planned: PlannedItem[],
  entities: SpatialRawEntity[],
  extractOptions: SpatialExtractOptions = {},
  opts: ReadbackOptions = {}
): ReadbackReport {
  const model = extractSpatialModel(entities, extractOptions)
  const positionTolerance = opts.positionTolerance ?? 50

  const used = new Set<string>()
  const matches: ItemMatch[] = []
  const discrepancies: string[] = []

  for (const p of planned) {
    const { furniture, distance } = matchOne(p, model.furniture, used, opts)
    if (!furniture) {
      matches.push({
        plannedId: p.id,
        state: 'missing',
        actualHandle: null,
        positionDelta: null,
        areaDelta: null,
        plannedCenter: p.center,
        actualCenter: null,
        confidence: 'high',
        detail: `no drawn entity corresponds to planned ${p.id}`
      })
      discrepancies.push(`MISSING: ${p.id} was planned but nothing was drawn for it`)
      continue
    }
    used.add(furniture.handle)
    const plannedArea = p.width * p.depth
    const actualArea = furniture.width * furniture.depth
    const drifted = distance > positionTolerance
    matches.push({
      plannedId: p.id,
      state: drifted ? 'drifted' : 'matched',
      actualHandle: furniture.handle,
      positionDelta: distance,
      areaDelta: actualArea - plannedArea,
      plannedCenter: p.center,
      actualCenter: furniture.insertion,
      confidence:
        furniture.confidence === 'high'
          ? 'high'
          : furniture.confidence === 'medium'
            ? 'medium'
            : 'low',
      detail: drifted
        ? `${p.id} landed ${Math.round(distance)} units from where it was planned (tolerance ${positionTolerance})`
        : `${p.id} matches its plan within ${Math.round(distance)} units`
    })
    if (drifted) discrepancies.push(`DRIFTED: ${matches[matches.length - 1]!.detail}`)
  }

  // Actual furniture that no planned item claimed: the drawing has something the plan did not.
  for (const f of model.furniture) {
    if (used.has(f.handle)) continue
    if (f.kind === 'column') continue // structural fabric is not a planned placement
    matches.push({
      plannedId: f.handle,
      state: 'extra',
      actualHandle: f.handle,
      positionDelta: null,
      areaDelta: null,
      plannedCenter: null,
      actualCenter: f.insertion,
      confidence: 'medium',
      detail: `drawn ${f.kind} ${f.handle} was not in the plan`
    })
    discrepancies.push(`EXTRA: ${f.handle} (${f.kind}) is on the drawing but was not planned`)
  }

  // Re-validate the ACTUAL layout: placements rebuilt from what is really drawn, not from the plan.
  const actualPlacements: ProposedPlacement[] = model.furniture
    .filter((f) => f.kind !== 'column')
    .map((f) => ({
      id: f.handle,
      kind: f.kind,
      center: f.insertion,
      width: f.width,
      depth: f.depth,
      rotationDeg: f.rotationDeg,
      footprint: f.footprint,
      spaceId: f.assignedSpaceId ?? undefined
    }))
  const batch = validateBatch({ model, placements: actualPlacements, options: opts })
  const access = checkAccessibility(model, opts)
  const findings = [...batch.findings, ...access.findings]
  const status: FindingStatus = findings.some((f) => f.status === 'FAIL')
    ? 'FAIL'
    : findings.some((f) => f.status === 'INSUFFICIENT_DATA')
      ? 'INSUFFICIENT_DATA'
      : 'PASS'

  const allMatched = matches.every((m) => m.state === 'matched')
  const faithful = allMatched && status === 'PASS'

  return {
    status,
    matches,
    discrepancies,
    findings,
    faithful,
    repair: planRepair(matches, status, faithful, opts)
  }
}

export interface PlanReadbackOptions {
  /** Tolerance in drawing units (mm) for endpoint and center matching. Default 50. */
  positionTolerance?: number
  /** Verify that matched entity is on the planned layer. Default true. */
  checkLayers?: boolean
}

export interface StepReadbackMatch {
  stepIndex: number
  kind: string
  status: 'matched' | 'drifted' | 'missing'
  delta?: number
  actualHandle?: string
  detail: string
}

export interface PlanReadbackReport {
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
  faithful: boolean
  matches: StepReadbackMatch[]
  discrepancies: string[]
  stats: {
    totalSteps: number
    matchedSteps: number
    driftedSteps: number
    missingSteps: number
  }
}

/**
 * Post-mutation verification of a compiled CAD plan against native read-back geometry.
 *
 * Checks that every compiled step (line segment, polyline, block placement) actually landed
 * on the drawing within positionTolerance, on the correct layer, and without drift.
 */
export function verifyCompiledPlanReadback(
  plan: CompiledCadPlan,
  entities: SpatialRawEntity[],
  opts: PlanReadbackOptions = {}
): PlanReadbackReport {
  const tol = opts.positionTolerance ?? 50
  const checkLayers = opts.checkLayers ?? true

  if (plan.opaque) {
    return {
      status: 'INSUFFICIENT_DATA',
      faithful: false,
      matches: [],
      discrepancies: ['plan contains opaque steps whose expected geometry is not enumerated'],
      stats: {
        totalSteps: plan.steps.length,
        matchedSteps: 0,
        driftedSteps: 0,
        missingSteps: plan.steps.length
      }
    }
  }

  const matches: StepReadbackMatch[] = []
  const discrepancies: string[] = []
  const usedHandles = new Set<string>()

  const drawnLines: Array<{ handle: string; layer: string; start: Point2D; end: Point2D }> = []
  const drawnPlacements: Array<{
    handle: string
    layer: string
    center: Point2D
    blockName?: string
  }> = []

  for (const ent of entities) {
    const geom = ent.geometry
    if (!geom) continue
    if (ent.kind === 'line' && geom.start && geom.end) {
      drawnLines.push({
        handle: ent.handle,
        layer: ent.layer,
        start: [geom.start.x, geom.start.y],
        end: [geom.end.x, geom.end.y]
      })
    } else if (ent.kind === 'polyline' && Array.isArray(geom.vertices)) {
      const pts: Point2D[] = []
      for (const v of geom.vertices) {
        if (Array.isArray(v)) pts.push([v[0], v[1]])
        else if (v.point) pts.push([v.point.x, v.point.y])
        else if (v.x != null && v.y != null) pts.push([v.x, v.y])
      }
      for (let i = 0; i < pts.length - 1; i++) {
        drawnLines.push({
          handle: `${ent.handle}:${i}`,
          layer: ent.layer,
          start: pts[i]!,
          end: pts[i + 1]!
        })
      }
      if (geom.closed && pts.length > 2) {
        drawnLines.push({
          handle: `${ent.handle}:${pts.length - 1}`,
          layer: ent.layer,
          start: pts[pts.length - 1]!,
          end: pts[0]!
        })
      }
    } else if (ent.kind === 'blockReference' || ent.kind === 'insert') {
      const pos = geom.position ?? geom.center
      if (pos) {
        drawnPlacements.push({
          handle: ent.handle,
          layer: ent.layer,
          center: [pos.x, pos.y],
          blockName: geom.blockName ?? geom.name
        })
      }
    }
  }

  const ptDist = (a: Point2D, b: Point2D): number => Math.hypot(a[0] - b[0], a[1] - b[1])
  const segmentDist = (
    s1: { start: Point2D; end: Point2D },
    s2: { start: Point2D; end: Point2D }
  ): number => {
    const fwd = Math.max(ptDist(s1.start, s2.start), ptDist(s1.end, s2.end))
    const rev = Math.max(ptDist(s1.start, s2.end), ptDist(s1.end, s2.start))
    return Math.min(fwd, rev)
  }

  for (const step of plan.steps) {
    if (step.kind === 'segment') {
      let stepMatched = true
      let maxDelta = 0
      for (const seg of step.segments) {
        let bestDist = Infinity
        let bestLine: (typeof drawnLines)[0] | undefined
        for (const dl of drawnLines) {
          if (checkLayers && step.layer && dl.layer !== step.layer) continue
          const d = segmentDist(seg, dl)
          if (d < bestDist) {
            bestDist = d
            bestLine = dl
          }
        }
        if (bestDist <= tol && bestLine) {
          usedHandles.add(bestLine.handle)
          maxDelta = Math.max(maxDelta, bestDist)
        } else {
          stepMatched = false
          break
        }
      }
      if (stepMatched) {
        matches.push({
          stepIndex: step.index,
          kind: 'segment',
          status: 'matched',
          delta: maxDelta,
          detail: `step ${step.index} matched ${step.segments.length} segment(s) within ${Math.round(maxDelta)} units`
        })
      } else {
        matches.push({
          stepIndex: step.index,
          kind: 'segment',
          status: 'missing',
          detail: `step ${step.index} has segments not found in readback geometry`
        })
        discrepancies.push(
          `MISSING: step ${step.index} (${step.entityKind}) was planned but not found on drawing`
        )
      }
    } else if (step.kind === 'placement') {
      let bestDist = Infinity
      let bestPlacement: (typeof drawnPlacements)[0] | undefined
      for (const dp of drawnPlacements) {
        if (usedHandles.has(dp.handle)) continue
        if (checkLayers && step.layer && dp.layer !== step.layer) continue
        const d = ptDist(step.center, dp.center)
        if (d < bestDist) {
          bestDist = d
          bestPlacement = dp
        }
      }
      if (bestDist <= tol && bestPlacement) {
        usedHandles.add(bestPlacement.handle)
        matches.push({
          stepIndex: step.index,
          kind: 'placement',
          status: 'matched',
          delta: bestDist,
          actualHandle: bestPlacement.handle,
          detail: `step ${step.index} placement matched ${bestPlacement.handle} within ${Math.round(bestDist)} units`
        })
      } else if (bestDist < tol * 10 && bestPlacement) {
        matches.push({
          stepIndex: step.index,
          kind: 'placement',
          status: 'drifted',
          delta: bestDist,
          actualHandle: bestPlacement.handle,
          detail: `step ${step.index} drifted by ${Math.round(bestDist)} units (tolerance ${tol})`
        })
        discrepancies.push(
          `DRIFTED: step ${step.index} placed ${Math.round(bestDist)} units from planned location`
        )
      } else {
        matches.push({
          stepIndex: step.index,
          kind: 'placement',
          status: 'missing',
          detail: `step ${step.index} placement was not found on drawing`
        })
        discrepancies.push(
          `MISSING: step ${step.index} placement was planned but missing on drawing`
        )
      }
    } else if (step.kind === 'annotation') {
      matches.push({
        stepIndex: step.index,
        kind: 'annotation',
        status: 'matched',
        detail: `step ${step.index} annotation skipped in geometric readback`
      })
    } else if (step.kind === 'point') {
      let bestDist = Infinity
      for (const ent of entities) {
        const pt = ent.geometry?.position ?? ent.geometry?.center
        if (!pt) continue
        const d = ptDist(step.position, [pt.x, pt.y])
        if (d < bestDist) bestDist = d
      }
      if (bestDist <= tol) {
        matches.push({
          stepIndex: step.index,
          kind: 'point',
          status: 'matched',
          delta: bestDist,
          detail: `step ${step.index} point matched within ${Math.round(bestDist)} units`
        })
      } else {
        matches.push({
          stepIndex: step.index,
          kind: 'point',
          status: 'missing',
          detail: `step ${step.index} point missing`
        })
        discrepancies.push(`MISSING: step ${step.index} point missing`)
      }
    }
  }

  const matchedSteps = matches.filter((m) => m.status === 'matched').length
  const driftedSteps = matches.filter((m) => m.status === 'drifted').length
  const missingSteps = matches.filter((m) => m.status === 'missing').length
  const faithful = missingSteps === 0 && driftedSteps === 0
  const status = faithful ? 'PASS' : 'FAIL'

  return {
    status,
    faithful,
    matches,
    discrepancies,
    stats: {
      totalSteps: plan.steps.length,
      matchedSteps,
      driftedSteps,
      missingSteps
    }
  }
}
