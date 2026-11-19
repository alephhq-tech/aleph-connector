import { expect, test } from 'bun:test'
import type { EntityRef } from '@arcdio/cad-types'
import { project, shapeRefs } from './resultShape.js'

const refs = (handles: string[]): EntityRef[] =>
  handles.map((handle, i) => ({ handle, kind: i % 2 ? 'line' : 'circle', layer: 'A-WALL' }))

test('full up to 20 refs, handle list above by default', () => {
  expect(shapeRefs(refs(['1', '2']), undefined)).toHaveLength(2)
  const many = shapeRefs(
    refs(Array.from({ length: 21 }, (_, i) => (i + 1).toString(16))),
    undefined
  )
  expect(many).toMatchObject({ count: 21, byLayer: { 'A-WALL': 21 } })
  expect((many as { handles: string[] }).handles).toHaveLength(21)
})

test('summary collapses consecutive hex handles into ranges, keeping order', () => {
  const summary = shapeRefs(refs(['9', 'A', 'B', '10', '2F', '30']), 'summary')
  expect(summary).toMatchObject({
    count: 6,
    byKind: { circle: 3, line: 3 },
    handleRanges: ['9..B', '10', '2F..30']
  })
})

test('project keeps only requested fields', () => {
  const item = { handle: '2A', kind: 'line', layer: '0' }
  expect(project(item, ['handle'])).toEqual({ handle: '2A' })
  expect(project(item, undefined)).toBe(item)
})
