import { z } from 'zod'

export const VerificationStatusSchema = z.enum([
  'PASS',
  'FAIL',
  'INSUFFICIENT_DATA',
  'NOT_APPLICABLE'
])
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>

export const VerificationFindingSchema = z.object({
  checkId: z.string(),
  name: z.string(),
  status: VerificationStatusSchema,
  standardRef: z.string().optional(),
  clauseRef: z.string().optional(),
  measuredValue: z.union([z.number(), z.string()]).optional(),
  thresholdValue: z.union([z.number(), z.string()]).optional(),
  unit: z.string().optional(),
  tolerance: z.number().optional(),
  evidence: z.string(),
  /** Which artifact the measurement came from, so a FAIL names the thing to fix rather than
   * inviting blind coordinate edits. `'router_geometry'` = judged on `pipeRoute.segments`. */
  source: z.string().optional(),
  affectedObjectIds: z.array(z.string()).default([])
})
export type VerificationFinding = z.infer<typeof VerificationFindingSchema>

export const VerificationReportSummarySchema = z.object({
  passCount: z.number().default(0),
  failCount: z.number().default(0),
  insufficientDataCount: z.number().default(0),
  notApplicableCount: z.number().default(0)
})
export type VerificationReportSummary = z.infer<typeof VerificationReportSummarySchema>

export const VerificationReportSchema = z.object({
  reportId: z.string(),
  targetDocument: z.string().optional(),
  overallStatus: z.enum(['PASS', 'FAIL', 'INSUFFICIENT_DATA']),
  findings: z.array(VerificationFindingSchema).default([]),
  summary: VerificationReportSummarySchema,
  generatedAt: z.number().default(() => Date.now())
})
export type VerificationReport = z.infer<typeof VerificationReportSchema>
