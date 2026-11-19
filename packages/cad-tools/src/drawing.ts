import * as z from 'zod/v4'
import { entityHandle, layerName, point3d } from './geometry.js'

export const drawingInfoParams = z.object({})

export const drawingListOpenParams = z.object({})

export const drawingSaveParams = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Absolute .dwg path inside this drawing\'s own folder — no other directory, UNC path, or device path (aleph-platform#5). Omit to save the current file in place.'
    ),
  /** Required to replace an existing file other than this document's own current one — see
   * `PluginExceptions.FileExists` (plugin/PluginErrors.cs). */
  overwrite: z.boolean().optional().describe('Required to overwrite an existing file at `path`.')
})
export const drawingOpenParams = z.object({
  path: z.string().min(1).describe('Absolute file path to the DWG or DXF drawing file to open.'),
  readOnly: z.boolean().optional().describe('Open the drawing in read-only mode (default false).')
})

export const drawingNewParams = z.object({
  template: z
    .string()
    .min(1)
    .optional()
    .describe('Path or name of the template (.dwt) to create the new drawing from (default uses standard template).')
})

export const drawingCloseParams = z.object({
  save: z
    .boolean()
    .optional()
    .describe('Save changes before closing (default false: discard unsaved changes).')
})

export const drawingActivateParams = z.object({})

export const drawingSetupParams = z.object({
  insUnits: z.enum(['unitless', 'mm', 'cm', 'm', 'in', 'ft']).optional(),
  linearUnits: z.enum(['decimal', 'architectural', 'engineering']).optional(),
  linearPrecision: z.number().int().min(0).max(8).optional(),
  angularUnits: z.enum(['decimalDegrees', 'radians']).optional(),
  ltScale: z.number().positive().optional(),
  celtScale: z.number().positive().optional(),
  dimScale: z.number().positive().optional(),
  lwDisplay: z.boolean().optional(),
  scale: z
    .number()
    .positive()
    .optional()
    .describe(
      'Convenience: also sets ltScale to scale * 0.5 (ISO linetype-scale convention) and ' +
        'dimScale to scale, unless those are given explicitly (explicit values win).'
    ),
  annotationScale: z
    .string()
    .regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/, 'annotationScale must be "paper:drawing", e.g. "1:100"')
    .refine(
      (s) => {
        const [paper, drawing] = s.split(':').map(Number)
        return (paper ?? 0) > 0 && (drawing ?? 0) > 0
      },
      { message: 'annotationScale must be "paper:drawing" with both parts > 0, e.g. "1:100"' }
    )
    .optional()
    .describe(
      'Sets CANNOSCALE, adding it to the drawing\'s scale list first if missing (e.g. "1:100"). ' +
        "From this call on, entity.create's annotative-capable kinds (mtext, text.singleLine, " +
        'dimension.linear/aligned/ordinate, hatch) default their own annotative field to true.'
    )
})

export const systemStatusParams = z.object({})

export const viewZoomExtentsParams = z.object({})

export const drawingCheckKind = z.enum([
  'duplicates',
  'overlaps',
  'zeroLength',
  'openOutlines',
  'layerZero',
  'textSize',
  'dimOverride',
  'offExtents'
])

/** First match wins: `handles`, else `layer`, else `window`, else the whole drawing. */
export const drawingCheckScope = z.object({
  handles: z.array(entityHandle).min(1).optional(),
  layer: layerName.optional(),
  window: z.object({ min: point3d, max: point3d }).optional()
})

export const drawingCheckParams = z.object({
  scope: drawingCheckScope.optional(),
  checks: z.array(drawingCheckKind).min(1).optional()
})

export const drawingCleanupFixKind = z.enum(['duplicates', 'zeroLength', 'purge', 'audit'])

export const drawingCleanupParams = z.object({
  fixes: z.array(drawingCleanupFixKind).min(1),
  dryRun: z.boolean().optional()
})
