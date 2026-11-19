import type { Point2D } from '../schemas/semantic-model'
import { canonicalize, digest } from './fingerprint'
import { bulgeToArcPoints } from './geometry'

/**
 * Compiles the CAD payload that is ACTUALLY about to be dispatched into geometric steps.
 *
 * The guard has to validate the thing that will execute, not a description of it. Two facts drive
 * this module:
 *
 * - A CAD write payload arrives in several shapes: `operations.apply` nests steps under
 *   `operations`, `entity` carries one entity at the top level (inline or under `entity`), and
 *   `construct`/program executors hide their steps behind a generator spec or a `planId`. A
 *   placement list is not the unit of safety — the concrete line/polyline/insert is.
 * - Whatever this module cannot read becomes an `opaque` step, never "nothing to check". An opaque
 *   step is what a hidden batch looks like from the registry, and treating it as empty is how a
 *   ~100-entity write compiled behind a `planId` would walk through a guard only ever shown the id.
 *
 * Vertex shapes follow the wire: `polyline` create steps carry `points: Point3d[]`, reads carry
 * `geometry.vertices` with `{ point }` objects, and callers also pass bare `[x, y]` and `{x, y}`.
 * All of them normalize here to the `Point2D` the geometry kernel uses.
 */

export type CompiledStep =
  | {
      index: number
      kind: 'segment'
      /** Every straight leg of the entity, in order. A polyline contributes N-1 legs, +1 if closed. */
      segments: Array<{ start: Point2D; end: Point2D }>
      entityKind: string
      layer?: string
      deviceType?: string
    }
  | {
      index: number
      kind: 'placement'
      center: Point2D
      /** Inserted block extents when the payload stated them; absent for a bare insert point. */
      footprint?: Point2D[]
      entityKind: string
      layer?: string
      deviceType?: string
    }
  | {
      index: number
      kind: 'point'
      position: Point2D
      entityKind: string
      layer?: string
      deviceType?: string
    }
  | {
      /** Text and dimensions: they cannot cross a zone, but they are still a geometry change. */
      index: number
      kind: 'annotation'
      entityKind: string
    }
  | {
      index: number
      kind: 'opaque'
      entityKind: string
      reason: string
      /** Which payload field hid the geometry, so the finding is actionable. */
      field: string
    }

export interface CompiledCadPlan {
  documentName: string
  steps: CompiledStep[]
  /** True when any step's geometry could not be read — forces INSUFFICIENT_DATA at preflight. */
  opaque: boolean
  opaqueReasons: string[]
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Normalizes every point shape the wire and callers actually carry. */
export function toPoint2D(value: unknown): Point2D | null {
  if (Array.isArray(value)) {
    const x = num(value[0])
    const y = num(value[1])
    return x !== null && y !== null ? [x, y] : null
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const inner = rec.point ?? rec.position
    if (inner !== undefined && inner !== value) {
      const p = toPoint2D(inner)
      if (p) return p
    }
    const x = num(rec.x)
    const y = num(rec.y)
    if (x !== null && y !== null) return [x, y]
  }
  return null
}

const POINT_KEYS = [
  'position',
  'insertion',
  'center',
  'start',
  'end',
  'point',
  'corner1',
  'corner2',
  'extLine1',
  'extLine2',
  'dimLinePoint',
  'origin',
  'basePoint'
] as const

/** Does this object carry coordinates anywhere within four levels? */
export function hasAnyCoordinate(value: unknown, depth = 0): boolean {
  if (depth > 4 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((v) => hasAnyCoordinate(v, depth + 1))
  const rec = value as Record<string, unknown>
  for (const key of POINT_KEYS) if (toPoint2D(rec[key]) !== null) return true
  if (Array.isArray(rec.points) || Array.isArray(rec.vertices)) return true
  return Object.values(rec).some((v) => hasAnyCoordinate(v, depth + 1))
}

/**
 * CAD operation names that read rather than draw. Structural (the payload's own operation field),
 * not a tool-name table: `entity` can list or erase, and only the argument says which.
 */
const READ_OPERATIONS: Record<string, true> = {
  list: true,
  get: true,
  info: true,
  summary: true,
  check: true,
  status: true,
  history: true,
  capture: true,
  read: true,
  preview: true,
  inspect: true,
  scan: true,
  changes: true,
  zoom: true,
  zoom_extents: true,
  get_live: true,
  area_measure: true,
  query: true,
  describe: true,
  diff: true,
  count: true,
  search: true,
  export: true,
  dump: true
}

/**
 * Operation names that carry the entity (or entities) to draw verbatim, as opposed to a generator
 * that expands into operations elsewhere. Anything outside both this table and READ_OPERATIONS is
 * treated as hiding its writes.
 */
const ENTITY_LEVEL_OPERATIONS: Record<string, true> = {
  create: true,
  apply: true,
  erase: true,
  delete: true,
  remove: true,
  explode: true,
  transform: true,
  move: true,
  rotate: true,
  scale: true,
  copy: true,
  copy_to: true,
  update: true,
  hatch: true,
  insert: true,
  revert: true,
  undo: true,
  redo: true,
  cleanup: true,
  purge: true,
  rename: true
}

const ANNOTATION_KINDS: Record<string, true> = {
  mtext: true,
  text: true,
  'text.singleLine': true,
  // Same single-line text entity as the device compiler emits (`block-library.ts`);
  // annotation either way — read-back cannot verify a label, so it is not a point step.
  single_line_text: true,
  'dimension.linear': true,
  'dimension.aligned': true,
  'dimension.ordinate': true,
  'dimension.angular': true,
  'dimension.radial': true,
  'dimension.diametric': true
}

/** Payload fields that name a target or a transport concern, never geometry. */
const NON_GEOMETRY_KEYS: Record<string, true> = {
  documentName: true,
  documentId: true,
  targetDocumentName: true,
  instanceId: true,
  idempotencyKey: true,
  taskId: true,
  defaults: true,
  view: true,
  result: true,
  capture: true,
  width: true,
  height: true,
  validationId: true
}

/**
 * Whether one CAD capability payload changes drawing geometry. Structural, never name-based: it
 * reads the payload's own operation field and whether it is a dry run, so a new CAD tool needs no
 * entry in a name table.
 */
export function cadPayloadChangesGeometry(input: Record<string, unknown>): boolean {
  const op = [input.op, input.operation, input.action].find((v) => typeof v === 'string')
  if (typeof op === 'string' && READ_OPERATIONS[op.toLowerCase()] === true) return false
  if (input.dryRun === true) return false
  return true
}

/** Axis-aligned footprint rotated about its centre, from an insert's scale + rotation. */
function orientedInsertFootprint(
  center: Point2D,
  width: number,
  depth: number,
  rotationRad: number
): Point2D[] {
  const cos = Math.cos(rotationRad)
  const sin = Math.sin(rotationRad)
  const hw = width / 2
  const hd = depth / 2
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd]
  ].map(([x, y]) => [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos])
}

/** Arc/circle tessellation: a curved leg is checked as the polyline AutoCAD will draw. */
function arcSegments(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number,
  steps = 24
): Array<{ start: Point2D; end: Point2D }> {
  const out: Array<{ start: Point2D; end: Point2D }> = []
  for (let i = 0; i < steps; i++) {
    const t0 = startAngle + ((endAngle - startAngle) * i) / steps
    const t1 = startAngle + ((endAngle - startAngle) * (i + 1)) / steps
    out.push({
      start: [center[0] + radius * Math.cos(t0), center[1] + radius * Math.sin(t0)],
      end: [center[0] + radius * Math.cos(t1), center[1] + radius * Math.sin(t1)]
    })
  }
  return out
}

function compilePolyline(index: number, entity: Record<string, unknown>): CompiledStep {
  const rawPoints = entity.points ?? entity.vertices
  const base = {
    index,
    entityKind: 'polyline',
    ...(typeof entity.layer === 'string' && { layer: entity.layer }),
    ...(typeof entity.blockName === 'string' && { deviceType: entity.blockName })
  }
  if (!Array.isArray(rawPoints) || rawPoints.length < 2) {
    return {
      ...base,
      kind: 'opaque',
      reason: `polyline step ${index} has no readable vertex list`,
      field: `operations[${index}].entity.points`
    }
  }
  const verts: Point2D[] = []
  const bulges: number[] = []
  for (const v of rawPoints) {
    const p = toPoint2D(v)
    if (!p) {
      return {
        ...base,
        kind: 'opaque',
        reason: `polyline step ${index} has a vertex without coordinates`,
        field: `operations[${index}].entity.points`
      }
    }
    verts.push(p)
    bulges.push(v && typeof v === 'object' ? (num((v as Record<string, unknown>).bulge) ?? 0) : 0)
  }
  const closed = entity.closed === true
  const expanded = bulgeToArcPoints(verts, bulges, closed)
  const segments: Array<{ start: Point2D; end: Point2D }> = []
  for (let i = 0; i < expanded.length - 1; i++)
    segments.push({ start: expanded[i]!, end: expanded[i + 1]! })
  if (closed && expanded.length > 2) segments.push({ start: expanded.at(-1)!, end: expanded[0]! })
  if (segments.length === 0) {
    return {
      ...base,
      kind: 'opaque',
      reason: `polyline step ${index} degenerates to no legs`,
      field: `operations[${index}].entity.points`
    }
  }
  return { ...base, kind: 'segment', segments }
}

function compileEntity(index: number, entity: Record<string, unknown>): CompiledStep {
  const kind = typeof entity.kind === 'string' ? entity.kind : 'unknown'
  const meta = {
    index,
    entityKind: kind,
    ...(typeof entity.layer === 'string' && { layer: entity.layer }),
    ...(typeof entity.blockName === 'string' && { deviceType: entity.blockName })
  }

  if (ANNOTATION_KINDS[kind] === true) return { index, kind: 'annotation', entityKind: kind }

  if (kind === 'polyline' || kind === 'lwpolyline') return compilePolyline(index, entity)

  if (kind === 'line') {
    const start = toPoint2D(entity.start)
    const end = toPoint2D(entity.end)
    if (start && end) return { ...meta, kind: 'segment', segments: [{ start, end }] }
    return {
      ...meta,
      kind: 'opaque',
      reason: `line step ${index} is missing start/end coordinates`,
      field: `operations[${index}].entity`
    }
  }

  if (kind === 'arc' || kind === 'circle') {
    const center = toPoint2D(entity.center)
    const radius = num(entity.radius)
    if (center && radius !== null && radius > 0) {
      const a0 = num(entity.startAngle) ?? 0
      const a1 = num(entity.endAngle) ?? Math.PI * 2
      return { ...meta, kind: 'segment', segments: arcSegments(center, radius, a0, a1) }
    }
    return {
      ...meta,
      kind: 'opaque',
      reason: `${kind} step ${index} is missing center/radius`,
      field: `operations[${index}].entity`
    }
  }

  if (kind === 'rectangle') {
    const c1 = toPoint2D(entity.corner1)
    const c2 = toPoint2D(entity.corner2)
    if (c1 && c2) {
      const ring: Point2D[] = [c1, [c2[0], c1[1]], c2, [c1[0], c2[1]]]
      return {
        ...meta,
        kind: 'segment',
        segments: ring.map((p, i) => ({ start: p, end: ring[(i + 1) % 4]! }))
      }
    }
    return {
      ...meta,
      kind: 'opaque',
      reason: `rectangle step ${index} is missing corner1/corner2`,
      field: `operations[${index}].entity`
    }
  }

  if (kind === 'blockReference' || kind === 'insert') {
    const center = toPoint2D(entity.position ?? entity.insertion ?? entity.point)
    if (!center) {
      return {
        ...meta,
        kind: 'opaque',
        reason: `block insert step ${index} has no readable position`,
        field: `operations[${index}].entity.position`
      }
    }
    const scale = toPoint2D(entity.scale) ?? [1, 1]
    const attributes =
      entity.attributes && typeof entity.attributes === 'object'
        ? (entity.attributes as Record<string, unknown>)
        : undefined
    const w = attributes ? (num(attributes.W) ?? num(attributes.width)) : null
    const d = attributes ? (num(attributes.H) ?? num(attributes.height)) : null
    const rotation = num(entity.rotation) ?? 0
    const footprint =
      w !== null && d !== null && w > 0 && d > 0
        ? orientedInsertFootprint(center, w * scale[0], d * scale[1], rotation)
        : undefined
    return { ...meta, kind: 'placement', center, ...(footprint && { footprint }) }
  }

  const position = POINT_KEYS.map((k) => toPoint2D(entity[k])).find((p): p is Point2D => p !== null)
  if (position) return { ...meta, kind: 'point', position }

  return {
    ...meta,
    kind: 'opaque',
    reason: `step ${index} of kind "${kind}" carries no geometry this preflight can read`,
    field: `operations[${index}]`
  }
}

/**
 * Compile one CAD capability payload into the geometric steps it will draw.
 *
 * `construct` and program executors send a generator spec, not operations: the registry cannot see
 * the writes that come out the other side, so the payload compiles to an opaque step. A caller
 * that wants a protected batch authorized passes the compiled operations (which `dryRun` returns)
 * or uses the task-level executor, which preflights internally.
 */
export function compileCadPayload(input: Record<string, unknown>): CompiledCadPlan {
  const documentName = ['documentName', 'documentId', 'targetDocumentName']
    .map((k) => input[k])
    .find((v) => typeof v === 'string' && v.trim() !== '') as string | undefined

  const steps: CompiledStep[] = []
  const opaqueReasons: string[] = []
  let hidesGeometry = false
  const push = (step: CompiledStep): void => {
    steps.push(step)
    if (step.kind === 'opaque') {
      opaqueReasons.push(step.reason)
      hidesGeometry = true
    }
  }

  for (const listKey of ['operations', 'steps', 'entities', 'items']) {
    const list = input[listKey]
    if (!Array.isArray(list)) continue
    for (const [i, raw] of list.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        push({
          index: i,
          kind: 'opaque',
          entityKind: 'unknown',
          reason: `${listKey}[${i}] is not an object`,
          field: `${listKey}[${i}]`
        })
        continue
      }
      const step = raw as Record<string, unknown>
      const op = [step.op, step.operation, step.action]
        .find((v) => typeof v === 'string')
        ?.toLowerCase()
      if (op === 'erase' || op === 'delete' || op === 'remove' || op === 'explode') {
        // Removal changes geometry but carries handles, not coordinates.
        push({ index: i, kind: 'annotation', entityKind: op })
        continue
      }
      if (
        op === 'transform' ||
        op === 'move' ||
        op === 'rotate' ||
        op === 'scale' ||
        op === 'copy'
      ) {
        const target = (step.transform ?? step) as Record<string, unknown>
        // A transform that names its destination coordinates can be checked; one that only names
        // handles moves geometry this payload does not carry, which is opaque, not empty.
        const namedMove =
          toPoint2D(target.delta) ?? toPoint2D(target.to) ?? toPoint2D(target.position)
        if (namedMove !== null || hasAnyCoordinate(target)) {
          push(compileEntity(i, target))
          continue
        }
        const handles = Array.isArray(target.handles) ? target.handles.length : 0
        push({
          index: i,
          kind: 'opaque',
          entityKind: op,
          reason: `${op} step ${i} moves ${handles} existing entit${handles === 1 ? 'y' : 'ies'} whose current geometry this payload does not carry`,
          field: `${listKey}[${i}]`
        })
        continue
      }
      const entity = step.entity
      if (entity && typeof entity === 'object' && !Array.isArray(entity)) {
        push(compileEntity(i, entity as Record<string, unknown>))
        continue
      }
      if (hasAnyCoordinate(step)) {
        push(compileEntity(i, step))
        continue
      }
      push({
        index: i,
        kind: 'opaque',
        entityKind: 'unknown',
        reason: `${listKey}[${i}] names no entity and carries no coordinates`,
        field: `${listKey}[${i}]`
      })
    }
    return finalize(documentName, steps, opaqueReasons, hidesGeometry)
  }

  // A generator operation (walls/grid/room/dimensions/array/…) expands SERVER-SIDE into entity
  // writes this payload does not enumerate: `walls` carries a centerline but draws two offset faces
  // with real opening cuts, so compiling the centerline would validate geometry that is not what
  // executes. Unknown operation names are treated the same way — hiding operations is the default
  // assumption, never "nothing to check".
  const generatorOp = [input.op, input.operation, input.action].find((v) => typeof v === 'string')
  if (
    typeof generatorOp === 'string' &&
    ENTITY_LEVEL_OPERATIONS[generatorOp.toLowerCase()] !== true &&
    READ_OPERATIONS[generatorOp.toLowerCase()] !== true
  ) {
    push({
      index: 0,
      kind: 'opaque',
      entityKind: generatorOp,
      reason: `"${generatorOp}" is expanded into CAD operations by the tool itself, so this payload does not enumerate what will be drawn`,
      field: 'operation'
    })
    return finalize(documentName, steps, opaqueReasons, hidesGeometry)
  }

  // Single-entity form: `entity` (operation:"create") carries the entity nested, and some callers
  // put the entity's own fields at the payload root. Both compile to one step.
  const nestedEntity =
    input.entity && typeof input.entity === 'object' && !Array.isArray(input.entity)
      ? (input.entity as Record<string, unknown>)
      : undefined
  if (nestedEntity || hasAnyCoordinate(input)) {
    const flat: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
      if (NON_GEOMETRY_KEYS[k] !== true) flat[k] = v
    }
    const entityLike = nestedEntity ?? {
      ...flat,
      ...(typeof flat.kind !== 'string' && typeof input.entityKind === 'string'
        ? { kind: input.entityKind }
        : {})
    }
    push(compileEntity(0, entityLike))
    return finalize(documentName, steps, opaqueReasons, hidesGeometry)
  }

  // A geometry-changing payload with no readable coordinates. Only a NAMED hiding mechanism
  // (a planId, generator or executor) actually conceals operations; other coordinate-free writes
  // (layer create, style set) change drawing state without geometry, and gating those as if they
  // hid routes would be the over-restriction this guard must not become.
  const hiddenMechanism = ['planId', 'programId', 'executor', 'generator', 'script', 'macro'].find(
    (k) => input[k] !== undefined
  )
  if (cadPayloadChangesGeometry(input) && hiddenMechanism !== undefined) {
    const reason = `"${hiddenMechanism}" compiles into CAD operations this preflight cannot see from the payload`
    push({ index: 0, kind: 'opaque', entityKind: 'opaque', reason, field: hiddenMechanism })
  }
  return finalize(documentName, steps, opaqueReasons, hidesGeometry)
}

/**
 * Digest of the canonical compiled operations — what a validation record binds to, so a PASS
 * describes the geometry that will execute rather than a wrapper around it. Opaque steps are part
 * of the digest: a hidden-operation plan hashes differently from any explicit validated plan.
 */
export function planHashOf(plan: CompiledCadPlan): string {
  const canonical = plan.steps.map((s) =>
    s.kind === 'segment'
      ? {
          index: s.index,
          kind: s.kind,
          entityKind: s.entityKind,
          segments: s.segments.map((seg) => [
            [seg.start[0], seg.start[1]],
            [seg.end[0], seg.end[1]]
          ])
        }
      : s.kind === 'placement'
        ? {
            index: s.index,
            kind: s.kind,
            entityKind: s.entityKind,
            center: s.center,
            deviceType: s.deviceType,
            footprint: s.footprint
          }
        : s
  )
  return digest(canonicalize({ documentName: plan.documentName, steps: canonical }))
}

function finalize(
  documentName: string | undefined,
  steps: CompiledStep[],
  opaqueReasons: string[],
  hidesGeometry: boolean
): CompiledCadPlan {
  return {
    documentName: documentName ?? '',
    steps,
    opaque: hidesGeometry,
    opaqueReasons
  }
}
