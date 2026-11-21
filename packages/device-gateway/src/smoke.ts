import assert from 'node:assert/strict'
import {
  DEVICE_PROTOCOL_VERSION,
  encodeDeviceMessage,
  isHelloAck,
  parseDeviceMessage,
  type CapabilityExecuteMessage,
  type DeviceMessage
} from '@aleph-connector/cad-protocol'
import type { DeviceAuthenticator } from './auth/DeviceAuthenticator.js'
import { DeviceGatewayService } from './DeviceGatewayService.js'
import { serveGateway } from './serve.js'

const TOKEN = 'smoke-device-token'
const authenticator: DeviceAuthenticator = {
  authenticate: async (deviceId, token) =>
    deviceId === 'device_pc_01' && token === TOKEN ? deviceId : null
}

async function main(): Promise<void> {
  const gateway = new DeviceGatewayService(
    {
      devicePath: '/device',
      helloTimeoutMs: 2000,
      defaultExecuteTimeoutMs: 5000,
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 90_000
    },
    authenticator
  )

  const server = serveGateway(gateway, { port: 0 })
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/device?deviceId=device_pc_01&token=${TOKEN}`
  )
  const opened = Promise.withResolvers<void>()
  ws.addEventListener('open', () => opened.resolve())
  ws.addEventListener('error', opened.reject)
  await opened.promise

  ws.send(
    encodeDeviceMessage({
      type: 'hello',
      deviceId: 'device_pc_01',
      bridgeVersion: '0.1.0',
      protocol: DEVICE_PROTOCOL_VERSION,
      capabilities: {
        autocad: {
          instances: [
            {
              instanceId: 'acad_18244',
              processId: 18244,
              status: 'online',
              autocadVersion: '2024',
              pluginVersion: '0.1.0',
              protocol: 1,
              activeDocument: 'building.dwg'
            }
          ]
        }
      }
    })
  )

  const ack = await nextMessage(ws)
  assert.ok(isHelloAck(ack))
  assert.equal(ack.status, 'compatible')

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : ''
    if (!raw) return
    const message = parseDeviceMessage(raw)
    if (message.type !== 'capability.execute') return
    const exec: CapabilityExecuteMessage = message
    ws.send(
      encodeDeviceMessage({
        type: 'capability.result',
        requestId: exec.requestId,
        status: 'success',
        result: { ok: true, method: exec.operation.type }
      })
    )
  })

  const result = await gateway.execute({
    deviceId: 'device_pc_01',
    capability: 'autocad',
    instanceId: 'acad_18244',
    operation: { type: 'system.status', arguments: {} }
  })
  assert.deepEqual(result, { status: 'success', result: { ok: true, method: 'system.status' } })

  ws.close()
  gateway.stopHeartbeatSweep()
  await server.stop()
  console.log('device-gateway smoke: ok')
}

async function nextMessage(ws: WebSocket): Promise<DeviceMessage> {
  const message = Promise.withResolvers<DeviceMessage>()
  ws.addEventListener(
    'message',
    (event) => {
      const raw = typeof event.data === 'string' ? event.data : ''
      if (!raw) return message.reject(new Error('Expected a text WebSocket frame.'))
      message.resolve(parseDeviceMessage(raw))
    },
    { once: true }
  )
  ws.addEventListener('error', message.reject, { once: true })
  return message.promise
}

await main()
