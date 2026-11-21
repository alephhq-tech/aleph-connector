import { expect, test } from 'bun:test'
import {
  arrayCopyCount,
  createEntityParams,
  entityOperation,
  entityTransformParams
} from '@aleph-connector/cad-tools'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { RpcMethodName, RpcMethodMap } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from '../bridge/MockBridgeClient.js'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import {
  ensureLayers,
  expandEntity,
  layersOf,
  wireEntity,
  wireOperations,
  wireTransform
} from './normalize.js'

test('compact [x, y] and [x, y, z] points parse to {x, y, z}', () => {
  const line = createEntityParams.parse({ kind: 'line', start: [1, 2], end: [3, 4, 5] })
  expect(line).toMatchObject({ start: { x: 1, y: 2, z: 0 }, end: { x: 3, y: 4, z: 5 } })
  expect(() => createEntityParams.parse({ kind: 'line', start: [1], end: [3, 4] })).toThrow()
})

test('alias kinds are accepted and sent canonical', () => {
  for (const [alias, canonical] of [
    ['rect', 'rectangle'],
    ['pline', 'polyline'],
    ['text', 'text.singleLine'],
    ['insert', 'blockReference'],
    ['dimlinear', 'dimension.linear']
  ]) {
    const parsed = createEntityParams.parse(
      {
        rect: { kind: alias, corner1: [0, 0], corner2: [1, 1] },
        pline: {
          kind: alias,
          points: [
            [0, 0],
            [1, 1]
          ]
        },
        text: { kind: alias, insertion: [0, 0], text: 'A' },
        insert: { kind: alias, blockName: 'DOOR', position: [0, 0] },
        dimlinear: { kind: alias, extLine1: [0, 0], extLine2: [1, 0], dimLinePoint: [0, 1] }
      }[alias!]
    )
    expect(wireEntity(parsed, undefined).kind).toBe(canonical as never)
  }
})

test('angleUnit deg converts every angle field to radians', () => {
  const arc = createEntityParams.parse({
    kind: 'arc',
    center: [0, 0],
    radius: 5,
    startAngle: 0,
    endAngle: 90
  })
  expect(wireEntity(arc, 'deg')).toMatchObject({ startAngle: 0, endAngle: Math.PI / 2 })
  expect(wireEntity(arc, undefined)).toMatchObject({ endAngle: 90 })
  const [rotate] = wireOperations(
    [
      entityOperation.parse({
        op: 'transform',
        transform: { op: 'rotate', handles: ['2A'], center: [0, 0], angle: 180 }
      })
    ],
    'deg'
  )
  expect(rotate).toMatchObject({ transform: { angle: Math.PI } })
})

test('layersOf collects explicit layers once', () => {
  expect(layersOf([{ layer: 'A' }, {}, { layer: 'A' }, { layer: 'B' }])).toEqual(['A', 'B'])
})

test('presets solve to plain primitives before the wire', () => {
  const polygon = wireEntity(
    createEntityParams.parse({ kind: 'polygon', center: [0, 0], sides: 6, radius: 50 }),
    undefined
  )
  expect(polygon).toMatchObject({ kind: 'polyline', closed: true })
  expect((polygon as { points: unknown[] }).points).toHaveLength(6)
  const arc = wireEntity(
    createEntityParams.parse({
      kind: 'arc.threePoint',
      start: [0, 0],
      mid: [50, 50],
      end: [100, 0]
    }),
    undefined
  )
  expect(arc).toMatchObject({ kind: 'arc', center: { x: 50 }, radius: 50 })
  expect((arc as { center: { y: number } }).center.y).toBeCloseTo(0, 9)
  expect(
    wireEntity(
      createEntityParams.parse({ kind: 'circle.twoPoint', p1: [0, 0], p2: [10, 0] }),
      undefined
    )
  ).toMatchObject({
    kind: 'circle',
    center: { x: 5, y: 0 },
    radius: 5
  })
  const plainRect = wireEntity(
    createEntityParams.parse({ kind: 'rect', corner1: [0, 0], corner2: [2, 1] }),
    undefined
  )
  expect(plainRect).toEqual({
    kind: 'rectangle',
    corner1: { x: 0, y: 0, z: 0 },
    corner2: { x: 2, y: 1, z: 0 }
  })
  const rotatedRect = wireEntity(
    createEntityParams.parse({ kind: 'rectangle', corner1: [0, 0], corner2: [2, 1], rotation: 30 }),
    'deg'
  )
  expect(rotatedRect).toMatchObject({ kind: 'polyline', closed: true })
  const vertical = wireEntity(
    createEntityParams.parse({
      kind: 'dimlinear',
      extLine1: [0, 0],
      extLine2: [0, 3000],
      dimLinePoint: [500, 0],
      direction: 'vertical'
    }),
    undefined
  )
  expect(vertical).toMatchObject({ kind: 'dimension.linear', rotation: Math.PI / 2 })
  expect('direction' in vertical).toBe(false)
})

test('dimension.chain: vertical measures only the Y delta, ignoring X', () => {
  const [a] = expandEntity(
    createEntityParams.parse({
      kind: 'dimension.chain',
      points: [
        [0, 0],
        [0, 3000]
      ],
      mode: 'continue',
      direction: 'vertical',
      offset: 500
    }),
    undefined
  )
  expect(a).toMatchObject({
    kind: 'dimension.linear',
    rotation: Math.PI / 2,
    extLine1: { x: 0, y: 0 },
    extLine2: { x: 0, y: 3000 }
  })
  const [b] = expandEntity(
    createEntityParams.parse({
      kind: 'dimension.chain',
      points: [
        [10, 0],
        [0, 3000]
      ],
      mode: 'continue',
      direction: 'vertical',
      offset: 500
    }),
    undefined
  )
  // extLine1/extLine2 still carry the raw points; RotatedDimension's own Rotation=PI/2 projects
  // the measured value onto Y only, so X differing (10 vs 0) does not change the 3000 measurement.
  expect(b).toMatchObject({
    kind: 'dimension.linear',
    rotation: Math.PI / 2,
    extLine1: { x: 10, y: 0 },
    extLine2: { x: 0, y: 3000 }
  })
})

test('dimension.chain: continue over 5 points creates 4 dims on one line, in order', () => {
  const points = [
    [0, 0],
    [900, 0],
    [1500, 0],
    [2100, 0],
    [3000, 0]
  ]
  const entities = expandEntity(
    createEntityParams.parse({
      kind: 'dimension.chain',
      points,
      mode: 'continue',
      direction: 'horizontal',
      offset: 500
    }),
    undefined
  )
  expect(entities).toHaveLength(4)
  for (const e of entities) expect(e).toMatchObject({ kind: 'dimension.linear', rotation: 0 })
  expect(
    entities.map((e) => [
      (e as { extLine1: { x: number } }).extLine1.x,
      (e as { extLine2: { x: number } }).extLine2.x
    ])
  ).toEqual([
    [0, 900],
    [900, 1500],
    [1500, 2100],
    [2100, 3000]
  ])
  // Same offset from points[0]'s baseline on every dim line ("continue" mode).
  for (const e of entities) {
    expect((e as { dimLinePoint: { y: number } }).dimLinePoint.y).toBeCloseTo(500, 9)
  }
})

test('dimension.chain: baseline over 5 points stacks 4 dims all starting at points[0]', () => {
  const points = [
    [0, 0],
    [900, 0],
    [1500, 0],
    [2100, 0],
    [3000, 0]
  ]
  const entities = expandEntity(
    createEntityParams.parse({
      kind: 'dimension.chain',
      points,
      mode: 'baseline',
      direction: 'horizontal',
      offset: 500,
      spacing: 400
    }),
    undefined
  )
  expect(entities).toHaveLength(4)
  expect(entities.map((e) => (e as { extLine1: { x: number } }).extLine1.x)).toEqual([0, 0, 0, 0])
  expect(entities.map((e) => (e as { extLine2: { x: number } }).extLine2.x)).toEqual([
    900, 1500, 2100, 3000
  ])
  expect(entities.map((e) => (e as { dimLinePoint: { y: number } }).dimLinePoint.y)).toEqual([
    500, 900, 1300, 1700
  ])
})

test('dimension.chain: a chain inside one operations.apply batch expands to one entry per dim, in order', () => {
  const ops = wireOperations(
    [
      {
        op: 'create',
        entity: createEntityParams.parse({
          kind: 'dimension.chain',
          points: [
            [0, 0],
            [900, 0],
            [1500, 0]
          ],
          mode: 'continue',
          direction: 'horizontal',
          offset: 500
        })
      },
      {
        op: 'create',
        entity: createEntityParams.parse({ kind: 'circle', center: [0, 0], radius: 1 })
      }
    ],
    undefined
  )
  // 2 dims from the chain + 1 circle = 3 steps, all in the same operations[] array the plugin
  // wraps in one Transaction/undo group — this IS "one undo step" for the chain, by construction.
  expect(ops).toHaveLength(3)
  expect(ops.map((o) => o.op)).toEqual(['create', 'create', 'create'])
})

test('dimension.chain: default baseline spacing is a fixed 3.75x the default text height', () => {
  const entities = expandEntity(
    createEntityParams.parse({
      kind: 'dimension.chain',
      points: [
        [0, 0],
        [100, 0],
        [200, 0]
      ],
      mode: 'baseline',
      direction: 'horizontal',
      offset: 500
    }),
    undefined
  )
  const step = 9.375 // 3.75 x 2.5
  expect((entities[0] as { dimLinePoint: { y: number } }).dimLinePoint.y).toBeCloseTo(500, 9)
  expect((entities[1] as { dimLinePoint: { y: number } }).dimLinePoint.y).toBeCloseTo(500 + step, 9)
})

test('dimension.chain: rejects fewer than 2 points, zero offset, and duplicate consecutive points', () => {
  const base = {
    kind: 'dimension.chain' as const,
    mode: 'continue' as const,
    direction: 'horizontal' as const
  }
  expect(() =>
    expandEntity(createEntityParams.parse({ ...base, points: [[0, 0]], offset: 500 }), undefined)
  ).toThrow()
  expect(() =>
    expandEntity(
      createEntityParams.parse({
        ...base,
        points: [
          [0, 0],
          [100, 0]
        ],
        offset: 0
      }),
      undefined
    )
  ).toThrow()
  expect(() =>
    expandEntity(
      createEntityParams.parse({
        ...base,
        points: [
          [0, 0],
          [0, 0],
          [100, 0]
        ],
        offset: 500
      }),
      undefined
    )
  ).toThrow(/coincide/)
})

test('dimension.chain: an arbitrary rotation object measures along that angle', () => {
  const [a] = expandEntity(
    createEntityParams.parse({
      kind: 'dimension.chain',
      points: [
        [0, 0],
        [1000, 1000]
      ],
      mode: 'continue',
      direction: { rotation: Math.PI / 4 },
      offset: 200
    }),
    undefined
  )
  expect(a).toMatchObject({ kind: 'dimension.linear', rotation: Math.PI / 4 })
})

test('arrays: copy count is checked against the cap before the wire', () => {
  const rect = entityTransformParams.parse({
    op: 'arrayRect',
    handles: ['2A', '2B'],
    rows: 3,
    columns: 4,
    rowSpacing: 10,
    columnSpacing: 10,
    angle: 90
  })
  expect(arrayCopyCount(rect)).toBe(22)
  expect(wireTransform(rect, 'deg')).toMatchObject({ angle: Math.PI / 2 })
  const polar = entityTransformParams.parse({
    op: 'arrayPolar',
    handles: ['2A'],
    center: [0, 0],
    count: 8
  })
  expect(arrayCopyCount(polar)).toBe(7)
  const huge = entityTransformParams.parse({
    op: 'arrayRect',
    handles: ['2A'],
    rows: 100,
    columns: 100,
    rowSpacing: 1,
    columnSpacing: 1
  })
  expect(() => wireTransform(huge, undefined)).toThrow(/limit 5000/)
  const pathByCount = entityTransformParams.parse({
    op: 'arrayPath',
    handles: ['2A', '2B'],
    path: { handle: '2C' },
    count: 5
  })
  // count mode is independent of the path's actual geometry — computable without a lookup.
  expect(arrayCopyCount(pathByCount)).toBe(8)
  const pathBySpacingPoints = entityTransformParams.parse({
    op: 'arrayPath',
    handles: ['2A'],
    path: {
      points: [
        [0, 0],
        [200, 0]
      ]
    },
    spacing: 60
  })
  expect(arrayCopyCount(pathBySpacingPoints)).toBe(3)
  const pathBySpacingHandle = entityTransformParams.parse({
    op: 'arrayPath',
    handles: ['2A'],
    path: { handle: '2C' },
    spacing: 60
  })
  // spacing mode with a path.handle can't be capped pre-wire (length unknown without a lookup);
  // the bridge/plugin enforces it after resolving the curve — see docs/PROTOCOL.md.
  expect(arrayCopyCount(pathBySpacingHandle)).toBe(0)
})

test('hatch: boundaryHandles still parses exactly as before (#58 regression)', () => {
  const hatch = createEntityParams.parse({ kind: 'hatch', boundaryHandles: ['2A'] })
  expect(hatch).toMatchObject({
    kind: 'hatch',
    boundaryHandles: ['2A'],
    pattern: 'SOLID',
    patternScale: 1,
    patternAngle: 0
  })
  expect('loops' in hatch).toBe(false)
})

test('hatch: loops[0] is the outer boundary, points/circle need no existing entity', () => {
  const hatch = createEntityParams.parse({
    kind: 'hatch',
    loops: [
      {
        points: [
          [0, 0],
          [1000, 0],
          [1000, 1000],
          [0, 1000]
        ]
      },
      { circle: { center: [500, 500], radius: 100 } },
      { handles: ['2A'] }
    ]
  })
  expect(hatch).toMatchObject({ kind: 'hatch' })
  const loops = (hatch as { loops: unknown[] }).loops
  expect(loops).toHaveLength(3)
  expect((loops[0] as { points: unknown[] }).points[0]).toEqual({ x: 0, y: 0, z: 0 })
  expect(loops[1]).toMatchObject({ circle: { center: { x: 500, y: 500 }, radius: 100 } })
  expect(loops[2]).toMatchObject({ handles: ['2A'] })
})

test('hatch: exactly one of boundaryHandles or loops is required', () => {
  expect(() => createEntityParams.parse({ kind: 'hatch' })).toThrow()
  expect(() =>
    createEntityParams.parse({
      kind: 'hatch',
      boundaryHandles: ['2A'],
      loops: [{ handles: ['2B'] }]
    })
  ).toThrow()
  expect(() =>
    createEntityParams.parse({
      kind: 'hatch',
      loops: [
        {
          points: [
            [0, 0],
            [1, 0]
          ]
        }
      ]
    })
  ).toThrow() // points needs >= 3
})

test('hatch: style and associative pass through', () => {
  const hatch = createEntityParams.parse({
    kind: 'hatch',
    boundaryHandles: ['2A'],
    style: 'outer',
    associative: true
  })
  expect(hatch).toMatchObject({ style: 'outer', associative: true })
})

/** Records the method name of every request so a test can assert on round-trip count. */
class CountingBridgeClient implements BridgeClient {
  readonly inner = new MockBridgeClient()
  readonly methods: RpcMethodName[] = []

  async request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params']
  ): Promise<RpcMethodMap[M]['result']> {
    this.methods.push(method)
    return this.inner.request(method, params)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

test('ensureLayers: one layer.ensure round trip, not list + one create per layer', async () => {
  const bridge = new CountingBridgeClient()
  const created = await ensureLayers(bridge, ['A-WALL', 'A-DOOR', 'A-GRID'], undefined)
  expect(bridge.methods).toEqual([RpcMethod.LayerEnsure])
  expect(created).toEqual(['A-WALL', 'A-DOOR', 'A-GRID'])
  const { layers } = await bridge.inner.request(RpcMethod.LayerList, {})
  expect(layers.map((l) => l.name)).toEqual(expect.arrayContaining(['A-WALL', 'A-DOOR', 'A-GRID']))
})

test('ensureLayers: existing layers are left untouched and not reported as created', async () => {
  const bridge = new CountingBridgeClient()
  await bridge.inner.request(RpcMethod.LayerCreate, { name: 'A-WALL', color: { aci: 3 } })
  const created = await ensureLayers(bridge, ['A-WALL', 'A-NEW'], undefined)
  expect(created).toEqual(['A-NEW'])
  const { layers } = await bridge.inner.request(RpcMethod.LayerList, {})
  expect(layers.find((l) => l.name === 'A-WALL')?.color).toEqual({ aci: 3 })
})

test("ensureLayers: chunks at the plugin's 200-layer cap instead of overflowing it", async () => {
  const bridge = new CountingBridgeClient()
  const names = Array.from({ length: 201 }, (_, i) => `L-${i}`)
  const created = await ensureLayers(bridge, names, undefined)
  expect(bridge.methods).toEqual([RpcMethod.LayerEnsure, RpcMethod.LayerEnsure])
  expect(created).toHaveLength(201)
})

test('ensureLayers: no layers means no round trip at all', async () => {
  const bridge = new CountingBridgeClient()
  expect(await ensureLayers(bridge, [], undefined)).toEqual([])
  expect(bridge.methods).toEqual([])
})
