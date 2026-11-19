import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import type { OpenDocumentInfo } from '@arcdio/cad-types'
import {
  DocumentPin,
  PinnedBridgeClient,
  PinnedDocumentGoneError,
  PinnedInstanceMismatchError
} from './PinnedBridgeClient.js'
import type { BridgeClient, BridgeRequestOptions } from './BridgeClient.js'

function row(documentId: string, name: string): OpenDocumentInfo {
  return {
    documentId,
    name,
    path: `C:/drawings/${name}.dwg`,
    isActive: false,
    modified: false
  }
}

/** Records the (method, options) each call reaches the transport with. */
class RecordingBridge implements BridgeClient {
  readonly calls: { method: RpcMethodName; options?: BridgeRequestOptions }[] = []

  async request<M extends RpcMethodName>(
    method: M,
    _params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    this.calls.push({ method, options })
    return {} as RpcMethodMap[M]['result']
  }

  async close(): Promise<void> {}
}

function pinned(instanceId: string | undefined): {
  bridge: PinnedBridgeClient
  inner: RecordingBridge
  pin: DocumentPin
} {
  const pin = new DocumentPin()
  pin.set({ documentId: 'doc_a1b2c3d4e5f6', name: 'floorplan.dwg', instanceId })
  const inner = new RecordingBridge()
  return { bridge: new PinnedBridgeClient(inner, pin), inner, pin }
}

describe('pin-to-instance binding (aleph-platform#331)', () => {
  test('an unscoped document call inherits the pinned instance', async () => {
    const { bridge, inner } = pinned('acad_2000')
    await bridge.request(RpcMethod.EntityList, {} as never)
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0]!.options?.instanceId).toBe('acad_2000')
  })

  test('a call that names a second instance without naming a document fails with a named reason', async () => {
    const { bridge, inner } = pinned('acad_2000')
    const err = await bridge
      .request(RpcMethod.EntityList, {} as never, { instanceId: 'acad_9000' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PinnedInstanceMismatchError)
    // It must not reach the transport at all — otherwise the pin's document id would be sent to the
    // other process and surface as a confusing DocumentNotFound.
    expect(inner.calls).toHaveLength(0)
  })

  test('naming another instance AND a document is allowed: deliberate cross-window work', async () => {
    const { bridge, inner } = pinned('acad_2000')
    await bridge.request(RpcMethod.DrawingInfo, { documentName: 'other.dwg' } as never, {
      instanceId: 'acad_9000'
    })
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0]!.options?.instanceId).toBe('acad_9000')
  })

  test("a pin taken with no instanceId keeps today's unscoped behaviour", async () => {
    const { bridge, inner } = pinned(undefined)
    await bridge.request(RpcMethod.EntityList, {} as never)
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0]!.options?.instanceId).toBeUndefined()
  })

  test('list_open inherits the pinned instance so the agent reads the window it is working in', async () => {
    const { bridge, inner } = pinned('acad_2000')
    await bridge.request(RpcMethod.DrawingListOpen, {})
    expect(inner.calls[0]!.method).toBe(RpcMethod.DrawingListOpen)
    expect(inner.calls[0]!.options?.instanceId).toBe('acad_2000')
  })
})

describe('pin revalidation against list_open (aleph-platform#331)', () => {
  test('a reload that drops the pinned documentId is proven gone, not retargeted', () => {
    const pin = new DocumentPin()
    pin.set({ documentId: 'doc_a1b2c3d4e5f6', name: 'floorplan.dwg', instanceId: 'acad_2000' })
    // CADAIRELOAD hands every open document a fresh id; the same tab now lists under a new one.
    const marked = pin.mark([row('doc_998877665544', 'floorplan.dwg')], 'acad_2000')
    expect(pin.provenGone).toBe(true)
    // The stale row is still not marked pinned, and the target survives so the next call fails loudly.
    expect(marked.some((d) => d.pinned)).toBe(false)
    expect(pin.target?.documentId).toBe('doc_a1b2c3d4e5f6')
  })

  test('a document still present keeps the pin live', () => {
    const pin = new DocumentPin()
    pin.set({ documentId: 'doc_a1b2c3d4e5f6', name: 'floorplan.dwg', instanceId: 'acad_2000' })
    const marked = pin.mark([row('doc_a1b2c3d4e5f6', 'floorplan.dwg')], 'acad_2000')
    expect(pin.provenGone).toBe(false)
    expect(marked.find((d) => d.documentId === 'doc_a1b2c3d4e5f6')!.pinned).toBe(true)
  })

  test('listing a DIFFERENT instance does not prove the pinned tab is gone', () => {
    const pin = new DocumentPin()
    pin.set({ documentId: 'doc_a1b2c3d4e5f6', name: 'floorplan.dwg', instanceId: 'acad_2000' })
    pin.mark([row('doc_111111111111', 'other.dwg')], 'acad_9000')
    expect(pin.provenGone).toBe(false)
  })

  test('a proven-gone pin fails with a named reason instead of sending the dead id', async () => {
    const { bridge, inner, pin } = pinned('acad_2000')
    pin.mark([row('doc_998877665544', 'floorplan.dwg')], 'acad_2000')
    const err = await bridge.request(RpcMethod.EntityList, {} as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PinnedDocumentGoneError)
    expect(inner.calls).toHaveLength(0)
  })

  test('re-taking the pin clears the gone flag', () => {
    const pin = new DocumentPin()
    pin.set({ documentId: 'doc_a1b2c3d4e5f6', name: 'floorplan.dwg', instanceId: 'acad_2000' })
    pin.mark([], 'acad_2000')
    expect(pin.provenGone).toBe(true)
    pin.set({ documentId: 'doc_newid00000', name: 'floorplan.dwg', instanceId: 'acad_2000' })
    expect(pin.provenGone).toBe(false)
  })
})
