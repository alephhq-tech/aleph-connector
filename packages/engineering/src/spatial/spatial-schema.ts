import { z } from 'zod'
import { Point2DSchema } from '../schemas/semantic-model'

/**
 * Architectural spatial model — the layer the constraint engine reasons over.
 *
 * Deliberately separate from `SemanticModel` (which PCCC sprinkler/pipe code consumes and must not
 * break): this schema models what a floor plan actually means — indoor vs outdoor vs courtyard,
 * real boundaries with holes, doors with host walls and swept areas, furniture with footprints.
 * `extractSpatialModel` derives it from the same raw CAD entities.
 *
 * Units: drawing units (mm by Aleph convention). Areas are reported in m² with the conversion
 * explicit at the point of computation.
 */

export const SpaceTypeSchema = z.enum([
  'indoor',
  'outdoor',
  'courtyard',
  'semi_outdoor',
  'circulation',
  'service',
  'unknown'
])
export type SpaceType = z.infer<typeof SpaceTypeSchema>

/**
 * What a space is FOR. Kept separate from `SpaceType` on purpose: a garden is normally outdoor but
 * a courtyard garden or an indoor planting bed is legitimate, and the distinction is the user's
 * intent, not a coordinate rule.
 */
export const SpaceUsageSchema = z.enum([
  'living',
  'bedroom',
  'kitchen',
  'bathroom',
  'dining',
  'office',
  'hallway',
  'staircase',
  'garage',
  'storage',
  'laundry',
  'garden',
  'courtyard',
  'atrium',
  'terrace',
  'driveway',
  'utility',
  'other',
  'unknown'
])
export type SpaceUsage = z.infer<typeof SpaceUsageSchema>

/** How confident the extractor is, and what it leaned on. Never a bare guess. */
export const ConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown'])
export type Confidence = z.infer<typeof ConfidenceSchema>

export const ClassificationEvidenceSchema = z.object({
  /** Layer name, block name, annotation text, geometric property, or adjacency that supported it. */
  source: z.enum(['layer', 'blockName', 'attribute', 'text', 'geometry', 'adjacency', 'user']),
  detail: z.string()
})
export type ClassificationEvidence = z.infer<typeof ClassificationEvidenceSchema>

export const SpaceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  usage: SpaceUsageSchema.default('unknown'),
  spaceType: SpaceTypeSchema.default('unknown'),
  /** Real usable boundary — the actual polygon, never a bounding rectangle. */
  boundary: z.array(Point2DSchema),
  /** Subtracted regions inside `boundary` (courtyards carved out of a floor plate, shafts). */
  holes: z.array(z.array(Point2DSchema)).default([]),
  level: z.number().int().default(0),
  /** Usable area in m², computed from `boundary` minus `holes`. */
  areaM2: z.number(),
  /** Bounding box for broad-phase queries only — never used for containment/area decisions. */
  bbox: z
    .object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() })
    .optional(),
  adjacentSpaces: z.array(z.string()).default([]),
  accessPoints: z.array(z.string()).default([]),
  sourceHandles: z.array(z.string()).default([]),
  confidence: ConfidenceSchema.default('unknown'),
  evidence: z.array(ClassificationEvidenceSchema).default([])
})
export type Space = z.infer<typeof SpaceSchema>

export const SiteSchema = z.object({
  /** Property / parcel boundary. */
  boundary: z.array(Point2DSchema).optional(),
  /** The room rings that make up the building — the real nested-polygon set, never a convex hull
   * (a hull swallows an L-shaped plan's notch and mislabels a garden in it as indoor). */
  buildingRings: z.array(z.array(Point2DSchema)).default([]),
  outdoorRegions: z.array(SpaceSchema).default([]),
  /** Regions nothing may be placed in without explicit authorization. */
  noPlacementRegions: z.array(SpaceSchema).default([]),
  sourceHandles: z.array(z.string()).default([]),
  confidence: ConfidenceSchema.default('unknown')
})
export type Site = z.infer<typeof SiteSchema>

export const SpatialOpeningSchema = z.object({
  handle: z.string(),
  /** Door or window. Only a door swings and only a door carries people between spaces, so every
   * circulation, egress and swing check filters on this; a window still records its host wall. */
  kind: z.enum(['door', 'window']).default('door'),
  /** The wall this opening cuts. Null when the host could not be determined — an opening with no
   * host wall is a finding, not a pass. */
  hostWallHandle: z.string().nullable().default(null),
  /** Where the opening actually sits on the host wall. */
  openingCenter: Point2DSchema.optional(),
  /** Clear opening width in drawing units. */
  width: z.number(),
  hinge: Point2DSchema.optional(),
  /** Leaf direction at rest, degrees. */
  leafAngleDeg: z.number().optional(),
  /** Which way the leaf swings from the wall normal. Only set from explicit block metadata —
   * a door's inward/outward is meaningless without a designated interior, so it stays 'unknown'
   * rather than being guessed from which side has more floor. */
  swingDirection: z.enum(['inward', 'outward', 'unknown']).default('unknown'),
  swingAngleDeg: z.number().default(90),
  /** Tessellated swept area of the leaf — the region furniture must not occupy. */
  sweptArea: z.array(Point2DSchema).optional(),
  /** How the hinge/leaf were obtained: real block insertion+rotation, an explicit attribute, or
   * the wall-endpoint fallback. 'wall-endpoint' is a guess, so it lowers confidence. */
  hingeSource: z
    .enum(['block-insertion', 'attribute', 'wall-endpoint', 'unknown'])
    .default('unknown'),
  /** Whether the wall is actually broken where the door sits (a real opening) or runs intact
   * through it (a decorative symbol). Null when wall geometry was too sparse to tell. */
  cutsWall: z.boolean().nullable().default(null),
  /** Interior door joins two indoor spaces; exterior joins an indoor space to the outside; unknown
   * when the spaces on either side could not be typed. Drives the accessibility roots. */
  connectionType: z.enum(['interior', 'exterior', 'unknown']).default('unknown'),
  /** Spaces the opening actually joins, from boundary topology, not vertex proximity. */
  connectsSpaces: z.array(z.string()).default([]),
  confidence: ConfidenceSchema.default('unknown'),
  evidence: z.array(ClassificationEvidenceSchema).default([])
})
export type SpatialOpening = z.infer<typeof SpatialOpeningSchema>

export const FurnitureKindSchema = z.enum([
  'bed',
  'sofa',
  'table',
  'chair',
  'wardrobe',
  'cabinet',
  'counter',
  'desk',
  'diningTable',
  'sanitary',
  'appliance',
  'plant',
  /** Structural column/pier: building fabric, not movable furniture. Treated as a fixed obstacle
   * nothing may be placed inside, and it is never itself a candidate placement. */
  'column',
  'generic',
  'unknown'
])
export type FurnitureKind = z.infer<typeof FurnitureKindSchema>

export const FurnitureSchema = z.object({
  handle: z.string(),
  kind: FurnitureKindSchema.default('unknown'),
  /** Space the item is meant to sit in. Null = unassigned, which placement validation reports. */
  assignedSpaceId: z.string().nullable().default(null),
  insertion: Point2DSchema,
  /** Nominal block size in drawing units. */
  width: z.number(),
  depth: z.number(),
  rotationDeg: z.number().default(0),
  /** Real 2D footprint (rotated), never a dimensionless point and never an axis-aligned proxy. */
  footprint: z.array(Point2DSchema),
  /** Extra clearance the item needs to function (door reach, seat pull-out). Optional because a
   * made-up clearance is a fake regulation — only set from library metadata or the Design Basis. */
  requiredClearance: z
    .object({ distance: z.number(), side: z.enum(['front', 'back', 'left', 'right', 'all']) })
    .optional(),
  blockName: z.string().optional(),
  confidence: ConfidenceSchema.default('unknown'),
  evidence: z.array(ClassificationEvidenceSchema).default([])
})
export type Furniture = z.infer<typeof FurnitureSchema>

export const RelationshipKindSchema = z.enum([
  'contains',
  'intersects',
  'touches',
  'adjacent_to',
  'connects_to',
  'bounded_by',
  'accessed_through',
  'belongs_to_space',
  'located_outside',
  'blocks_access'
])
export type RelationshipKind = z.infer<typeof RelationshipKindSchema>

export const SpatialRelationSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  kind: RelationshipKindSchema,
  /** Measured evidence, so a relationship can be audited rather than trusted. */
  evidence: z
    .object({
      overlapAreaM2: z.number().optional(),
      boundaryDistance: z.number().optional(),
      detail: z.string().optional()
    })
    .optional()
})
export type SpatialRelation = z.infer<typeof SpatialRelationSchema>

export const SpatialModelSchema = z.object({
  documentName: z.string().optional(),
  site: SiteSchema.optional(),
  spaces: z.array(SpaceSchema).default([]),
  openings: z.array(SpatialOpeningSchema).default([]),
  furniture: z.array(FurnitureSchema).default([]),
  relationships: z.array(SpatialRelationSchema).default([]),
  /** Entities the extractor could not classify — reported, never silently dropped. */
  unclassifiedHandles: z.array(z.string()).default([]),
  /** Geometry too incomplete to model. The extractor must not invent a rectangle for these. */
  insufficientData: z.array(z.object({ handle: z.string(), reason: z.string() })).default([]),
  /** Unit basis the geometry was read with. `declared: false` means the caller never said what the
   * drawing uses and the millimetre default was applied — every area, clutter threshold and m²
   * comparison below is then unverified. The native audit for #413 SS11.1 found inch-declared
   * partner drawings (INSUNITS=1), so "Aleph drawings are millimetres" is not a safe premise. */
  units: z
    .object({ perMetre: z.number(), declared: z.boolean() })
    .default({ perMetre: 1000, declared: false }),
  analyzedAt: z.number().default(() => Date.now())
})
export type SpatialModel = z.infer<typeof SpatialModelSchema>
