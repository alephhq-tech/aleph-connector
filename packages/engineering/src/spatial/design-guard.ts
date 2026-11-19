import { operationFingerprint } from './fingerprint'
import { compileCadPayload, planHashOf, type CompiledStep } from './operations-compile'
import type { RecordBindingCheck, RecordRejection } from './validation-record'

/**
 * The single enforcement point for architectural CAD mutations.
 *
 * Two rules shape this file.
 *
 * 1. **Classification is payload-based, never name-based.** Routing to a provider is already
 *    provider-declared (`CapabilityRegistry.findProvider`), and this repo forbids
 *    `capability.startsWith("autocad.")` branching. So the guard asks the question a provider
 *    would: is this a write/destructive capability whose *arguments change drawing geometry* —
 *    placing it (coordinates) or removing it (handles)? That covers the MCP
 *    `entity`/`operations`/`construct` tools, a node-hosted CAD tool, and any future CAD surface
 *    without a name table to keep in sync.
 *
 * 2. **Arming is cumulative per run, not per call.** A run becomes a protected architectural
 *    session once it has placed enough real geometry to be drawing a layout rather than issuing
 *    one-off commands. Counting per call would leave the obvious bypass open — split a plan into 40
 *    single-entity `entity.create` calls and no individual call looks like a layout. Counting per
 *    run closes it, while a human asking for one line or one circle is untouched.
 *
 * Drawing staleness rests on three independent mechanisms: the `documentRevision` binding when a
 * probe is wired, the short TTL, and single-use plus `invalidateRun` — every committed CAD mutation
 * drops every other record in the run, so one PASS can never cover a second batch.
 */

/** Entity placements that trigger protection. One or two is a command; this many is a layout. */
export const ARCHITECTURAL_ARM_THRESHOLD = 3

/**
 * Operation names that read rather than draw. The CAD tools declare risk per *tool*, not per
 * operation — `entity` is `destructiveHint: true` because it can erase, but `operation:"list"`
 * changes nothing. Without this, the large-drawing workflow the drafting guide prescribes (three
 * `entity.list` calls with a `window` region each) would count as three placements and arm the run
 * as a design session on pure reads.
 */
const READ_OPERATIONS = new Set([
  'list',
  'get',
  'info',
  'summary',
  'check',
  'status',
  'history',
  'capture',
  'read',
  'preview',
  'inspect',
  'scan',
  'changes',
  'zoom',
  'zoom_extents',
  'get_live',
  'area_measure'
])

const DESTRUCTIVE_OPERATIONS = new Set([
  'erase',
  'delete',
  'remove',
  'explode',
  'cleanup',
  'update',
  'transform'
])

function isDestructiveShaped(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  for (const key of ['operations', 'steps', 'entities', 'items']) {
    const list = rec[key]
    if (Array.isArray(list) && list.some(isDestructiveShaped)) return true
  }
  const op = [rec.op, rec.operation].find((v) => typeof v === 'string')
  if (typeof op !== 'string' || !DESTRUCTIVE_OPERATIONS.has(op.toLowerCase())) return false
  const namedTargets = [rec.handles, rec.entities, rec.items].some(
    (v) => Array.isArray(v) && v.length > 0
  )
  const sweepTargets = [rec.fixes, rec.layers].some((v) => Array.isArray(v) && v.length > 0)
  const nestedTransform = rec.transform
  const transformHandles =
    nestedTransform && typeof nestedTransform === 'object' && !Array.isArray(nestedTransform)
      ? (nestedTransform as Record<string, unknown>).handles
      : undefined
  const nestedUpdate = rec.update
  const updateHandle =
    nestedUpdate && typeof nestedUpdate === 'object' && !Array.isArray(nestedUpdate)
      ? (nestedUpdate as Record<string, unknown>).handle
      : undefined
  return (
    namedTargets ||
    sweepTargets ||
    typeof rec.handle === 'string' ||
    typeof updateHandle === 'string' ||
    (Array.isArray(transformHandles) && transformHandles.length > 0)
  )
}

/**
 * Detects whether a compiled step is an annotation, note, label or device symbol rather than an
 * architectural or structural element (wall, door, partition, pipe, or door-blocking furniture).
 */
export function isAnnotationOrSymbolStep(step: CompiledStep): boolean {
  if (step.kind === 'annotation' || step.kind === 'point') return true

  // Device block inserts (e.g. detectors, bells, valves) that don't declare furniture footprints
  if (step.kind === 'placement') {
    const type = (step.deviceType ?? '').toUpperCase()
    const isFurniture = ['SOFA', 'BED', 'DESK', 'TABLE', 'DOOR', 'WALL', 'CABINET', 'CHAIR'].some(
      (f) => type.includes(f)
    )
    if (isFurniture) return false
    return step.footprint === undefined
  }

  // Explicit annotation, note, legend, or device layer
  const layer = (step as { layer?: string }).layer?.toLowerCase() ?? ''
  if (
    layer.includes('text') ||
    layer.includes('anno') ||
    layer.includes('note') ||
    layer.includes('legend') ||
    layer.includes('symbol') ||
    layer.includes('device') ||
    layer.includes('equipment') ||
    layer.includes('thietbi') ||
    layer.includes('thiet_bi') ||
    layer.includes('ky_hieu') ||
    layer.includes('ghi_chu')
  ) {
    return true
  }

  // Small detector/marker circles (radius <= 600mm)
  if (step.kind === 'segment' && (step.entityKind === 'circle' || step.entityKind === 'arc')) {
    const xs = step.segments.flatMap((s) => [s.start[0], s.end[0]])
    const ys = step.segments.flatMap((s) => [s.start[1], s.end[1]])
    if (xs.length > 0) {
      const spanX = Math.max(...xs) - Math.min(...xs)
      const spanY = Math.max(...ys) - Math.min(...ys)
      if (spanX <= 1200 && spanY <= 1200) return true
    }
  }

  return false
}

/**
 * Counts the geometry-changing steps one payload carries. `operations.apply` nests them under
 * `operations`; `entity.create` carries one at the top level; `construct` describes a whole run of
 * geometry in a single generator payload. Erase/delete steps count too: a batch that only removes
 * geometry is the most destructive shape there is, and reading it as "nothing changes here" is how
 * an unvalidated erase reached the drawing.
 *
 * `dryRun: true` counts as nothing: the tool returns the steps it *would* draw and touches no
 * drawing, so previewing a layout must not arm a run.
 */
export function countPlacements(input: Record<string, unknown>): number {
  if (input.dryRun === true) return 0
  const op = [input.op, input.operation, input.action].find((v) => typeof v === 'string')
  if (typeof op === 'string' && READ_OPERATIONS.has(op.toLowerCase())) return 0
  const plan = compileCadPayload(input)
  if (plan.steps.length > 0) return plan.steps.length
  return isDestructiveShaped(input) ? 1 : 0
}

/** The document a payload targets, when it names one. Empty string = the active tab. */
export function targetDocumentOf(input: Record<string, unknown>): string {
  for (const key of ['documentName', 'documentId', 'targetDocumentName']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

export interface GuardContext {
  risk: 'read' | 'write' | 'sensitive' | 'destructive'
  input: Record<string, unknown>
  runId: string
  workspaceId: string
  deviceId?: string | null
  /**
   * True only for a capability Cloud itself declared a self-preflighting task-level executor (its
   * implementation refuses to draw a blocked plan). Threaded from the registry's provider-declared
   * tier, never inferred from the payload — the guard stays name-blind and keeps gating every other
   * geometry write, including one on the same run or the same connection.
   */
  selfPreflightingExecutor?: boolean
}

export interface GuardDecision {
  blocked: boolean
  /** True when this dispatch is what turned the run into a protected session. */
  armed: boolean
  placements: number
  code?: string
  reason?: string
  claimedRecordId?: string
  planHash?: string
}

/**
 * Reads the live drawing revision for a document. Wired by the composition root when it can reach a
 * CAD read path for the run's workspace/node; absent means the revision binding is skipped and
 * staleness rests on TTL + single-use + run invalidation.
 */
export type DocumentRevisionProbe = (context: {
  workspaceId: string
  nodeId?: string | null
  documentName: string
}) => Promise<string | null>

export type DesignPolicyProbe = (context: {
  workspaceId: string
}) => Promise<readonly unknown[]> | readonly unknown[]

export interface DesignGuardStore {
  isProtected(runId: string): boolean
  arm(runId: string): void
  addPlacements(runId: string, count: number): number
  check(binding: RecordBindingCheck): RecordRejection
  claim(binding: RecordBindingCheck): RecordRejection
  markCommitted(recordId: string, receipt?: string): void
  markFailed(recordId: string): void
  markOutcomeUnknown(recordId: string): void
  invalidateRun(runId: string, keepId?: string): void
}

export interface DesignGuardDeps {
  store: DesignGuardStore
  revisionProbe?: DocumentRevisionProbe
  designPolicies?: DesignPolicyProbe
}

/**
 * Decide one CAD mutation dispatch. `blocked: true` means the registry must refuse the call and
 * return `reason` to the model — the reason is written to be actionable, because the point is that
 * the agent learns the validated path, not just that it hit a wall.
 */
export async function guardCadMutation(
  context: GuardContext,
  deps: DesignGuardDeps
): Promise<GuardDecision> {
  // Allow disabling Design Guard via environment variable (e.g. for unrestricted CAD drawing)
  if (process.env.DISABLE_DESIGN_GUARD === 'true') {
    return { blocked: false, armed: false, placements: 0 }
  }
  const isCadWrite = context.risk === 'write' || context.risk === 'destructive'
  const placements = countPlacements(context.input)
  if (!isCadWrite || placements === 0) return { blocked: false, armed: false, placements }

  const plan = compileCadPayload(context.input)
  const isPureAnnotationOrSymbol =
    !isDestructiveShaped(context.input) &&
    !plan.opaque &&
    plan.steps.length > 0 &&
    plan.steps.every(isAnnotationOrSymbolStep)

  // Pure annotation and device symbol edits (text, labels, notes, small equipment markers)
  // do not alter architectural room enclosures, partitions, or egress clearance:
  // allow them through without blocking on architectural layout validation.
  if (isPureAnnotationOrSymbol) {
    return { blocked: false, armed: false, placements }
  }

  const protectedRun = deps.store.isProtected(context.runId)

  // Arming is cumulative across the run: what matters is how much geometry the run has placed in
  // total, not what fit in one call.
  const totalPlacements = deps.store.addPlacements(context.runId, placements)

  const policies = deps.designPolicies
    ? await deps.designPolicies({ workspaceId: context.workspaceId })
    : []
  const hasDesignPolicies = (policies ?? []).length > 0
  const shouldArm =
    !protectedRun && (hasDesignPolicies || totalPlacements >= ARCHITECTURAL_ARM_THRESHOLD)

  // A Cloud-declared, owner-gated self-preflighting executor (see mcp-provider.ts) already refuses to
  // draw a plan it marked blocked, and its real writes sit behind a planId the registry never sees —
  // so a `validationId` could never be satisfied for it, which is what trapped the Slice 05 agent in
  // a re-scan loop. Let exactly this call through, but still arm the run first: the exemption is
  // per-call, so a later raw entity.create/operations.apply in the same run still hits the gate.
  if (context.selfPreflightingExecutor === true) {
    if (shouldArm) deps.store.arm(context.runId)
    return { blocked: false, armed: shouldArm, placements }
  }

  if (shouldArm) {
    deps.store.arm(context.runId)
    return {
      blocked: true,
      armed: true,
      placements,
      code: 'ARCHITECTURAL_SESSION_ARMED',
      reason: hasDesignPolicies
        ? 'this workspace has engineering design policies configured, so every CAD write that changes geometry must be preflighted first: read the affected region (entity.list detail:"full" with a window filter), preflight the EXACT operations you intend to send, then re-send this call with the returned `validationId`. Operations compiled behind a planId or a generator spec cannot be preflighted from the payload, so preflight the compiled operations themselves.'
        : `this run is now an architectural design session (${totalPlacements} entity placements so far), so its CAD mutations must be validated first: read the drawing (entity.list detail:"full" or drawing.summary), call spatial_validate_layout on the exact layout, then re-send this call with the returned \`validationId\`. Drawing without validation is what produces rooms that cannot be reached and furniture that blocks doors.`
    }
  }

  if (!protectedRun) return { blocked: false, armed: false, placements }

  const recordId = context.input.validationId
  if (typeof recordId !== 'string' || recordId.trim() === '') {
    return {
      blocked: true,
      armed: false,
      placements,
      code: 'VALIDATION_REQUIRED',
      reason:
        'this run is an architectural design session, so every CAD mutation must carry `validationId` ' +
        'from spatial_validate_layout. No validation record, no drawing.'
    }
  }

  const documentName = targetDocumentOf(context.input)
  const documentRevision =
    (await deps.revisionProbe?.({
      workspaceId: context.workspaceId,
      nodeId: context.deviceId,
      documentName
    })) ?? ''

  const payload = withoutValidationId(context.input)
  const binding: RecordBindingCheck = {
    recordId,
    runId: context.runId,
    workspaceId: context.workspaceId,
    deviceId: context.deviceId ?? null,
    documentName,
    documentRevision,
    drawingFingerprint: '',
    operationFingerprint: operationFingerprint(payload),
    planHash: planHashOf(plan)
  }

  const claimResult = deps.store.claim(binding)
  if (!claimResult.ok) {
    return {
      blocked: true,
      armed: false,
      placements,
      code: claimResult.code,
      reason: claimResult.message
    }
  }

  deps.store.invalidateRun(context.runId, recordId)
  return {
    blocked: false,
    armed: false,
    placements,
    claimedRecordId: recordId,
    planHash: binding.planHash
  }
}

function withoutValidationId(input: Record<string, unknown>): Record<string, unknown> {
  const { validationId: _omit, ...rest } = input
  return rest
}
