import type { ServerWebSocket } from 'bun'
import type { Capabilities } from '@arcdio/cad-protocol'

export interface DeviceSocketData {
  deviceId: string
}

export interface DeviceConnection {
  deviceId: string
  ws: ServerWebSocket<DeviceSocketData>
  bridgeVersion: string
  protocol: number
  capabilities: Capabilities
  lastSeenAt: number
  /** RequestIds this connection currently owes a `capability.result` for — failed on disconnect. */
  pendingRequestIds: Set<string>
}

/**
 * Live Bridge connections, keyed by deviceId. See AUTOCAD_MCP_PROJECT.md section 7, "Device
 * Registry".
 */
export class DeviceRegistry {
  private readonly byDeviceId = new Map<string, DeviceConnection>()

  /** Registers `connection`, replacing any existing one for its deviceId; returns the replaced
   * connection (the caller must fail its pending requests and close its socket). */
  upsert(connection: DeviceConnection): DeviceConnection | undefined {
    const previous = this.byDeviceId.get(connection.deviceId)
    this.byDeviceId.set(connection.deviceId, connection)
    return previous
  }

  get(deviceId: string): DeviceConnection | undefined {
    return this.byDeviceId.get(deviceId)
  }

  /**
   * Removes the connection for `deviceId` ONLY when it is the one backed by `ws` — a stale
   * socket's close/drop must never evict the connection that replaced it.
   */
  remove(deviceId: string, ws: ServerWebSocket<DeviceSocketData>): DeviceConnection | undefined {
    const current = this.byDeviceId.get(deviceId)
    if (!current || current.ws !== ws) return undefined
    this.byDeviceId.delete(deviceId)
    return current
  }

  list(): DeviceConnection[] {
    return [...this.byDeviceId.values()]
  }

  /** Removes and returns every connection whose last inbound frame is older than `timeoutMs`. */
  sweepStale(timeoutMs: number): DeviceConnection[] {
    const cutoff = Date.now() - timeoutMs
    const stale = this.list().filter((connection) => connection.lastSeenAt < cutoff)
    for (const connection of stale) this.byDeviceId.delete(connection.deviceId)
    return stale
  }
}
