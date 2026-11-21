import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type {
  CreateEntityParams,
  EntityOperation,
  EntityTransformParams,
  EntityUpdateParams
} from '@aleph-connector/cad-protocol'
import {
  arrayCopyCount,
  canonicalEntity,
  MAX_ARRAY_COPIES,
  type CreateEntityInput,
  type EntityTransformInput
} from '@aleph-connector/cad-tools'
import { invalidGeometry, type Vec2 } from '../construct/geometry.js'
import {
  arcStartEndRadius,
  arcThroughPoints,
  circleThroughPoints,
  donutVertices,
  polygonVertices,
  rectangleVertices,
  type ArcSolution
} from '../construct/shapes.js'
import type { BridgeClient } from '../bridge/BridgeClient.js'

/**
 * Forgiving inputs (#71): tool-level options that turn what models commonly send into the exact
 * wire payload the plugin expects. Compact `[x, y]` points are handled by the `point3d` schema.
 */

export const angleUnit = z
  .enum(['rad', 'deg'])
  .optional()
  .describe(
    'Unit of every angle in this call (arc startAngle/endAngle, text/block rotation, hatch ' +
      'patternAngle, rotate angle). Default rad.'
  )

export const ensureLayer = z
  .boolean()
  .optional()
  .describe(
    "Create any layer this call draws on that doesn't exist yet (default color). Default false."
  )

type AngleUnit = z.infer<typeof angleUnit>

const ANGLE_FIELDS = [
  'startAngle',
  'endAngle',
  'rotation',
  'patternAngle',
  'angle',
  'fillAngle'
] as const

/**
 * Converts every field in `ANGLE_FIELDS` present on `value` from degrees to radians when `unit ===
 * "deg"`.
 */
export function toRadians<T extends object>(value: T, unit: AngleUnit): T {
  if (unit !== 'deg') return value
  const out = { ...value } as Record<string, unknown>
  for (const field of ANGLE_FIELDS) {
    if (typeof out[field] === 'number') out[field] = ((out[field] as number) * Math.PI) / 180
  }
  return out as T
}

/**
 * Canonical kind + radians + presets solved: the exact `entity.create` wire payload. Presets
 * (polygon, rotated/chamfered rectangle, 3-point and start-end-radius arcs, 2P/3P circles, a linear
 * dimension's `direction`) become the plain polyline/arc/circle/dimension the plugin draws.
 *
 * Throws if the entity expands to more than one wire entity (`dimension.chain` — see
 * `expandEntity`); callers that accept multi-entity kinds (`entity.create`, `operations.apply`
 * batch steps) must call `expandEntity` instead.
 */
export function wireEntity(entity: { kind: string }, unit: AngleUnit): CreateEntityParams {
  const expanded = expandEntity(entity, unit)
  if (expanded.length !== 1) {
    throw invalidGeometry(
      `"${entity.kind}" expands to ${expanded.length} entities; use expandEntity`
    )
  }
  return expanded[0]!
}

/**
 * Like `wireEntity`, but supports kinds that expand to more than one wire entity in the same batch
 * (`dimension.chain` → N `dimension.linear` steps). Every caller that can accept a batch of results
 * (`entity.create`, `operations.apply` steps) must use this, not `wireEntity`.
 */
export function expandEntity(entity: { kind: string }, unit: AngleUnit): CreateEntityParams[] {
  const e = toRadians(canonicalEntity(entity), unit) as CreateEntityInput
  if (e.kind === 'dimension.chain') return dimensionChainEntities(e)
  return [solvePreset(e)]
}

const p3 = (p: Vec2) => ({ x: p.x, y: p.y, z: 0 })

function solvePreset(e: CreateEntityInput): CreateEntityParams {
  const { layer } = e
  switch (e.kind) {
    case 'polygon':
      return {
        kind: 'polyline',
        layer,
        points: polygonVertices(e.center, e.sides, e.radius, e.mode, e.rotation).map(p3),
        closed: true
      }
    case 'polygon.edge': {
      const dx = e.edgeEnd.x - e.edgeStart.x
      const dy = e.edgeEnd.y - e.edgeStart.y
      const edgeLength = Math.hypot(dx, dy)
      if (edgeLength < 1e-9) {
        throw invalidGeometry('polygon.edge: edgeStart and edgeEnd must differ')
      }
      const radius = edgeLength / 2 / Math.sin(Math.PI / e.sides)
      const apothem = radius * Math.cos(Math.PI / e.sides)
      const ux = dx / edgeLength
      const uy = dy / edgeLength
      const mid = { x: (e.edgeStart.x + e.edgeEnd.x) / 2, y: (e.edgeStart.y + e.edgeEnd.y) / 2 }
      // Center sits to the left of edgeStart→edgeEnd so the polygon winds counter-clockwise,
      // matching AutoCAD POLYGON's Edge option — verified in shapes.test.ts's edge-form case.
      const center = { x: mid.x - uy * apothem, y: mid.y + ux * apothem }
      const rotation = Math.atan2(e.edgeStart.y - center.y, e.edgeStart.x - center.x)
      return {
        kind: 'polyline',
        layer,
        points: polygonVertices(center, e.sides, radius, 'inscribed', rotation).map(p3),
        closed: true
      }
    }
    case 'rectangle': {
      const { rotation, chamfer, fillet, ...plain } = e
      if (!rotation && !chamfer && !fillet) return { ...plain, kind: 'rectangle' }
      const width = e.corner2.x - e.corner1.x
      const height = e.corner2.y - e.corner1.y
      const vertices = rectangleVertices(e.corner1, width, height, rotation, chamfer, fillet)
      const points = vertices.map((v) => p3(v.point))
      const bulges = fillet ? vertices.map((v) => v.bulge) : undefined
      return { kind: 'polyline', layer, points, closed: true, ...(bulges && { bulges }) }
    }
    case 'donut': {
      const { points, bulges, width } = donutVertices(e.center, e.innerDiameter, e.outerDiameter)
      return {
        kind: 'polyline',
        layer,
        points: points.map(p3),
        closed: true,
        bulges,
        constantWidth: width
      }
    }
    case 'arc.threePoint':
      return { kind: 'arc', layer, ...arcWire(arcThroughPoints(e.start, e.mid, e.end)) }
    case 'arc.startEndRadius':
      return {
        kind: 'arc',
        layer,
        ...arcWire(arcStartEndRadius(e.start, e.end, e.radius, e.direction, e.large))
      }
    case 'circle.twoPoint':
      return {
        kind: 'circle',
        layer,
        center: p3({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 }),
        radius: Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y) / 2
      }
    case 'circle.threePoint': {
      const { center, radius } = circleThroughPoints(e.p1, e.p2, e.p3)
      return { kind: 'circle', layer, center: p3(center), radius }
    }
    case 'dimension.linear': {
      const { direction, ...dimension } = e
      const rotation = direction ? (direction === 'vertical' ? Math.PI / 2 : 0) : e.rotation
      return { ...dimension, kind: 'dimension.linear', rotation }
    }
    default:
      return e as CreateEntityParams
  }
}

/**
 * `dimension.chain` (#59): expands to N `dimension.linear` entities before the wire — the plugin
 * needs no new code for this kind. `continue`: consecutive point pairs, one dim line each, at
 * `offset` from the chain axis (DIMCONTINUE). `baseline`: every point measured from `points[0]`,
 * each on its own line at `offset + i * spacing` (DIMBASELINE).
 *
 * Default `spacing` (baseline only): real AutoCAD's DIMBASELINE spaces stacked dim lines by the
 * live DIMDLI system variable (conventionally ~3.75x the annotation text height), but this function
 * runs here, server-side, before the batch reaches the plugin or its database — there is no live
 * document to read DIMDLI or the current text height from. It falls back to a fixed 3.75x the
 * tool's own default text height (2.5, see `createMText`/`createSingleLineText`), i.e. 9.375
 * drawing units. Pass an explicit `spacing` to match a real drawing's DIMDLI/text height.
 */
const DEFAULT_TEXT_HEIGHT = 2.5
const DEFAULT_BASELINE_SPACING = 3.75 * DEFAULT_TEXT_HEIGHT

function dimensionChainEntities(
  e: Extract<CreateEntityInput, { kind: 'dimension.chain' | 'dimchain' }>
): CreateEntityParams[] {
  const { points, mode, direction, offset, layer } = e
  if (points.length < 2) {
    throw invalidGeometry('dimension.chain: at least 2 points are required')
  }
  if (offset === 0) {
    throw invalidGeometry('dimension.chain: offset must not be 0')
  }
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i]!.x === points[i + 1]!.x && points[i]!.y === points[i + 1]!.y) {
      throw invalidGeometry(`dimension.chain: points ${i} and ${i + 1} coincide`)
    }
  }
  const spacing = e.spacing ?? DEFAULT_BASELINE_SPACING
  const first = points[0]!
  const pairs =
    mode === 'continue'
      ? points.slice(1).map((p, i) => [points[i]!, p] as const)
      : points.slice(1).map((p) => [first, p] as const)

  return pairs.map(([a, b], i) => {
    const distance = mode === 'baseline' ? offset + i * spacing : offset
    let rotation: number
    let dimLinePoint: Vec2
    if (direction === 'horizontal' || direction === 'vertical') {
      rotation = direction === 'vertical' ? Math.PI / 2 : 0
      dimLinePoint =
        direction === 'vertical'
          ? { x: first.x + distance, y: a.y }
          : { x: a.x, y: first.y + distance }
    } else {
      // Generic rotation: offset perpendicular (counter-clockwise) to the measurement axis, at
      // the offset point's projection onto the axis and the chain's first point's projection
      // onto the perpendicular plus distance.
      rotation = direction.rotation
      const axis = { x: Math.cos(rotation), y: Math.sin(rotation) }
      const perp = { x: -Math.sin(rotation), y: Math.cos(rotation) }
      const aAxis = a.x * axis.x + a.y * axis.y
      const firstPerp = first.x * perp.x + first.y * perp.y
      const v = firstPerp + distance
      dimLinePoint = { x: aAxis * axis.x + v * perp.x, y: aAxis * axis.y + v * perp.y }
    }
    return {
      kind: 'dimension.linear',
      layer,
      extLine1: p3(a),
      extLine2: p3(b),
      dimLinePoint: p3(dimLinePoint),
      rotation
    }
  })
}

const arcWire = (arc: ArcSolution) => ({
  center: p3(arc.center),
  radius: arc.radius,
  startAngle: arc.startAngle,
  endAngle: arc.endAngle
})

export function wireTransform(
  transform: EntityTransformInput,
  unit: AngleUnit
): EntityTransformParams {
  const copies = arrayCopyCount(transform)
  if (copies > MAX_ARRAY_COPIES) {
    throw invalidGeometry(
      `${transform.op} would create ${copies} copies (limit ${MAX_ARRAY_COPIES}); use fewer rows/columns/items or split it`
    )
  }
  return toRadians(transform, unit) as unknown as EntityTransformParams
}

type ParsedOperation =
  | { op: 'create'; entity: { kind: string }; id?: string }
  | { op: 'erase'; handles: string[]; id?: string }
  | { op: 'transform'; transform: EntityTransformInput; id?: string }
  | {
      op: 'update'
      update: Omit<EntityUpdateParams, 'documentName' | 'idempotencyKey' | 'view'>
      id?: string
    }

/**
 * `defaults` (#19): merges fallback fields into every `create` step that omits them — a step's own
 * explicit value always wins. Applied before `wireOperations` so expansion (e.g. `dimension.chain`)
 * and `layersOf`/`ensureLayers` both see the effective `layer`.
 */
export function applyDefaults<T extends { op: string; entity?: { layer?: string } }>(
  operations: T[],
  defaults: { layer?: string } | undefined
): T[] {
  if (!defaults?.layer) return operations
  return operations.map((step) =>
    step.op === 'create' && step.entity && step.entity.layer == null
      ? { ...step, entity: { ...step.entity, layer: defaults.layer } }
      : step
  )
}

/**
 * `id` (#19) survives expansion: a `dimension.chain` create step that expands to N wire entities
 * tags every one of them with the same `id`, so a reference resolves to all of them (ambiguous
 * where exactly one handle is expected, same as any other multi-entity id — see `refs.ts`).
 */
export function wireOperations(operations: ParsedOperation[], unit: AngleUnit): EntityOperation[] {
  return operations.flatMap((step): EntityOperation[] => {
    if (step.op === 'create') {
      return expandEntity(step.entity, unit).map((entity) => ({
        op: 'create' as const,
        entity,
        ...(step.id != null && { id: step.id })
      }))
    }
    if (step.op === 'transform') {
      return [
        {
          op: 'transform' as const,
          transform: wireTransform(step.transform, unit),
          ...(step.id != null && { id: step.id })
        }
      ]
    }
    if (step.op === 'update') {
      const updated = { ...step.update }
      return [
        {
          op: 'update' as const,
          update: {
            ...updated,
            ...(updated.geometry && { geometry: toRadians(updated.geometry, unit) })
          },
          ...(step.id != null && { id: step.id })
        }
      ]
    }
    return [step]
  })
}

/** Layers the given entities draw on (explicit `layer` only; omitted means the current layer). */
export function layersOf(entities: { layer?: string }[]): string[] {
  return [...new Set(entities.flatMap((entity) => (entity.layer ? [entity.layer] : [])))]
}

/** Plugin cap for `layer.ensure` (`LayerHandlers.MaxEnsureLayers`). */
const MAX_ENSURE_LAYERS = 200

/**
 * Creates whichever of `layers` don't exist yet; returns the names it created.
 *
 * One `layer.ensure` per chunk instead of `layer.list` + one `layer.create` per missing layer:
 * every round trip here is a separate AutoCAD main-thread dispatch, so the old N+1 shape made a
 * multi-layer batch block the CAD UI once per layer. `layer.ensure` upserts inside a single
 * transaction and reports `action`, so the pre-flight list is unnecessary — an existing layer
 * comes back `unchanged` untouched, exactly what the old skip-and-continue did.
 */
export async function ensureLayers(
  bridge: BridgeClient,
  layers: string[],
  documentName: string | undefined
): Promise<string[]> {
  const created: string[] = []
  for (let i = 0; i < layers.length; i += MAX_ENSURE_LAYERS) {
    const chunk = layers.slice(i, i + MAX_ENSURE_LAYERS)
    const { layers: result } = await bridge.request(RpcMethod.LayerEnsure, {
      layers: chunk.map((name) => ({ name })),
      documentName
    })
    created.push(...result.filter((layer) => layer.action === 'created').map((layer) => layer.name))
  }
  return created
}
