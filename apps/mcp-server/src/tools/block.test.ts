import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import { registerBlockTools } from './block.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import type { BridgeClient } from '../bridge/BridgeClient.js'

type BlockHandler = (
  input: unknown,
  ctx: { mcpReq: { id: number; signal?: AbortSignal } }
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>

function blockHandler(bridge: BridgeClient): BlockHandler {
  let handler!: BlockHandler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: BlockHandler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerBlockTools>[0]
  registerBlockTools(serverDouble, bridge)
  return handler
}

describe('block tool operations', () => {
  test('includeContents reaches the plugin, and is omitted when not asked', async () => {
    // The real defect this pins: the schema gained the flag but the handler's request object did
    // not forward it, so the plugin never saw it and `contents` was silently absent on live AutoCAD.
    const requested: Record<string, unknown>[] = []
    const spy: BridgeClient = {
      async request<M extends RpcMethodName>(
        method: M,
        params: RpcMethodMap[M]['params']
      ): Promise<RpcMethodMap[M]['result']> {
        if (method === RpcMethod.BlockInspect) {
          requested.push(params as unknown as Record<string, unknown>)
          return {
            name: 'MẶT BẰNG TẦNG HẦM',
            explodable: true,
            isDynamic: false,
            isAnonymous: false,
            isLayout: false,
            isXref: false,
            referenceCount: 1,
            contents: { entityCount: 4, kinds: ['blockReference:4'], texts: [], nestedBlocks: ['X'], truncated: false }
          } as RpcMethodMap[M]['result']
        }
        throw new Error(`unexpected ${method}`)
      },
      async close(): Promise<void> {}
    }
    const handler = blockHandler(spy)

    const withContents = await handler(
      { operation: 'inspect', blockName: 'MẶT BẰNG TẦNG HẦM', includeContents: true },
      { mcpReq: { id: 1 } }
    )
    expect(requested[0]!.includeContents).toBe(true)
    expect(JSON.parse(withContents.content[0]!.text).contents.entityCount).toBe(4)

    await handler({ operation: 'inspect', blockName: 'MẶT BẰNG TẦNG HẦM' }, { mcpReq: { id: 2 } })
    expect(requested[1]!.includeContents).toBeUndefined()
  })

  test('inspects a block definition by name', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    // Create a block reference to register the definition in the mock
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'DOOR_900',
      position: { x: 10, y: 10, z: 0 }
    })

    const res = await handler(
      { operation: 'inspect', blockName: 'DOOR_900' },
      { mcpReq: { id: 1 } }
    )

    expect(res.isError).toBeFalsy()
    const data = JSON.parse(res.content[0]!.text)
    expect(data.name).toBe('DOOR_900')
    expect(data.explodable).toBe(true)
    expect(data.referenceCount).toBe(1)
    expect(data.isLayout).toBe(false)
  })

  test('inspects a block definition by block reference handle and verifies layer status', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    // Create a locked layer and insert a block on it
    await bridge.request(RpcMethod.LayerCreate, { name: 'LOCKED_LAYER' })
    await bridge.request(RpcMethod.LayerSetProperties, {
      name: 'LOCKED_LAYER',
      locked: true
    })

    const resCreated = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'WINDOW_1200',
      layer: 'LOCKED_LAYER',
      position: { x: 50, y: 50, z: 0 }
    })

    const res = await handler(
      { operation: 'inspect', handle: resCreated.entity.handle },
      { mcpReq: { id: 2 } }
    )

    expect(res.isError).toBeFalsy()
    const data = JSON.parse(res.content[0]!.text)
    expect(data.name).toBe('WINDOW_1200')
    expect(data.handle).toBe(resCreated.entity.handle)
    expect(data.layer).toBe('LOCKED_LAYER')
    expect(data.layerLocked).toBe(true)
  })

  test('fails inspect when neither blockName nor handle is provided', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    const res = await handler({ operation: 'inspect' }, { mcpReq: { id: 3 } })

    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('Either blockName or handle must be provided')
  })

  test('fails inspect when block does not exist', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    const res = await handler(
      { operation: 'inspect', blockName: 'NON_EXISTENT_BLOCK' },
      { mcpReq: { id: 4 } }
    )

    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('BlockNotFound')
  })

  test('set_explodable refuses without sharedScope: true and reports SharedDefinitionScopeRequired', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'SHARED_DOOR',
      position: { x: 0, y: 0, z: 0 }
    })

    const refused = await handler(
      { operation: 'set_explodable', blockName: 'SHARED_DOOR', explodable: false },
      { mcpReq: { id: 4 } }
    )
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('SharedDefinitionScopeRequired')
  })

  test('set_explodable updates BlockTableRecord.Explodable when sharedScope: true', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    // Insert block (defaults to explodable: true in mock)
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'LOCKED_BLOCK',
      position: { x: 0, y: 0, z: 0 }
    })

    // Lock exploding (set to false) with sharedScope: true
    const lockRes = await handler(
      {
        operation: 'set_explodable',
        blockName: 'LOCKED_BLOCK',
        explodable: false,
        sharedScope: true
      },
      { mcpReq: { id: 5 } }
    )
    expect(lockRes.isError).toBeFalsy()
    const lockData = JSON.parse(lockRes.content[0]!.text)
    expect(lockData.success).toBe(true)
    expect(lockData.previousExplodable).toBe(true)
    expect(lockData.explodable).toBe(false)
    expect(lockData.changed).toBe(true)
    expect(lockData.affectedReferenceCount).toBe(1)

    // Verify inspect reflects explodable: false
    const inspect1 = await handler(
      { operation: 'inspect', blockName: 'LOCKED_BLOCK' },
      { mcpReq: { id: 6 } }
    )
    expect(JSON.parse(inspect1.content[0]!.text).explodable).toBe(false)

    // Unlock exploding (set to true)
    const unlockRes = await handler(
      {
        operation: 'set_explodable',
        blockName: 'LOCKED_BLOCK',
        explodable: true,
        sharedScope: true
      },
      { mcpReq: { id: 7 } }
    )
    expect(unlockRes.isError).toBeFalsy()
    const unlockData = JSON.parse(unlockRes.content[0]!.text)
    expect(unlockData.success).toBe(true)
    expect(unlockData.previousExplodable).toBe(false)
    expect(unlockData.explodable).toBe(true)
    expect(unlockData.changed).toBe(true)

    // Calling again with true should be idempotent (changed: false)
    const idempotentRes = await handler(
      {
        operation: 'set_explodable',
        blockName: 'LOCKED_BLOCK',
        explodable: true,
        sharedScope: true
      },
      { mcpReq: { id: 8 } }
    )
    expect(idempotentRes.isError).toBeFalsy()
    const idempotentData = JSON.parse(idempotentRes.content[0]!.text)
    expect(idempotentData.changed).toBe(false)
    expect(idempotentData.previousExplodable).toBe(true)
    expect(idempotentData.explodable).toBe(true)
  })
  test('set_explodable by block reference handle', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    const refCreated = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'EQUIPMENT_PUMP',
      position: { x: 0, y: 0, z: 0 }
    })

    const res = await handler(
      {
        operation: 'set_explodable',
        handle: refCreated.entity.handle,
        explodable: false,
        sharedScope: true
      },
      { mcpReq: { id: 9 } }
    )
    const data = JSON.parse(res.content[0]!.text)
    expect(data.blockName).toBe('EQUIPMENT_PUMP')
    expect(data.explodable).toBe(false)
    expect(data.changed).toBe(true)
  })

  test('set_explodable rejects modifying layout blocks', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    const res = await handler(
      { operation: 'set_explodable', blockName: '*Model_Space', explodable: true },
      { mcpReq: { id: 10 } }
    )

    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('cannot be modified')
  })

  test('lists block definitions with filtering', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'BLOCK_A',
      position: { x: 0, y: 0, z: 0 }
    })
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'BLOCK_B',
      position: { x: 10, y: 0, z: 0 }
    })

    // Default list excludes layouts
    const resDefault = await handler({ operation: 'list' }, { mcpReq: { id: 11 } })
    expect(resDefault.isError).toBeFalsy()
    const listDefault = JSON.parse(resDefault.content[0]!.text)
    const namesDefault = listDefault.blocks.map((b: { name: string }) => b.name)
    expect(namesDefault).toContain('BLOCK_A')
    expect(namesDefault).toContain('BLOCK_B')
    expect(namesDefault).not.toContain('*Model_Space')

    // Including layouts should include *Model_Space
    const resLayouts = await handler(
      { operation: 'list', includeLayouts: true },
      { mcpReq: { id: 12 } }
    )
    const listLayouts = JSON.parse(resLayouts.content[0]!.text)
    const namesLayouts = listLayouts.blocks.map((b: { name: string }) => b.name)
    expect(namesLayouts).toContain('*Model_Space')
  })

  test('explode refuses with SharedDefinitionScopeRequired when definition is not explodable', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    const { entity: ref } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'NON_EXPLODABLE',
      position: { x: 0, y: 0, z: 0 }
    })

    // Make definition non-explodable
    await bridge.request(RpcMethod.BlockSetExplodable, {
      blockName: 'NON_EXPLODABLE',
      explodable: false,
      sharedScope: true
    })

    const explodeRes = await handler(
      { operation: 'explode', handle: ref.handle },
      { mcpReq: { id: 11 } }
    )
    expect(explodeRes.isError).toBe(true)
    expect(explodeRes.content[0]!.text).toContain('SharedDefinitionScopeRequired')

    // Verify definition explodable flag was NOT mutated behind the user's back
    const inspect = await handler(
      { operation: 'inspect', blockName: 'NON_EXPLODABLE' },
      { mcpReq: { id: 12 } }
    )
    expect(JSON.parse(inspect.content[0]!.text).explodable).toBe(false)
  })

  test('uniquify isolates reference into dedicated definition and enables isolated explode', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    // Create 2 instances of SHARED_BLOCK
    const ref1 = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'SHARED_BLOCK',
      position: { x: 0, y: 0, z: 0 }
    })
    const ref2 = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'SHARED_BLOCK',
      position: { x: 10, y: 0, z: 0 }
    })

    // Make definition non-explodable
    await bridge.request(RpcMethod.BlockSetExplodable, {
      blockName: 'SHARED_BLOCK',
      explodable: false,
      sharedScope: true
    })

    // Uniquify ref1
    const uniqRes = await handler(
      { operation: 'uniquify', handle: ref1.entity.handle },
      { mcpReq: { id: 13 } }
    )
    expect(uniqRes.isError).toBeFalsy()
    const uniqData = JSON.parse(uniqRes.content[0]!.text)
    expect(uniqData.success).toBe(true)
    expect(uniqData.originalDefinitionName).toBe('SHARED_BLOCK')
    expect(uniqData.newDefinitionName).toContain('SHARED_BLOCK__CadAI_')
    expect(uniqData.referenceCountBefore).toBe(2)
    expect(uniqData.referenceCountAfter).toBe(1)

    // ref2 still points to original SHARED_BLOCK and cannot be exploded without sharedScope
    const explodeRef2 = await handler(
      { operation: 'explode', handle: ref2.entity.handle },
      { mcpReq: { id: 14 } }
    )
    expect(explodeRef2.isError).toBe(true)
    expect(explodeRef2.content[0]!.text).toContain('SharedDefinitionScopeRequired')

    // uniquified ref1 CAN be exploded (it has its own isolated definition)
    const explodeRef1 = await handler(
      { operation: 'explode', handle: ref1.entity.handle },
      { mcpReq: { id: 15 } }
    )
    expect(explodeRef1.isError).toBeFalsy()
    const explodeData = JSON.parse(explodeRef1.content[0]!.text)
    expect(explodeData.success).toBe(true)
    expect(explodeData.blockName).toBe(uniqData.newDefinitionName)
  })

  test('explode refuses with ProtectedEntity on pre-existing user block reference', async () => {
    const bridge = new MockBridgeClient()
    const handler = blockHandler(bridge)

    const userBlock = bridge.seedUserEntity({
      kind: 'blockReference',
      blockName: 'USER_BLOCK',
      position: { x: 0, y: 0, z: 0 }
    })

    const explodeRes = await handler(
      { operation: 'explode', handle: userBlock.handle },
      { mcpReq: { id: 20 } }
    )
    expect(explodeRes.isError).toBe(true)
    expect(explodeRes.content[0]!.text).toContain('ProtectedEntity')
    expect(explodeRes.content[0]!.text).toContain(userBlock.handle)
  })
})
