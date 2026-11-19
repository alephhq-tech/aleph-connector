import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@arcdio/cad-protocol'
import { entityListParams } from '@arcdio/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { textResult } from './textResult.js'
import { guarded } from './toolError.js'

/**
 * Per-call execute timeout for a full-detail scan page: walking and bounding 2000 entities on a
 * cold multi-MB DWG exceeds the gateway's 15 s default (same reasoning as DRAWING_OPEN_TIMEOUT_MS).
 */
const CAD_SCAN_TIMEOUT_MS = 60_000

export function registerCadStateTools(server: McpServer, baseBridge: BridgeClient): void {
  const inputSchema = z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('scan'),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(2000).optional(),
      detail: z.enum(['summary', 'full']).optional(),
      layer: z.string().min(1).max(255).optional(),
      kind: entityListParams.shape.kind,
      handles: z.array(z.string()).optional(),
      documentName,
      instanceId
    }),
    z.object({
      operation: z.literal('changes'),
      afterSequence: z.number().int().min(0),
      // Same max as `scan`: portableInputSchema flattens the operation union, so a shared field
      // must carry an identical schema across operations. The changes feed only replays the
      // plugin's bounded ring, so 2000 events is cheap to return — no reason to cap it lower.
      limit: z.number().int().min(1).max(2000).optional(),
      documentName,
      instanceId
    })
  ])

  server.registerTool(
    'cad',
    {
      title: 'CAD State (scan, changes)',
      description:
        `Read-only transport for Aleph Cloud's CAD State Engine. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `scan returns one bounded page of the model-space inventory (handle/kind/layer/bounds/text per entity, ` +
        `plus the layer/xref/layout manifests on the first page) with the drawing revision read BEFORE and AFTER the page walk; ` +
        `Cloud assembles a versioned snapshot from paged scans instead of the agent paging entity.list/entity.get. ` +
        `revisionBefore != revisionAfter means the drawing moved mid-page and the page is discarded, never committed. ` +
        `changes returns the plugin's change feed after afterSequence (created/modified/erased handles plus a monotonic sequence); ` +
        `earliestSequence > afterSequence + 1 reports dropped events, which forces a reconcile rather than a partial delta. ` +
        `These calls exist for the Cloud engine's indexing pipeline — a normal question about a drawing should read the ` +
        `already-built index (cad_state_query), not run a manual scan. Optional documentName targets another open tab; ` +
        `optional instanceId targets another AutoCAD process when 2+ are online.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    guarded(async (input, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      switch (input.operation) {
        case 'scan':
          return textResult(
            await bridge.request(
              RpcMethod.CadScan,
              {
                offset: input.offset,
                limit: input.limit,
                detail: input.detail,
                layer: input.layer,
                kind: input.kind,
                handles: input.handles,
                documentName: input.documentName
              },
              { timeoutMs: CAD_SCAN_TIMEOUT_MS, signal: ctx.mcpReq.signal }
            )
          )
        case 'changes':
          return textResult(
            await bridge.request(RpcMethod.CadChanges, {
              afterSequence: input.afterSequence,
              limit: input.limit,
              documentName: input.documentName
            })
          )
      }
    })
  )
}
