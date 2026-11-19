import { z } from 'zod'

export const PlanStageStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'blocked'
])
export type PlanStageStatus = z.infer<typeof PlanStageStatusSchema>

export const PlanStageSchema = z.object({
  stageNumber: z.number(),
  name: z.string(),
  description: z.string(),
  operations: z.array(z.string()),
  calculationRequired: z.string().optional(),
  stoppingCondition: z.string(),
  status: PlanStageStatusSchema.default('pending')
})
export type PlanStage = z.infer<typeof PlanStageSchema>

export const EngineeringPlanStatusSchema = z.enum([
  'draft',
  'awaiting_analysis',
  'blocked',
  'validation_failed',
  'validated',
  'ready_for_drafting',
  'drafting',
  'verification_required',
  'reviewed',
])
export type EngineeringPlanStatus = z.infer<typeof EngineeringPlanStatusSchema>

/**
 * The layout-validation verdict a plan was approved on. `ready_for_drafting` is only ever honest
 * when this records a PASS: schema validity says the plan is well-formed, not that its geometry
 * works.
 */
export const PlanValidationSchema = z.object({
  status: z.enum(['PASS', 'FAIL', 'INSUFFICIENT_DATA']),
  findings: z.array(z.string()).optional(),
  validatedAgainst: z.string().optional(),
  validatedAt: z.number().optional(),
})
export type PlanValidation = z.infer<typeof PlanValidationSchema>

export const EngineeringPlanSchema = z.object({
  id: z.string(),
  designBasisId: z.string(),
  title: z.string(),
  status: EngineeringPlanStatusSchema.default('draft'),
  stages: z.array(PlanStageSchema).default([]),
  blockedReason: z.string().optional(),
  validation: PlanValidationSchema.optional(),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
})
export type EngineeringPlan = z.infer<typeof EngineeringPlanSchema>
