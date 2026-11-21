import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import {
  createEntityParams,
  entityAreaMeasureParams,
  entityCopyToParams,
  entityEraseParams,
  entityGetParams,
  entityListParams,
  entityTransformParams,
  entityUpdateParams,
  idempotencyKey,
  viewOverride
} from '@aleph-connector/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { applyBatch } from './applyBatch.js'
import { BULK_REVIEW_MIN_ENTITIES } from './capture.js'
import { outcomeMeta } from './attestOutcome.js'
import {
  angleUnit,
  ensureLayer,
  ensureLayers,
  expandEntity,
  layersOf,
  toRadians,
  wireTransform
} from './normalize.js'
import { operationKey } from './operationIdentity.js'
import { withInstance } from './instanceScope.js'
import { portableInputSchema } from './portableSchema.js'
import { fieldsParam, project, refsResultMode, shapeRefs } from './resultShape.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'

const entityFields = fieldsParam(['handle', 'kind', 'layer', 'bounds', 'properties', 'geometry'])

/**
 * The `entity` tool's full operation union, hoisted to module scope and exported so
 * `entity.test.ts` can flatten it through `portableInputSchema` and assert the list operation's
 * new `window` field collides with nothing across the union (the flatten guard is per-tool).
 * `registerEntityTools` below is the only runtime consumer.
 */
export const entityInputSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    entity: createEntityParams,
    angleUnit,
    ensureLayer,
    view: viewOverride,
    progressive: z
      .boolean()
      .optional()
      .describe('Repaint partway through an expanded batch. Default false.'),
    paceMs: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Extra delay (ms) between progressive repaints.'),
    documentName,
    instanceId,
    idempotencyKey
  }),
  z.object({
    operation: z.literal('list'),
    ...entityListParams.shape,
    fields: entityFields,
    documentName,
    instanceId
  }),
  z.object({
    operation: z.literal('get'),
    ...entityGetParams.shape,
    fields: entityFields,
    documentName,
    instanceId
  }),
  z
    .object({
      operation: z.literal('area_measure'),
      ...entityAreaMeasureParams.shape,
      documentName,
      instanceId
    })
    .refine(
      (p) => (p.handles?.length ?? 0) > 0 || p.selection !== undefined || p.window !== undefined,
      { message: 'area_measure needs a scope: handles, selection, or window' }
    ),
  z.object({
    operation: z.literal('erase'),
    ...entityEraseParams.shape,
    view: viewOverride,
    documentName,
    instanceId,
    idempotencyKey
  }),
  z.object({
    operation: z.literal('copy_to'),
    ...entityCopyToParams.shape,
    documentName,
    instanceId,
    idempotencyKey
  }),
  z.object({
    operation: z.literal('transform'),
    transform: entityTransformParams,
    angleUnit,
    result: refsResultMode,
    view: viewOverride,
    documentName,
    instanceId,
    idempotencyKey
  }),
  z.object({
    operation: z.literal('update'),
    ...entityUpdateParams.shape,
    angleUnit,
    view: viewOverride,
    documentName,
    instanceId,
    idempotencyKey
  })
])

export function registerEntityTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = entityInputSchema
  server.registerTool(
    'entity',
    {
      title:
        'Entities (create, list, get, area_measure, erase, transform, update, copy between tabs)',
      description:
        `Create, read and edit AutoCAD geometry one call at a time — for more than a few entities ` +
        `use operations → apply instead. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `create: entity.kind = ${literalValues(createEntityParams.options, 'kind').join(' | ')} ` +
        `(aliases: rect, pline, text, insert, dimlinear…; angles in radians unless angleUnit: "deg"; ` +
        `points as {x,y} or [x,y]; ensureLayer creates missing layers; mtext/text.singleLine/dimension.linear/aligned/ordinate/hatch take an ` +
        `\`annotative\` flag (default: this document's setting from drawing.setup's annotationScale) — mtext/text.singleLine also take ` +
        `\`paperHeight\` (mm on paper) instead of a pre-scaled \`height\`). transform: transform.op = ${literalValues(entityTransformParams.options, 'op').join(' | ')}. ` +
        `area_measure: read-only native area/perimeter of closed polylines, circles, hatches and regions — ` +
        `scope by \`handles\` (fast path, opens only those), \`selection: "implied"\` (the user's current pick), ` +
        `or \`window\`; \`outputUnit: "m2"\` also gives square metres but ONLY when the drawing declares usable ` +
        `INSUNITS (a unitless drawing returns insUnits "unitless" and no areaM2 — it never guesses). Every ` +
        `number is AutoCAD's own \`Area\`/\`Perimeter\` (a hatch already nets its holes out); an open curve is ` +
        `open_boundary, a line/arc in a region query is ambiguous_region, never a bounding-box estimate. ` +
        `erase: only accepts handles of entities you created this session; entities you did not create are protected (ProtectedEntity) and must go through edit.begin/edit.accept (human approval) or the user's own hand. copy_to: reuse entities from this tab (documentName, default active) in another open tab \`targetDocumentName\`, optionally offset by \`delta\` — layers they need are created there; erase the returned handles to undo. update: edit an existing \`handle\` in place without losing it — \`layer\`/\`color\`/\`linetype\`/\`lineweight\` apply to any kind; \`geometry\` is a per-kind partial patch (\`geometry.kind\` must match the handle's actual current kind, e.g. circle {center?,radius?}, line {start?,end?}, mtext {text?,height?,width?,insertion?}, dimension.linear {extLine1?,extLine2?,dimLinePoint?,dimText?,rotation?}, hatch {pattern?,patternScale?,patternAngle?} — can't change vertex count or kind, use erase+create for that). list/get take \`fields\` and \`detail\`: \`detail: "full"\` returns each entity's actual geometry (center/radius, start/end, vertices, text, dimension measurement, hatch pattern, …) and common properties (color, linetype, lineweight, …) beyond layer, instead of just handle/kind/layer/bounds (default \`"summary"\`, unchanged); list also takes \`limit\` (max 1000), \`offset\`, \`includeBounds: false\` to skip computing each entity's bounding box (cheaper on large drawings when you only need handle/kind/layer), and \`window: {min,max}\` to read only one world XY region of a huge drawing (\`total\` then counts just the region's matches — start with drawing → summary to pick the region); transform takes \`result\`. AutoCAD aliases: L PL C A REC T MT ` +
        `H DIMLINEAR DIMALIGNED INSERT M RO SC MI CO E. Optional documentName targets another open tab; ` +
        `optional instanceId targets another AutoCAD process when 2+ are online.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    mutatingGuarded(async (input, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      switch (input.operation) {
        case 'create': {
          const key = operationKey(ctx, input.idempotencyKey)
          const expanded = expandEntity(input.entity, input.angleUnit)
          // Checked before any RPC at all: a refused call must not even create the layers, or the
          // "Nothing was drawn" below would be false. Deliberately only on `create` — `copy_to` is a
          // different operation that duplicates already-drawn entities into another tab, where the
          // reviewable surface is the source handles, not new authoring.
          if (expanded.length >= BULK_REVIEW_MIN_ENTITIES)
            throw new Error(
              `this preset creates ${expanded.length} entities in one call, which \`entity\` cannot ` +
                `show you a picture of — draw it with \`construct\` or \`operations\` (apply) and pass ` +
                `\`capture\` so the result is checked. Nothing was drawn.`
            )
          const createdLayers = input.ensureLayer
            ? await ensureLayers(bridge, layersOf(expanded), input.documentName)
            : []
          if (expanded.length === 1) {
            const created = await bridge.request(
              RpcMethod.EntityCreate,
              {
                ...expanded[0]!,
                view: input.view,
                documentName: input.documentName,
                idempotencyKey: key
              },
              { signal: ctx.mcpReq.signal }
            )
            return textResult(createdLayers.length ? { ...created, createdLayers } : created)
          }
          // Multi-entity presets (`dimension.chain`) can't go through the single-entity
          // EntityCreate RPC — send them as one operations.apply batch instead, so the plugin
          // still needs no new code and the whole chain is one transaction/undo step.
          const { payload, claim } = await applyBatch(
            bridge,
            expanded.map((entity) => ({ op: 'create' as const, entity })),
            {
              documentName: input.documentName,
              ensureLayer: false,
              result: 'full',
              view: input.view,
              progressive: input.progressive,
              paceMs: input.paceMs,
              idempotencyKey: key,
              signal: ctx.mcpReq.signal
            }
          )
          return textResult(
            createdLayers.length ? { ...payload, createdLayers } : payload,
            outcomeMeta(claim)
          )
        }
        case 'list': {
          const listed = await bridge.request(RpcMethod.EntityList, {
            layer: input.layer,
            kind: input.kind,
            limit: input.limit,
            offset: input.offset,
            includeBounds: input.includeBounds,
            detail: input.detail,
            window: input.window,
            documentName: input.documentName
          })
          return textResult({
            ...listed,
            entities: listed.entities.map((entity) => project(entity, input.fields))
          })
        }
        case 'get': {
          const got = await bridge.request(RpcMethod.EntityGet, {
            handle: input.handle,
            detail: input.detail,
            documentName: input.documentName
          })
          // #413 phase B: stateDigest (full detail only) is the value operations.apply's
          // expectedState re-checks — surface it so a read can capture the guard token.
          return textResult({
            entity: project(got.entity, input.fields),
            ...(got.stateDigest && { stateDigest: got.stateDigest })
          })
        }
        case 'area_measure':
          return textResult(
            await bridge.request(
              RpcMethod.EntityAreaMeasure,
              {
                handles: input.handles,
                selection: input.selection,
                window: input.window,
                outputUnit: input.outputUnit,
                documentName: input.documentName
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'erase':
          return textResult(
            await bridge.request(
              RpcMethod.EntityErase,
              {
                handles: input.handles,
                view: input.view,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'copy_to':
          return textResult(
            await bridge.request(
              RpcMethod.EntityCopyTo,
              {
                handles: input.handles,
                targetDocumentName: input.targetDocumentName,
                delta: input.delta,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey),
                ...(input.taskId ? { taskId: input.taskId } : {})
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'transform': {
          const transformed = await bridge.request(
            RpcMethod.EntityTransform,
            {
              ...wireTransform(input.transform, input.angleUnit),
              view: input.view,
              documentName: input.documentName,
              idempotencyKey: operationKey(ctx, input.idempotencyKey)
            },
            { signal: ctx.mcpReq.signal }
          )
          return textResult({ affected: shapeRefs(transformed.affected, input.result) })
        }
        case 'update': {
          const {
            operation: _operation,
            instanceId: _instanceId,
            angleUnit: unit,
            view,
            documentName: doc,
            idempotencyKey: key,
            ...rest
          } = input
          const geometry = rest.geometry ? toRadians(rest.geometry, unit) : undefined
          const updated = await bridge.request(
            RpcMethod.EntityUpdate,
            {
              ...rest,
              geometry,
              view,
              documentName: doc,
              idempotencyKey: operationKey(ctx, key)
            },
            { signal: ctx.mcpReq.signal }
          )
          return textResult(updated)
        }
      }
    })
  )
}
