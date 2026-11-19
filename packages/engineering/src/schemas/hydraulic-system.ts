import { z } from 'zod'

export const PipeSegmentSchema = z.object({
  id: z.string(),
  fromNode: stringSchema(),
  toNode: stringSchema(),
  lengthM: z.number().positive(),
  nominalDiameterMm: z.number().positive(),
  internalDiameterMm: z.number().positive(),
  roughnessC: z.number().positive().default(120), // Hazen-Williams C (default 120 for steel sprinkler pipe)
  fittingsEquivalentLengthM: z.number().nonnegative().default(0),
  elevationChangeM: z.number().default(0) // positive = upward, negative = downward
})
export type PipeSegment = z.infer<typeof PipeSegmentSchema>

export const DemandNodeSchema = z.object({
  id: z.string(),
  requiredFlowLpm: z.number().nonnegative(), // Liters per minute
  minPressureBar: z.number().nonnegative().default(0.5), // Min pressure at remote head
  kFactor: z.number().positive().optional() // Standard sprinkler K-factor (metric)
})
export type DemandNode = z.infer<typeof DemandNodeSchema>

export const HydraulicSystemSchema = z.object({
  systemId: z.string(),
  sourceNodeId: z.string(),
  availableSourcePressureBar: z.number().positive().optional(),
  segments: z.array(PipeSegmentSchema).min(1),
  demandNodes: z.array(DemandNodeSchema).min(1),
  fluidDensityKgM3: z.number().positive().optional() // Water at 20C
})
export type HydraulicSystem = z.infer<typeof HydraulicSystemSchema>

export const HydraulicResultSchema = z.object({
  totalDemandFlowLpm: z.number(),
  requiredSourcePressureBar: z.number(),
  availableSourcePressureBar: z.number().optional(),
  isPressureAdequate: z.boolean(),
  nodePressuresBar: z.record(z.string(), z.number()),
  segmentFlowsLpm: z.record(z.string(), z.number()),
  segmentHeadLossesBar: z.record(z.string(), z.number()),
  mostRemoteNodeId: z.string(),
  calculationMethod: z.literal('Hazen-Williams'),
  calculatedAt: z.number().default(() => Date.now())
})
export type HydraulicResult = z.infer<typeof HydraulicResultSchema>

function stringSchema() {
  return z.string().min(1)
}
