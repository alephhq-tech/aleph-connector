import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { EntityOperation } from '@arcdio/cad-protocol'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import {
  checkOperationsScope,
  resolveDrawingUnits,
  verifyPcccApply
} from './pcccVerify.js'

/**
 * Shared PCCC apply-time machinery (E9 scope gate + post-apply read-back): the unit pins
 * are here so neither tool can silently drift the gate or the verifier.
 */

const RING: Array<[number, number]> = [
  [0, 0],
  [12000, 0],
  [12000, 8000],
  [0, 8000]
]

function blockOp(x: number, y: number, blockName = 'SPRK_HEAD'): EntityOperation {
  return {
    op: 'create',
    entity: {
      kind: 'blockReference',
      blockName,
      position: { x, y, z: 0 },
      layer: 'FA-DEVICES'
    }
  } as unknown as EntityOperation
}

function lineOp(
  start: [number, number],
  end: [number, number]
): EntityOperation {
  return {
    op: 'create',
    entity: {
      kind: 'line',
      start: { x: start[0], y: start[1], z: 0 },
      end: { x: end[0], y: end[1], z: 0 },
      layer: 'FA-WIRING'
    }
  } as unknown as EntityOperation
}

describe('pccc scope gate (E9)', () => {
  test('a batch fully inside the inspected ring passes', () => {
    expect(
      checkOperationsScope([blockOp(6000, 4000), lineOp([1000, 1000], [11000, 7000])], [RING], {
        checkLines: true
      })
    ).toBeNull()
  })

  test('the first out-of-scope device refuses the whole batch, naming its point', () => {
    const violation = checkOperationsScope(
      [blockOp(6000, 4000), blockOp(15000, 4000), blockOp(2000, 2000)],
      [RING]
    )
    expect(violation).toContain('OUT_OF_SCOPE')
    expect(violation).toContain('[15000, 4000]')
    expect(violation).toContain('point 2 of 3')
  })

  test('a device exactly on the ring boundary passes within tolerance', () => {
    expect(checkOperationsScope([blockOp(12000, 4000)], [RING], { tolerance: 1 })).toBeNull()
  })

  test('an empty scope never passes a point', () => {
    expect(checkOperationsScope([blockOp(6000, 4000)], [])).toContain('OUT_OF_SCOPE')
  })

  test('a device whose position cannot be read refuses the batch instead of passing the gate', () => {
    const unreadable = {
      op: 'create',
      entity: { kind: 'blockReference', blockName: 'SPRK_HEAD', position: 'garbage', layer: '0' }
    } as unknown as EntityOperation
    const violation = checkOperationsScope([blockOp(6000, 4000), unreadable], [RING])
    expect(violation).toContain('OUT_OF_SCOPE')
    expect(violation).toContain('cannot be read')
  })

  test('exempt anchor blocks (panel, call point) are not gated', () => {
    expect(
      checkOperationsScope([blockOp(15000, 4000, 'JUNCTION_BOX')], [RING], {
        exemptBlockNames: ['JUNCTION_BOX', 'MANUAL_CALL_POINT']
      })
    ).toBeNull()
  })

  test('line endpoints are gated only when checkLines is set', () => {
    const ops = [lineOp([6000, 4000], [15000, 4000])]
    expect(checkOperationsScope(ops, [RING])).toBeNull()
    expect(checkOperationsScope(ops, [RING], { checkLines: true })).toContain('OUT_OF_SCOPE')
  })

  test('exempt points (e.g. the riser anchor) are skipped', () => {
    expect(
      checkOperationsScope([lineOp([6000, 4000], [15000, 4000])], [RING], {
        checkLines: true,
        exemptPoints: [[15000, 4000]]
      })
    ).toBeNull()
  })
})

describe('pccc post-apply read-back', () => {
  test('a batch that landed exactly as planned verifies faithful', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await bridge.request(RpcMethod.LayerCreate, { name: 'FA-DEVICES' })
    await bridge.request(RpcMethod.LayerCreate, { name: 'FA-WIRING' })
    const ops: EntityOperation[] = [blockOp(6000, 4000), lineOp([1000, 1000], [11000, 7000])]
    // Draw the batch the way OperationsApply would, then verify against the same ops.
    for (const op of ops) {
      await bridge.request(RpcMethod.EntityCreate, {
        ...((op as { entity: Record<string, unknown> }).entity as Record<string, unknown>)
      } as never)
    }
    const report = await verifyPcccApply(bridge, 'Drawing1.dwg', ops, 1000)
    expect(report.faithful).toBe(true)
    expect(report.stats.totalSteps).toBe(2)
    expect(report.stats.matchedSteps).toBe(2)
  })

  test('a planned device that never landed is reported missing, not committed', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    await bridge.request(RpcMethod.LayerCreate, { name: 'FA-DEVICES' })
    const ops: EntityOperation[] = [blockOp(6000, 4000), blockOp(2000, 2000)]
    // Only the first device is actually in the drawing.
    await bridge.request(RpcMethod.EntityCreate, {
      ...((ops[0]! as { entity: Record<string, unknown> }).entity as Record<string, unknown>)
    } as never)
    const report = await verifyPcccApply(bridge, 'Drawing1.dwg', ops, 1000)
    expect(report.faithful).toBe(false)
    expect(report.stats.matchedSteps).toBe(1)
    expect(report.stats.totalSteps).toBe(2)
    expect(report.discrepancies.join(' ')).toContain('MISSING')
  })

  test('an empty drawing fails the read-back instead of reporting a commit', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const report = await verifyPcccApply(bridge, 'Drawing1.dwg', [blockOp(6000, 4000)], 1000)
    expect(report.faithful).toBe(false)
    expect(report.stats.matchedSteps).toBe(0)
  })

  test('resolveDrawingUnits returns null for unitless drawings, mm for mm drawings', async () => {
    const bridge = new MockBridgeClient() as unknown as BridgeClient
    expect(await resolveDrawingUnits(bridge, 'Drawing1.dwg')).toBeNull()
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'mm' })
    const mm = await resolveDrawingUnits(bridge, 'Drawing1.dwg')
    expect(mm?.insUnits).toBe('mm')
    expect(mm?.unitsPerMetre).toBe(1000)
    await bridge.request(RpcMethod.DrawingSetup, { insUnits: 'm' })
    const m = await resolveDrawingUnits(bridge, 'Drawing1.dwg')
    expect(m?.insUnits).toBe('m')
    expect(m?.unitsPerMetre).toBe(1)
  })
})
