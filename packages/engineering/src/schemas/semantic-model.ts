import { z } from 'zod'

export const Point2DSchema = z.tuple([z.number(), z.number()])
export type Point2D = z.infer<typeof Point2DSchema>

export const WallSegmentSchema = z.object({
  handle: z.string(),
  start: Point2DSchema,
  end: Point2DSchema,
  thickness: z.number().optional(),
  layer: z.string().optional()
})
export type WallSegment = z.infer<typeof WallSegmentSchema>

export const OpeningSchema = z.object({
  handle: z.string(),
  type: z.enum(['door', 'window', 'opening']),
  location: Point2DSchema,
  width: z.number(),
  connectsRooms: z.array(z.string()).optional(),
  /**
   * `unresolved` means position/width could not be measured from the entity. The extractor no
   * longer silently defaults to `[0, 0]` / `900` and reports the value as if it were measured.
   */
  locationSource: z.enum(['bounds', 'insertion', 'unresolved']).default('bounds'),
  widthSource: z.enum(['bounds', 'blockName', 'assumed']).default('bounds')
})
export type Opening = z.infer<typeof OpeningSchema>

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  usage: z.string().optional(),
  boundary: z.array(Point2DSchema),
  areaM2: z.number(),
  isProtected: z.boolean().default(true),
  hazardClassification: z.string().optional(),
  /**
   * Where `boundary` came from. `bbox-fallback` means the drawing's real outline could not be read
   * and the ring is the entity's axis-aligned box — a coarse approximation that downstream
   * spatial validation must treat as insufficient evidence, never as the room's true shape.
   * Making this explicit is the fix for "the agent drew a garden inside a bedroom": a fabricated
   * rectangle used to be indistinguishable from a measured boundary.
   */
  boundarySource: z.enum(['vertices', 'hatch-loop', 'bbox-fallback']).default('bbox-fallback'),
  /** Usable area in m² when the boundary has holes; equals areaM2 for a simple ring. */
  usableAreaM2: z.number().optional()
})
export type Room = z.infer<typeof RoomSchema>

export const CorridorSchema = z.object({
  id: z.string(),
  centerline: z.array(Point2DSchema),
  width: z.number()
})
export type Corridor = z.infer<typeof CorridorSchema>

export const EquipmentSymbolSchema = z.object({
  handle: z.string(),
  type: z.string(), // e.g. "sprinkler_head", "smoke_detector", "fire_hydrant"
  position: Point2DSchema,
  layer: z.string(),
  rotationDeg: z.number().default(0),
  properties: z.record(z.string(), z.unknown()).optional()
})
export type EquipmentSymbol = z.infer<typeof EquipmentSymbolSchema>

export const RegionBoundarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  boundary: z.array(Point2DSchema),
  areaM2: z.number(),
  properties: z.record(z.string(), z.unknown()).optional()
})
export type RegionBoundary = z.infer<typeof RegionBoundarySchema>

export const SpatialRelationshipSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  relation: z.enum(['contains', 'bounds', 'connects_to', 'intersects', 'adjacent_to'])
})
export type SpatialRelationship = z.infer<typeof SpatialRelationshipSchema>

export const SemanticModelSchema = z.object({
  documentName: z.string().optional(),
  walls: z.array(WallSegmentSchema).default([]),
  openings: z.array(OpeningSchema).default([]),
  rooms: z.array(RoomSchema).default([]),
  corridors: z.array(CorridorSchema).default([]),
  equipment: z.array(EquipmentSymbolSchema).default([]),
  protectedRegions: z.array(RegionBoundarySchema).default([]),
  excludedRegions: z.array(RegionBoundarySchema).default([]),
  relationships: z.array(SpatialRelationshipSchema).default([]),
  unclassifiedHandles: z.array(z.string()).default([]),
  analyzedAt: z.number().default(() => Date.now())
})
export type SemanticModel = z.infer<typeof SemanticModelSchema>
