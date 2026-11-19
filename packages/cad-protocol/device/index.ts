/**
 * WSS Device Protocol layer: the envelope exchanged between device-gateway (TypeScript) and bridge
 * (C#) over the persistent `wss://.../device` connection. Types come from
 *
 * @arcdio/device-protocol (hand-authored mirror of ../schemas/device-protocol.schema.json —
 * see that file's header for why it isn't tool-generated). This module adds the one thing generated
 * code can't: runtime validation of frames actually crossing the wire against the schema.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

const addFormats = addFormatsModule.default ?? addFormatsModule
import type { DeviceMessage, ProtocolVersion } from '@arcdio/device-protocol'

export * from '@arcdio/device-protocol'

/** Device protocol versions this repo's Device Gateway and Bridge currently negotiate. */
export const DEVICE_PROTOCOL_VERSION: ProtocolVersion = { min: 1, max: 1 }

const schemaPath = fileURLToPath(new URL('../schemas/device-protocol.schema.json', import.meta.url))
const schema: object = JSON.parse(readFileSync(schemaPath, 'utf8'))

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
