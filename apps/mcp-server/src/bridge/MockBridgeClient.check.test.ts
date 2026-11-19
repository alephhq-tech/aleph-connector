import { expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

test('a clean drawing reports no findings', async () => {
  const bridge = new MockBridgeClient()
  await bridge.request(RpcMethod.LayerCreate, { name: 'A-WALL', color: { aci: 1 } })
  await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    layer: 'A-WALL',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  })
  const result = await bridge.request(RpcMethod.DrawingCheck, {})
  expect(result.findings).toEqual([])
})

test('a seeded drawing with one of each problem reports exactly those handles', async () => {
  const bridge = new MockBridgeClient()
  const { entity: dup1 } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  })
  const { entity: dup2 } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  })
  const { entity: zero } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 50, y: 50, z: 0 },
    end: { x: 50, y: 50, z: 0 }
  })
  await bridge.request(RpcMethod.LayerCreate, { name: 'A-WALL', color: { aci: 1 } })
  const { entity: openOutline } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'polyline',
    layer: 'A-WALL',
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 }
    ],
    closed: false
  })
  const { entity: dimBad } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'dimension.linear',
    extLine1: { x: 0, y: 0, z: 0 },
    extLine2: { x: 0, y: 10, z: 0 },
    dimLinePoint: { x: 5, y: 5, z: 0 },
    dimText: '999'
  })

  const result = await bridge.request(RpcMethod.DrawingCheck, {})
  const byCheck = Object.fromEntries(result.findings.map((f) => [f.check, f.handles]))

  expect(byCheck.duplicates).toEqual([dup1.handle, dup2.handle])
  expect(byCheck.zeroLength).toEqual([zero.handle])
  expect(byCheck.openOutlines).toEqual([openOutline.handle])
  expect(byCheck.dimOverride).toEqual([dimBad.handle])
  // layerZero includes every entity left on "0" — everything here except the A-WALL polyline.
  expect(byCheck.layerZero).toEqual(
    expect.arrayContaining([dup1.handle, dup2.handle, zero.handle, dimBad.handle])
  )
  expect(byCheck.layerZero).not.toContain(openOutline.handle)
})

test('scope filters to handles, a layer, or a window', async () => {
  const bridge = new MockBridgeClient()
  const { entity: inWindow } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 0, y: 0, z: 0 }
  })
  const { entity: outWindow } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 1000, y: 1000, z: 0 },
    end: { x: 1000, y: 1000, z: 0 }
  })

  const byHandle = await bridge.request(RpcMethod.DrawingCheck, {
    scope: { handles: [inWindow.handle] },
    checks: ['zeroLength']
  })
  expect(byHandle.findings[0]?.handles).toEqual([inWindow.handle])

  const byWindow = await bridge.request(RpcMethod.DrawingCheck, {
    scope: { window: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } } },
    checks: ['zeroLength']
  })
  expect(byWindow.findings[0]?.handles).toEqual([inWindow.handle])
  expect(byWindow.findings[0]?.handles).not.toContain(outWindow.handle)
})

test('check never mutates — entity count is unchanged after a call', async () => {
  const bridge = new MockBridgeClient()
  await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 0, y: 0, z: 0 }
  })
  const before = await bridge.request(RpcMethod.EntityList, {})
  await bridge.request(RpcMethod.DrawingCheck, {})
  const after = await bridge.request(RpcMethod.EntityList, {})
  expect(after.total).toBe(before.total)
})

test('cleanup dryRun changes nothing; dryRun:false actually erases', async () => {
  const bridge = new MockBridgeClient()
  await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  })
  await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  })

  const dry = await bridge.request(RpcMethod.DrawingCleanup, {
    fixes: ['duplicates'],
    dryRun: true
  })
  expect(dry.dryRun).toBe(true)
  expect(dry.applied[0]?.count).toBe(1)
  const stillThere = await bridge.request(RpcMethod.EntityList, {})
  expect(stillThere.total).toBe(2)

  const real = await bridge.request(RpcMethod.DrawingCleanup, {
    fixes: ['duplicates'],
    dryRun: false
  })
  expect(real.dryRun).toBe(false)
  expect(real.applied[0]?.count).toBe(1)
  const after = await bridge.request(RpcMethod.EntityList, {})
  expect(after.total).toBe(1)
})

test('cleanup defaults dryRun to true when omitted', async () => {
  const bridge = new MockBridgeClient()
  await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 50, y: 50, z: 0 },
    end: { x: 50, y: 50, z: 0 }
  })
  const result = await bridge.request(RpcMethod.DrawingCleanup, { fixes: ['zeroLength'] })
  expect(result.dryRun).toBe(true)
  const stillThere = await bridge.request(RpcMethod.EntityList, {})
  expect(stillThere.total).toBe(1)
})

test('cleanup with audit always fails the whole call, even mixed with other fixes', async () => {
  const bridge = new MockBridgeClient()
  await expect(bridge.request(RpcMethod.DrawingCleanup, { fixes: ['audit'] })).rejects.toThrow()
  await expect(
    bridge.request(RpcMethod.DrawingCleanup, { fixes: ['duplicates', 'audit'] })
  ).rejects.toThrow()
})

test('purge removes only unreferenced, non-reserved layers', async () => {
  const bridge = new MockBridgeClient()
  await bridge.request(RpcMethod.LayerCreate, { name: 'USED', color: { aci: 1 } })
  await bridge.request(RpcMethod.LayerCreate, { name: 'UNUSED', color: { aci: 2 } })
  await bridge.request(RpcMethod.EntityCreate, {
    kind: 'circle',
    layer: 'USED',
    center: { x: 0, y: 0, z: 0 },
    radius: 1
  })

  const result = await bridge.request(RpcMethod.DrawingCleanup, {
    fixes: ['purge'],
    dryRun: false
  })
  expect(result.applied[0]).toMatchObject({ fix: 'purge', count: 1 })
  const layers = await bridge.request(RpcMethod.LayerList, {})
  expect(layers.layers.map((l) => l.name)).toContain('USED')
  expect(layers.layers.map((l) => l.name)).toContain('0')
  expect(layers.layers.map((l) => l.name)).not.toContain('UNUSED')
})

test('cleanup skips non-CadAI entities for duplicates and zeroLength', async () => {
  const bridge = new MockBridgeClient()
  // User duplicate lines and zero-length line
  const userDup1 = bridge.seedUserEntity({
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  })
  const userDup2 = bridge.seedUserEntity({
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 }
  })
  const userZero = bridge.seedUserEntity({
    kind: 'line',
    start: { x: 50, y: 50, z: 0 },
    end: { x: 50, y: 50, z: 0 }
  })

  // CadAI duplicate lines and zero-length line
  const { entity: cadDup1 } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 100, y: 0, z: 0 },
    end: { x: 110, y: 0, z: 0 }
  })
  const { entity: cadDup2 } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 100, y: 0, z: 0 },
    end: { x: 110, y: 0, z: 0 }
  })
  const { entity: cadZero } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'line',
    start: { x: 200, y: 200, z: 0 },
    end: { x: 200, y: 200, z: 0 }
  })

  const result = await bridge.request(RpcMethod.DrawingCleanup, {
    fixes: ['duplicates', 'zeroLength'],
    dryRun: false
  })

  // Check what was applied
  const dupFix = result.applied.find((a) => a.fix === 'duplicates')
  const zeroFix = result.applied.find((a) => a.fix === 'zeroLength')
  expect(dupFix?.handles).toEqual([cadDup2.handle])
  expect(zeroFix?.handles).toEqual([cadZero.handle])

  // Check drawing contents: all 3 user entities survived!
  const remaining = await bridge.request(RpcMethod.EntityList, {})
  const remainingHandles = remaining.entities.map((e) => e.handle)
  expect(remainingHandles).toContain(userDup1.handle)
  expect(remainingHandles).toContain(userDup2.handle)
  expect(remainingHandles).toContain(userZero.handle)
  expect(remainingHandles).toContain(cadDup1.handle)
  expect(remainingHandles).not.toContain(cadDup2.handle)
  expect(remainingHandles).not.toContain(cadZero.handle)
})

test('cleanup purge skips user layers and only purges CadAI-created layers', async () => {
  const bridge = new MockBridgeClient()
  bridge.seedUserLayer('USER_UNUSED')
  await bridge.request(RpcMethod.LayerCreate, { name: 'CADAI_UNUSED', color: { aci: 3 } })

  const result = await bridge.request(RpcMethod.DrawingCleanup, {
    fixes: ['purge'],
    dryRun: false
  })

  expect(result.applied[0]).toMatchObject({ fix: 'purge', count: 1 })
  const layers = await bridge.request(RpcMethod.LayerList, {})
  const layerNames = layers.layers.map((l) => l.name)
  expect(layerNames).toContain('USER_UNUSED')
  expect(layerNames).not.toContain('CADAI_UNUSED')
})
