import { expect, test } from 'bun:test'
import type { DeviceExecutionRequest, DeviceGateway } from '@arcdio/device-contracts'
import { DeviceGatewayBridgeClient } from './DeviceGatewayBridgeClient.js'

/**
 * aleph-platform#4: this is the one real conduit between a tool's `instanceId` input and the
 * Device Gateway's `DeviceExecutionRequest.instanceId` — the thing every AutoCAD tool's
 * `instanceId` field ultimately has to reach for multi-instance routing to work at all. Verified
 * directly against a recording fake `DeviceGateway`, independent of the smoke/e2e harness's
 * separate `MockBridgeClient`/`MockDeviceGateway` (which model different, non-overlapping halves
 * of the stack and don't exercise this wiring — see MockDeviceGateway's own doc comment).
 */
function recordingGateway(): { gateway: DeviceGateway; requests: DeviceExecutionRequest[] } {
  const requests: DeviceExecutionRequest[] = []
  const gateway: DeviceGateway = {
    execute(request) {
      requests.push(request)
      return Promise.resolve({ status: 'success', result: {} })
    },
    getContext: () => Promise.resolve(null),
    listDevices: () => Promise.resolve([])
  }
  return { gateway, requests }
}

test('no instanceId option reaches the gateway as undefined (unchanged default)', async () => {
  const { gateway, requests } = recordingGateway()
  const client = new DeviceGatewayBridgeClient(gateway, 'device_pc_01')
  await client.request('drawing.info' as never, { documentName: 'A.dwg' } as never)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.instanceId).toBeUndefined()
  expect(requests[0]!.deviceId).toBe('device_pc_01')
})

test('an instanceId option is threaded through to DeviceExecutionRequest.instanceId', async () => {
  const { gateway, requests } = recordingGateway()
  const client = new DeviceGatewayBridgeClient(gateway, 'device_pc_01')
  await client.request('drawing.info' as never, {} as never, { instanceId: 'acad_18244' })
  expect(requests[0]!.instanceId).toBe('acad_18244')
})
