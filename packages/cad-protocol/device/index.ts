/**
 * WSS Device Protocol layer: the envelope exchanged between device-gateway (TypeScript) and bridge
 * (C#) over the persistent `wss://.../device` connection. Types come from
 *
 * @aleph-connector/device-protocol (hand-authored mirror of ../schemas/device-protocol.schema.json —
 * see that file's header for why it isn't tool-generated). This module adds the one thing generated
 * code can't: runtime validation of frames actually crossing the wire against the schema.
 */
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

const addFormats = addFormatsModule.default ?? addFormatsModule
import type { DeviceMessage, ProtocolVersion } from '@aleph-connector/device-protocol'
// Static JSON import so `bun build --compile` embeds the schema in the sidecar exe;
// a runtime readFileSync path does not survive compilation.
import schemaJson from '../schemas/device-protocol.schema.json' with { type: 'json' }

export * from '@aleph-connector/device-protocol'

/** Device protocol versions this repo's Device Gateway and Bridge currently negotiate. */
export const DEVICE_PROTOCOL_VERSION: ProtocolVersion = { min: 1, max: 1 }

const schema: object = schemaJson

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validateDeviceMessage = ajv.compile<DeviceMessage>(schema)

export class DeviceMessageValidationError extends Error {
  constructor(public readonly issues: string) {
    super(`Device message failed schema validation: ${issues}`)
    this.name = 'DeviceMessageValidationError'
  }
}

/**
 * Parses and schema-validates one WSS text frame. Throws {@link DeviceMessageValidationError} on
 * mismatch.
 */
export function parseDeviceMessage(raw: string): DeviceMessage {
  const candidate: unknown = JSON.parse(raw)
  if (!validateDeviceMessage(candidate)) {
    throw new DeviceMessageValidationError(ajv.errorsText(validateDeviceMessage.errors))
  }
  return candidate
}

/**
 * Encodes one outgoing frame. Every send site in device-gateway/bridge-facing code funnels through
 * here.
 */
export function encodeDeviceMessage(message: DeviceMessage): string {
  return JSON.stringify(message)
}
