import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import {
  blockInspectParams,
  blockListParams,
  blockSetExplodableParams,
  blockExplodeParams,
  blockUniquifyParams,
  idempotencyKey
} from '@aleph-connector/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'

export function registerBlockTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('inspect'),
      ...blockInspectParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('set_explodable'),
      ...blockSetExplodableParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('list'),
      ...blockListParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('explode'),
      ...blockExplodeParams.shape,
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('uniquify'),
      ...blockUniquifyParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('ensure_definition'),
      blockName: z.string().min(1),
      entities: z.array(z.record(z.string(), z.unknown())),
      documentName,
      instanceId
    })
  ])
  server.registerTool(
    'block',
    {
      title: 'Block Definitions',
      description:
        `Manage AutoCAD block definitions. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `inspect reads a block definition's state (name, explodable, isDynamic, isAnonymous, isLayout, isXref, referenceCount), ` +
        `accepting either blockName or a blockReference's handle (which also reports instance layer and whether that layer is locked). ` +
        `inspect {includeContents: true} also censuses what the definition actually holds — per-kind entity counts, every text-bearing entity ` +
        `(DBText/MText/ATTDEF, with its tag) in the definition's LOCAL coordinates, nested block names, plus the ATTRIB values attached to the ` +
        `instance in world coordinates — the read that answers "are this plan's room labels inside the block at all, and as what entity type". ` +
        `set_explodable permits (true) or forbids (false) exploding all references to a block definition across the drawing ` +
        `(BlockTableRecord.Explodable), targeted by blockName or a blockReference handle. ` +
        `list enumerates block definitions in the drawing with optional filters for anonymous blocks, layouts, or xrefs. ` +
        `explode breaks an unexploded BlockReference into its component entities (lines, arcs, polylines) in model space, targeted by handle (the user's block reference is protected). ` +
        `uniquify clones the definition into a dedicated unique BlockTableRecord and redirects only the targeted instance. ` +
        `Optional documentName targets another open tab; optional instanceId targets another ` +
        `AutoCAD process when 2+ are online.`,
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
        case 'inspect': {
          if (!input.blockName && !input.handle) {
            throw new Error('Either blockName or handle must be provided.')
          }
          return textResult(
            await bridge.request(RpcMethod.BlockInspect, {
              blockName: input.blockName,
              handle: input.handle,
              documentName: input.documentName,
              includeContents: input.includeContents
            })
          )
        }
        case 'set_explodable': {
          if (!input.blockName && !input.handle) {
            throw new Error('Either blockName or handle must be provided.')
          }
          return textResult(
            await bridge.request(
              RpcMethod.BlockSetExplodable,
              {
                blockName: input.blockName,
                handle: input.handle,
                explodable: input.explodable,
                sharedScope: input.sharedScope,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        }
        case 'list': {
          return textResult(
            await bridge.request(RpcMethod.BlockList, {
              includeAnonymous: input.includeAnonymous,
              includeLayouts: input.includeLayouts,
              includeXrefs: input.includeXrefs,
              documentName: input.documentName
            })
          )
        }
        case 'explode': {
          if (!input.handle) {
            throw new Error('handle must be provided to explode a block.')
          }
          return textResult(
            await bridge.request(RpcMethod.BlockExplode, {
              handle: input.handle,
              documentName: input.documentName
            })
          )
        }
        case 'uniquify': {
          return textResult(
            await bridge.request(
              RpcMethod.BlockUniquify,
              {
                handle: input.handle,
                newName: input.newName,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        }
        case 'ensure_definition': {
          return textResult(
            await bridge.request(RpcMethod.BlockEnsureDefinition, {
              blockName: input.blockName,
              entities: input.entities as any,
              documentName: input.documentName
            })
          )
        }
      }
    })
  )
}
