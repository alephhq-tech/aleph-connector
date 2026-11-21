import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { portableInputSchema } from './portableSchema.js'
import { instanceId } from './shared.js'
import { textResult } from './textResult.js'
import { guarded } from './toolError.js'

export function registerSystemTools(server: McpServer, baseBridge: BridgeClient): void {
  server.registerTool(
    'system',
    {
      title: 'AutoCAD plugin status',
      description:
        'Diagnostics for the AutoCAD plugin behind this session. operation: status — AutoCAD ' +
        'and plugin versions, process id, active document, pipe uptime. Optional instanceId ' +
        'targets a specific AutoCAD process when 2+ are online (see context).',
      inputSchema: portableInputSchema(z.object({ operation: z.literal('status'), instanceId })),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    guarded(async (input) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      return textResult(await bridge.request(RpcMethod.SystemStatus, {}))
    })
  )
}
