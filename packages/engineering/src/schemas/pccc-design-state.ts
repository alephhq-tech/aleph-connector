import { z } from 'zod'
import { Point2DSchema } from './semantic-model'
import { HydraulicResultSchema } from './hydraulic-system'
import { VerificationReportSchema } from './verification-result'

export const PcccSprinklerHeadItemSchema = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  row: z.number(),
  col: z.number(),
  handle: z.string().optional(),
  status: z.enum(['planned', 'drawn', 'verified', 'modified', 'erased']).default('planned')
})
export type PcccSprinklerHeadItem = z.infer<typeof PcccSprinklerHeadItemSchema>

export const PcccPipeSegmentRouteItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['main', 'branch']),
  start: Point2DSchema,
  end: Point2DSchema,
  nominalDiameterMm: z.number().positive(),
  connectedHeadIds: z.array(z.string()).default([]),
  lengthM: z.number().nonnegative(),
  handles: z.array(z.string()).optional()
})
export type PcccPipeSegmentRouteItem = z.infer<typeof PcccPipeSegmentRouteItemSchema>

export const PcccDesignStateDataSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  drawingId: z.string(),
  conversationId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  revision: z.string(),
  status: z.enum(['draft', 'validated', 'committed', 'verified', 'stale']).default('draft'),
  // No default: an unconfirmed design basis must stay absent, not silently become Group 1.
  hazardGroup: z.enum(['Group 1', 'Group 2', 'Group 3']).nullable().optional(),
  standard: z.string().nullable().optional(),
  roomName: z.string().nullable().optional(),
  roomBoundary: z.array(Point2DSchema).nullable().optional(),
  sprinklers: z.array(PcccSprinklerHeadItemSchema).default([]),
  pipeRoutes: z.array(PcccPipeSegmentRouteItemSchema).default([]),
  hydraulic: HydraulicResultSchema.nullable().optional(),
  verification: VerificationReportSchema.nullable().optional(),
  lastAction: z.string().default('created'),
  nextStep: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
})
export type PcccDesignStateData = z.infer<typeof PcccDesignStateDataSchema>

export const PcccTaskJournalDataSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  drawingId: z.string(),
  conversationId: z.string().nullable().optional(),
  taskId: z.string(),
  designStateId: z.string().nullable().optional(),
  baseRevision: z.string(),
  targetRevision: z.string().nullable().optional(),
  phase: z.enum([
    'intake',
    'spatial_analysis',
    'sprinkler_layout',
    'pipe_routing',
    'hydraulic_calc',
    'standards_verification',
    'micro_batch_drafting',
    'readback_verified',
    'modified'
  ]),
  affectedHandles: z.array(z.string()).default([]),
  plannedOperations: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  completedOperations: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  validationStatus: z
    .enum(['pending', 'PASS', 'FAIL', 'INSUFFICIENT_DATA', 'bypassed'])
    .default('pending'),
  validationId: z.string().nullable().optional(),
  lastKnownResult: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
})
export type PcccTaskJournalData = z.infer<typeof PcccTaskJournalDataSchema>
