import { z } from 'zod'

export const EngineeringDisciplineSchema = z.enum([
  'pccc',
  'architecture',
  'structural',
  'mep',
  'civil',
  'general'
])
export type EngineeringDiscipline = z.infer<typeof EngineeringDisciplineSchema>

export const DesignScopeSchema = z.enum([
  'new_design',
  'modification',
  'inspection',
  'verification'
])
export type DesignScope = z.infer<typeof DesignScopeSchema>

export const MissingInputSchema = z.object({
  field: z.string(),
  description: z.string(),
  safetyCritical: z.boolean().default(true)
})
export type MissingInput = z.infer<typeof MissingInputSchema>

export const ApplicableStandardSchema = z.object({
  standardId: z.string(),
  edition: z.string(),
  clause: z.string().optional(),
  mandatory: z.boolean().default(false),
  source: z.string().optional()
})
export type ApplicableStandard = z.infer<typeof ApplicableStandardSchema>

export const DesignConstraintSchema = z.object({
  description: z.string(),
  type: z.enum(['spatial', 'regulatory', 'hydraulic', 'equipment'])
})
export type DesignConstraint = z.infer<typeof DesignConstraintSchema>

export const EngineeringUnitsSchema = z.object({
  length: z.enum(['mm', 'm']).default('mm'),
  area: z.enum(['m2']).default('m2'),
  flow: z.enum(['L/s', 'L/min']).default('L/s'),
  pressure: z.enum(['bar', 'MPa', 'kPa']).default('bar')
})
export type EngineeringUnits = z.infer<typeof EngineeringUnitsSchema>

export const DesignBasisSchema = z.object({
  id: z.string(),
  discipline: EngineeringDisciplineSchema,
  projectRef: z.string(),
  drawingRef: z.string().optional(),
  designScope: DesignScopeSchema,
  buildingUsage: z.string().optional(),
  hazardClassification: z.string().optional(),
  knownInputs: z.record(z.string(), z.unknown()).default({}),
  missingInputs: z.array(MissingInputSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  applicableStandards: z.array(ApplicableStandardSchema).default([]),
  constraints: z.array(DesignConstraintSchema).default([]),
  units: EngineeringUnitsSchema.default({
    length: 'mm',
    area: 'm2',
    flow: 'L/s',
    pressure: 'bar'
  }),
  verificationRequirements: z.array(z.string()).default([]),
  approvalStatus: z.enum(['draft', 'needs_input', 'ready_for_planning', 'approved']).default('draft'),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
})
export type DesignBasis = z.infer<typeof DesignBasisSchema>
