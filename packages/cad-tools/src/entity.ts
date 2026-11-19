import * as z from 'zod/v4'
import { pathLength, segmentsFromPoints } from './arrayPath.js'
import { colorSpec, entityHandle, layerName, point3d, scale3d } from './geometry.js'

const createLine = z.object({
  kind: z.literal('line'),
  layer: layerName.optional(),
  start: point3d,
  end: point3d
})

const createCircle = z.object({
  kind: z.literal('circle'),
  layer: layerName.optional(),
  center: point3d,
  radius: z.number().positive()
})

const createArc = z.object({
  kind: z.literal('arc'),
  layer: layerName.optional(),
  center: point3d,
  radius: z.number().positive(),
  startAngle: z.number(),
  endAngle: z.number()
})

const createPolyline = z.object({
  kind: z.literal(['polyline', 'pline']),
  layer: layerName.optional(),
  points: z.array(point3d).min(2),
  closed: z.boolean().default(false)
})

const createRectangle = z
  .object({
    kind: z.literal(['rectangle', 'rect']),
    layer: layerName.optional(),
    corner1: point3d,
    /** With `rotation`, read in the rectangle's own frame: width = x2 − x1, height = y2 − y1. */
    corner2: point3d,
    /** Rotation about corner1 (RECTANG Rotation). */
    rotation: z.number().optional(),
    /**
     * Straight chamfer at every corner (RECTANG Chamfer): d1 along the first edge, d2 along the
     * second. Mutually exclusive with `fillet`.
     */
    chamfer: z.object({ d1: z.number().positive(), d2: z.number().positive() }).optional(),
    /**
     * Rounded corner of this radius at every corner (RECTANG Fillet). Mutually exclusive with
     * `chamfer`.
     */
    fillet: z.number().positive().optional()
  })
  .refine((r) => !(r.chamfer && r.fillet), {
    message: 'rectangle: fillet and chamfer are mutually exclusive',
    path: ['fillet']
  })

// Shape presets (#57) — solved server-side into polyline / arc / circle before the wire.
const createPolygon = z.object({
  kind: z.literal('polygon'),
  layer: layerName.optional(),
  center: point3d,
  sides: z.number().int().min(3).max(1024),
  radius: z.number().positive(),
  /** Inscribed (default): vertices on the circle; circumscribed: edge midpoints on it. */
  mode: z.enum(['inscribed', 'circumscribed']).optional(),
  rotation: z.number().optional()
})

/** POLYGON Edge: the polygon's first edge, counter-clockwise from `edgeStart` to `edgeEnd`. */
const createPolygonEdge = z.object({
  kind: z.literal('polygon.edge'),
  layer: layerName.optional(),
  edgeStart: point3d,
  edgeEnd: point3d,
  sides: z.number().int().min(3).max(1024)
})

const createDonut = z
  .object({
    kind: z.literal('donut'),
    layer: layerName.optional(),
    center: point3d,
    innerDiameter: z.number().min(0),
    outerDiameter: z.number().positive()
  })
  .refine((d) => d.outerDiameter > d.innerDiameter, {
    message: 'donut: outerDiameter must be greater than innerDiameter',
    path: ['outerDiameter']
  })

const createArcThreePoint = z.object({
  kind: z.literal('arc.threePoint'),
  layer: layerName.optional(),
  start: point3d,
  mid: point3d,
  end: point3d
})

const createArcStartEndRadius = z.object({
  kind: z.literal('arc.startEndRadius'),
  layer: layerName.optional(),
  start: point3d,
  end: point3d,
  radius: z.number().positive(),
  direction: z.enum(['ccw', 'cw']).optional(),
  /** True = the arc longer than 180°. */
  large: z.boolean().optional()
})

const createCircleTwoPoint = z.object({
  kind: z.literal('circle.twoPoint'),
  layer: layerName.optional(),
  p1: point3d,
  p2: point3d
})

const createCircleThreePoint = z.object({
  kind: z.literal('circle.threePoint'),
  layer: layerName.optional(),
  p1: point3d,
  p2: point3d,
  p3: point3d
})

const createMText = z.object({
  kind: z.literal('mtext'),
  layer: layerName.optional(),
  insertion: point3d,
  text: z.string().min(1),
  height: z.number().positive().default(2.5),
  width: z.number().positive().optional(),
  // Annotative text/dimensions/hatch (#74): paperHeight (mm on paper) overrides height with the
  // model-space size the plugin computes from the document's current CANNOSCALE.
  paperHeight: z.number().positive().optional(),
  annotative: z.boolean().optional()
})

const createBlockReference = z.object({
  kind: z.literal(['blockReference', 'insert', 'block']),
  layer: layerName.optional(),
  blockName: z.string().min(1),
  position: point3d,
  scale: scale3d.optional(),
  rotation: z.number().default(0),
  attributes: z.record(z.string(), z.string()).optional()
})

const createSingleLineText = z.object({
  kind: z.literal(['text.singleLine', 'text', 'dtext']),
  layer: layerName.optional(),
  insertion: point3d,
  text: z.string().min(1),
  height: z.number().positive().default(2.5),
  rotation: z.number().default(0),
  paperHeight: z.number().positive().optional(),
  annotative: z.boolean().optional()
})

const createLinearDimension = z.object({
  kind: z.literal(['dimension.linear', 'dimlinear', 'dimension']),
  layer: layerName.optional(),
  extLine1: point3d,
  extLine2: point3d,
  dimLinePoint: point3d,
  dimText: z.string().optional(),
  /** Dimension line angle (radians); or use `direction`. Default horizontal. */
  rotation: z.number().optional(),
  direction: z.enum(['horizontal', 'vertical']).optional(),
  annotative: z.boolean().optional()
})

const createAlignedDimension = z.object({
  kind: z.literal(['dimension.aligned', 'dimaligned']),
  layer: layerName.optional(),
  extLine1: point3d,
  extLine2: point3d,
  dimLinePoint: point3d,
  dimText: z.string().optional(),
  annotative: z.boolean().optional()
})

// dimension.chain (#59): expanded server-side into N `dimension.linear` steps in the same batch —
// never reaches the wire itself, so it has no plugin-side representation.
const createDimensionChain = z.object({
  kind: z.literal(['dimension.chain', 'dimchain']),
  layer: layerName.optional(),
  points: z.array(point3d).min(2),
  mode: z.enum(['continue', 'baseline']),
  direction: z.union([z.enum(['horizontal', 'vertical']), z.object({ rotation: z.number() })]),
  offset: z.number().refine((v) => v !== 0, 'offset must not be 0'),
  /**
   * Baseline only: step between stacked dim lines (default: a fixed 3.75x the default text height —
   * see normalize.ts).
   */
  spacing: z.number().optional()
})

const createOrdinateDimension = z.object({
  kind: z.literal(['dimension.ordinate', 'dimordinate']),
  layer: layerName.optional(),
  origin: point3d,
  featurePoint: point3d,
  leaderEndPoint: point3d,
  axis: z.enum(['x', 'y']),
  annotative: z.boolean().optional()
})

const hatchLoop = z.union([
  z.object({ handles: z.array(entityHandle).min(1) }),
  z.object({ points: z.array(point3d).min(3), bulges: z.array(z.number()).optional() }),
  z.object({ circle: z.object({ center: point3d, radius: z.number().positive() }) })
])

const createHatch = z
  .object({
    kind: z.literal('hatch'),
    layer: layerName.optional(),
    // Existing single-loop form (unchanged): all handles joined into one loop.
    boundaryHandles: z.array(entityHandle).min(1).optional(),
    // Multi-loop form (#58): loops[0] is the outer boundary, every later entry an island.
    loops: z.array(hatchLoop).min(1).optional(),
    pattern: z.string().min(1).default('SOLID'),
    patternScale: z.number().positive().default(1),
    patternAngle: z.number().default(0),
    style: z.enum(['normal', 'outer', 'ignore']).optional(),
    associative: z.boolean().optional(),
    annotative: z.boolean().optional()
  })
  .refine((h) => (h.boundaryHandles ? 1 : 0) + (h.loops ? 1 : 0) === 1, {
    message: 'hatch requires exactly one of boundaryHandles or loops'
  })

/**
 * AutoCAD-flavoured aliases some kinds also accept (e.g. `rect`, `pline`, `text`). The first value
 * of each `kind` literal is canonical; `canonicalEntity` maps an alias back before it goes on the
 * wire, since the plugin only knows canonical kinds.
 */
export const createEntityParams = z.discriminatedUnion('kind', [
  createLine,
  createCircle,
  createArc,
  createPolyline,
  createRectangle,
  createMText,
  createBlockReference,
  createSingleLineText,
  createLinearDimension,
  createAlignedDimension,
  createHatch,
  createPolygon,
  createPolygonEdge,
  createDonut,
  createArcThreePoint,
  createArcStartEndRadius,
  createCircleTwoPoint,
  createCircleThreePoint,
  createDimensionChain,
  createOrdinateDimension
])

export type CreateEntityInput = z.output<typeof createEntityParams>

/** Max entity.list `limit` per call, matching the plugin's own MaxListLimit bound (#10). */
export const MAX_ENTITY_LIST_LIMIT = 1000

const entityDetail = z
  .enum(['summary', 'full'])
  .optional()
  .describe(
    '"full" (#25) returns each entity\'s actual geometry and common properties (color, ' +
      'linetype, lineweight, …) beyond layer, instead of just handle/kind/layer/bounds. ' +
      'Default/omitted: "summary", today\'s shape.'
  )

export const entityListParams = z.object({
  layer: layerName.optional(),
  kind: z
    .enum([
      'line',
      'circle',
      'arc',
      'polyline',
      'rectangle',
      'mtext',
      'blockReference',
      'text.singleLine',
      'dimension.linear',
      'dimension.aligned',
      'hatch',
      'other'
    ])
    .optional(),
  limit: z.number().int().min(1).max(MAX_ENTITY_LIST_LIMIT).default(100),
  offset: z.number().int().min(0).default(0),
  includeBounds: z
    .boolean()
    .optional()
    .describe(
      "false skips computing each entity's bounding box (the plugin's most expensive per-entity " +
        'work) — use when you only need handle/kind/layer. Default/omitted: true.'
    ),
  detail: entityDetail,
  window: z
    .object({ min: point3d, max: point3d })
    .optional()
    .describe(
      'Only entities whose bounds intersect this world XY rectangle count and page — read one ' +
        'region of a huge drawing instead of paging the whole model space. `total` then means ' +
        '"matches the filters", not the whole drawing. An entity whose bounds AutoCAD cannot ' +
        'compute is included, never silently dropped.'
    )
})

export const entityGetParams = z.object({
  handle: entityHandle,
  detail: entityDetail
})

/**
 * `entity.area_measure` — read-only native area/perimeter measurement. Every number comes from
 * AutoCAD's own geometry engine (`Polyline.Area`/`Hatch.Area`/`Region.Area`/`Circle.Area`), never
 * from arithmetic over a text dump, and never converted to m² unless the drawing declares usable
 * INSUNITS. Scope is first-match-wins: `handles` (fast path — opens exactly those entities, no
 * model-space scan), else `selection: "implied"` (the user's current pick), else `window`.
 */
export const entityAreaMeasureParams = z
  .object({
    handles: z
      .array(entityHandle)
      .optional()
      .describe(
        'Area-bearing entities to measure, by handle. The fast path: a follow-up "what is that ' +
          'room\'s area?" costs one call and opens only these entities. ' +
          'A handle that does not exist is an error, never a silently skipped one.'
      ),
    selection: z
      .enum(['implied'])
      .optional()
      .describe(
        '"implied": measure whatever the user has currently selected in the drawing. Empty result ' +
          'when nothing is picked. Only valid for the active tab — a background tab has no selection.'
      ),
    window: z
      .object({ min: point3d, max: point3d })
      .optional()
      .describe(
        'World XY rectangle: measures every area-bearing entity whose bounds intersect it. Line/arc ' +
          'geometry inside the rectangle is reported ambiguous_region rather than summed — a soup of ' +
          'open curves has no single enclosed area.'
      ),
    outputUnit: z
      .enum(['m2'])
      .optional()
      .describe(
        '"m2": also report square metres, but only when the drawing\'s INSUNITS are known. A ' +
          'unitless drawing returns insUnits "unitless", convertedToM2 false and no areaM2 at all — ' +
          'the tool refuses to invent a metre figure rather than guessing the unit.'
      )
  })
  .refine(
    (p) => (p.handles?.length ?? 0) > 0 || p.selection !== undefined || p.window !== undefined,
    { message: 'area_measure needs a scope: handles, selection, or window' }
  )

export const entityEraseParams = z.object({
  handles: z.array(entityHandle).min(1)
})

export const entityCopyToParams = z.object({
  handles: z.array(entityHandle).min(1),
  targetDocumentName: z
    .string()
    .min(1)
    .describe('The open tab to copy into (a `name` from drawing → list_open).'),
  delta: point3d.optional().describe('Offset applied to the copies; omit to keep coordinates.'),
  taskId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Group this copy into a task so the whole symbol import reverts as a unit: operations.revert(taskId) ' +
        'erase-copies it back. Omit for a one-off copy (reverse by erasing the returned handles).'
    )
})

// Update (#26) — kind-specific geometry patch, every field optional (only given fields change).
// Field names mirror the matching entity.create kind exactly, minus whatever that kind can't
// change in place: polyline only takes `closed` (vertex-count changes are still erase+recreate
// territory), and there is no `rectangle` entry — a created rectangle is reported back by
// entity.get/list as kind "polyline" (AutoCAD has no native Rectangle entity), so no stored
// entity's real kind is ever "rectangle".
const updateLine = z.object({
  kind: z.literal('line'),
  start: point3d.optional(),
  end: point3d.optional()
})
const updateCircle = z.object({
  kind: z.literal('circle'),
  center: point3d.optional(),
  radius: z.number().positive().optional()
})
const updateArc = z.object({
  kind: z.literal('arc'),
  center: point3d.optional(),
  radius: z.number().positive().optional(),
  startAngle: z.number().optional(),
  endAngle: z.number().optional()
})
const updatePolyline = z.object({
  kind: z.literal('polyline'),
  closed: z.boolean().optional()
})
const updateMText = z.object({
  kind: z.literal('mtext'),
  insertion: point3d.optional(),
  text: z.string().min(1).optional(),
  height: z.number().positive().optional(),
  width: z.number().positive().optional()
})
const updateSingleLineText = z.object({
  kind: z.literal('text.singleLine'),
  insertion: point3d.optional(),
  text: z.string().min(1).optional(),
  height: z.number().positive().optional(),
  rotation: z.number().optional()
})
const updateBlockReference = z.object({
  kind: z.literal('blockReference'),
  position: point3d.optional(),
  scale: scale3d.optional(),
  rotation: z.number().optional(),
  attributes: z.record(z.string(), z.string()).optional()
})
const updateLinearDimension = z.object({
  kind: z.literal('dimension.linear'),
  extLine1: point3d.optional(),
  extLine2: point3d.optional(),
  dimLinePoint: point3d.optional(),
  dimText: z.string().optional(),
  rotation: z.number().optional()
})
const updateAlignedDimension = z.object({
  kind: z.literal('dimension.aligned'),
  extLine1: point3d.optional(),
  extLine2: point3d.optional(),
  dimLinePoint: point3d.optional(),
  dimText: z.string().optional()
})
const updateOrdinateDimension = z.object({
  kind: z.literal('dimension.ordinate'),
  origin: point3d.optional(),
  featurePoint: point3d.optional(),
  leaderEndPoint: point3d.optional()
})
const updateHatch = z.object({
  kind: z.literal('hatch'),
  pattern: z.string().optional(),
  patternScale: z.number().positive().optional(),
  patternAngle: z.number().optional()
})

export const entityUpdateGeometry = z.discriminatedUnion('kind', [
  updateLine,
  updateCircle,
  updateArc,
  updatePolyline,
  updateMText,
  updateSingleLineText,
  updateBlockReference,
  updateLinearDimension,
  updateAlignedDimension,
  updateOrdinateDimension,
  updateHatch
])

export type EntityUpdateGeometryInput = z.output<typeof entityUpdateGeometry>

export const entityUpdateParams = z.object({
  handle: entityHandle,
  layer: layerName.optional(),
  color: colorSpec.optional(),
  linetype: z.string().min(1).optional(),
  lineweight: z.number().int().optional(),
  geometry: entityUpdateGeometry.optional()
})

const move = z.object({
  op: z.literal('move'),
  handles: z.array(entityHandle).min(1),
  delta: point3d
})
const rotate = z.object({
  op: z.literal('rotate'),
  handles: z.array(entityHandle).min(1),
  center: point3d,
  angle: z.number()
})
const scale = z.object({
  op: z.literal('scale'),
  handles: z.array(entityHandle).min(1),
  center: point3d,
  factor: z.number().positive()
})
const mirror = z.object({
  op: z.literal('mirror'),
  handles: z.array(entityHandle).min(1),
  axisStart: point3d,
  axisEnd: point3d,
  erase: z.boolean().default(false)
})
const copy = z.object({
  op: z.literal('copy'),
  handles: z.array(entityHandle).min(1),
  delta: point3d
})

/** Most copies one array step may create (sources × positions), checked before AutoCAD is touched. */
export const MAX_ARRAY_COPIES = 5000

// Arrays (#20): non-associative copies made by the plugin (Clone + TransformBy), one batch step.
const arrayRect = z.object({
  op: z.literal('arrayRect'),
  handles: z.array(entityHandle).min(1),
  rows: z.number().int().min(1).max(1000),
  columns: z.number().int().min(1).max(1000),
  /** Distance between rows (along +Y before `angle`); negative builds downward. */
  rowSpacing: z.number(),
  /** Distance between columns (along +X before `angle`); negative builds leftward. */
  columnSpacing: z.number(),
  /** Rotation of the whole array's axes (radians). */
  angle: z.number().optional()
})

const arrayPolar = z.object({
  op: z.literal('arrayPolar'),
  handles: z.array(entityHandle).min(1),
  center: point3d,
  /** Total items including the source. */
  count: z.number().int().min(2).max(1000),
  /** Angle to fill (radians, counter-clockwise; negative = clockwise). Default a full circle. */
  fillAngle: z.number().optional(),
  /** Rotate each copy as it goes around (default true). */
  rotateItems: z.boolean().optional()
})

const arrayPathPath = z.union([
  z.object({ handle: entityHandle }),
  z.object({ points: z.array(point3d).min(2) })
])

// Path/linear array (#20): equal arc-length spacing along a handle's curve (line/arc/polyline,
// bulges ignored — same simplification `entityLength`'s zeroLength check already makes) or an
// explicit straight-segment `points` path. `count` mirrors AutoCAD ARRAYPATH's "Divide" method
// (evenly spaced including both path endpoints); `spacing` mirrors its "Measure" method (items
// every `spacing` from the path's start; a remainder short of `spacing` gets no extra item).
// `align` defaults true (rotate each copy to the path's local tangent), matching arrayPolar's
// `rotateItems` default.
const arrayPath = z
  .object({
    op: z.literal('arrayPath'),
    handles: z.array(entityHandle).min(1),
    path: arrayPathPath,
    /** Total items including the source. Mutually exclusive with `spacing`. */
    count: z.number().int().min(2).max(1000).optional(),
    /** Distance between items along the path. Mutually exclusive with `count`. */
    spacing: z.number().positive().optional(),
    /** Rotate each copy to the path's local tangent direction at its placement (default true). */
    align: z.boolean().optional()
  })
  .refine((v) => (v.count != null ? 1 : 0) + (v.spacing != null ? 1 : 0) === 1, {
    message: 'arrayPath requires exactly one of count or spacing'
  })

export const entityTransformParams = z.discriminatedUnion('op', [
  move,
  rotate,
  scale,
  mirror,
  copy,
  arrayRect,
  arrayPolar,
  arrayPath
])

export type EntityTransformInput = z.output<typeof entityTransformParams>

/** Copies an array transform will create, or 0 for other ops. */
export function arrayCopyCount(transform: EntityTransformInput): number {
  if (transform.op === 'arrayRect')
    return (transform.rows * transform.columns - 1) * transform.handles.length
  if (transform.op === 'arrayPolar') return (transform.count - 1) * transform.handles.length
  if (transform.op === 'arrayPath') {
    if (transform.count != null) return (transform.count - 1) * transform.handles.length
    // Spacing mode: item count depends on the path's actual length. Computable here only when
    // `path` is explicit `points` (no lookup needed); a `handle` path's length is only known once
    // resolved against the drawing, so the bridge/plugin enforces the cap after resolving it
    // (docs/PROTOCOL.md).
    if ('points' in transform.path) {
      const length = pathLength(segmentsFromPoints(transform.path.points))
      const extraItems = Math.floor(length / transform.spacing! + 1e-9)
      return extraItems * transform.handles.length
    }
    return 0
  }
  return 0
}

const CANONICAL_KIND = new Map<string, string>(
  createEntityParams.options.flatMap((option) => {
    const [canonical, ...aliases] = [...option.shape.kind.values] as string[]
    return aliases.map((alias) => [alias, canonical!] as const)
  })
)

/** Replaces an alias `kind` (`rect`, `pline`, `text`, …) with its canonical name. */
export function canonicalEntity<T extends { kind: string }>(entity: T): T {
  const canonical = CANONICAL_KIND.get(entity.kind)
  return canonical ? { ...entity, kind: canonical } : entity
}
