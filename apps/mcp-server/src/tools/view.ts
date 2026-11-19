import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@arcdio/cad-protocol'
import { point3d, viewSetLiveParams, viewZoomParams } from '@arcdio/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { captureSize } from './capture.js'
import { withInstance } from './instanceScope.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { imageResult, textResult } from './textResult.js'
import { guarded } from './toolError.js'

export function registerViewTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('zoom_extents'), documentName, instanceId }),
    z.object({
      operation: z.literal('capture'),
      ...captureSize,
      handles: z
        .array(z.string())
        .optional()
        .describe('Frame the picture on these entity handles (e.g. what was just drawn).'),
      window: z
        .object({ min: point3d, max: point3d })
        .optional()
        .describe('Frame the picture on this world XY rectangle. Wins over handles.'),
      background: z
        .enum(['white', 'black'])
        .optional()
        .describe('Paper color (default white; color 7 draws black on it).'),
      source: z
        .enum(['viewport', 'drawing'])
        .optional()
        .describe(
          "Capture source: 'viewport' (fast screen/viewport snapshot, default) or 'drawing' (slower off-screen render)."
        ),
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('live'),
      ...viewSetLiveParams.shape,
      documentName,
      instanceId
    }),
    z.object({ operation: z.literal('get_live'), documentName, instanceId }),
    z.object({
      operation: z.literal('zoom'),
      ...viewZoomParams.shape,
      documentName,
      instanceId
    })
  ])

  server.registerTool(
    'view',
    {
      title: 'View (zoom, picture, live drafting)',
      description:
        `Look at or move the drawing's camera; never changes drawing data. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        "zoom_extents fits the whole drawing in the user's view. zoom frames a `window`, `handles`, " +
        "or `center`+`viewHeight` explicitly (world/drawing units, not pixels — unrelated to capture's " +
        'pixel `width`/`height`) — use it to look somewhere before drawing there. capture ' +
        'returns a PNG of the drawing so you can check it looks right — proportions, overlaps, ' +
        'missing or misplaced parts, text legibility — and also to read a reference drawing in ' +
        "another tab (documentName). live sets this document's follow mode (off default | fit | " +
        'pan) so the view tracks entity.*/operations.apply calls afterward — fit/pan frame what ' +
        'changed with `margin`, clamped by `minHeight`; `progressive`+`paceMs` make a big ' +
        'operations.apply batch appear piece by piece instead of all at once; get_live reads the ' +
        'current setting back. Every mutating entity/operations call also takes its own `view` ' +
        "override for that call only. Never touches the user's screen or active tab except the " +
        'camera. Optional documentName targets another open tab; optional instanceId targets ' +
        'another AutoCAD process when 2+ are online.',
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    guarded(async (input) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      switch (input.operation) {
        case 'zoom_extents':
          return textResult(
            await bridge.request(RpcMethod.ViewZoomExtents, { documentName: input.documentName })
          )
        case 'capture': {
          // `instanceId` is Device Gateway routing (handled by `withInstance` above), never a
          // wire-protocol field — excluded here like `operation`, not forwarded to the plugin.
          const { operation: _operation, instanceId: _instanceId, ...params } = input
          const { data, mimeType, ...meta } = await bridge.request(RpcMethod.ViewCapture, params)
          return imageResult(meta, { data, mimeType })
        }
        case 'live': {
          const { operation: _operation, instanceId: _instanceId, ...params } = input
          return textResult(await bridge.request(RpcMethod.ViewSetLive, params))
        }
        case 'get_live':
          return textResult(
            await bridge.request(RpcMethod.ViewGetLive, { documentName: input.documentName })
          )
        case 'zoom': {
          const { operation: _operation, instanceId: _instanceId, ...params } = input
          return textResult(await bridge.request(RpcMethod.ViewZoom, params))
        }
      }
    })
  )
}
