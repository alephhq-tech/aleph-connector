import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/** The mock attaches paperHeight/height/annotative as debug-only extras (not EntityRef fields). */
type AnnotativeExtras = { annotative?: boolean; paperHeight?: number; height?: number }

describe('drawing.setup annotationScale / drawing.info (#74)', () => {
  test('a fresh document defaults to 1:1, unset by drawing.setup', async () => {
    const bridge = new MockBridgeClient()
    const info = await bridge.request(RpcMethod.DrawingInfo, {})
    expect(info.annotationScale).toBe('1:1')
  })

  test("annotationScale sets CANNOSCALE, read back from setup's own result and from drawing.info", async () => {
    const bridge = new MockBridgeClient()
    const setup = await bridge.request(RpcMethod.DrawingSetup, { annotationScale: '1:100' })
    expect(setup.annotationScale).toBe('1:100')
    const info = await bridge.request(RpcMethod.DrawingInfo, {})
    expect(info.annotationScale).toBe('1:100')
  })
})

describe('annotative mtext/text.singleLine paperHeight -> model height (#74)', () => {
  test('2.5mm paperHeight at 1:100 computes to 250 drawing units', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { annotationScale: '1:100' })
    const created = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'mtext',
      insertion: { x: 0, y: 0, z: 0 },
      text: 'NOTE',
      paperHeight: 2.5,
      annotative: true
    })
    const entity = created.entity as unknown as AnnotativeExtras
    expect(entity.height).toBe(250)
    expect(entity.paperHeight).toBe(2.5)
    expect(entity.annotative).toBe(true)
  })

  test('the same paperHeight computes to a different height at a different annotation scale', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { annotationScale: '1:50' })
    const created = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'text.singleLine',
      insertion: { x: 0, y: 0, z: 0 },
      text: 'NOTE',
      paperHeight: 2.5
    })
    const entity = created.entity as unknown as AnnotativeExtras
    expect(entity.height).toBe(125)
  })

  test('no paperHeight given -> the mock records no extra height (regression, backwards compatible)', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { annotationScale: '1:100' })
    const created = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'mtext',
      insertion: { x: 0, y: 0, z: 0 },
      text: 'NOTE',
      height: 250
    })
    const entity = created.entity as unknown as AnnotativeExtras
    expect(entity.paperHeight).toBeUndefined()
    expect(entity.height).toBeUndefined()
  })
})

describe('annotative default once drawing.setup has set an annotationScale (#74)', () => {
  test('entity.create defaults annotative to true for mtext/dimension/hatch after annotationScale is set', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { annotationScale: '1:100' })

    const dim = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'dimension.aligned',
      extLine1: { x: 0, y: 0, z: 0 },
      extLine2: { x: 100, y: 0, z: 0 },
      dimLinePoint: { x: 0, y: 20, z: 0 }
    })
    expect((dim.entity as unknown as AnnotativeExtras).annotative).toBe(true)

    const hatch = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'hatch',
      boundaryHandles: ['1']
    })
    expect((hatch.entity as unknown as AnnotativeExtras).annotative).toBe(true)
  })

  test('annotative stays false before any drawing.setup annotationScale call (backwards compatible)', async () => {
    const bridge = new MockBridgeClient()
    const created = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'mtext',
      insertion: { x: 0, y: 0, z: 0 },
      text: 'NOTE',
      height: 2.5
    })
    expect((created.entity as unknown as AnnotativeExtras).annotative).toBe(false)
  })

  test('an explicit annotative:false opts a single entity out of the document default', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.DrawingSetup, { annotationScale: '1:100' })
    const created = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'mtext',
      insertion: { x: 0, y: 0, z: 0 },
      text: 'NOTE',
      annotative: false
    })
    expect((created.entity as unknown as AnnotativeExtras).annotative).toBe(false)
  })
})
