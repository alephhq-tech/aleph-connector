import * as z from 'zod/v4'
import { colorSpec, layerName } from './geometry.js'

export const layerListParams = z.object({})

export const layerCreateParams = z.object({
  name: layerName,
  color: colorSpec.optional()
})

export const layerSetCurrentParams = z.object({
  name: layerName
})

export const layerSetPropertiesParams = z.object({
  name: layerName,
  color: colorSpec.optional(),
  linetype: z.string().min(1).optional(),
  lineweight: z.number().int().optional(),
  frozen: z.boolean().optional(),
  locked: z.boolean().optional(),
  plottable: z.boolean().optional(),
  on: z.boolean().optional()
})

const layerEnsureEntry = z.object({
  name: layerName,
  color: colorSpec.optional(),
  linetype: z.string().min(1).optional(),
  lineweight: z.number().int().optional(),
  plottable: z.boolean().optional(),
  on: z.boolean().optional(),
  frozen: z.boolean().optional(),
  locked: z.boolean().optional(),
  description: z.string().optional()
})

/** Max layers per `layer.ensure` call, matching the plugin's own `MaxEnsureLayers` bound. */
export const MAX_ENSURE_LAYERS = 200

export const layerEnsureParams = z.object({
  layers: z.array(layerEnsureEntry).min(1).max(MAX_ENSURE_LAYERS),
  setCurrent: layerName.optional()
})

export const layerRenameParams = z.object({
  from: layerName,
  to: layerName
})

export const layerDeleteParams = z.object({
  name: layerName
})
