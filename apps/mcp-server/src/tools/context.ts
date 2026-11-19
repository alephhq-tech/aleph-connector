import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { DeviceGateway } from '@arcdio/device-contracts'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import type { DocumentPin, PinnedOpenDocument } from '../bridge/PinnedBridgeClient.js'
import { withInstance } from './instanceScope.js'
import { portableInputSchema } from './portableSchema.js'
import { instanceId } from './shared.js'
import { textResult } from './textResult.js'
import { describeToolError, guarded, type ToolErrorInfo } from './toolError.js'

/**
 * `cad.get_context` (AUTOCAD_MCP_PROJECT.md section 5): reports what this authenticated session is
 * actually connected to, before spending a tool call on real AutoCAD work — device online/offline,
 * Bridge version, and every AutoCAD instance this device has online (aleph-platform#4: previously
 * `deviceGateway.getContext()` silently picked one and showed only that, which is exactly what made
 * a 2nd instance invisible and `InstanceAmbiguous` a surprise on the very next tool call). Also
 * lists every open tab on the resolved/sole instance, so the model sees a reference drawing without
 * knowing to ask (#68).
 *
 * That tab read is still not fatal — the device may be offline, AutoCAD busy, no drawing open — but
 * its failure is now reported as `documentsError` instead of dropped. With no reason attached,
 * "Bridge online, no `documents`" was undiagnosable: a refused pipe (`-32025`), a busy AutoCAD, an
 * ambiguous 2-instance call and a genuinely empty process all looked identical, and the model
 * retried blind. `instanceId` also lets the caller say which instance's tabs to read.
 */
export function registerContextTools(
  server: McpServer,
  deviceGateway: DeviceGateway,
  bridge: BridgeClient,
  pin: DocumentPin,
  deviceId: string
): void {
  server.registerTool(
    'context',
    {
      title: 'Session context',
      description:
        "Call first: is this session's CadAI Bridge online, every AutoCAD instance it has online " +
        '(`instances[]`, with `instanceId`/version/active document each — 2+ means every other ' +
        'AutoCAD-touching tool needs an explicit `instanceId`), and every open drawing tab on the ' +
        'resolved instance (`documents`, with which one is active, which is pinned) — several tabs ' +
        'may be open there too, so check which one the user means. Pass `instanceId` to read a ' +
        "specific instance's tabs when 2+ are online; when `documents` is absent, `documentsError` " +
        'says why instead of leaving it unexplained.',
      inputSchema: portableInputSchema(z.object({ instanceId })),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    guarded(async (input) => {
      const devices = await deviceGateway.listDevices()
      const device = devices.find((d) => d.deviceId === deviceId) ?? null
      const instances = device?.capabilities.autocad?.instances ?? []
      // Kept for back-compat and as the "the" instance when there's exactly one — the single
      // source of truth for "which instance(s)" is `instances` above, never this field alone.
      // Same live/dead rule as `DeviceGatewayService`'s own (unexported) `isLive`: online or busy
      // both still route; only a stale/offline/error entry is skipped in favor of a live one.
      const autocad =
        instances.find((i) => i.status === 'online' || i.status === 'busy') ?? instances[0] ?? null
      let documents: PinnedOpenDocument[] | undefined
      let documentsError: ToolErrorInfo | undefined
      try {
        const listed = await withInstance(bridge, input.instanceId).request(
          RpcMethod.DrawingListOpen,
          {}
        )
        documents = pin.mark(listed.documents, input.instanceId)
      } catch (err) {
        documentsError = describeToolError(err)
      }
      return textResult({
        device,
        instances,
        autocad,
        ...(documents && { documents }),
        ...(documentsError && { documentsError })
      })
    })
  )
}
