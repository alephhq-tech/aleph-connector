import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@arcdio/cad-protocol'
import {
  entityOperation,
  idempotencyKey,
  operationsApplyParams,
  operationsHistoryParams,
  operationsPreviewParams,
  operationsRedoParams,
  operationsRevertParams,
  operationsUndoParams
} from '@arcdio/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { applyBatch } from './applyBatch.js'
import { outcomeMeta } from './attestOutcome.js'
import {
  captureOption,
  captureSize,
  requireVisualReview,
  visualReviewOption,
  withCapture
} from './capture.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { angleUnit, applyDefaults, ensureLayer, wireOperations } from './normalize.js'
import { portableInputSchema } from './portableSchema.js'
import { refsResultMode } from './resultShape.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'

export function registerOperationsTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('apply'),
      ...operationsApplyParams.shape,
      result: refsResultMode,
      angleUnit,
      ensureLayer,
      capture: captureOption,
      visualReview: visualReviewOption,
      ...captureSize,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('preview'),
      ...operationsPreviewParams.shape,
      angleUnit,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('revert'),
      ...operationsRevertParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('undo'),
      ...operationsUndoParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('redo'),
      ...operationsRedoParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('history'),
      ...operationsHistoryParams.shape,
      documentName,
      instanceId
    })
  ])

  server.registerTool(
    'operations',
    {
      title: 'Batch operations and undo',
      description:
        `Draw many entities in one AutoCAD transaction and one undo step — the fast way to draw. ` +
        `operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. apply: operations[] ` +
        `of op = ${literalValues(entityOperation.options, 'op').join(' | ')} (same payloads as the entity ` +
        `tool, incl. aliases, [x,y]/[x,y,z] points, angleUnit, ensureLayer); \`result\` = full | handles | summary. ` +
        `Each step may carry an \`id\` (e.g. "wall1"); a later step references its resulting handle(s) as ` +
        `"@wall1" anywhere a handle is accepted (erase.handles, transform handles/path, hatch ` +
        `boundaryHandles/loops) — e.g. create a polyline with id "outline", then hatch and copy it via ` +
        `"@outline", all in one call. \`defaults.layer\` sets the layer every create step that omits its own ` +
        `uses. A batch with no \`id\`/\`@ref\` use is one AutoCAD transaction/undo step; one that chains a ` +
        `reference to a same-call step's result may run as more than one (still one tool call, still ` +
        `all-or-nothing per sub-batch — check \`status\`, and \`error.failedStep\` for which step). ` +
        `undo/redo are LIFO on this document's batch journal (the batchId must be the latest). ` +
        `history lists recent batches. Optional documentName targets another open tab; optional ` +
        `instanceId targets another AutoCAD process when 2+ are online.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    mutatingGuarded(async (input, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      switch (input.operation) {
        case 'apply': {
          // Counted after expansion: one `dimension.chain` step is one parsed operation but 20+
          // entities on the wire, and the gate is about what gets drawn, not how it was worded.
          const wireOps = wireOperations(
            applyDefaults(input.operations, input.defaults),
            input.angleUnit
          )
          requireVisualReview(wireOps.length, input.capture, input.visualReview)
          const { refs, payload, claim } = await applyBatch(bridge, wireOps, {
            documentName: input.documentName,
            taskId: input.taskId,
            ensureLayer: input.ensureLayer,
            result: input.result,
            view: input.view,
            progressive: input.progressive,
            paceMs: input.paceMs,
            idempotencyKey: operationKey(ctx, input.idempotencyKey),
            signal: ctx.mcpReq.signal,
            expectedRevision: input.expectedRevision,
            expectedState: input.expectedState
          })
          return withCapture(
            bridge,
            payload,
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
        }
        case 'preview': {
          const wireOps = wireOperations(
            applyDefaults(input.operations, input.defaults),
            input.angleUnit
          )
          const result = await bridge.request(RpcMethod.OperationsPreview, {
            operations: wireOps,
            documentName: input.documentName,
            taskId: input.taskId
          })
          return textResult(result)
        }
        case 'revert': {
          const result = await bridge.request(
            RpcMethod.OperationsRevert,
            {
              batchId: input.batchId,
              taskId: input.taskId,
              documentName: input.documentName
            },
            { signal: ctx.mcpReq.signal }
          )
          return textResult(result)
        }
        case 'undo':
          return textResult(
            await bridge.request(
              RpcMethod.OperationsUndo,
              {
                batchId: input.batchId,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'redo':
          return textResult(
            await bridge.request(
              RpcMethod.OperationsRedo,
              {
                batchId: input.batchId,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'history':
          return textResult(
            await bridge.request(RpcMethod.OperationsHistory, {
              limit: input.limit,
              documentName: input.documentName,
              taskId: input.taskId
            })
          )
      }
    })
  )
}
