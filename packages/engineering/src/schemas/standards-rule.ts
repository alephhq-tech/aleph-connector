import { z } from 'zod'

export const RuleOperatorSchema = z.enum(['<=', '>=', '==', '<', '>', 'between'])
export type RuleOperator = z.infer<typeof RuleOperatorSchema>

export const RuleRequirementSchema = z.object({
  parameter: z.string(),
  operator: RuleOperatorSchema,
  value: z.union([z.number(), z.string(), z.array(z.number())]),
  unit: z.string()
})
export type RuleRequirement = z.infer<typeof RuleRequirementSchema>

export const RuleProvenanceSchema = z.enum([
  'knowledge_base',
  'official_gazette',
  'contract',
  'user_input'
])
export type RuleProvenance = z.infer<typeof RuleProvenanceSchema>

export const VerificationMethodSchema = z.enum([
  'geometric_measurement',
  'hydraulic_calculation',
  'topology_check',
  'document_review'
])
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>

export const StandardsRuleSchema = z.object({
  id: z.string(),
  standardId: z.string(), // e.g. "TCVN 7336", "QCVN 06:2022/BXD"
  edition: z.string(),    // e.g. "2021", "2022"
  sourceDoc: z.string(),
  clauseRef: z.string(),  // e.g. "Điều 5.2.1", "Bảng 1"
  jurisdiction: z.string().default('VN'),
  isMandatory: z.boolean().default(false), // QCVN = true, TCVN = false unless invoked
  conditions: z.record(z.string(), z.unknown()).default({}), // e.g. { hazardGroup: 'Group 1', ceilingHeightMaxM: 9 }
  requirement: RuleRequirementSchema,
  provenance: RuleProvenanceSchema,
  verificationMethod: VerificationMethodSchema,
  evidenceStatus: z.enum(['verified', 'unverified', 'superseded']).default('verified')
})
export type StandardsRule = z.infer<typeof StandardsRuleSchema>
