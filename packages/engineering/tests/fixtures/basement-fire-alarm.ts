export type Pt = [number, number]

/**
 * Basement floor-plan regression fixture (CAD semantic grounding + spatial validation).
 *
 * Millimetres, the Aleph convention. One 40 m x 24 m basement plate containing:
 *  - an elevator shaft (`ELEVATOR` layer) at x 16000..19000, y 8000..12000
 *  - a stairwell (`STAIR` layer) at x 4000..9000, y 15000..22000
 *  - a corridor band (`CORRIDOR` layer) across the plate at y 9000..12000
 *  - bilingual room labels so classification has drawing evidence, not a guess
 *
 * Every region is REAL closed-polyline geometry: what is under test is that validation reasons
 * from rings, never from bounding boxes or from what the caller claims a region is.
 */

export const BASEMENT_PLATE: Pt[] = [
  [0, 0],
  [40000, 0],
  [40000, 24000],
  [0, 24000]
]

export const ELEVATOR_SHAFT: Pt[] = [
  [16000, 8000],
  [19000, 8000],
  [19000, 12000],
  [16000, 12000]
]

export const STAIRWELL: Pt[] = [
  [4000, 15000],
  [9000, 15000],
  [9000, 22000],
  [4000, 22000]
]

export const CORRIDOR: Pt[] = [
  [0, 9000],
  [40000, 9000],
  [40000, 12000],
  [0, 12000]
]

const ring = (handle: string, layer: string, pts: Pt[]) => ({
  handle,
  kind: 'polyline',
  layer,
  geometry: { closed: true, vertices: pts.map(([x, y]) => ({ point: { x, y } })) },
  bounds: {
    min: { x: Math.min(...pts.map((p) => p[0])), y: Math.min(...pts.map((p) => p[1])) },
    max: { x: Math.max(...pts.map((p) => p[0])), y: Math.max(...pts.map((p) => p[1])) }
  }
})

/** Model space as `entity.list detail:"full"` delivers it. */
export const basementEntities = () => [
  ring('BASEMENT_PLATE', 'WALL', BASEMENT_PLATE),
  ring('ELEV_SHAFT_1', 'ELEVATOR', ELEVATOR_SHAFT),
  ring('STAIR_1', 'STAIR', STAIRWELL),
  ring('CORRIDOR_1', 'CORRIDOR', CORRIDOR),
  {
    handle: 'TXT_ELEV',
    kind: 'text.singleLine',
    layer: 'ANNO',
    geometry: { position: { x: 16200, y: 9800 }, text: 'THANG MAY / ELEVATOR' },
    bounds: { min: { x: 16200, y: 9800 }, max: { x: 17600, y: 10200 } }
  },
  {
    handle: 'TXT_STAIR',
    kind: 'text.singleLine',
    layer: 'ANNO',
    geometry: { position: { x: 4200, y: 18000 }, text: 'CAU THANG / STAIR' },
    bounds: { min: { x: 4200, y: 18000 }, max: { x: 5600, y: 18400 } }
  }
]

/** Verified restricted zones, exactly as region inspection emits them. */
export const basementZones = () => [
  {
    id: 'zone-elev-1',
    zoneClass: 'elevator_shaft',
    outer: ELEVATOR_SHAFT,
    holes: [],
    verified: true,
    sourceHandles: ['ELEV_SHAFT_1'],
    confidence: 'high' as const
  },
  {
    id: 'zone-stair-1',
    zoneClass: 'stairwell',
    outer: STAIRWELL,
    holes: [],
    verified: true,
    sourceHandles: ['STAIR_1'],
    confidence: 'high' as const
  }
]

/** A fire-alarm wire whose endpoints are both OUTSIDE the shaft, crossing its interior. */
export const wireThroughShaft = () => ({
  op: 'create' as const,
  entity: {
    kind: 'line' as const,
    layer: 'FA-Wiring',
    start: { x: 10000, y: 10000, z: 0 },
    end: { x: 25000, y: 10000, z: 0 }
  }
})

/** The same connection detoured south of the shaft — the compliant alternative. */
export const wireAroundShaft = () => ({
  op: 'create' as const,
  entity: {
    kind: 'polyline' as const,
    layer: 'FA-Wiring',
    closed: false,
    points: [
      { x: 10000, y: 10000, z: 0 },
      { x: 14000, y: 10000, z: 0 },
      { x: 14000, y: 6000, z: 0 },
      { x: 21000, y: 6000, z: 0 },
      { x: 21000, y: 10000, z: 0 },
      { x: 25000, y: 10000, z: 0 }
    ]
  }
})

/** A sounder dropped inside the elevator shaft. */
export const deviceInShaft = () => ({
  op: 'create' as const,
  entity: {
    kind: 'blockReference' as const,
    layer: 'FA-Devices',
    blockName: 'FA_SOUNDER',
    position: { x: 17500, y: 10000, z: 0 }
  }
})

/** An emergency light in the stairwell — conditionally permitted by the project policy. */
export const emergencyLightInStairwell = () => ({
  op: 'create' as const,
  entity: {
    kind: 'blockReference' as const,
    layer: 'FA-Devices',
    blockName: 'FA_EMERGENCY_LIGHT',
    position: { x: 6500, y: 18500, z: 0 }
  }
})

/** A non-permitted device in the same stairwell. */
export const speakerInStairwell = () => ({
  op: 'create' as const,
  entity: {
    kind: 'blockReference' as const,
    layer: 'FA-Devices',
    blockName: 'FA_SPEAKER',
    position: { x: 6500, y: 18500, z: 0 }
  }
})
