import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@arcdio/cad-protocol'
import type { EntityOperation } from '@arcdio/cad-protocol'
import { db } from '@arcdio/data'
import {
  editApplyParams,
  editBeginParams,
  editPreviewParams,
  editStatusParams,
  editDiscardParams,
  editAcceptParams,
  idempotencyKey
} from '@arcdio/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { attestBatchOutcome, outcomeMeta } from './attestOutcome.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId } from './shared.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'

export function registerEditTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('begin'),
      ...editBeginParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('apply'),
      ...editApplyParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('preview'),
      ...editPreviewParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('status'),
      ...editStatusParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('discard'),
      ...editDiscardParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('accept'),
      ...editAcceptParams.shape,
      documentName,
      instanceId
    })
  ])

  server.registerTool(
    'edit',
    {
      title: 'Safe entity editing',
      description:
        'Isolate and preview edits before applying them to drawing entities. ' +
        'begin: captures immutable pre-images and clones target entities to a dedicated candidate layer. ' +
        'apply: mutates candidates within session-scoped candidate layers/handles. ' +
        'preview: computes a structured diff between pre-images and candidates with optional before/after PNGs. ' +
        'status: inspects active, revalidating, accepted, or discarded session metadata. ' +
        'discard: abandons the session and cleans up candidate entities and layer. ' +
        'accept: compare-and-swap commit promoting candidates and erasing source entities in one undo group.',
      inputSchema: portableInputSchema(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    mutatingGuarded(async (args, ctx) => {
      const bridge = withInstance(baseBridge, args.instanceId)
      switch (args.operation) {
        case 'begin': {
          const result = await bridge.request(RpcMethod.EditBegin, {
            handles: args.handles,
            selection: args.selection,
            documentName: args.documentName,
            includeDependencies: args.includeDependencies
          })
          return textResult(result)
        }
        case 'apply': {
          const result = await bridge.request(RpcMethod.EditApply, {
            editId: args.editId,
            operations: args.operations as unknown as EntityOperation[],
            documentName: args.documentName,
            idempotencyKey: operationKey(ctx, args.idempotencyKey),
            view: args.view,
            progressive: args.progressive,
            paceMs: args.paceMs
          })
          // `EditApplyResult extends OperationsApplyResult`: the plugin reports the same commit
          // truth here as a raw batch, so the same attestation applies (issue #388 §C).
          return textResult(result, outcomeMeta(attestBatchOutcome(result)))
        }
        case 'preview': {
          const result = (await bridge.request(RpcMethod.EditPreview, {
            editId: args.editId,
            documentName: args.documentName,
            capture: args.capture
          })) as unknown as Record<string, unknown>
          const { beforePng, afterPng, ...diffOnly } = result
          const content: [
            { type: 'text'; text: string },
            ...{ type: 'image'; data: string; mimeType: string }[]
          ] = [{ type: 'text', text: JSON.stringify(diffOnly) }]
          if (typeof beforePng === 'string' && beforePng.length > 0) {
            content.push({ type: 'image', data: beforePng, mimeType: 'image/png' })
          }
          if (typeof afterPng === 'string' && afterPng.length > 0) {
            content.push({ type: 'image', data: afterPng, mimeType: 'image/png' })
          }
          return { content }
        }
        case 'status': {
          const result = await bridge.request(RpcMethod.EditStatus, {
            editId: args.editId,
            documentName: args.documentName
          })
          return textResult(result)
        }
        case 'discard': {
          const result = await bridge.request(RpcMethod.EditDiscard, {
            editId: args.editId,
            approvalToken: args.approvalToken,
            documentName: args.documentName
          })
          return textResult(result)
        }
        case 'accept': {
          if (!args.approvalToken || !args.approvalToken.trim()) {
            throw new BridgeRpcError(
              BridgeErrorCode.EditRequiresHumanApproval,
              'edit.accept requires human approval via Desktop approval token.'
            )
          }

          const consumeResult = await db.editApprovals.consumeToken({
            token: args.approvalToken,
            editId: args.editId,
            diffDigest: args.expectedDiffDigest,
            now: Date.now()
          })

          if (!consumeResult.success) {
            if (consumeResult.reason?.includes('diff digest')) {
              throw new BridgeRpcError(
                BridgeErrorCode.EditConflict,
                `Approval token validation failed: ${consumeResult.reason}`
              )
            }
            throw new BridgeRpcError(
              BridgeErrorCode.EditRequiresHumanApproval,
              `Approval token validation failed: ${consumeResult.reason}`
            )
          }

          const result = await bridge.request(RpcMethod.EditAccept, {
            editId: args.editId,
            approvalToken: args.approvalToken,
            expectedDiffDigest: args.expectedDiffDigest,
            expectedRevision: args.expectedRevision,
            allowUnknownFeatures: args.allowUnknownFeatures,
            idempotencyKey: operationKey(ctx, args.idempotencyKey),
            documentName: args.documentName
          })
          return textResult(result)
        }
      }
    })
  )
}
