import {
  EngineeringPlanSchema,
  type EngineeringPlan,
  type EngineeringPlanStatus,
  type PlanValidation
} from '../schemas/engineering-plan'
import type { SpatialValidationRecord } from '../spatial/validation-record'

/**
 * Creates an engineering plan whose status is derived from a server-issued validation record.
 *
 * The old shape took a `validation: { status: 'PASS' }` object straight from the model's tool
 * arguments and handed back `ready_for_drafting`. That made the approval a formality: a model that
 * wanted to draw could simply assert it had validated. The field is gone. A plan now names a
 * `validationId`, and the status is whatever the server's own record for that id says — an id the
 * model cannot mint, because only the call that ran the constraint engine creates one.
 */
export interface PlanCreationInput {
  designBasisId: string
  title: string
  stages: Array<{
    stageNumber: number
    name: string
    description: string
    operations: string[]
    calculationRequired?: string
    stoppingCondition: string
  }>
  /**
   * The record issued by `spatial_validate_layout` for this layout. Omit it and the plan is a
   * proposal (`draft`) — never an authorization to draw.
   */
  validationId?: string
}

export interface PlanCreationDeps {
  /**
   * Resolves a record id to the record the server actually issued. Injected by the composition root
   * (the capabilities package owns the ledger), so this module stays free of any storage or routing
   * concern. An unknown id resolves to `undefined`, which yields `draft`, not a guess.
   */
  resolveValidation?: (validationId: string) => SpatialValidationRecord | undefined
}

export interface PlanCreationResult {
  success: boolean
  plan?: EngineeringPlan
  error?: string
  /** Why the plan is not `ready_for_drafting`, in the caller's terms rather than a code. */
  validationNote?: string
}

/**
 * Status semantics, all of them derived from the record rather than asserted:
 *
 * - record PASS → `ready_for_drafting`
 * - record FAIL → `validation_failed` (blocked, with the recorded findings)
 * - record INSUFFICIENT_DATA → `awaiting_analysis` (blocked: nothing was proven either way)
 * - record expired or already spent → `awaiting_analysis` (the verdict no longer describes the
 *   drawing; re-validate)
 * - no `validationId`, or an id the server never issued → `draft` (a proposal, not an authorization)
 */
export function createEngineeringPlan(
  input: PlanCreationInput,
  deps: PlanCreationDeps = {}
): PlanCreationResult {
  const record = input.validationId ? deps.resolveValidation?.(input.validationId) : undefined

  let status: EngineeringPlanStatus = 'draft'
  let validation: PlanValidation | undefined
  let blockedReason: string | undefined
  let validationNote: string | undefined

  if (!input.validationId) {
    validationNote =
      'no validationId supplied — the plan is a proposal (draft). Validate the layout with ' +
      'spatial_validate_layout and pass its validationId to authorize drafting.'
  } else if (!record) {
    status = 'draft'
    validationNote =
      `validationId '${input.validationId}' is not a record this server issued — the plan stays a ` +
      'proposal (draft). A validation id comes only from spatial_validate_layout.'
  } else {
    validation = {
      status: record.result,
      findings: record.blockingCodes,
      validatedAgainst: record.layoutFingerprint,
      validatedAt: record.createdAt
    }
    // Any state other than `issued` means the authorization has been consumed by a dispatch:
    // a plan is a proposal to draw, not a licence to draw twice.
    const spent = record.state !== 'issued'
    const expired = record.expiresAt !== null && Date.now() > record.expiresAt
    if (record.result === 'PASS' && !spent && !expired) {
      status = 'ready_for_drafting'
    } else if (record.result === 'FAIL') {
      status = 'validation_failed'
      blockedReason = `layout validation failed: ${record.blockingCodes.join('; ') || 'see findings'}`
      validationNote = 'the server recorded a FAIL verdict for this layout.'
    } else {
      status = 'awaiting_analysis'
      blockedReason =
        record.result !== 'PASS'
          ? 'layout validation returned INSUFFICIENT_DATA — geometry must be read before drafting'
          : expired
            ? 'the validation record expired — re-validate against the current drawing'
            : 'the validation record was already spent on a committed batch — re-validate for the next'
      validationNote = blockedReason
    }
  }

  const parseResult = EngineeringPlanSchema.safeParse({
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    designBasisId: input.designBasisId,
    title: input.title,
    status,
    blockedReason,
    validation,
    stages: input.stages.map((s) => ({ ...s, status: 'pending' }))
  })

  if (!parseResult.success) {
    return { success: false, error: parseResult.error.message }
  }

  return { success: true, plan: parseResult.data, validationNote }
}

/**
 * The post-drafting completion gate. A plan reaches `reviewed` only when a read-back verification of
 * the DRAWING (not the plan) came back faithful: every planned item actually landed where it was
 * planned, and re-validating the drawn geometry still passes. This mirrors `ready_for_drafting` —
 * the status is granted by the server from a computed verdict, never from a field the model typed.
 *
 * `drafting` → `verification_required` is the honest state after a CAD batch commits: the work is
 * done but unproven. Only a faithful read-back moves it to `reviewed`; a read-back that finds drift,
 * a missing item, or a re-validation FAIL leaves it at `verification_required` with the reason, so a
 * run cannot declare itself finished on the strength of the pre-draw PASS alone.
 */
export function reviewEngineeringPlan(
  plan: EngineeringPlan,
  readback: {
    faithful: boolean
    status: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
    discrepancies: string[]
  }
): { success: boolean; plan?: EngineeringPlan; error?: string } {
  if (plan.status !== 'drafting' && plan.status !== 'verification_required') {
    return {
      success: false,
      error: `a plan can only be reviewed after drafting; it is currently "${plan.status}"`
    }
  }
  const status: EngineeringPlanStatus = readback.faithful ? 'reviewed' : 'verification_required'
  const parseResult = EngineeringPlanSchema.safeParse({
    ...plan,
    status,
    blockedReason: readback.faithful
      ? undefined
      : `read-back verification did not confirm the drawing: ${readback.discrepancies.join('; ') || readback.status}`,
    updatedAt: Date.now()
  })
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.message }
  }
  return { success: true, plan: parseResult.data }
}
