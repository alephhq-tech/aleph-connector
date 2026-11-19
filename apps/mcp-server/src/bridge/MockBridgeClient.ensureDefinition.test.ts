import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

describe('block.ensureDefinition RPC (Slice 06 of pccc-cad-drawing-truth)', () => {
  test('builds a new block definition from inline entities, no source DWG involved', async () => {
    const bridge = new MockBridgeClient()
    const result = await bridge.request(RpcMethod.BlockEnsureDefinition, {
      blockName: 'ALEPH_PCCC_TEST_SYMBOL',
      entities: [
        { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 400 },
        { kind: 'text.singleLine', insertion: { x: -140, y: -175, z: 0 }, text: 'S', height: 350 }
      ]
    })
    expect(result.created).toBe(true)
    expect(result.handle).toBeTruthy()

    const list = await bridge.request(RpcMethod.BlockList, {})
    expect(list.blocks.some((b) => b.name === 'ALEPH_PCCC_TEST_SYMBOL')).toBe(true)
  })

  test('is idempotent: an existing block name is a no-op, entities are never re-applied', async () => {
    const bridge = new MockBridgeClient()
    const first = await bridge.request(RpcMethod.BlockEnsureDefinition, {
      blockName: 'ALEPH_PCCC_TEST_SYMBOL',
      entities: [{ kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 400 }]
    })
    expect(first.created).toBe(true)

    const second = await bridge.request(RpcMethod.BlockEnsureDefinition, {
      blockName: 'ALEPH_PCCC_TEST_SYMBOL',
      // Deliberately different entities: proves the second call never applies them.
      entities: [{ kind: 'circle', center: { x: 999, y: 999, z: 0 }, radius: 1 }]
    })
    expect(second.created).toBe(false)

    const list = await bridge.request(RpcMethod.BlockList, {})
    expect(list.blocks.filter((b) => b.name === 'ALEPH_PCCC_TEST_SYMBOL')).toHaveLength(1)
  })
})
