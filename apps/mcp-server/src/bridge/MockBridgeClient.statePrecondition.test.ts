import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * #413 phase B — per-entity write-set precondition. Mirrors the plugin's
 * CadOperationScheduler.PruneStateConflicts semantics: a stale expectedState digest skips ONLY the
 * offending handle inside the batch's transaction; every other write proceeds, and the skips are
 * reported in result.conflicts. Omitted expectation = opt-out, exactly like phase A's
 * expectedRevision.
 */
async function setup() {
  const bridge = new MockBridgeClient()
  const made = await bridge.request(RpcMethod.OperationsApply, {
    operations: [
      { op: 'create', entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 } },
      { op: 'create', entity: { kind: 'circle', center: { x: 10, y: 0, z: 0 }, radius: 2 } },
      { op: 'create', entity: { kind: 'circle', center: { x: 20, y: 0, z: 0 }, radius: 3 } }
    ]
  })
  expect(made.status).toBe('committed')
  const handles = made.entityRefs.map((e) => e.handle)
  return { bridge, handles }
}

async function digest(bridge: MockBridgeClient, handle: string): Promise<string> {
  const got = await bridge.request(RpcMethod.EntityGet, { handle, detail: 'full' })
  expect(got.stateDigest).toBeString()
  return got.stateDigest!
}

describe('operations.apply expectedState precondition (#413 phase B)', () => {
  test('entity.get detail:"full" carries a stable stateDigest; summary does not', async () => {
    const { bridge, handles } = await setup()
    const first = await digest(bridge, handles[0]!)
    const again = await digest(bridge, handles[0]!)
    expect(first).toBe(again)
    const summary = await bridge.request(RpcMethod.EntityGet, { handle: handles[0]! })
    expect(summary.stateDigest).toBeUndefined()
    // A different entity digests differently.
    expect(await digest(bridge, handles[1]!)).not.toBe(first)
  })

  test('omitted expectedState: behaves exactly as before', async () => {
    const { bridge, handles } = await setup()
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [{ op: 'erase', handles: [handles[0]!] }]
    })
    expect(result.status).toBe('committed')
    expect(result.conflicts).toBeUndefined()
  })

  test('matching digests: proceeds normally', async () => {
    const { bridge, handles } = await setup()
    const d0 = await digest(bridge, handles[0]!)
    const d1 = await digest(bridge, handles[1]!)
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [{ op: 'erase', handles: [handles[0]!, handles[1]!] }],
      expectedState: { [handles[0]!]: d0, [handles[1]!]: d1 }
    })
    expect(result.status).toBe('committed')
    expect(result.conflicts).toBeUndefined()
    const list = await bridge.request(RpcMethod.EntityList, {})
    expect(list.entities).toHaveLength(1)
  })

  test('one stale handle among several: only it is skipped, reported with expected/actual', async () => {
    const { bridge, handles } = await setup()
    const d0 = await digest(bridge, handles[0]!)
    const d1Before = await digest(bridge, handles[1]!)
    // A concurrent edit moves handle[1]'s state (mirrors the user nudging it in AutoCAD).
    await bridge.request(RpcMethod.EntityTransform, {
      op: 'move',
      handles: [handles[1]!],
      delta: { x: 5, y: 0, z: 0 }
    })
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [{ op: 'erase', handles: [handles[0]!, handles[1]!, handles[2]!] }],
      expectedState: {
        [handles[0]!]: d0,
        [handles[1]!]: d1Before,
        [handles[2]!]: await digest(bridge, handles[2]!)
      }
    })
    expect(result.status).toBe('committed')
    const conflict = result.conflicts?.[0]
    expect(result.conflicts).toHaveLength(1)
    expect(conflict?.handle).toBe(handles[1])
    expect(conflict?.expected).toBe(d1Before)
    expect(conflict?.actual).toBe(await digest(bridge, handles[1]!))
    expect(conflict?.reason).toBe('state_conflict')
    // The two fresh handles erased; the stale one untouched.
    const list = await bridge.request(RpcMethod.EntityList, {})
    expect(list.entities.map((e) => e.handle)).toEqual([handles[1]])
  })

  test('update op: stale digest skips only that update', async () => {
    const { bridge, handles } = await setup()
    const stale = '0'.repeat(16)
    await bridge.request(RpcMethod.LayerCreate, { name: 'WALLS' })
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        { op: 'update', update: { handle: handles[0]!, layer: 'WALLS' } },
        { op: 'update', update: { handle: handles[1]!, layer: 'WALLS' } }
      ],
      expectedState: { [handles[0]!]: stale }
    })
    expect(result.status).toBe('committed')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts![0]!.handle).toBe(handles[0])
    const h0 = await bridge.request(RpcMethod.EntityGet, { handle: handles[0]! })
    const h1 = await bridge.request(RpcMethod.EntityGet, { handle: handles[1]! })
    expect(h0.entity.layer).not.toBe('WALLS')
    expect(h1.entity.layer).toBe('WALLS')
    expect(result.entityRefs).toHaveLength(1) // the skipped update reported no ref
  })

  test('transform op: stale handle is not moved; siblings still are', async () => {
    const { bridge, handles } = await setup()
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [
        {
          op: 'transform',
          transform: {
            op: 'move',
            handles: [handles[0]!, handles[1]!],
            delta: { x: 100, y: 0, z: 0 }
          }
        }
      ],
      expectedState: { [handles[1]!]: 'f'.repeat(16) }
    })
    expect(result.status).toBe('committed')
    expect(result.conflicts).toHaveLength(1)
    const c0 = (await bridge.request(RpcMethod.EntityGet, { handle: handles[0]!, detail: 'full' }))
      .entity
    const c1 = (await bridge.request(RpcMethod.EntityGet, { handle: handles[1]!, detail: 'full' }))
      .entity
    expect('geometry' in c0 ? c0.geometry : null).toEqual({
      center: { x: 100, y: 0, z: 0 },
      radius: 1
    })
    expect('geometry' in c1 ? c1.geometry : null).toEqual({
      center: { x: 10, y: 0, z: 0 },
      radius: 2
    })
  })

  test('handle no longer exists: not reported as a state conflict, skipped silently as before', async () => {
    const { bridge, handles } = await setup()
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [{ op: 'erase', handles: ['DEADBEEF'] }],
      expectedState: { DEADBEEF: 'abc' }
    })
    expect(result.status).toBe('committed')
    expect(result.conflicts).toBeUndefined()
  })

  test('unrelated map key (never touched by any op) is ignored', async () => {
    const { bridge, handles } = await setup()
    const result = await bridge.request(RpcMethod.OperationsApply, {
      operations: [{ op: 'erase', handles: [handles[0]!] }],
      expectedState: { [handles[2]!]: 'bad'.repeat(5) + 'b' }
    })
    expect(result.status).toBe('committed')
    expect(result.conflicts).toBeUndefined()
    const list = await bridge.request(RpcMethod.EntityList, {})
    expect(list.entities).toHaveLength(2)
  })
})
