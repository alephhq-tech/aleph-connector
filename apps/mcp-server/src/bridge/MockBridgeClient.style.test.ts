import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

describe('style.linetypes', () => {
  test('Continuous is always loaded on a fresh document', async () => {
    const bridge = new MockBridgeClient()
    const { linetypes } = await bridge.request(RpcMethod.StyleLinetypesList, {})
    expect(linetypes.map((l) => l.name)).toEqual(['Continuous'])
  })

  test('load is idempotent: an already-loaded name is a no-op, not an error', async () => {
    const bridge = new MockBridgeClient()
    const first = await bridge.request(RpcMethod.StyleLinetypesLoad, { names: ['DASHED'] })
    expect(first).toEqual({ loaded: ['DASHED'], alreadyLoaded: [] })
    const second = await bridge.request(RpcMethod.StyleLinetypesLoad, { names: ['DASHED'] })
    expect(second).toEqual({ loaded: [], alreadyLoaded: ['DASHED'] })
  })
})

describe('style.textStyles', () => {
  test('Standard exists and is current on a fresh document', async () => {
    const bridge = new MockBridgeClient()
    const { textStyles } = await bridge.request(RpcMethod.StyleTextStylesList, {})
    expect(textStyles).toEqual([
      {
        name: 'Standard',
        font: 'txt.shx',
        height: 0,
        widthFactor: 1,
        obliqueAngle: 0,
        isCurrent: true,
        isTrueType: false,
        bold: false,
        italic: false,
        charSet: 0,
        pitchAndFamily: 0
      }
    ])
  })

  test('create on an existing name fails unless update: true', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.StyleTextStylesCreate, {
      name: 'TITLE',
      font: 'Arial.ttf',
      height: 0,
      widthFactor: 1,
      obliqueAngle: 0
    })
    await expect(
      bridge.request(RpcMethod.StyleTextStylesCreate, {
        name: 'TITLE',
        font: 'Arial.ttf',
        height: 0,
        widthFactor: 1,
        obliqueAngle: 0
      })
    ).rejects.toMatchObject({ code: BridgeErrorCode.StyleNameConflict })
    const updated = await bridge.request(RpcMethod.StyleTextStylesCreate, {
      name: 'TITLE',
      font: 'Arial.ttf',
      height: 5,
      widthFactor: 1,
      obliqueAngle: 0,
      update: true
    })
    expect(updated.created).toBe(false)
    expect(updated.textStyle.height).toBe(5)
  })

  test('setCurrent on an unknown name fails with StyleNotFound', async () => {
    const bridge = new MockBridgeClient()
    await expect(
      bridge.request(RpcMethod.StyleTextStylesSetCurrent, { name: 'NOPE' })
    ).rejects.toBeInstanceOf(BridgeRpcError)
  })
})

describe('style.dimStyles', () => {
  test('Standard exists and is current on a fresh document', async () => {
    const bridge = new MockBridgeClient()
    const { dimStyles } = await bridge.request(RpcMethod.StyleDimStylesList, {})
    expect(dimStyles).toHaveLength(1)
    expect(dimStyles[0]).toMatchObject({ name: 'Standard', isCurrent: true })
  })

  /**
   * #34 (E2E #6): the plugin never overrides dimension style per entity — entities created after
   * `dimStyles.setCurrent` pick up the ambient `Database.Dimstyle` automatically. This is the
   * mock's equivalent of that ambient state: `setCurrent` flips exactly one style's `isCurrent`
   * flag, and every later `list` call reflects it — the same "current name tracked" contract the
   * real plugin's `Database.Dimstyle` property provides.
   */
  test('setCurrent moves the ambient current dim style, tracked across subsequent list calls', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.StyleDimStylesCreate, {
      name: 'PLOT-1-100',
      textHeight: 250,
      arrowSize: 250,
      extensionOffset: 62.5,
      extensionBeyond: 125,
      decimalPlaces: 0,
      unitsFormat: 'architectural',
      scale: 100
    })
    await bridge.request(RpcMethod.StyleDimStylesSetCurrent, { name: 'PLOT-1-100' })
    const { dimStyles } = await bridge.request(RpcMethod.StyleDimStylesList, {})
    const current = dimStyles.filter((d) => d.isCurrent).map((d) => d.name)
    expect(current).toEqual(['PLOT-1-100'])
  })

  test('create with an unknown basedOn fails with StyleNotFound', async () => {
    const bridge = new MockBridgeClient()
    await expect(
      bridge.request(RpcMethod.StyleDimStylesCreate, {
        name: 'X',
        basedOn: 'NOPE',
        textHeight: 2.5,
        arrowSize: 2.5,
        extensionOffset: 0.625,
        extensionBeyond: 1.25,
        decimalPlaces: 4,
        unitsFormat: 'decimal',
        scale: 1
      })
    ).rejects.toMatchObject({ code: BridgeErrorCode.StyleNotFound })
  })
})
