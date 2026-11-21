import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { idempotencyKey, layerName, point3d, viewOverride } from '@aleph-connector/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { dimensionChain, grid, room, walls, type ConstructStep } from '../construct/generators.js'
import { applyBatch } from './applyBatch.js'
import { outcomeMeta } from './attestOutcome.js'
import { captureOption, captureSize, requireVisualReview, visualReviewOption, withCapture } from './capture.js'
import { withInstance } from './instanceScope.js'
import { ensureLayer } from './normalize.js'
import { operationKey } from './operationIdentity.js'
import { portableInputSchema } from './portableSchema.js'
import { refsResultMode } from './resultShape.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'

const length = z.number().positive()
const gridAxis = z
  .object({
    spacings: z.array(length).min(1).optional(),
    count: z.number().int().min(1).max(200).optional(),
    spacing: length.optional(),
    labels: z.array(z.string().min(1)).optional()
  })
  .refine((a) => a.spacings !== undefined || (a.count !== undefined && a.spacing !== undefined), {
    message: 'give spacings, or count + spacing'
  })

/** Everything the three generators share: where to draw and how to report. */
const common = {
  layer: layerName.optional(),
  taskId: z
    .string()
    .min(1)
    .optional()
    .describe('Logical agent task identifier for grouping and selective restore.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('Return the generated steps without drawing (default false).'),
  ensureLayer,
  result: refsResultMode,
  capture: captureOption,
  visualReview: visualReviewOption,
  ...captureSize,
  documentName,
  instanceId,
  idempotencyKey,
  view: viewOverride,
  progressive: z
    .boolean()
    .optional()
    .describe('Repaint partway through this batch instead of only at the end. Default false.'),
  paceMs: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Extra delay (ms) between progressive repaints.')
}

const inputSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('walls'),
    centerline: z.array(point3d).min(2),
    thickness: length,
    closed: z.boolean().optional(),
    justification: z.enum(['center', 'left', 'right']).optional(),
    openings: z
      .array(
        z
          .object({
            at: point3d.optional(),
            along: z.number().min(0).optional(),
            width: length
          })
          .refine((o) => o.at !== undefined || o.along !== undefined, {
            message:
              'an opening needs at (a point near the wall) or along (distance from the start)'
          })
      )
      .optional()
      .describe(
        'Doors/windows to cut out of the run. Each becomes a real gap: the wall is drawn as ' +
          'separate pieces, never as one continuous run with the opening drawn over it.'
      ),
    ...common
  }),
  z.object({
    operation: z.literal('grid'),
    origin: point3d,
    x: gridAxis,
    y: gridAxis,
    extension: z.number().min(0),
    bubbleRadius: length,
    textHeight: length.optional(),
    bubbles: z.enum(['start', 'both']).optional(),
    ...common
  }),
  z.object({
    operation: z.literal('dimensions'),
    points: z.array(point3d).min(2),
    mode: z.enum(['continue', 'baseline']),
    direction: z.enum(['horizontal', 'vertical']),
    offset: z.number().refine((v) => v !== 0, 'offset must not be 0'),
    spacing: z.number().optional(),
    ...common
  }),
  z.object({
    operation: z.literal('room'),
    outline: z.array(point3d).min(3),
    name: z.string().min(1),
    showArea: z.boolean().optional(),
    unit: z.enum(['mm', 'cm', 'm']).optional(),
    areaDecimals: z.number().int().min(0).max(4).optional(),
    textHeight: length,
    ...common
  })
])

type ConstructInput = z.output<typeof inputSchema>

function generate(input: ConstructInput): ConstructStep[] {
  switch (input.operation) {
    case 'walls':
      return walls(input)
    case 'grid':
      return grid(input)
    case 'room':
      return room(input)
    case 'dimensions':
      return dimensionChain(input)
  }
}

/** Upper bound on steps one construct call may produce — keeps a batch well inside the timeout. */
const MAX_STEPS = 2000

/**
 * `construct` (#21): drafting intents — walls, a structural grid, a room — expanded server-side
 * into one `operations.apply` batch: one round trip, one transaction, one undo step.
 */
export function registerConstructTools(server: McpServer, baseBridge: BridgeClient): void {
  server.registerTool(
    'construct',
    {
      title: 'Construct (walls, grid, room, dimension chains)',
      description:
        `Draw a whole drafting element from its intent in one batch and one undo step — far fewer ` +
        `tokens than sending every coordinate. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `walls: centerline points + thickness (mitred corners; justification center|left|right; ` +
        `closed → two faces, open → one closed outline you can hatch). openings[] cuts real gaps in ` +
        `the run — each { at | along, width } — so a door/window is an actual break in the wall, not ` +
        `an arc drawn over a sealed one; a run with openings comes back as walls.segmentN pieces. ` +
        `grid: origin, x/y as ` +
        `spacings[] or count+spacing, extension, bubbleRadius (axis lines, bubbles, labels 1,2,3 / ` +
        `A,B,C without I,O). room: outline, name, textHeight, area label in m² (unit = what one ` +
        `drawing unit is). dimensions: points + mode continue|baseline + direction horizontal|vertical ` +
        `+ offset (DIMCONTINUE/DIMBASELINE in one step). dryRun returns the steps without drawing. Result: the batch result plus ` +
        `\`elements\` mapping labels like grid.axis.A or room.name to handles. \`capture\` (changed | all) also returns a PNG of the result. ` +
        `Optional instanceId targets another AutoCAD process when 2+ are online.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    mutatingGuarded(async (input, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      const steps = generate(input).map((step) => ({
        ...step,
        entity: { ...step.entity, layer: step.entity.layer ?? input.layer }
      }))
      if (steps.length > MAX_STEPS) {
        throw new Error(
          `construct would create ${steps.length} entities (limit ${MAX_STEPS}); split it`
        )
      }
      if (input.dryRun) {
        return textResult({ dryRun: true, stepCount: steps.length, steps })
      }
      requireVisualReview(steps.length, input.capture, input.visualReview)
      const { refs, payload, claim } = await applyBatch(
        bridge,
        steps.map((step) => ({ op: 'create' as const, entity: step.entity })),
        {
          documentName: input.documentName,
          taskId: input.taskId,
          ensureLayer: input.ensureLayer,
          result: input.result,
          view: input.view,
          progressive: input.progressive,
          paceMs: input.paceMs,
          idempotencyKey: operationKey(ctx, input.idempotencyKey)
        }
      )
      const elements = Object.fromEntries(
        steps.flatMap((step, i) => (refs[i] ? [[step.label, refs[i].handle]] : []))
      )
      return withCapture(
        bridge,
        { ...payload, elements },
        {
          mode: input.capture,
          handles: refs.map((ref) => ref.handle),
          review: input.visualReview,
          documentName: input.documentName,
          width: input.width,
          height: input.height
        },
        outcomeMeta(claim)
      )
    })
  )
}
