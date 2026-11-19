import * as z from 'zod/v4'
import { point3d } from './geometry.js'

export const viewFollow = z.enum(['off', 'fit', 'pan'])

/**
 * Per-call override for `entity.create`/`entity.erase`/`entity.transform`/`operations.apply` — lets
 * a caller say "don't move the camera for this one" (or force a move) without touching the
 * document's `view.setLive` default. Spread as `view: viewOverride` on a mutating tool's schema.
 */
export const viewOverride = z
  .object({ follow: viewFollow.optional() })
  .optional()
  .describe(
    "Override this document's live-view follow setting for this call only (e.g. {follow:'off'} " +
      'for hidden helper geometry); omit to use the document default from view -> live.'
  )

export const viewSetLiveParams = z.object({
  follow: viewFollow
    .optional()
    .describe(
      "off: never move the view (today's behavior). fit: frame the affected geometry with " +
        'margin after each mutating call. pan: keep the current view height, just recenter.'
    ),
  margin: z
    .number()
    .min(0)
    .max(5)
    .optional()
    .describe('Fraction of the affected extents added around it when fitting.'),
  minHeight: z
    .number()
    .positive()
    .optional()
    .describe(
      'Never zoom the view closer than this height (drawing units) — avoids zooming into a tiny detail.'
    ),
  animate: z
    .boolean()
    .optional()
    .describe('Smoothly interpolate the view over ~8 frames (<=200ms) instead of jumping.'),
  progressive: z
    .boolean()
    .optional()
    .describe('operations.apply repaints partway through a batch instead of only at the end.'),
  paceMs: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Extra delay (ms) between progressive repaints, for a human-paced draw; hard-capped so a ' +
        'batch never adds more than 3s of delay in total regardless of paceMs x step count.'
    )
})

export const viewZoomParams = z.object({
  window: z
    .object({ min: point3d, max: point3d })
    .optional()
    .describe('Zoom to this world XY rectangle. First match wins over handles/center+viewHeight.'),
  handles: z.array(z.string()).optional().describe("Zoom to fit these entities' extents."),
  center: point3d.optional().describe('Zoom to this center point; requires viewHeight.'),
  viewHeight: z
    .number()
    .positive()
    .optional()
    .describe(
      "View height in world/drawing units (e.g. millimetres) for center — unrelated to capture's pixel width/height."
    )
})
