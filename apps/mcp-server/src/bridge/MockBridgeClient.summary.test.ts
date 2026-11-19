import { describe, expect, test } from 'bun:test'
import { RpcMethod } from '@arcdio/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

/**
 * drawing.summary's block-attribute pass. A PCCC title block is a block reference whose project
 * name / drawing number / scale / date live in its AttributeReference children — model-space
 * iteration never surfaces them, so the old preview's "title blocks live in the text" claim was
 * false for exactly the drawings that matter. These pin the corrected contract on the mock's
 * mirror of the plugin's one pass: attributes land in `blockTexts` (tagged with the block name),
 * deduplicated per block name, blank fields skipped, and its own budget so a note-heavy drawing
 * can't crowd the title block out.
 */

async function insert(
  bridge: MockBridgeClient,
  blockName: string,
  attributes?: Record<string, string>
): Promise<string> {
  const { entity } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'blockReference',
    blockName,
    position: { x: 0, y: 0, z: 0 },
    attributes
  })
  return entity.handle
}

async function note(bridge: MockBridgeClient, text: string): Promise<string> {
  const { entity } = await bridge.request(RpcMethod.EntityCreate, {
    kind: 'mtext',
    text,
    insertion: { x: 0, y: 0, z: 0 }
  })
  return entity.handle
}

describe('drawing.summary blockTexts (title-block attributes)', () => {
  test("a title block's attribute values reach the summary, tagged with their block", async () => {
    const bridge = new MockBridgeClient()
    await insert(bridge, 'TITLEBLOCK_A1', {
      PROJECT_NAME: 'Nhà máy A',
      DRAWING_NO: 'PCCC-A1-01',
      SCALE: '1:100'
    })

    const summary = await bridge.request(RpcMethod.DrawingSummary, {})
    expect(summary.blockTexts).toEqual([
      { text: 'Nhà máy A', layer: expect.any(String), block: 'TITLEBLOCK_A1' },
      { text: 'PCCC-A1-01', layer: expect.any(String), block: 'TITLEBLOCK_A1' },
      { text: '1:100', layer: expect.any(String), block: 'TITLEBLOCK_A1' }
    ])
    // The attributes are not free-standing model-space text — they must not leak into `texts`.
    expect(summary.texts).toEqual([])
    expect(summary.textsHasMore).toBe(false)
  })

  test('free-standing text keeps its own list and never carries a block tag', async () => {
    const bridge = new MockBridgeClient()
    await note(bridge, 'Cửa đi mở ra ngoài')

    const summary = await bridge.request(RpcMethod.DrawingSummary, {})
    expect(summary.texts).toEqual([{ text: 'Cửa đi mở ra ngoài', layer: expect.any(String) }])
    expect(summary.blockTexts).toEqual([])
  })

  test('attributes are read once per block name, not once per insertion', async () => {
    const bridge = new MockBridgeClient()
    await insert(bridge, 'DOOR', { FIRE_RATING: 'EI60' })
    await insert(bridge, 'DOOR', { FIRE_RATING: 'EI90' })
    await insert(bridge, 'WINDOW', { GLAZING: 'A' })

    const summary = await bridge.request(RpcMethod.DrawingSummary, {})
    expect(summary.blockReferenceCount).toBe(3)
    // The second DOOR insert is the same definition — walking it again would repeat 20k door
    // inserts' worth of work for no new information.
    expect(summary.blockTexts).toEqual([
      { text: 'EI60', layer: expect.any(String), block: 'DOOR' },
      { text: 'A', layer: expect.any(String), block: 'WINDOW' }
    ])
  })

  test('blank attribute values are not previewed', async () => {
    const bridge = new MockBridgeClient()
    await insert(bridge, 'TITLEBLOCK_A1', { PROJECT_NAME: '  ', DRAWING_NO: 'PCCC-01' })

    const summary = await bridge.request(RpcMethod.DrawingSummary, {})
    expect(summary.blockTexts).toEqual([
      { text: 'PCCC-01', layer: expect.any(String), block: 'TITLEBLOCK_A1' }
    ])
    expect(summary.blockTextsHasMore).toBe(false)
  })

  test('blockTexts has its own budget — 30 notes cannot crowd out the title block', async () => {
    const bridge = new MockBridgeClient()
    for (let i = 0; i < 35; i++) await note(bridge, `note ${i}`)
    await insert(bridge, 'TITLEBLOCK_A1', { DRAWING_NO: 'PCCC-01' })

    const summary = await bridge.request(RpcMethod.DrawingSummary, {})
    expect(summary.texts).toHaveLength(30)
    expect(summary.textsHasMore).toBe(true)
    expect(summary.blockTexts).toEqual([
      { text: 'PCCC-01', layer: expect.any(String), block: 'TITLEBLOCK_A1' }
    ])
    expect(summary.blockTextsHasMore).toBe(false)
  })

  test('more than 30 attribute values caps the preview and flags it', async () => {
    const bridge = new MockBridgeClient()
    const attributes: Record<string, string> = {}
    for (let i = 0; i < 35; i++) attributes[`TAG_${i}`] = `value ${i}`
    await insert(bridge, 'TITLEBLOCK_A1', attributes)

    const summary = await bridge.request(RpcMethod.DrawingSummary, {})
    expect(summary.blockTexts).toHaveLength(30)
    expect(summary.blockTextsHasMore).toBe(true)
  })

  test('a block reference with no attributes contributes nothing to blockTexts', async () => {
    const bridge = new MockBridgeClient()
    await insert(bridge, 'SYMBOL_NO_ATTRS')

    const summary = await bridge.request(RpcMethod.DrawingSummary, {})
    expect(summary.blockReferenceCount).toBe(1)
    expect(summary.blocks).toEqual([{ name: 'SYMBOL_NO_ATTRS', count: 1 }])
    expect(summary.blockTexts).toEqual([])
    expect(summary.blockTextsHasMore).toBe(false)
  })
})
