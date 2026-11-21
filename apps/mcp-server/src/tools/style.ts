import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import {
  idempotencyKey,
  styleDimStylesCreateParams,
  styleDimStylesSetCurrentParams,
  styleLinetypesLoadParams,
  styleTextStylesCreateParams,
  styleTextStylesSetCurrentParams
} from '@aleph-connector/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'

export function registerStyleTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('linetypes.list'), documentName, instanceId }),
    z.object({
      operation: z.literal('linetypes.load'),
      ...styleLinetypesLoadParams.shape,
      documentName,
      instanceId
    }),
    z.object({ operation: z.literal('textStyles.list'), documentName, instanceId }),
    z.object({
      operation: z.literal('textStyles.create'),
      ...styleTextStylesCreateParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('textStyles.setCurrent'),
      ...styleTextStylesSetCurrentParams.shape,
      documentName,
      instanceId
    }),
    z.object({ operation: z.literal('dimStyles.list'), documentName, instanceId }),
    z.object({
      operation: z.literal('dimStyles.create'),
      ...styleDimStylesCreateParams.shape,
      documentName,
      instanceId,
      idempotencyKey
    }),
    z.object({
      operation: z.literal('dimStyles.setCurrent'),
      ...styleDimStylesSetCurrentParams.shape,
      documentName,
      instanceId
    })
  ])

  server.registerTool(
    'style',
    {
      title: 'Symbol tables (linetypes, text styles, dimension styles)',
      description:
        `Manage the symbol tables drafting depends on. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `linetypes.list/load: DASHED, CENTER, HIDDEN etc. aren't loaded in a default drawing — ` +
        `layer → set_properties { linetype } fails until linetypes.load loads it (names + optional ` +
        `file, default acadiso.lin); already-loaded names are a no-op. textStyles.create/setCurrent: ` +
        `font, height (0 = variable), widthFactor, obliqueAngle (radians); set trueTypeFace (e.g. ` +
        `"Arial") for a real TrueType style instead of an SHX font path — required for reliable ` +
        `Vietnamese/Unicode text (optional bold, italic, charSet [163 = Vietnamese], pitchAndFamily); ` +
        `create on an existing ` +
        `name fails unless update: true. dimStyles.create/setCurrent: textHeight, arrowSize, ` +
        `extensionOffset, extensionBeyond, decimalPlaces, unitsFormat, scale; setCurrent sets the ` +
        `ambient Database.Dimstyle, so entities created afterward pick it up automatically — the ` +
        `plugin never overrides per-entity dimension style. Optional documentName targets another ` +
        `open tab; optional instanceId targets another AutoCAD process when 2+ are online.`,
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
        case 'linetypes.list': {
          const result = await bridge.request(RpcMethod.StyleLinetypesList, {
            documentName: input.documentName
          })
          return textResult(result)
        }
        case 'linetypes.load':
          return textResult(
            await bridge.request(RpcMethod.StyleLinetypesLoad, {
              names: input.names,
              file: input.file,
              documentName: input.documentName
            })
          )
        case 'textStyles.list': {
          const result = await bridge.request(RpcMethod.StyleTextStylesList, {
            documentName: input.documentName
          })
          return textResult(result)
        }
        case 'textStyles.create':
          return textResult(
            await bridge.request(
              RpcMethod.StyleTextStylesCreate,
              {
                name: input.name,
                font: input.font,
                height: input.height,
                widthFactor: input.widthFactor,
                obliqueAngle: input.obliqueAngle,
                update: input.update,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey),
                trueTypeFace: input.trueTypeFace,
                bold: input.bold,
                italic: input.italic,
                charSet: input.charSet,
                pitchAndFamily: input.pitchAndFamily
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'textStyles.setCurrent':
          return textResult(
            await bridge.request(RpcMethod.StyleTextStylesSetCurrent, {
              name: input.name,
              documentName: input.documentName
            })
          )
        case 'dimStyles.list': {
          const result = await bridge.request(RpcMethod.StyleDimStylesList, {
            documentName: input.documentName
          })
          return textResult(result)
        }
        case 'dimStyles.create':
          return textResult(
            await bridge.request(
              RpcMethod.StyleDimStylesCreate,
              {
                name: input.name,
                basedOn: input.basedOn,
                textHeight: input.textHeight,
                arrowSize: input.arrowSize,
                extensionOffset: input.extensionOffset,
                extensionBeyond: input.extensionBeyond,
                decimalPlaces: input.decimalPlaces,
                unitsFormat: input.unitsFormat,
                scale: input.scale,
                update: input.update,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'dimStyles.setCurrent':
          return textResult(
            await bridge.request(RpcMethod.StyleDimStylesSetCurrent, {
              name: input.name,
              documentName: input.documentName
            })
          )
      }
    })
  )
}
