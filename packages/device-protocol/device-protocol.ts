/**
 * GENERATED CONTRACT — mirrors contracts/protocol/schemas/device-protocol.schema.json
 * field-for-field. quicktype's JSON-Schema `oneOf` support flattens discriminated
 * unions into a single all-optional interface (verified, unusable for a wire
 * protocol), so this file is hand-authored instead of tool-generated. Treat the
 * schema as the source of truth: any change here MUST land in the same commit as
 * the matching schema edit and the matching generated/csharp/DeviceProtocol.cs edit.
 * Validated against the schema via contracts/protocol/schemas/fixtures/*.json —
 * see device-gateway's test suite.
 */

export interface ProtocolVersion {
  /** Oldest device protocol version this side can speak. */
  min: number
  /** Newest device protocol version this side can speak. */
  max: number
}

export type CapabilityStatus = 'online' | 'offline' | 'busy' | 'error'

export interface AutoCadInstance {
  /** Stable id for one running AutoCAD process, e.g. "acad_18244". */
  instanceId: string
  processId: number
  status: CapabilityStatus
  /** AutoCAD product version, e.g. "2024". */
  autocadVersion: string
  /** CadAI.AutoCAD.dll version currently loaded in this instance. */
  pluginVersion: string
  /** Local IPC protocol version the loaded plugin speaks. */
  protocol: number
  activeDocument: string | null
}

export interface Capabilities {
  autocad?: { instances: AutoCadInstance[] }
}

export interface ErrorEnvelope {
  code: number
  message: string
  data?: unknown
}

export interface HelloMessage {
  type: 'hello'
  deviceId: string
  bridgeVersion: string
  protocol: ProtocolVersion
  capabilities: Capabilities
}

export type HelloAckMessage =
  | { type: 'hello.ack'; status: 'compatible'; protocol: number; sessionId: string }
  | { type: 'hello.ack'; status: 'update_required'; minimumBridgeVersion: string }

export interface CapabilityUpdateMessage {
  type: 'capability.update'
  capability: 'autocad'
  instance: AutoCadInstance
}

export interface CapabilityExecuteTarget {
  capability: 'autocad'
  instanceId: string
}

export interface CapabilityOperation {
  /** Local IPC method name, e.g. "entity.create". */
  type: string
  /** Method-specific payload — validated by contracts/mcp-tools (send) and plugin DTOs (receive). */
  arguments: Record<string, unknown>
}

export interface CapabilityExecuteMessage {
  type: 'capability.execute'
  requestId: string
  target: CapabilityExecuteTarget
  operation: CapabilityOperation
  timeoutMs?: number
  /** W3C traceparent of the Cloud-side span wrapping this round trip — log-correlation only, the Bridge does not link a span to it. */
  traceparent?: string
}

export interface CapabilityCancelMessage {
  type: 'capability.cancel'
  /** The capability.execute requestId to cancel — see the schema's description for when this is sent and what it does. */
  requestId: string
}

export type CapabilityResultMessage =
  | {
      type: 'capability.result'
      requestId: string
      status: 'success'
      result: Record<string, unknown>
    }
  | { type: 'capability.result'; requestId: string; status: 'error'; error: ErrorEnvelope }

export interface HeartbeatMessage {
  type: 'heartbeat'
  role: 'ping' | 'pong'
  /** ISO-8601 timestamp. */
  timestamp: string
}

/** Every frame that can cross the Device Gateway <-> Bridge WSS connection, either direction. */
export type DeviceMessage =
  | HelloMessage
  | HelloAckMessage
  | CapabilityUpdateMessage
  | CapabilityExecuteMessage
  | CapabilityCancelMessage
  | CapabilityResultMessage
  | HeartbeatMessage

export function isHello(msg: DeviceMessage): msg is HelloMessage {
  return msg.type === 'hello'
}
export function isHelloAck(msg: DeviceMessage): msg is HelloAckMessage {
  return msg.type === 'hello.ack'
}
export function isCapabilityUpdate(msg: DeviceMessage): msg is CapabilityUpdateMessage {
  return msg.type === 'capability.update'
}
export function isCapabilityExecute(msg: DeviceMessage): msg is CapabilityExecuteMessage {
  return msg.type === 'capability.execute'
}
export function isCapabilityCancel(msg: DeviceMessage): msg is CapabilityCancelMessage {
  return msg.type === 'capability.cancel'
}
export function isCapabilityResult(msg: DeviceMessage): msg is CapabilityResultMessage {
  return msg.type === 'capability.result'
}
export function isHeartbeat(msg: DeviceMessage): msg is HeartbeatMessage {
  return msg.type === 'heartbeat'
}
