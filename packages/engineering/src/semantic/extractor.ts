import {
  SemanticModelSchema,
  type SemanticModel,
  type WallSegment,
  type Opening,
  type Room,
  type EquipmentSymbol,
  type RegionBoundary,
  type SpatialRelationship,
  type Point2D
} from '../schemas/semantic-model'
import { SpatialIndex2D, type Box2D } from './spatial-index'
import { bulgeToArcPoints } from '../spatial/geometry'

export interface RawCadEntity {
  handle: string
  kind: string // 'line' | 'polyline' | 'blockReference' | 'circle' | 'arc' | 'text.singleLine' | 'mtext' | 'hatch'
  layer: string
  geometry?: Record<string, unknown>
  bounds?: { min: { x: number; y: number; z?: number }; max: { x: number; y: number; z?: number } }
}

export interface SemanticExtractionOptions {
  documentName?: string
  defaultToleranceMm?: number
}

/**
 * Deterministic Semantic Extractor for AutoCAD drawings.
 * Transforms low-level CAD geometry into structured architectural & MEP engineering concepts.
 */
export function extractSemanticModel(
  entities: RawCadEntity[],
  options: SemanticExtractionOptions = {}
): SemanticModel {
  const walls: WallSegment[] = []
  const openings: Opening[] = []
  const rooms: Room[] = []
  const equipment: EquipmentSymbol[] = []
  const protectedRegions: RegionBoundary[] = []
  const excludedRegions: RegionBoundary[] = []
  const relationships: SpatialRelationship[] = []
  const unclassifiedHandles: string[] = []

  // Build spatial index for fast containment and adjacency queries
  const spatialIndex = new SpatialIndex2D<RawCadEntity>(2000)

  for (const ent of entities) {
    if (ent.bounds) {
      spatialIndex.insert(
        ent.handle,
        {
          minX: ent.bounds.min.x,
          minY: ent.bounds.min.y,
          maxX: ent.bounds.max.x,
          maxY: ent.bounds.max.y
        },
        ent
      )
    }
  }

  // Pass 1: Classification by geometric type and layer semantics
  for (const ent of entities) {
    const layerUpper = ent.layer.toUpperCase()

    // 1. Walls
    if (isWallEntity(ent, layerUpper)) {
      const seg = extractWallSegment(ent)
      if (seg) walls.push(seg)
      else unclassifiedHandles.push(ent.handle)
      continue
    }

    // 2. Openings / Doors / Windows
    if (isOpeningEntity(ent, layerUpper)) {
      const op = extractOpening(ent)
      if (op) openings.push(op)
      else unclassifiedHandles.push(ent.handle)
      continue
    }

    // 3. Equipment (Sprinklers, Detectors, Hydrants, Valves, Pumps)
    if (isEquipmentEntity(ent, layerUpper)) {
      const eq = extractEquipment(ent)
      if (eq) equipment.push(eq)
      else unclassifiedHandles.push(ent.handle)
      continue
    }

    // 4. Closed Polygons / Rooms / Compartments
    if (isRoomEntity(ent, layerUpper)) {
      const rm = extractRoom(ent)
      if (rm) {
        rooms.push(rm)
        if (rm.isProtected) {
          protectedRegions.push({
            id: `prot_${rm.id}`,
            name: rm.name,
            boundary: rm.boundary,
            areaM2: rm.areaM2
          })
        } else {
          excludedRegions.push({
            id: `excl_${rm.id}`,
            name: rm.name,
            boundary: rm.boundary,
            areaM2: rm.areaM2
          })
        }
      } else {
        unclassifiedHandles.push(ent.handle)
      }
      continue
    }

    // Text / Dimensions / Details
    if (ent.kind.startsWith('text') || ent.kind === 'mtext') {
      // Annotations are recorded or linked
      continue
    }

    unclassifiedHandles.push(ent.handle)
  }

  // Pass 2: Spatial Relationships (Topological linking)
  for (const rm of rooms) {
    const roomBox: Box2D = getPolygonBox(rm.boundary)
    const candidates = spatialIndex.query(roomBox)

    for (const cand of candidates) {
      if (cand.bounds) {
        const midX = (cand.bounds.min.x + cand.bounds.max.x) / 2
        const midY = (cand.bounds.min.y + cand.bounds.max.y) / 2
        if (pointInPolygon([midX, midY], rm.boundary)) {
          // Room contains equipment or text
          if (equipment.some((e) => e.handle === cand.handle)) {
            relationships.push({
              sourceId: rm.id,
              targetId: cand.handle,
              relation: 'contains'
            })
          }
        }
      }
    }
  }

  // Doors connecting adjacent spaces — measured by distance to the actual boundary, not to the
  // nearest vertex. A door centred on a long wall edge used to match nothing (or matched the wrong
  // room because one room happened to have a corner nearby).
  for (const op of openings) {
    const tolerance = Math.max(op.width * 0.6, 500)
    const connected = rooms
      .map((rm) => ({ rm, d: distanceToRingBoundary(op.location, rm.boundary) }))
      .filter((c) => c.d <= tolerance)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map((c) => c.rm)
    if (connected.length >= 2) {
      relationships.push({
        sourceId: op.handle,
        targetId: connected[0]!.id,
        relation: 'connects_to',
      })
      relationships.push({
        sourceId: op.handle,
        targetId: connected[1]!.id,
        relation: 'connects_to',
      })
      op.connectsRooms = [connected[0]!.id, connected[1]!.id]
    }
  }

  return SemanticModelSchema.parse({
    documentName: options.documentName,
    walls,
    openings,
    rooms,
    corridors: [],
    equipment,
    protectedRegions,
    excludedRegions,
    relationships,
    unclassifiedHandles,
    analyzedAt: Date.now()
  })
}

// Helpers
function isWallEntity(ent: RawCadEntity, layerUpper: string): boolean {
  if (layerUpper.includes('WALL') || layerUpper.includes('TUONG') || layerUpper.includes('A-WALL')) {
    return ent.kind === 'line' || ent.kind === 'polyline'
  }
  return false
}

function extractWallSegment(ent: RawCadEntity): WallSegment | null {
  if (ent.geometry && 'start' in ent.geometry && 'end' in ent.geometry) {
    const s = ent.geometry.start as { x: number; y: number }
    const e = ent.geometry.end as { x: number; y: number }
    return {
      handle: ent.handle,
      start: [s.x, s.y],
      end: [e.x, e.y],
      layer: ent.layer
    }
  }
  if (ent.bounds) {
    return {
      handle: ent.handle,
      start: [ent.bounds.min.x, ent.bounds.min.y],
      end: [ent.bounds.max.x, ent.bounds.max.y],
      layer: ent.layer
    }
  }
  return null
}

function isOpeningEntity(ent: RawCadEntity, layerUpper: string): boolean {
  if (
    layerUpper.includes('DOOR') ||
    layerUpper.includes('CUA') ||
    layerUpper.includes('WINDOW') ||
    layerUpper.includes('OPENING')
  ) {
    return true
  }
  if (ent.kind === 'blockReference' && (ent.geometry?.name as string | undefined)?.toUpperCase().includes('DOOR')) {
    return true
  }
  return false
}

function extractOpening(ent: RawCadEntity): Opening | null {
  const isWindow =
    ent.layer.toUpperCase().includes('WINDOW') ||
    (ent.geometry?.name as string | undefined)?.toUpperCase().includes('WIN')
  const insertion = ent.geometry?.position as { x: number; y: number } | undefined
  const loc: Point2D | null = insertion
    ? [insertion.x, insertion.y]
    : ent.bounds
      ? [(ent.bounds.min.x + ent.bounds.max.x) / 2, (ent.bounds.min.y + ent.bounds.max.y) / 2]
      : null
  // No silent [0,0]: an opening whose position cannot be measured is reported as unresolved so
  // downstream checks answer INSUFFICIENT_DATA instead of validating against the drawing origin.
  if (!loc) return null
  const blockName = (ent.geometry?.name as string | undefined) ?? ''
  const blockWidthMatch = blockName.match(/(\d{3,4})/)
  let width = ent.bounds
    ? Math.max(ent.bounds.max.x - ent.bounds.min.x, ent.bounds.max.y - ent.bounds.min.y)
    : 0
  let widthSource: Opening['widthSource'] = 'bounds'
  if (width <= 0 && blockWidthMatch) {
    width = Number(blockWidthMatch[1])
    widthSource = 'blockName'
  }
  if (width <= 0) return null
  return {
    handle: ent.handle,
    type: isWindow ? 'window' : 'door',
    location: loc,
    width,
    locationSource: insertion ? 'insertion' : 'bounds',
    widthSource,
  }
}

function isEquipmentEntity(ent: RawCadEntity, layerUpper: string): boolean {
  if (
    layerUpper.includes('PCCC') ||
    layerUpper.includes('SPRINKLER') ||
    layerUpper.includes('HEAD') ||
    layerUpper.includes('DETECTOR') ||
    layerUpper.includes('VALVE') ||
    layerUpper.includes('HYDRANT')
  ) {
    return ent.kind === 'blockReference' || ent.kind === 'circle'
  }
  const blockName = (ent.geometry?.name as string | undefined)?.toUpperCase() ?? ''
  if (blockName.includes('SPRINKLER') || blockName.includes('HEAD') || blockName.includes('DETECTOR')) {
    return true
  }
  return false
}

function extractEquipment(ent: RawCadEntity): EquipmentSymbol | null {
  const blockName = (ent.geometry?.name as string | undefined) ?? 'sprinkler_head'
  const loc: Point2D = ent.bounds
    ? [(ent.bounds.min.x + ent.bounds.max.x) / 2, (ent.bounds.min.y + ent.bounds.max.y) / 2]
    : [0, 0]
  return {
    handle: ent.handle,
    type: blockName,
    position: loc,
    layer: ent.layer,
    rotationDeg: (ent.geometry?.rotation as number | undefined) ?? 0
  }
}

function isRoomEntity(ent: RawCadEntity, layerUpper: string): boolean {
  if (layerUpper.includes('ROOM') || layerUpper.includes('PHONG') || layerUpper.includes('BOUNDARY') || layerUpper.includes('KV_')) {
    return ent.kind === 'polyline' || ent.kind === 'hatch'
  }
  return false
}

function extractRoom(ent: RawCadEntity): Room | null {
  // Prefer the entity's real outline. A closed polyline's vertices (bulges tessellated) or a
  // hatch loop give the actual boundary — concave, L-shaped, rotated, whatever the drawing holds.
  const real = realRingOf(ent)
  let boundary: Point2D[] | null = real
  const boundarySource: Room['boundarySource'] = real ? 'vertices' : 'bbox-fallback'
  if (!boundary) {
    if (!ent.bounds) return null
    const { minX, minY, maxX, maxY } = boxOf(ent.bounds)
    boundary = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ]
  }
  // Area from the actual ring (shoelace), not from width×height of a box. mm → m conversion is
  // explicit; the drawing-unit assumption is documented at the call site.
  const areaM2 = polygonAreaM2(boundary)

  const isExcluded = ent.layer.toUpperCase().includes('EXCLUDE') || ent.layer.toUpperCase().includes('KHONG_CC')

  return {
    id: `rm_${ent.handle}`,
    name: ent.layer,
    boundary,
    areaM2,
    isProtected: !isExcluded,
    boundarySource,
    usableAreaM2: areaM2,
  }
}

/** Real closed ring from polyline vertices (bulges tessellated) or a hatch loop; null otherwise. */
function realRingOf(ent: RawCadEntity): Point2D[] | null {
  const g = ent.geometry as
    | {
        vertices?: Array<{ point?: { x: number; y: number }; x?: number; y?: number; bulge?: number }>
        closed?: boolean
        loops?: Array<{ points?: Array<{ x: number; y: number }> }>
      }
    | undefined
  if (g?.vertices && g.vertices.length >= 3 && (g.closed ?? true)) {
    const pts = g.vertices
      .map((v) => {
        const p = v.point ?? { x: v.x, y: v.y }
        return [p.x as number, p.y as number] as Point2D
      })
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    if (pts.length >= 3) return bulgeToArcPoints(pts, g.vertices.map((v) => v.bulge ?? 0), true)
  }
  const loop = g?.loops?.[0]?.points
  if (loop && loop.length >= 3) {
    const pts = loop.map((p) => [p.x, p.y] as Point2D).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    if (pts.length >= 3) return pts
  }
  return null
}

function boxOf(bounds: { min: { x: number; y: number }; max: { x: number; y: number } }): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  return { minX: bounds.min.x, minY: bounds.min.y, maxX: bounds.max.x, maxY: bounds.max.y }
}

function getPolygonBox(pts: Point2D[]): Box2D {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/** Shoelace area over the real ring, converted mm² → m². */
function polygonAreaM2(ring: Point2D[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!
    const [x2, y2] = ring[(i + 1) % ring.length]!
    sum += x1 * y2 - x2 * y1
  }
  return Math.round((Math.abs(sum) / 2 / 1_000_000) * 100) / 100
}

function pointInPolygon(pt: Point2D, poly: Point2D[]): boolean {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function pointNearPolygon(pt: Point2D, poly: Point2D[], tol: number): boolean {
  return distanceToRingBoundary(pt, poly) <= tol
}

/** Shortest distance from a point to any edge of the ring (true boundary distance). */
function distanceToRingBoundary(pt: Point2D, ring: Point2D[]): number {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % ring.length]!
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2))
    const d = Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy))
    if (d < best) best = d
  }
  return best
}
