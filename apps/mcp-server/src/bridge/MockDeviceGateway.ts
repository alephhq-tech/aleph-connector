import type {
  DeviceContext,
  DeviceExecutionRequest,
  DeviceExecutionResult,
  DeviceGateway,
  DeviceSummary
} from '@arcdio/device-contracts'
import type { AutoCadInstance } from '@arcdio/cad-protocol'

/**
 * Fakes only the metadata surface of {@link DeviceGateway} (`getContext`, `listDevices`) for the
 * offline smoke test's `context` tool. `execute` is intentionally unused there — every RPC-shaped
 * tool call goes straight to {@link MockBridgeClient} — so it throws instead of silently faking a
 * result. Accepts one instance (the common case every existing caller passes) or several
 * (aleph-platform#4: lets a test exercise `context`'s `instances[]` with 2+ entries and
 * `getContext`'s own instanceId-disambiguation without needing a real multi-instance Bridge).
 */
export class MockDeviceGateway implements DeviceGateway {
  private readonly instances: AutoCadInstance[]

  constructor(
    private readonly deviceId: string,
    instances: AutoCadInstance | AutoCadInstance[]
  ) {
    this.instances = Array.isArray(instances) ? instances : [instances]
  }

  async execute(_request: DeviceExecutionRequest): Promise<DeviceExecutionResult> {
    throw new Error(
      'MockDeviceGateway.execute is unused by the offline smoke test; see MockBridgeClient.'
    )
  }

  async getContext(deviceId: string, instanceId?: string): Promise<DeviceContext> {
    if (deviceId !== this.deviceId) return null
    if (instanceId) return this.instances.find((i) => i.instanceId === instanceId) ?? null
    // Same live/dead preference as the real `DeviceGatewayService.getContext` (its own
    // `isLive`): online or busy before falling back to whatever's first.
    return (
      this.instances.find((i) => i.status === 'online' || i.status === 'busy') ??
      this.instances[0] ??
      null
    )
  }

  async listDevices(): Promise<DeviceSummary[]> {
    return [
      {
        deviceId: this.deviceId,
        online: true,
        bridgeVersion: '0.1.0-mock',
        capabilities: { autocad: { instances: this.instances } }
      }
    ]
  }
}
