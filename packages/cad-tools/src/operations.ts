import * as z from 'zod/v4'
import {
  createEntityParams,
  entityEraseParams,
  entityTransformParams,
  entityUpdateParams
} from './entity.js'
import { batchStepId, entityHandle, layerName, point3d } from './geometry.js'
import { viewOverride } from './view.js'

/** A batch-local step label, referenced by later steps as `"@id"` (#19). */
const stepId = batchStepId
  .optional()
  .describe(
    "Batch-local label for this step's resulting entity/entities. Later steps reference it as " +
      '"@id" anywhere a handle is accepted (erase.handles, transform handles/path, hatch ' +
      'boundaryHandles/loops) — resolved against the handles AutoCAD actually assigns, in order, ' +
      'before each is sent. The update op accepts only one handle and retains it. Must be unique in the batch; forward/unknown refs are rejected before ' +
      'anything is sent to AutoCAD.'
  )

const curveOffsetParams = z.object({
  handle: entityHandle,
  distance: z.number().refine((v) => v !== 0, 'offset.distance must not be 0'),
  replace: z
    .boolean()
    .optional()
    .describe('Erase the source after creating offsets (CadAI-owned sources only).'),
  layer: layerName.optional()
})

const curveBreakParams = z.object({
  handle: entityHandle,
  points: z.array(point3d).min(1).max(2),
  replace: z.boolean().optional().default(true)
})

const curveTrimParams = z.object({
  handle: entityHandle,
  cutPoint: point3d,
  keepPoint: point3d
})

const curveExtendParams = z.object({
  handle: entityHandle,
  boundaryHandle: entityHandle,
  end: z.enum(['start', 'end', 'both']).optional().default('end')
})

const curveFilletParams = z
  .object({
    radius: z.number().positive(),
    handles: z.array(entityHandle).length(2).optional(),
    polylineHandle: entityHandle.optional(),
    vertexIndex: z.number().int().min(0).optional()
  })
  .refine(
    (v) =>
      (v.handles != null && v.polylineHandle == null) ||
      (v.polylineHandle != null && v.vertexIndex != null && v.handles == null),
    { message: 'fillet requires handles:[a,b] XOR polylineHandle+vertexIndex' }
  )

/** One step of an operations.apply batch — reuses the same per-kind shapes entity.* uses. */
export const entityOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), entity: createEntityParams, id: stepId }),
  z.object({ op: z.literal('erase'), ...entityEraseParams.shape, id: stepId }),
  z.object({ op: z.literal('transform'), transform: entityTransformParams, id: stepId }),
  z.object({ op: z.literal('update'), update: entityUpdateParams, id: stepId }),
  z.object({ op: z.literal('offset'), offset: curveOffsetParams, id: stepId }),
  z.object({ op: z.literal('break'), break: curveBreakParams, id: stepId }),
  z.object({ op: z.literal('trim'), trim: curveTrimParams, id: stepId }),
  z.object({ op: z.literal('extend'), extend: curveExtendParams, id: stepId }),
  z.object({ op: z.literal('fillet'), fillet: curveFilletParams, id: stepId })
])

export const operationsApplyParams = z.object({
  operations: z.array(entityOperation).min(1),
  taskId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Logical task identifier (e.g. "task_fire_protection_123") linking multiple related batches.'
    ),
  /**
   * Merged under (not overriding) each `create` step's own fields — at minimum `layer`, the most
   * repeated field across a batch (#19). A step's own explicit value always wins.
   */
  defaults: z
    .object({ layer: layerName.optional() })
    .optional()
    .describe(
      'Fallback fields merged into every create step that omits them. layer: default layer.'
    ),
  view: viewOverride,
  progressive: z
    .boolean()
    .optional()
    .describe(
      'Repaint partway through this batch instead of only at the end (still one transaction + ' +
        'one native undo group). Default false.'
    ),
  paceMs: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Extra delay (ms) between progressive repaints; hard-capped so the batch never adds more ' +
        'than 3s total.'
    ),
  expectedRevision: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional: a revision from a prior drawing.info/entity.get read on this document. Checked ' +
        'before this batch starts; if the drawing changed since then, the call fails closed with ' +
        '0 entities changed instead of writing over a concurrent edit. Omit to skip the check.'
    ),
  expectedState: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Optional per-entity guard (#413 phase B): handle -> that entity's stateDigest from a prior " +
        'entity.get with detail:"full". Each mapped handle is re-checked inside the batch: if its ' +
        'state changed since the read, ONLY that handle is skipped (never mutated) and listed in ' +
        'result.conflicts; every other write in the batch proceeds normally. Handles without an ' +
        'entry are unchecked. Use instead of expectedRevision when unrelated concurrent edits ' +
        'elsewhere in the drawing must not veto this batch.'
    )
})
export const operationsPreviewParams = z.object({
  operations: z.array(entityOperation).min(1),
  taskId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Logical task identifier (e.g. "task_fire_protection_123") linking multiple related batches.'
    ),
  defaults: z
    .object({ layer: layerName.optional() })
    .optional()
    .describe(
      'Fallback fields merged into every create step that omits them. layer: default layer.'
    )
})
export const operationsRevertParams = z
  .object({
    batchId: z
      .string()
      .min(1)
      .optional()
      .describe('Batch identifier to revert (e.g. "batch_4a1b2c3d").'),
    taskId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Logical task identifier (e.g. "task_fire_protection_123") to revert all change sets for.'
      )
  })
  .refine((data) => Boolean(data.batchId || data.taskId), {
    message: 'Either batchId or taskId must be provided.'
  })

export const operationsUndoParams = z.object({
  batchId: z.string().min(1)
})

export const operationsRedoParams = z.object({
  batchId: z.string().min(1)
})

export const operationsHistoryParams = z.object({
  limit: z.number().int().positive().max(100).default(20),
  taskId: z
    .string()
    .min(1)
    .optional()
    .describe('Filter history to change sets belonging to this specific task.')
})
