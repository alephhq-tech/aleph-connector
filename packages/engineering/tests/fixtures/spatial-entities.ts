import type { SpatialRawEntity } from '../../src/index'

/**
 * Shared entity fixtures for the spatial suites. Every fixture carries REAL vertices (the shape
 * the wire actually delivers for `entity.list detail:"full"`), because the behaviour under test is
 * precisely that the extractor reasons from polygon rings, not axis-aligned boxes.
 *
 * Units: millimetres, Aleph drawing convention. Kept in one module: three suites need the same
 * builders, and inlining them tripped jscpd's repo threshold once.
 */

export const rect = (x: number, y: number, w: number, h: number): Array<[number, number]> => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h]
]

export const polyline = (
  handle: string,
  layer: string,
  pts: Array<[number, number]>
): SpatialRawEntity => ({
  handle,
  kind: 'polyline',
  layer,
  geometry: { closed: true, vertices: pts.map(([x, y]) => ({ point: { x, y } })) },
  bounds: {
    min: { x: Math.min(...pts.map((p) => p[0])), y: Math.min(...pts.map((p) => p[1])) },
    max: { x: Math.max(...pts.map((p) => p[0])), y: Math.max(...pts.map((p) => p[1])) }
  }
})

export const block = (
  handle: string,
  layer: string,
  blockName: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rotation = 0
): SpatialRawEntity => ({
  handle,
  kind: 'blockReference',
  layer,
  geometry: { name: blockName, position: { x: cx, y: cy }, rotation },
  bounds: { min: { x: cx - w / 2, y: cy - h / 2 }, max: { x: cx + w / 2, y: cy + h / 2 } }
})

export const wall = (
  handle: string,
  a: [number, number],
  b: [number, number]
): SpatialRawEntity => ({
  handle,
  kind: 'line',
  layer: 'A-WALL',
  geometry: { start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } },
  bounds: {
    min: { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]) },
    max: { x: Math.max(a[0], b[0]), y: Math.max(a[1], b[1]) }
  }
})

/** Two rooms side by side sharing a wall at x=6000, plus a door on that wall. */
export function twoRoomScene(): SpatialRawEntity[] {
  return [
    polyline('rmLiving', 'A-ROOM-PHONG_KHACH', rect(0, 0, 6000, 6000)),
    polyline('rmBed', 'A-ROOM-PHONG_NGU', rect(6000, 0, 6000, 6000)),
    wall('wShared', [6000, 0], [6000, 6000]),
    wall('wLeft', [0, 0], [0, 6000]),
    block('d1', 'A-DOOR', 'DOOR_900', 6000, 3000, 900, 200)
  ]
}
