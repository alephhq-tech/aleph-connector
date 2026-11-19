import { z } from 'zod'
import { entityOperation } from './operations.js'
import { viewOverride } from './view.js'

export const editBeginParams = z.object({
  handles: z.array(z.string()).min(1).optional().describe('Target entity handles to edit.'),
  selection: z
    .literal('implied')
    .optional()
    .describe('Use current pick in AutoCAD active document.'),
  documentName: z.string().optional().describe('Target document (defaults to active tab).'),
  includeDependencies: z
    .boolean()
    .optional()
    .describe('Include touched layers/blocks in pre-image.')
})

export const editApplyParams = z.object({
  editId: z.string().describe('Session ID returned by edit.begin.'),
  operations: z
    .array(entityOperation)
    .min(1)
    .describe('Operations to apply, confined to candidate layer and candidate handles.'),
  documentName: z.string().optional().describe('Target document.'),
  idempotencyKey: z
    .string()
    .optional()
    .describe('Repeat this key on retry to get original result.'),
  view: viewOverride,
  progressive: z.boolean().optional().describe('Repaint partway through the batch.'),
  paceMs: z.number().optional().describe('Extra delay (ms) between progressive repaints.')
})

export const editPreviewParams = z.object({
  editId: z.string().describe('Session ID returned by edit.begin.'),
  documentName: z.string().optional().describe('Target document.'),
  capture: z
    .object({
      width: z
        .number()
        .int()
        .min(64)
        .max(2048)
        .optional()
        .describe('Off-screen PNG width (default 1024).'),
      height: z
        .number()
        .int()
        .min(64)
        .max(2048)
        .optional()
        .describe('Off-screen PNG height (default 768).')
    })
    .optional()
    .describe('Off-screen PNG capture settings.')
})

export const editStatusParams = z.object({
  editId: z.string().describe('Session ID returned by edit.begin.'),
  documentName: z.string().optional().describe('Target document.')
})

export const editDiscardParams = z.object({
  editId: z.string().describe('Session ID returned by edit.begin.'),
  approvalToken: z.string().optional().describe('Approval token if required.'),
  documentName: z.string().optional().describe('Target document.')
})

export const editAcceptParams = z.object({
  editId: z.string().describe('Session ID returned by edit.begin.'),
  approvalToken: z.string().optional().describe('Approval token authorized for this edit session.'),
  expectedDiffDigest: z.string().optional().describe('Expected DiffDigest from edit.preview.'),
  expectedRevision: z
    .string()
    .optional()
    .describe('Expected document revision from edit.preview/begin.'),
  allowUnknownFeatures: z
    .boolean()
    .optional()
    .describe('Allow accepting edits with lossy/unsupported features.'),
  idempotencyKey: z
    .string()
    .optional()
    .describe('Repeat this key on retry to get original result.'),
  documentName: z.string().optional().describe('Target document.')
})
