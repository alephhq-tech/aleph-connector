import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@aleph-connector/cad-protocol'
import type { BridgeClient, BridgeRequestOptions } from '../bridge/BridgeClient.js'
import { verifyBlockFootprints } from './pcccRegion.js'

class PreviewBridge implements BridgeClient {
  readonly calls: Array<{ method: RpcMethodName; params: unknown; options?: BridgeRequestOptions }> = []

  constructor(
    private readonly result: RpcMethodMap[typeof RpcMethod.OperationsPreview]['result']
  ) {}

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    this.calls.push({ method, params, options })
    if (method !== RpcMethod.OperationsPreview) throw new Error(`unexpected RPC ${method}`)
    return this.result as RpcMethodMap[M]['result']
  }

  async close(): Promise<void> {}
}

const blockInsertInsideRegion = {
  op: 'create',
  entity: {
    kind: 'blockReference',
    blockName: 'SPRINKLER_HEAD',
    position: { x: 50, y: 50, z: 0 },
    scale: { x: 4, y: 4, z: 1 },
    rotation: 0
  }
}

describe('verifyBlockFootprints', () => {
  test('rejects an insertion whose actual scaled/rotated native extents leave the region', async () => {
    const bridge = new PreviewBridge({
      valid: true,
      operationCount: 1,
      entityRefs: [],
      extents: {
        min: { x: 40, y: 40, z: 0 },
        max: { x: 120, y: 60, z: 0 }
      }
    })

    const result = await verifyBlockFootprints(
      bridge,
      [blockInsertInsideRegion],
      [0, 0, 100, 100],
      'PCCC.dwg'
    )

    expect(result.status).toBe('outside')
    expect(result.bounds).toEqual([40, 40, 120, 60])
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.calls[0]!.method).toBe(RpcMethod.OperationsPreview)
    expect(bridge.calls[0]!.params).toMatchObject({ documentName: 'PCCC.dwg' })
    expect(bridge.calls[0]!.options?.timeoutMs).toBe(45_000)
  })

  test('does not trust an insertion point when native footprint extents are unavailable', async () => {
    const bridge = new PreviewBridge({ valid: false, operationCount: 1, entityRefs: [] })
    const result = await verifyBlockFootprints(
      bridge,
      [blockInsertInsideRegion],
      [0, 0, 100, 100],
      'PCCC.dwg'
    )

    expect(result.status).toBe('unverified')
    expect(result.reason).toBeDefined()
  })

  test('matches the synthetic layout fixture for a scaled and rotated inline block', async () => {
    const bridge = new PreviewBridge({ valid: true, operationCount: 0, entityRefs: [] })
    const insert = {
      op: 'create',
      entity: {
        kind: 'blockReference',
        blockName: 'TEST-FOOTPRINT',
        position: { x: 92, y: 50, z: 0 },
        scale: { x: 1, y: 2, z: 1 },
        rotation: Math.PI / 6
      }
    }
    const result = await verifyBlockFootprints(
      bridge,
      [insert],
      [0, 0, 100, 100],
      undefined,
      {
        inlineDefinitions: [{
          blockName: 'TEST-FOOTPRINT',
          entities: [{
            kind: 'polyline',
            closed: true,
            points: [
              { x: -20, y: -10, z: 0 },
              { x: 20, y: -10, z: 0 },
              { x: 20, y: 10, z: 0 },
              { x: -20, y: 10, z: 0 }
            ]
          }]
        }]
      }
    )

    expect(result.status).toBe('outside')
    expect(result.bounds?.[0]).toBeCloseTo(64.6794919243, 8)
    expect(result.bounds?.[1]).toBeCloseTo(22.6794919243, 8)
    expect(result.bounds?.[2]).toBeCloseTo(119.3205080757, 8)
    expect(result.bounds?.[3]).toBeCloseTo(77.3205080757, 8)
    expect(bridge.calls).toHaveLength(0)
  })

  test('fails closed for inline geometry with hidden or unsupported extents', async () => {
    const cases = [
      {
        blockName: 'BULGED',
        entity: {
          kind: 'polyline',
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          bulges: [1, 0]
        }
      },
      {
        blockName: 'WIDE',
        entity: {
          kind: 'polyline',
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          constantWidth: 4
        }
      },
      {
        blockName: 'VARIABLE-WIDTH',
        entity: {
          kind: 'polyline',
          points: [{ x: 0, y: 0, startWidth: 4 }, { x: 10, y: 0 }]
        }
      },
      {
        blockName: 'MULTILINE',
        entity: { kind: 'mtext', insertion: { x: 0, y: 0 }, text: 'line one\\nline two', height: 2, width: 10 }
      }
    ]
    for (const { blockName, entity } of cases) {
      const bridge = new PreviewBridge({ valid: true, operationCount: 0, entityRefs: [] })
      const result = await verifyBlockFootprints(
        bridge,
        [{ op: 'create', entity: { kind: 'blockReference', blockName, position: { x: 50, y: 50 } } }],
        [0, 0, 100, 100],
        undefined,
        { inlineDefinitions: [{ blockName, entities: [entity] }] }
      )
      expect(result.status).toBe('unverified')
      expect(result.reason).toContain('unsupported geometry or transform')
      expect(bridge.calls).toHaveLength(0)
    }
  })

  test('includes single-line text rotation in inline block bounds', async () => {
    const bridge = new PreviewBridge({ valid: true, operationCount: 0, entityRefs: [] })
    const result = await verifyBlockFootprints(
      bridge,
      [{
        op: 'create',
        entity: {
          kind: 'blockReference',
          blockName: 'ROTATED-TEXT',
          position: { x: 50, y: 90 },
          scale: { x: 1, y: 1, z: 1 },
          rotation: 0
        }
      }],
      [0, 0, 100, 100],
      undefined,
      {
        inlineDefinitions: [{
          blockName: 'ROTATED-TEXT',
          entities: [{
            kind: 'text.singleLine',
            insertion: { x: 0, y: 0 },
            text: 'ABCD',
            height: 2,
            rotation: Math.PI / 2
          }]
        }]
      }
    )

    expect(result.status).toBe('outside')
    expect(result.bounds?.[3]).toBeCloseTo(110, 8)
    expect(bridge.calls).toHaveLength(0)
  })

  test('does not call AutoCAD when there are no block references', async () => {
    const bridge = new PreviewBridge({ valid: true, operationCount: 0, entityRefs: [] })
    const result = await verifyBlockFootprints(
      bridge,
      [{ op: 'create', entity: { kind: 'line', start: { x: 5, y: 5 }, end: { x: 10, y: 10 } } }],
      [0, 0, 100, 100]
    )

    expect(result.status).toBe('none')
    expect(bridge.calls).toHaveLength(0)
  })
})
