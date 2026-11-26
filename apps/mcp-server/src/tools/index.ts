import type { McpServer } from '@modelcontextprotocol/server'
import type { DeviceGateway } from '@aleph-connector/device-contracts'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import type { DocumentPin } from '../bridge/PinnedBridgeClient.js'
import { registerConstructTools } from './construct.js'
import { registerContextTools } from './context.js'
import { registerDrawingTools } from './drawing.js'
import { registerEntityTools } from './entity.js'
import { registerLayerTools } from './layer.js'
import { registerOperationsTools } from './operations.js'
import { registerStyleTools } from './style.js'
import { registerSystemTools } from './system.js'
import { registerViewTools } from './view.js'
import { registerBlockTools } from './block.js'
import { registerCadStateTools } from './cadState.js'
import { registerEditTools } from './edit.js'
import { registerPcccOverlayTools } from './pcccOverlay.js'
import { registerPcccFireAlarmTools } from './pcccFireAlarm.js'
import { createCadStateSource } from './drawing.js'
import { createRegionCache } from './pcccRegion.js'
import { buildSnapshot } from '../local/snapshotBuilder.js'
import { localStore } from '../local/store.js'
export function registerAllTools(
  server: McpServer,
  bridge: BridgeClient,
  pin: DocumentPin,
  deviceGateway: DeviceGateway,
  deviceId: string,
  // Authenticated tenant, when the caller resolved one. Lets the drawing tool read that workspace's
  // CAD State snapshot; absent -> inspect geometry fails closed.
  workspaceId?: string
): void {
  registerContextTools(server, deviceGateway, bridge, pin, deviceId)
  registerSystemTools(server, bridge)
  // One CAD State seam for both tools that read plan geometry: `drawing.inspect_floorplan` publishes
  // room refs from it, `pccc_fire_alarm_overlay` resolves them through it. Separate sources could
  // disagree about what the drawing says.
  const store = localStore()
  const cadState = workspaceId
    ? createCadStateSource(
        workspaceId,
        bridge,
        store
          ? async (identity) =>
              identity.revision
                ? buildSnapshot(bridge, store, workspaceId, {
                    documentId: identity.documentId,
                    documentName: identity.documentName,
                    fingerprintGuid: identity.fingerprintGuid,
                    revision: identity.revision
                  })
                : null
          : undefined
      )
    : undefined
  // One region cache so inspect answers the next overlay preview without a second AutoCAD walk.
  const regionCache = createRegionCache()
  registerDrawingTools(server, bridge, pin, cadState, regionCache)
  registerLayerTools(server, bridge)
  registerEntityTools(server, bridge)
  registerOperationsTools(server, bridge)
  registerConstructTools(server, bridge)
  registerStyleTools(server, bridge)
  registerViewTools(server, bridge)
  registerBlockTools(server, bridge)
  registerCadStateTools(server, bridge)
  registerEditTools(server, bridge)
  registerPcccOverlayTools(server, bridge, cadState, regionCache)
  registerPcccFireAlarmTools(server, bridge, cadState, regionCache)
}
