import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * Idempotency key (#9, primary fix): a repeat `idempotencyKey` on a mutating call returns the
 * original result instead of re-executing — the fix for "a timed-out mutation still commits, so a
 * client retry duplicates entities". Pins `MockBridgeClient`'s `IdempotencyStore`: hit (same key,
 * same document -> stored result, no new entity), miss (no key, or a different key -> normal
 * execution), bounded LRU eviction, and — issue #388 §C, bullet 2 — a key that already stands for
 * one payload refuses a different one instead of silently answering with the stored result.
 * The real plugin's `Journal/IdempotencyCache.cs` enforces the same rules with the same
 * canonicalization; only the C# side needs AutoCAD/dotnet to exercise, so this is the side fully
 * proven here.
 */
describe('idempotency key (#9)', () => {
  test('miss: no idempotencyKey executes normally every time, one entity per call', async () => {
    const bridge = new MockBridgeClient()
    const a = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5
    })
    const b = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5
    })
    expect(a.entity.handle).not.toBe(b.entity.handle)
    const { entities, total } = await bridge.request(RpcMethod.EntityList, {})
    expect(total).toBe(2)
    expect(entities).toHaveLength(2)
  })

  test('hit: repeating the same idempotencyKey returns the original result, no second entity created', async () => {
    const bridge = new MockBridgeClient()
    const first = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 1, y: 2, z: 0 },
      radius: 5,
      idempotencyKey: 'retry-1'
    })
    const retry = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 1, y: 2, z: 0 },
      radius: 5,
      idempotencyKey: 'retry-1'
    })
    expect(retry).toEqual(first)
    const { total } = await bridge.request(RpcMethod.EntityList, {})
    expect(total).toBe(1)
  })

  test("a key reused with CHANGED parameters fails — it does not return the first call's result (issue #388 §C, bullet 2)", async () => {
    const bridge = new MockBridgeClient()
    const first = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 1, y: 2, z: 0 },
      radius: 5,
      idempotencyKey: 'retry-2'
    })
    // Answering this with `first` would report a radius-999 circle that was never drawn; running
    // it under the same key would corrupt the ledger that history/selective revert read back.
    await expect(
      bridge.request(RpcMethod.EntityCreate, {
        kind: 'circle',
        center: { x: 1, y: 2, z: 0 },
        radius: 999,
        idempotencyKey: 'retry-2'
      })
    ).rejects.toThrow(/already stands for a different set of parameters/)
    const { entities, total } = await bridge.request(RpcMethod.EntityList, {})
    expect(total).toBe(1)
    expect(entities).toHaveLength(1)
    expect(entities[0]!.handle).toBe(first.entity.handle)
  })

  test('a genuine retry still hits when only volatile envelope fields differ (a different view carries no identity)', async () => {
    const bridge = new MockBridgeClient()
    const first = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 1, y: 2, z: 0 },
      radius: 5,
      idempotencyKey: 'retry-volatile',
      view: { follow: 'pan' }
    })
    const retry = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 1, y: 2, z: 0 },
      radius: 5,
      idempotencyKey: 'retry-volatile',
      view: { follow: 'fit' }
    })
    expect(retry).toEqual(first)
    const { total } = await bridge.request(RpcMethod.EntityList, {})
    expect(total).toBe(1)
  })

  test('a different idempotencyKey is a miss — a genuinely new call, even with identical params', async () => {
    const bridge = new MockBridgeClient()
    const a = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5,
      idempotencyKey: 'key-a'
    })
    const b = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5,
      idempotencyKey: 'key-b'
    })
    expect(a.entity.handle).not.toBe(b.entity.handle)
  })

  test('idempotencyKey is scoped per document — the same key on a different open document ("Drawing2.dwg", pre-seeded by this mock) is a miss, not cross-document contamination', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5,
      idempotencyKey: 'shared-key'
    })
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 5,
      idempotencyKey: 'shared-key',
      documentName: 'Drawing2.dwg'
    })
    // Handles are per-document (both legitimately land on "1" — a separate counter per
    // document, not a cache hit), so assert the thing that actually proves no cross-document
    // contamination happened: each document really did execute its own create.
    const { total: doc1Total } = await bridge.request(RpcMethod.EntityList, {})
    const { total: doc2Total } = await bridge.request(RpcMethod.EntityList, {
      documentName: 'Drawing2.dwg'
    })
    expect(doc1Total).toBe(1)
    expect(doc2Total).toBe(1)
  })

  test('bounded LRU eviction: past the cap, the least-recently-used key is forgotten and a repeat of it executes again instead of hitting', async () => {
    const bridge = new MockBridgeClient()
    // Matches MAX_IDEMPOTENCY_ENTRIES_PER_DOCUMENT in MockBridgeClient.ts (and the real plugin's
    // mirrored cap) — fill the cache to exactly its limit with distinct keys, then one more to
    // force an eviction of the least-recently-used (key "0", touched first and never again).
    const cap = 200
    for (let i = 0; i < cap; i++) {
      await bridge.request(RpcMethod.EntityCreate, {
        kind: 'circle',
        center: { x: i, y: 0, z: 0 },
        radius: 1,
        idempotencyKey: `k${i}`
      })
    }
    const { total: afterFill } = await bridge.request(RpcMethod.EntityList, {})
    expect(afterFill).toBe(cap)

    // One more distinct key pushes the cache over its cap, evicting "k0" (the oldest / least
    // recently touched — none of the first `cap` keys were repeated above).
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 9999, y: 0, z: 0 },
      radius: 1,
      idempotencyKey: 'k-overflow'
    })

    // k0 was evicted: repeating it now is a MISS (executes again, creating a new entity) rather
    // than returning the long-gone cached result.
    const beforeRepeat = await bridge.request(RpcMethod.EntityList, {})
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      radius: 1,
      idempotencyKey: 'k0'
    })
    const afterRepeat = await bridge.request(RpcMethod.EntityList, {})
    expect(afterRepeat.total).toBe(beforeRepeat.total + 1)

    // A recently-touched key (the very last one stored, "k-overflow") is still a hit.
    const beforeRecentRepeat = await bridge.request(RpcMethod.EntityList, {})
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 9999, y: 0, z: 0 },
      radius: 1,
      idempotencyKey: 'k-overflow'
    })
    const afterRecentRepeat = await bridge.request(RpcMethod.EntityList, {})
    expect(afterRecentRepeat.total).toBe(beforeRecentRepeat.total)
  })
})
