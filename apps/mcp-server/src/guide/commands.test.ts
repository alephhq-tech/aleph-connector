import { expect, test } from 'bun:test'
import { createEntityParams, entityTransformParams } from '@aleph-connector/cad-tools'

// Spot-check (#65): the payload forms references/commands.md lists as supported must validate.
test('commands.md create payloads validate', () => {
  const payloads = [
    { kind: 'line', start: [0, 0], end: [1, 0] },
    {
      kind: 'polyline',
      points: [
        [0, 0],
        [1, 1]
      ],
      closed: true
    },
    { kind: 'circle', center: [0, 0], radius: 1 },
    { kind: 'circle.twoPoint', p1: [0, 0], p2: [2, 0] },
    { kind: 'circle.threePoint', p1: [0, 0], p2: [1, 1], p3: [2, 0] },
    { kind: 'arc', center: [0, 0], radius: 1, startAngle: 0, endAngle: 1 },
    { kind: 'arc.threePoint', start: [0, 0], mid: [1, 1], end: [2, 0] },
    {
      kind: 'arc.startEndRadius',
      start: [0, 0],
      end: [2, 0],
      radius: 1,
      direction: 'cw',
      large: false
    },
    {
      kind: 'rectangle',
      corner1: [0, 0],
      corner2: [2, 1],
      rotation: 0.5,
      chamfer: { d1: 0.1, d2: 0.1 }
    },
    {
      kind: 'rectangle',
      corner1: [0, 0],
      corner2: [2, 1],
      rotation: 0.5,
      fillet: 0.1
    },
    { kind: 'polygon', center: [0, 0], sides: 6, radius: 1, mode: 'circumscribed', rotation: 0 },
    { kind: 'polygon.edge', edgeStart: [1, 0], edgeEnd: [0.5, 0.866], sides: 6 },
    { kind: 'donut', center: [0, 0], innerDiameter: 0.5, outerDiameter: 1 },
    { kind: 'mtext', insertion: [0, 0], text: 'A', height: 2.5, width: 10 },
    { kind: 'text', insertion: [0, 0], text: 'A', height: 2.5, rotation: 0 },
    { kind: 'hatch', boundaryHandles: ['2A'], pattern: 'ANSI31', patternScale: 1, patternAngle: 0 },
    {
      kind: 'dimension.linear',
      extLine1: [0, 0],
      extLine2: [0, 1],
      dimLinePoint: [1, 0],
      direction: 'vertical'
    },
    { kind: 'dimension.aligned', extLine1: [0, 0], extLine2: [1, 1], dimLinePoint: [0, 1] },
    {
      kind: 'blockReference',
      blockName: 'DOOR',
      position: [0, 0],
      rotation: 0,
      attributes: { TAG: '1' }
    }
  ]
  for (const payload of payloads) expect(() => createEntityParams.parse(payload)).not.toThrow()
})

test('commands.md transform payloads validate', () => {
  const handles = ['2A']
  const payloads = [
    { op: 'move', handles, delta: [1, 0] },
    { op: 'copy', handles, delta: [1, 0] },
    { op: 'rotate', handles, center: [0, 0], angle: 1 },
    { op: 'scale', handles, center: [0, 0], factor: 2 },
    { op: 'mirror', handles, axisStart: [0, 0], axisEnd: [0, 1], erase: true },
    { op: 'arrayRect', handles, rows: 2, columns: 2, rowSpacing: 1, columnSpacing: 1, angle: 0 },
    { op: 'arrayPolar', handles, center: [0, 0], count: 4, fillAngle: 3, rotateItems: false },
    { op: 'arrayPath', handles, path: { handle: '2B' }, count: 5, align: true },
    {
      op: 'arrayPath',
      handles,
      path: {
        points: [
          [0, 0],
          [10, 0]
        ]
      },
      spacing: 2,
      align: false
    }
  ]
  for (const payload of payloads) expect(() => entityTransformParams.parse(payload)).not.toThrow()
})
