import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@arcdio/cad-protocol'
import {
  idempotencyKey,
  layerCreateParams,
  layerDeleteParams,
  layerEnsureParams,
  layerRenameParams,
  layerSetCurrentParams,
  layerSetPropertiesParams
} from '@arcdio/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { portableInputSchema } from './portableSchema.js'
import { fieldsParam, project } from './resultShape.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'

export function registerLayerTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('list'),
      fields: fieldsParam([
        'name',
        'color',
        'linetype',
        'lineweight',
        'frozen',
        'locked',
        'plottable',
        'on',
        'isCurrent'
      ]),
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('create'),
      ...layerCreateParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('set_current'),
      ...layerSetCurrentParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('set_properties'),
      ...layerSetPropertiesParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('ensure'),
      ...layerEnsureParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('rename'),
      ...layerRenameParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('delete'),
      ...layerDeleteParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    })
  ])

  server.registerTool(
    'layer',
    {
      title: 'Layers',
      description:
        `Manage layers (AutoCAD LA). operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `create takes only name + color and never fails if the layer exists; set linetype, ` +
        `lineweight, frozen, locked, plottable, on with set_properties. ensure upserts a whole ` +
        `layer set (up to 200) in one call, reporting created/updated/unchanged per layer, and ` +
        `validates every entry before writing any of them. rename fails if the target name is ` +
        `taken; delete refuses layer 0, Defpoints, the current layer, or a layer with entities on ` +
        `it. entity → create never creates layers, so create/ensure them first. list takes ` +
        `\`fields\`. Optional documentName targets another open tab; optional instanceId targets ` +
        `another AutoCAD process when 2+ are online.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    mutatingGuarded(async (input, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      switch (input.operation) {
        case 'list': {
          const { layers } = await bridge.request(RpcMethod.LayerList, {
            documentName: input.documentName
          })
          return textResult({ layers: layers.map((layer) => project(layer, input.fields)) })
        }
        case 'create':
          return textResult(
            await bridge.request(
              RpcMethod.LayerCreate,
              {
                name: input.name,
                color: input.color,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'set_current':
          return textResult(
            await bridge.request(RpcMethod.LayerSetCurrent, {
              name: input.name,
              documentName: input.documentName
            })
          )
        case 'set_properties':
          return textResult(
            await bridge.request(
              RpcMethod.LayerSetProperties,
              {
                name: input.name,
                color: input.color,
                linetype: input.linetype,
                lineweight: input.lineweight,
                frozen: input.frozen,
                locked: input.locked,
                plottable: input.plottable,
                on: input.on,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'ensure':
          return textResult(
            await bridge.request(
              RpcMethod.LayerEnsure,
              {
                layers: input.layers,
                setCurrent: input.setCurrent,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'rename':
          return textResult(
            await bridge.request(
              RpcMethod.LayerRename,
              {
                from: input.from,
                to: input.to,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'delete':
          return textResult(
            await bridge.request(
              RpcMethod.LayerDelete,
              {
                name: input.name,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
      }
    })
  )
}
