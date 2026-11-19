import * as z from 'zod/v4'
import { entityHandle } from './geometry.js'

export const blockName = z.string().min(1)

export const blockInspectParams = z.object({
  blockName: blockName.optional(),
  handle: entityHandle.optional(),
  includeContents: z.boolean().optional()
})

export const blockSetExplodableParams = z.object({
  blockName: blockName.optional(),
  handle: entityHandle.optional(),
  explodable: z.boolean(),
  sharedScope: z.boolean().optional()
})

export const blockListParams = z.object({
  includeAnonymous: z.boolean().optional(),
  includeLayouts: z.boolean().optional(),
  includeXrefs: z.boolean().optional()
})
export const blockExplodeParams = z.object({
  handle: entityHandle
})

export const blockUniquifyParams = z.object({
  handle: entityHandle,
  newName: blockName.optional()
})
