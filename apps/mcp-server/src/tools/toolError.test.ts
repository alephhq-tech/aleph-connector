import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError } from '@arcdio/cad-protocol'
import { DeviceGatewayError, GatewayErrorCode } from '@arcdio/device-contracts'
import { describeToolError, toolErrorResult } from './toolError.js'

describe('describeToolError', () => {
  test.each(Object.entries(BridgeErrorCode))('plugin %s has a name and a hint', (name, code) => {
    const info = describeToolError(new BridgeRpcError(code, 'boom'))
    expect(info).toMatchObject({ code, name, message: 'boom' })
    expect(info.hint?.length).toBeGreaterThan(20)
  })

  test.each(Object.entries(GatewayErrorCode))('gateway %s has a name and a hint', (name, code) => {
    const info = describeToolError(new DeviceGatewayError(code, 'boom'))
    expect(info).toMatchObject({ code, name, message: 'boom' })
    expect(info.hint?.length).toBeGreaterThan(20)
  })

  test('only BridgeBusy is marked retryable among BridgeErrorCodes', () => {
    const retryable = Object.values(BridgeErrorCode).filter(
      (code) => describeToolError(new BridgeRpcError(code, 'x')).retryable
    )
    expect(retryable).toEqual([BridgeErrorCode.BridgeBusy])
  })

  test('RequestTimeout is retryable (#9) — idempotencyKey makes a retry return the original result instead of duplicating it', () => {
    expect(
      describeToolError(new DeviceGatewayError(GatewayErrorCode.RequestTimeout, 'x')).retryable
    ).toBe(true)
  })

  test('unknown codes and plain errors still produce a usable result', () => {
    expect(describeToolError(new BridgeRpcError(-32999, 'odd'))).toMatchObject({
      name: 'UnknownBridgeError(-32999)',
      retryable: false
    })
    expect(describeToolError(new Error('plain'))).toEqual({
      name: 'Error',
      message: 'plain',
      retryable: false
    })
  })
})

test('toolErrorResult is an isError result with the same data as text and structured content', () => {
  const result = toolErrorResult(new BridgeRpcError(BridgeErrorCode.LayerNotFound, 'no A-WALL'))
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent)
  expect(result.structuredContent).toMatchObject({ error: { name: 'LayerNotFound' } })
})
