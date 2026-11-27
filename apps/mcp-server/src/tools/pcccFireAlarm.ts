import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { CreateEntityParams, EntityOperation } from '@aleph-connector/cad-protocol'
import {
  areaOf,
  bboxOf,
  resolvePcccBlocks,
  traceRegionBoundaries,
  DEFAULT_PCCC_SYMBOL_GEOMETRY,
  DEFAULT_PCCC_BLOCK_NAMES,
  outOfScopeViolation,
  type CadOperation,
  type FireAlarmDeviceType,
  type Point2D,
  type FireAlarmRoomInput,
  type FireAlarmFullPlanResult,
  type PcccBlockAssignment,
  type PlanReadbackReport
} from '@aleph-connector/engineering'
// The fire-alarm planner is not part of the public engineering API (approach 1: the overlay tool
// is the only entry point). Reach it by deep import so no client can call the planner directly and
// bypass the CAD-geometry gates.
import { planHighwayFireAlarm } from '@aleph-connector/engineering/src/pccc/fire-alarm-planner.js'
import { resolveSymbolCatalogEntry } from '@aleph-connector/cad-state'
import {
  checkOperationsScope,
  resolveDrawingUnits,
  SCOPE_TOLERANCE_MM,
  verifyPcccApply
} from './pcccVerify.js'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { applyBatch } from './applyBatch.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { refsResultMode } from './resultShape.js'
import { createEntityParams, idempotencyKey } from '@aleph-connector/cad-tools'
import { expandEntity } from './normalize.js'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'
import { DRAWING_OPEN_TIMEOUT_MS } from './drawing.js'
import { outcomeMeta } from './attestOutcome.js'
import type { RegionGeometrySource, SnapshotRow } from './floorplanCadState.js'
import {
  createRegionCache,
  designRegionCacheKey,
  leavesRegion,
  locateRoom,
  operationsOutsideRegion,
  resolvedRoomSummary,
  resolveDesignRegion,
  resolveExcludedRings,
  type RegionCache,
  verifyBlockFootprints
} from './pcccRegion.js'
import {
  captureOption,
  captureSize,
  requireVisualReview,
  visualReviewOption,
  withCapture
} from './capture.js'

interface FireAlarmPlanRecord {
  planId: string
  documentName?: string
  revisionAtPreview: string
  createdAt: number
  expiresAt: number
  consumed: boolean
  blocked: boolean
  blockedReasons: string[]
  deviceCount: number
  wireLengthM: number
  layoutStatus: string
  cadOperations: EntityOperation[]
  /** Device type -> the library block definition actually used, resolved from `block.list`. */
  blockNames: PcccBlockAssignment
  /** Definitions the plan needs that the target lacks — cloned at APPLY, never at preview.
   * Null when the drawing already carries every definition. */
  pendingImport: PendingSymbolImport | null
  /** Definitions resolved via `cad_symbol_catalog`'s `geometryJson` mode or Aleph's built-in
   * default geometry (Slice 06 of pccc-cad-drawing-truth) — built at APPLY via
   * `block.ensureDefinition`, no library DWG ever opens. Null when `pendingImport` covers every
   * missing type instead, or the drawing already has every definition. */
  pendingDefinitions: Array<{ blockName: string; entities: Record<string, unknown>[] }> | null
  /** E9 scope: the room polygons every placed detector must stay inside, re-checked at apply. */
  scope: Array<Array<[number, number]>>
  /** Resolved drawing units (E8), for the apply-time scope tolerance and read-back. Null when
   * the drawing declares no physical unit: the plan is blocked, and the draw path refuses
   * rather than measuring in millimetres. */
  unitsPerMetre: number | null
  insUnits: string | null
  lastApplyReceipt: Record<string, unknown> | null
  lastReadback?: { status: string; faithful: boolean; matchedSteps: number; totalSteps: number }
}

/** A read-only `preview` may VERIFY a library holds a block; only `apply` may clone it into the
 * user's drawing. Stores enough to finish the import at apply without a second library probe. */
interface PendingSymbolImport {
  /** Absolute path on the machine running AutoCAD, exactly as the caller passed it. */
  libraryPath: string
  /** Block DEFINITION names to clone, already matched against the library's `block.list`. */
  blockNames: string[]
}

const PLAN_TTL_MS = 15 * 60 * 1000
const MAX_STORED_PLANS = 16
const plans = new Map<string, FireAlarmPlanRecord>()

function prunePlans(): void {
  const now = Date.now()
  for (const [id, rec] of plans) {
    if (rec.expiresAt < now) plans.delete(id)
  }
  if (plans.size > MAX_STORED_PLANS) {
    const oldest = [...plans.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    const toDrop = plans.size - MAX_STORED_PLANS
    for (let i = 0; i < toDrop; i++) {
      const entry = oldest[i]
      if (entry) plans.delete(entry[0])
    }
  }
}

const point2d = z.tuple([z.number(), z.number()])

const roomSchema = z
  .object({
    id: z.string(),
    // `ref` is the handle `drawing.inspect_floorplan` published for this room on this revision; `name`
    // is the sheet's own room label. Either addresses the room, so the caller never retypes vertices.
    ref: z.string().optional(),
    name: z.string().optional(),
    usage: z.enum([
      'garage',
      'parking',
      'kitchen',
      'generator',
      'electrical',
      'pump_room',
      'office',
      'corridor',
      'stairwell',
      'elevator',
      'storage',
      'general'
    ]),
    // Omit this to take the closed outline from the drawing itself (resolved via `ref`/`name` against
    // the CAD State snapshot). With acceptCallerGeometry:true only, when the sheet cannot bind a ring.
    boundary: z.array(point2d).min(3).optional(),
    heightMm: z.number().optional(),
    // Spaces inside this room to skip coverage for (a server room, a stair void, a wet area with no
    // combustibles). Preferred: named by the same ref/label inspect published, so the outline is the
    // drawing's own ring, not a box drawn around where the model thinks the space stands.
    excludedRefs: z
      .array(
        z
          .object({
            ref: z.string().optional(),
            name: z.string().optional()
          })
          .refine((entry) => entry.ref !== undefined || entry.name !== undefined, {
            message: 'an excluded space needs `ref` or `name`'
          })
      )
      .optional()
      .describe(
        'Spaces inside this room to skip coverage for, each addressed by the ref (or label) that '
          + 'drawing.inspect_floorplan reported. Their closed outlines come from the drawing.'
      ),
    excludedBoundaries: z
      .array(z.array(point2d).min(3))
      .optional()
      .describe(
        'Rings inside this room to skip coverage. Requires acceptCallerGeometry:true, and only for a '
          + 'space the inspect could not bind to a label, taken from entity.traceBoundary — never typed '
          + 'from a brief. Prefer excludedRefs.'
      )
  })
  .refine(
    (room) => room.ref !== undefined || room.name !== undefined || room.boundary !== undefined,
    {
      message:
        "a room needs `ref` (from drawing.inspect_floorplan), the sheet's `name`, or a `boundary`"
    }
  )

const previewInput = z.object({
  operation: z.literal('preview'),
  rooms: z
    .array(roomSchema)
    .min(1)
    .describe(
      "Rooms to protect, each with its usage. Prefer `ref` (or the sheet's room `name`) copied from " +
        'drawing.inspect_floorplan and NO boundary: the tool then takes each closed outline from the ' +
        'drawing itself. An explicit `boundary` requires top-level acceptCallerGeometry:true (drafting-only) ' +
        'and must come from entity.traceBoundary — never typed from a brief.'
    ),
  floorplanName: z
    .string()
    .min(1)
    .describe(
      'The floor plan being designed (e.g. "MẶT BẰNG TẦNG HẦM"). The tool reads its real region from ' +
        'CAD with drawing.inspect_floorplan and requires every room polygon to lie inside it. This is ' +
        'what stops an overlay being drawn beside the plan, or over another plan on the same sheet.'
    ),
  floorplanLayoutName: z
    .string()
    .min(1)
    .optional()
    .describe('Exact layout tab from drawing.summary; omit for the existing model-space behavior.'),
  candidateIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'When inspect reported several copies of this floor plan, the 0-based copy to design on — ' +
        'same field as drawing.inspect_floorplan.candidateIndex.'
    ),
  acceptCallerGeometry: z
    .literal(true)
    .optional()
    .describe(
      'Required to use any rooms[].boundary or elevatorShafts polygons typed by the caller. Marks the ' +
        'plan drafting-only. Prefer room refs from inspect whenever they exist.'
    ),
  elevatorShafts: z
    .array(z.array(point2d).min(3))
    .optional()
    .describe('Forbidden elevator shaft voids.'),
  forbiddenZones: z
    .array(
      z.object({
        minX: z.number(),
        minY: z.number(),
        maxX: z.number(),
        maxY: z.number()
      })
    )
    .optional()
    .describe('Forbidden bounding boxes that wiring and placement must never cross.'),
  elevatorPickPoints: z
    .array(point2d)
    .optional()
    .describe(
      'One interior point per elevator shaft, in drawing coordinates — use this when the architecture is one ' +
        'merged block and no closed room polyline can be read. Each point is traced with entity.traceBoundary ' +
        "(AutoCAD's own boundary engine) into the real closed polygon, which then excludes detectors and " +
        'reroutes wiring around the shaft. Vision names the shaft; CAD supplies its boundary.'
    ),
  stairDoors: z
    .array(
      z.object({
        doorPoint: point2d,
        stairName: z.string().optional()
      })
    )
    .optional()
    .describe('Exit doors of stairs for MCP & Alarm combination placement.'),
  junctionBoxLocation: point2d
    .optional()
    .describe(
      'Panel/junction-box anchor [x, y] in drawing coordinates — the position of a REAL ' +
        'panel or junction-box block in the drawing (read it from block.list). Required: ' +
        'without it the plan fails closed with NO_PANEL_ANCHOR; the planner never invents a ' +
        'junction-box location.'
    ),
  beamYHighways: z.array(z.number()).optional().describe('Y coordinates of horizontal structural beam axes.'),
  beamXHighways: z
    .array(z.number())
    .optional()
    .describe('X coordinates of vertical structural beam axes; a span no horizontal axis carries may still run along one.'),
  symbolScale: z
    .number()
    .positive()
    .optional()
    .describe('Scale multiplier for symbol geometry (default 1.0).'),
  symbolLibraryPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional absolute path to a house-style symbol library DWG. When omitted, Aleph resolves ' +
        'default PCCC symbol geometry / workspace catalog entries — do NOT invent a Windows path. ' +
        'Pass a real path only to override with company blocks; preview opens it read-only.'
    ),
  layerDevices: z.string().min(1).default('FA-DEVICES'),
  layerWiring: z.string().min(1).default('FA-WIRING'),
  layerText: z.string().min(1).default('FA-TEXT'),
  documentName,
  instanceId
})

const applyInput = z.object({
  operation: z.literal('apply'),
  planId: z.string().min(1).describe('planId from a fresh pccc_fire_alarm_overlay preview.'),
  result: refsResultMode,
  capture: captureOption,
  visualReview: visualReviewOption,
  ...captureSize,
  documentName,
  instanceId,
  idempotencyKey
})

const statusInput = z.object({
  operation: z.literal('status'),
  planId: z.string().min(1),
  documentName,
  instanceId
})

// `execute` is `preview` + `apply` in one call: it compiles the plan, applies every read-only gate,
// and draws it only if the plan is NOT blocked. A blocked plan is never drawn — the caller gets the
// same violations `preview` would report, with nothing committed. Use `preview`/`apply` separately
// when a human must review the plan between the two.
const executeInput = previewInput.extend({
  operation: z.literal('execute'),
  result: refsResultMode,
  capture: captureOption,
  visualReview: visualReviewOption,
  ...captureSize,
  idempotencyKey
})

const inputSchema = z.discriminatedUnion('operation', [
  previewInput,
  applyInput,
  executeInput,
  statusInput
])
export { inputSchema as pcccFireAlarmInputSchema }

/** The authenticated caller's workspaceId when the transport carries one (HTTP + device auth).
 * A transport without it (stdio smoke) gets no catalog resolution — falls straight to the
 * built-in default geometry. */
function callerWorkspaceId(ctx: {
  http?: { authInfo?: { extra?: Record<string, unknown> } }
}): string | undefined {
  const ws = ctx.http?.authInfo?.extra?.workspaceId
  return typeof ws === 'string' ? ws : undefined
}

/**
 * Resolves every missing device type WITHOUT a library DWG (Slice 06 of pccc-cad-drawing-truth):
 * an approved `cad_symbol_catalog` row (`pccc_fire_alarm.<TYPE>`, `geometryJson`-sourced) wins when
 * the workspace registered one, else Aleph's own built-in default geometry — which always covers
 * every `REQUIRED_PCCC_SYMBOLS` type, so this never fails the way the library-DWG path can.
 * `block.ensureDefinition` builds whichever of these the drawing still lacks, at apply time.
 */
async function resolveDefaultSymbols(
  workspaceId: string | undefined,
  missing: readonly FireAlarmDeviceType[]
): Promise<{
  blockMap: PcccBlockAssignment
  pendingDefinitions: Array<{ blockName: string; entities: Record<string, unknown>[] }>
}> {
  const blockMap: PcccBlockAssignment = {}
  const pendingDefinitions: Array<{ blockName: string; entities: Record<string, unknown>[] }> = []
  for (const type of missing) {
    const catalogEntry = workspaceId
      ? await resolveSymbolCatalogEntry(workspaceId, `pccc_fire_alarm.${type}`)
      : null
    if (catalogEntry?.geometryJson) {
      blockMap[type] = catalogEntry.blockName
      pendingDefinitions.push({
        blockName: catalogEntry.blockName,
        entities: catalogEntry.geometryJson
      })
    } else {
      const blockName = DEFAULT_PCCC_BLOCK_NAMES[type]
      blockMap[type] = blockName
      pendingDefinitions.push({ blockName, entities: DEFAULT_PCCC_SYMBOL_GEOMETRY[type] })
    }
  }
  return { blockMap, pendingDefinitions }
}

/** The target drawing's full name + coarse revision, as the plugin reports them. */
async function resolveDocument(
  bridge: BridgeClient,
  documentName: string | undefined
): Promise<{ name: string; revision: string }> {
  const info = await bridge.request(RpcMethod.DrawingInfo, { documentName })
  return { name: info.name, revision: info.revision ?? '' }
}

/** Every block definition name in a drawing (layout/anonymous names are filtered by the resolver). */
async function listBlockNames(bridge: BridgeClient, doc: string | undefined): Promise<string[]> {
  const result = await bridge.request(RpcMethod.BlockList, { documentName: doc })
  return result.blocks.map((b) => b.name)
}

/**
 * The planner returns loose records, and this is the seam where they become a batch the plugin can
 * execute. Parsing through the same schema `entity`/`operations` already validate against turns two
 * classes of past failure into a named field in a Cloud-side error: a kind the plugin has no create
 * handler for (`single_line_text` — the whole batch aborted with `Unknown entity kind`), and a point
 * in the planner's internal `[x, y]` form rather than the wire's `{x,y,z}` (the plugin's
 * `Point3dDto` has no array form, so it failed mid-transaction with a C# deserialization message
 * after other entities in the batch had already been written).
 */
function toWireOperations(operations: CadOperation[]): EntityOperation[] {
  const wire: EntityOperation[] = []
  const rejected: string[] = []
  for (const [index, step] of operations.entries()) {
    const parsed = createEntityParams.safeParse(step.entity)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      rejected.push(
        `operations[${index}] (kind ${String(step.entity.kind)}): ` +
          `${issue?.path.join('.') || '(root)'} — ${issue?.message ?? 'invalid'}`
      )
      continue
    }
    // The same alias/canonical + preset pass `operations.apply` runs on model-supplied steps, which
    // is what turns a compact [x,y] into the {x,y,z} the plugin deserializes.
    for (const entity of expandEntity(parsed.data, 'rad')) wire.push({ op: 'create', entity })
  }
  if (rejected.length > 0) {
    const more = rejected.length > 8 ? ` (+${rejected.length - 8} more)` : ''
    throw new Error(
      `The generated plan contains ${rejected.length} operation(s) AutoCAD cannot draw, so nothing ` +
        `was sent: ${rejected.slice(0, 8).join('; ')}${more}. This is a defect in the layout plan, ` +
        `not in the input — re-preview; if it repeats, report the planId.`
    )
  }
  return wire
}

/**
 * One representative block-reference handle per definition name in the library drawing.
 * `entity.copyTo` deep-clones the definition plus its dependent layers/styles, so one instance per
 * name is enough to import the definition itself (model-space instances are erased afterwards).
 */
async function libraryHandlesByName(
  bridge: BridgeClient,
  libraryDoc: string
): Promise<Map<string, string>> {
  const byName = new Map<string, string>()
  const pageSize = 200
  for (let offset = 0; offset < 2000; offset += pageSize) {
    const page = await bridge.request(RpcMethod.EntityList, {
      documentName: libraryDoc,
      kind: 'blockReference',
      detail: 'full',
      limit: pageSize,
      offset
    })
    for (const entity of page.entities as Array<{
      handle: string
      geometry?: { blockName?: string }
      blockName?: string
    }>) {
      const name = entity.geometry?.blockName ?? entity.blockName
      if (name && !byName.has(name)) byName.set(name, entity.handle)
    }
    if (offset + page.entities.length >= page.total) break
  }
  return byName
}

/**
 * Clone the definitions a previewed plan needs into the target drawing — the write half of the
 * symbol resolution, kept out of preview so a read-only call never touches the user's DWG.
 * Deliberately NOT journaled with a taskId: the cloned instances are erased immediately (they only
 * carry the definition in), and `operations.revert(taskId)` refuses a change set whose created
 * handle no longer exists (`RevertConflict`) — journaling this copy would make the whole overlay
 * un-revertable. What stays behind is the block DEFINITION only: inert, invisible in the drawing,
 * purgeable, and needed by the overlay's own entities until it is reverted.
 * Returns the definition names now present; throws when the library turns out not to hold one
 * (its contents changed since preview).
 */
async function importSymbolDefinitions(
  bridge: BridgeClient,
  pending: PendingSymbolImport,
  target: { name: string }
): Promise<string[]> {
  const library = await bridge.request(
    RpcMethod.DrawingOpen,
    { path: pending.libraryPath, readOnly: true },
    { timeoutMs: DRAWING_OPEN_TIMEOUT_MS }
  )
  try {
    const handles = await libraryHandlesByName(bridge, library.name)
    const cloneHandles = pending.blockNames
      .map((name) => handles.get(name))
      .filter((h): h is string => Boolean(h))
    const notInLibrary = pending.blockNames.filter((name) => !handles.has(name))
    if (notInLibrary.length > 0) {
      throw new Error(
        `symbol library "${pending.libraryPath}" no longer holds: ${notInLibrary.join(', ')} — re-preview so the plan resolves against the current library.`
      )
    }
    if (cloneHandles.length === 0) return []

    const copyRes = await bridge.request(RpcMethod.EntityCopyTo, {
      documentName: library.name,
      targetDocumentName: target.name,
      handles: cloneHandles
    })
    // The cloned instances only carried the definitions; do not leave stray sample symbols
    // scattered through the user's drawing.
    await bridge
      .request(RpcMethod.EntityErase, {
        documentName: target.name,
        handles: (copyRes.copied ?? []).map((c) => c.handle)
      })
      .catch(() => undefined)
    return pending.blockNames
  } finally {
    // Never leave the library tab open in the user's AutoCAD, even if the copy failed.
    await bridge
      .request(RpcMethod.DrawingClose, { documentName: library.name })
      .catch(() => undefined)
  }
}

const FLOOR_ENVELOPE_FRACTION = 0.8

/** Rejects the live failure where a caller relabels the attributed floor frame as one room. */
export function callerBoundaryIsFloorEnvelope(
  boundary: Point2D[],
  region: readonly [number, number, number, number]
): boolean {
  const box = bboxOf(boundary)
  if (!box) return false
  const [minX, minY, maxX, maxY] = region
  const width = maxX - minX
  const height = maxY - minY
  if (width <= 0 || height <= 0) return false
  const toleranceX = Math.max(width * 0.01, 1e-6)
  const toleranceY = Math.max(height * 0.01, 1e-6)
  const fillsFrame =
    Math.abs(box.minX - minX) <= toleranceX &&
    Math.abs(box.maxX - maxX) <= toleranceX &&
    Math.abs(box.minY - minY) <= toleranceY &&
    Math.abs(box.maxY - maxY) <= toleranceY
  return fillsFrame && areaOf(boundary) >= width * height * FLOOR_ENVELOPE_FRACTION
}

function point2(value: unknown): Point2D | null {
  if (!value || typeof value !== 'object' || !('x' in value) || !('y' in value)) return null
  const x = value.x
  const y = value.y
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? [x, y]
    : null
}

function blockEvidence(
  rows: readonly SnapshotRow[],
  blockName: string
): Array<{ handle: string; point: Point2D }> {
  const found: Array<{ handle: string; point: Point2D }> = []
  for (const row of rows) {
    if (row.kind !== 'blockReference') continue
    const geometry = row.geometry ?? {}
    const geometryName =
      'blockName' in geometry && typeof geometry.blockName === 'string'
        ? geometry.blockName
        : undefined
    if ((row.blockName ?? geometryName) !== blockName) continue
    const point = 'position' in geometry ? point2(geometry.position) : null
    if (point) found.push({ handle: row.handle, point })
  }
  return found
}

function structuralLayer(layer: string | undefined): boolean {
  if (!layer) return false
  const folded = layer
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
  // Deliberately conservative: an explicit structural/beam token in the CAD-authored layer name.
  // A generic grid/axis layer is not enough evidence that cable tray may run on it.
  return /(^|[-_.\s])(beam|dam|struct|structural|ket[-_.\s]*cau)([-_.\s]|$)/.test(folded)
}

function geometryPoints(row: SnapshotRow): Point2D[] {
  const geometry = row.geometry ?? {}
  if (row.kind === 'line') {
    const start = 'start' in geometry ? point2(geometry.start) : null
    const end = 'end' in geometry ? point2(geometry.end) : null
    return start && end ? [start, end] : []
  }
  if (row.kind !== 'polyline' || !('vertices' in geometry) || !Array.isArray(geometry.vertices))
    return []
  const points: Point2D[] = []
  for (const vertex of geometry.vertices) {
    if (!vertex || typeof vertex !== 'object' || !('point' in vertex)) continue
    const point = point2(vertex.point)
    if (point) points.push(point)
  }
  return points
}

/**
 * Structural axes read from real beam-layer entities, along one coordinate.
 * `axis === 'y'` keeps horizontal segments (constant Y); `axis === 'x'` keeps vertical ones
 * (constant X). No matching evidence means []. A span whose endpoints sit on a vertical beam
 * grid but no horizontal one used to fail NO_STRUCTURAL_HIGHWAY even though a real beam carried it.
 */
function deriveBeamAxes(
  rows: readonly SnapshotRow[],
  unitsPerMetre: number | null,
  axis: 'x' | 'y'
): number[] {
  const tolerance = unitsPerMetre === null ? 1e-6 : unitsPerMetre * 0.05
  const fixed = axis === 'y' ? 1 : 0
  const along = axis === 'y' ? 0 : 1
  const axes: number[] = []
  for (const row of rows) {
    if (!structuralLayer(row.layer)) continue
    const points = geometryPoints(row)
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      if (Math.abs(a[fixed] - b[fixed]) > tolerance || Math.abs(a[along] - b[along]) <= tolerance)
        continue
      const v = (a[fixed] + b[fixed]) / 2
      if (!axes.some((existing) => Math.abs(existing - v) <= tolerance)) axes.push(v)
    }
  }
  return axes.sort((a, b) => a - b)
}

/** Horizontal structural axes read from real beam-layer entities; no matching evidence means []. */
export function deriveBeamYHighways(
  rows: readonly SnapshotRow[],
  unitsPerMetre: number | null
): number[] {
  return deriveBeamAxes(rows, unitsPerMetre, 'y')
}

/** Vertical structural axes read from real beam-layer entities; no matching evidence means []. */
export function deriveBeamXHighways(
  rows: readonly SnapshotRow[],
  unitsPerMetre: number | null
): number[] {
  return deriveBeamAxes(rows, unitsPerMetre, 'x')
}

export function registerPcccFireAlarmTools(
  server: McpServer,
  baseBridge: BridgeClient,
  // Same CAD State seam `drawing.inspect_floorplan` reads. Without tenant context it stays undefined:
  // ref-addressed rooms then resolve to nothing and block with ROOM_REF_UNRESOLVED, never a
  // fabricated outline.
  cadState?: RegionGeometrySource,
  /** Shared with drawing.inspect_floorplan when registered via registerAllTools. */
  sharedRegionCache?: RegionCache
): void {
  // Scopes to this registration so it can never outlive the server whose drawing it describes.
  const regionCache = sharedRegionCache ?? createRegionCache()

  server.registerTool(
    'pccc_fire_alarm_overlay',
    {
      title: 'PCCC Fire Alarm 1-Shot Overlay Executor',
      description:
        `Compile and draw a complete automatic fire alarm system (TCVN 7568-14:2025, which superseded ` +
        `TCVN 5738:2021) in ONE step, inserting every ` +
        `device as a block reference resolved against the definitions that ACTUALLY exist in the drawing — never ` +
        `substitute shapes. Block names are read from block.list, so do not guess them. A device type the drawing ` +
        `lacks resolves automatically: an approved cad_symbol_catalog entry if the workspace registered one, else ` +
        `Aleph's own built-in default symbol geometry (covers every required type with no file needed). Pass ` +
        `symbolLibraryPath only to override with a specific library DWG (e.g. "ki hieu.dwg", a path on the machine ` +
        `running AutoCAD) instead of the default — preview proves it holds the matching definitions and apply ` +
        `clones them in; a device type missing from THAT library blocks the plan with MISSING_SYMBOL:<type> rather ` +
        `than drawing a stand-in. ` +
        `operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `preview: requires floorplanName (the plan title as the sheet writes it). Address each room by the ` +
        `ref that drawing.inspect_floorplan published, plus its usage — the tool then takes the room's closed ` +
        `outline from the drawing itself; retyping vertices is what produced boxes copied from a container's ` +
        `extents. The tool also resolves that plan's real region with drawing.inspect_floorplan and blocks the ` +
        `plan with ROOM_OUTSIDE_FLOORPLAN if any room polygon lies outside it, FLOORPLAN_REGION_UNRESOLVED if ` +
        `the title matches no attributed region, or ROOM_REF_UNRESOLVED (naming the refs that do resolve) when ` +
        `a room has no outline the drawing can confirm — the overlay is never drawn beside the floor plan it ` +
        `belongs to, nor over a room whose walls the sheet does not show. Each planned room reports ` +
        `boundarySource: cad | caller so the reviewer sees which geometry the design actually used. ` +
        `preview also resolves symbols (reading the library DWG to PROVE it holds a definition the drawing lacks, without writing anything), runs the sensor classifier (heat for garage, smoke for tech/office), ` +
        `the coverage layout — the grid pitch comes from the clause REACH (every protected ceiling point ` +
        `within 7,2 m of a smoke detector, 5,1 m of a heat detector), then audited at reach/4 so a void or ` +
        `shaft cannot leave a blind patch that the device count would still report as designed ` +
        `(UNCOVERED_CEILING blocks the plan) — and structural beam highway routing (strictly non-branching Daisy-Chain, no ` +
        `elevator-shaft crossing) — preview writes NOTHING to the drawing. ` +
        `apply: clones any missing symbol definitions in (definitions only — the probe instances are erased, so the import is NOT part of the revertable unit; revert rolls back the drawn entities), then draws a non-blocked plan atomically as ONE journaled batch; a blocked plan is refused. ` +
        `execute: compile + every gate + draw in a SINGLE call — the same path as preview then apply, and it draws ONLY when no gate blocked. A blocked plan is reported with its violations and nothing is drawn, exactly like preview. Choose it for the ordinary one-shot job; keep preview/apply when a human must review the plan between the steps.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    mutatingGuarded(async (input: z.infer<typeof inputSchema>, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)

      // The single drawing path for a committed plan, shared by `apply` and by `execute` after it
      // compiles a non-blocked plan. Both must behave identically: import the symbols the probe only
      // PROVED exist, re-check the revision the plan was minted against, and commit as ONE journaled
      // batch under the operation identity. One implementation is what stops `execute` silently
      // drawing through a weaker path than `apply`.
      const drawCommittedPlan = async (
        plan: FireAlarmPlanRecord,
        draw: {
          result: z.infer<typeof refsResultMode> | undefined
          capture: z.infer<typeof captureOption>
          visualReview: 'unavailable' | undefined
          width: number | undefined
          height: number | undefined
          idempotencyKey: string | undefined
        }
      ) => {
        if (plan.unitsPerMetre === null) {
          throw new Error(
            `Plan "${plan.planId}" was minted without resolved drawing units — it cannot be ` +
              `measured, read back, or drawn. Re-preview after declaring units with drawing.setup.`
          )
        }
        requireVisualReview(plan.cadOperations.length, draw.capture, draw.visualReview)

        // The plan was minted against a revision that may lack the symbol definitions, which
        // preview only PROBED. Clone them now, then re-read the revision the batch precondition
        // must match: the import itself moved it.
        // An empty preview revision means drawing.info was unavailable then, so there is nothing
        // to compare; the native precondition is skipped rather than compared against "".
        let expectedRevision = plan.revisionAtPreview || undefined
        let importedBlocks: string[] = []
        // The drawing batch carries the operation identity as its task id, so
        // operations.revert(taskId) rolls the whole overlay back as one unit (#413 §11.5). The
        // symbol import is intentionally OUTSIDE that unit — see importSymbolDefinitions.
        const taskId = operationKey(ctx, draw.idempotencyKey)
        if (plan.pendingImport) {
          const target = await resolveDocument(bridge, plan.documentName || undefined)
          if (plan.revisionAtPreview && target.revision !== plan.revisionAtPreview) {
            throw new Error(
              `Drawing "${target.name}" changed between preview and apply (${plan.revisionAtPreview} -> ${target.revision}) — the plan is stale; re-preview so the symbol check and the drawing agree.`
            )
          }
          importedBlocks = await importSymbolDefinitions(bridge, plan.pendingImport, target)
          expectedRevision =
            (await resolveDocument(bridge, plan.documentName || undefined)).revision || undefined
        } else if (plan.pendingDefinitions) {
          const target = await resolveDocument(bridge, plan.documentName || undefined)
          if (plan.revisionAtPreview && target.revision !== plan.revisionAtPreview) {
            throw new Error(
              `Drawing "${target.name}" changed between preview and apply (${plan.revisionAtPreview} -> ${target.revision}) — the plan is stale; re-preview so the symbol check and the drawing agree.`
            )
          }
          // No library DWG involved at all: each entry is either a workspace's approved
          // cad_symbol_catalog geometry or Aleph's built-in default — block.ensureDefinition
          // builds whichever of these the drawing still lacks, in the already-open document.
          for (const def of plan.pendingDefinitions) {
            await bridge.request(RpcMethod.BlockEnsureDefinition, {
              documentName: target.name,
              blockName: def.blockName,
              entities: def.entities as CreateEntityParams[]
            })
          }
          importedBlocks = plan.pendingDefinitions.map((def) => def.blockName)
          expectedRevision =
            (await resolveDocument(bridge, plan.documentName || undefined)).revision || undefined
        }

        // E9: re-check the STORED batch against the inspected region before drawing. Only
        // detector placements are gated: the junction box and call points sit on
        // caller-supplied anchors, and wires legitimately traverse corridors outside the
        // rooms, so those block names are exempt here (preview gates the same set).
        const exemptBlocks = [
          plan.blockNames.JUNCTION_BOX,
          plan.blockNames.MANUAL_CALL_POINT,
          plan.blockNames.COMBINATION_ALARM
        ].filter((b): b is string => typeof b === 'string' && b.length > 0)
        const scopeViolation = checkOperationsScope(plan.cadOperations, plan.scope, {
          tolerance: SCOPE_TOLERANCE_MM * (plan.unitsPerMetre / 1000),
          exemptBlockNames: exemptBlocks
        })
        if (scopeViolation) {
          throw new Error(scopeViolation)
        }
        const { refs, payload, claim } = await applyBatch(bridge, plan.cadOperations, {
          progressive: false,
          paceMs: 0,
          result: draw.result ?? 'summary',
          ensureLayer: true,
          documentName: plan.documentName || undefined,
          taskId,
          idempotencyKey: taskId,
          signal: ctx.mcpReq.signal,
          // #413 phase A: the plugin re-checks this atomically before its transaction opens,
          // closing the window between the reads above and the commit.
          expectedRevision
        })

        plan.consumed = true
        plan.lastApplyReceipt = {
          status: payload.status,
          batchId: payload.batchId,
          committedOperations: payload.committedOperations
        }

        // Post-apply verification: a batch that did not land is never reported committed.
        if (payload.status !== 'committed') {
          throw new Error(
            `Plan "${plan.planId}" was not committed (apply reported status ` +
              `"${String(payload.status)}", error: ${JSON.stringify(payload.error)}) — nothing is reported as drawn.`
          )
        }
        if (refs.length === 0 && plan.cadOperations.length > 0) {
          throw new Error(
            `Plan "${plan.planId}" applied 0 entities for ${plan.cadOperations.length} planned ` +
              `operations — the batch is not reported committed.`
          )
        }
        let readback: PlanReadbackReport
        try {
          readback = await verifyPcccApply(
            bridge,
            plan.documentName || undefined,
            plan.cadOperations,
            plan.unitsPerMetre
          )
        } catch (err) {
          throw new Error(
            `Post-apply read-back verification could not run for plan "${plan.planId}": ` +
              `${(err as Error).message} — the batch is not reported committed. ` +
              `The batch itself already committed: revert it with operations.revert(taskId ` +
              `"${taskId}") before retrying — the plan is consumed and a fresh apply would ` +
              `duplicate the entities.`
          )
        }
        if (!readback.faithful) {
          throw new Error(
            `Post-apply read-back verification FAILED for plan "${plan.planId}": ` +
              `${readback.discrepancies.join('; ')} (${readback.stats.matchedSteps}/` +
              `${readback.stats.totalSteps} steps matched). The batch committed but did not ` +
              `land as planned — it is not reported committed. Revert it with ` +
              `operations.revert(taskId "${taskId}") before retrying — the plan is consumed ` +
              `and a fresh apply would duplicate the entities.`
          )
        }
        plan.lastReadback = {
          status: readback.status,
          faithful: readback.faithful,
          matchedSteps: readback.stats.matchedSteps,
          totalSteps: readback.stats.totalSteps
        }

        return withCapture(
          bridge,
          {
            planId: plan.planId,
            deviceCount: plan.deviceCount,
            wireLengthM: plan.wireLengthM,
            ...(importedBlocks.length > 0 && { importedFromLibrary: importedBlocks }),
            ...payload,
            readback: plan.lastReadback
          },
          {
            mode: draw.capture,
            handles: refs.map((ref) => ref.handle),
            review: draw.visualReview,
            documentName: plan.documentName || undefined,
            width: draw.width,
            height: draw.height
          },
          outcomeMeta(claim)
        )
      }

      // The one compile+gate path, shared by `preview` and by `execute` before it draws. It resolves
      // the floor-plan region and every room outline from the drawing, resolves symbols against the
      // definitions that ACTUALLY exist, traces unbounded elevators from their labels, runs the
      // planner, and applies every read-only gate — minting a plan record that says whether it is
      // blocked and why. It writes NOTHING to the drawing. `execute` draws the record only when
      // `blocked` is false, so both operations see identical gates: there is no weaker path.
      // Both `preview` and `execute` feed this; the compile step never reads `operation`, so the
      // parameter is their union rather than one literal.
      const compilePlan = async (
        input: z.infer<typeof previewInput> | z.infer<typeof executeInput>
      ) => {
        prunePlans()
        const doc = input.documentName
        console.log(
          `\x1b[36m[PCCC-FIRE-ALARM]\x1b[0m COMPILE request on doc="${doc ?? '(active)'}" with ${input.rooms?.length ?? 0} rooms`
        )

        let target = { name: doc ?? '', revision: '' }
        try {
          target = await resolveDocument(bridge, doc)
        } catch {
          // Tolerated if drawing info is unavailable
        }
        let revision = target.revision

        // E8: resolve the drawing's real units from drawing.summary before measuring anything.
        // Unknown units do not stop the region/symbol reads below, but the planner refuses to
        // measure on them (UNKNOWN_DRAWING_UNITS) and the plan is blocked — never a silent
        // millimetre assumption.
        const units = await resolveDrawingUnits(bridge, doc)

        // Every coordinate this tool is handed was written by a caller, not read from the drawing.
        // Resolve the floor plan's own region first, and refuse the whole plan if any room polygon
        // falls outside it: a 1000x1000 placeholder square, a box pasted from a container's extents, or
        // a plan aimed beside the frame it belongs to all produce a design that is internally
        // consistent and spatially wrong, and the only thing that can tell them apart is the sheet.
        const designRegion = await resolveDesignRegion(
          bridge,
          cadState,
          regionCache,
          // Two AutoCAD instances can hold same-named documents at the same revision counter, so the
          // key carries the instance and the resolved name — never the caller's raw documentName,
          // which may be undefined ("whatever is active") and change between calls.
          target.name && revision
            ? designRegionCacheKey({
                instanceId: input.instanceId,
                documentName: target.name,
                floorplanName: input.floorplanName,
                revision,
                layoutName: input.floorplanLayoutName ?? 'Model',
                candidateIndex: input.candidateIndex
              })
            : null,
          input.floorplanName,
          doc,
          input.floorplanLayoutName,
          { candidateIndex: input.candidateIndex }
        )
        const regionProblems: string[] = []
        // Rooms the planner may use, each with a boundary that is either the caller's polygon or the
        // drawing's own outline. Nothing downstream sees a room without a real closed ring.
        const plannedRooms: FireAlarmRoomInput[] = []
        // Label points of elevator rooms the sheet could not bound; the plugin's native boundary trace
        // turns each into a real shaft polygon below, so a named elevator still excludes detectors and
        // reroutes wiring even when its outline is a merged block.
        const elevatorLabelPoints: Point2D[] = []
        // What each requested room's outline actually came from, reported back so a reviewer can see
        // the design rests on the drawing's geometry rather than typed coordinates.
        const plannedGeometry: Array<{
          id: string
          name: string
          ref?: string
          boundarySource: 'cad' | 'caller'
          areaM2?: number
        }> = []

        const callerRooms = (input.rooms ?? []).some(
          (r) => r.boundary !== undefined || (r.excludedBoundaries && r.excludedBoundaries.length > 0)
        )
        if (
          (callerRooms || (input.elevatorShafts && input.elevatorShafts.length > 0)) &&
          input.acceptCallerGeometry !== true
        ) {
          regionProblems.push(
            'CALLER_GEOMETRY_REQUIRES_ACCEPT: rooms[].boundary / rooms[].excludedBoundaries / ' +
              'elevatorShafts need acceptCallerGeometry:true (drafting-only). Prefer room refs and ' +
              'excludedRefs from drawing.inspect_floorplan and elevatorPickPoints so outlines come from CAD.'
          )
        }

        if ('problem' in designRegion) {
          regionProblems.push(`FLOORPLAN_REGION_UNRESOLVED: ${designRegion.problem}`)
        } else if (!regionProblems.some((p) => p.startsWith('CALLER_GEOMETRY_REQUIRES_ACCEPT'))) {
          for (const room of input.rooms ?? []) {
            const located = locateRoom(designRegion.rooms, room)
            // Prefer CAD outline whenever inspect published one; caller polygon is draft-only fallback.
            const fromDrawing = located?.boundary
            // A room the sheet already names but could not bound must NOT be filled in with typed
            // coordinates: that is how grid-axis rectangles (Trục 1/6/A/D) became "room boundaries"
            // and detectors landed outside the real walls. Only a room the sheet does not know at all
            // may take a caller polygon (still checked against the plan region below).
            const callerBoundary =
              !located && input.acceptCallerGeometry === true ? room.boundary : undefined
            const boundary = fromDrawing ?? callerBoundary
            const name = room.name ?? located?.name ?? room.ref ?? room.id
            if (!boundary) {
              const why = !located
                ? room.ref
                  ? `no room on this sheet has the ref "${room.ref}"`
                  : `no room labelled "${room.name}" was found in ${input.floorplanName}`
                : located.boundaryStatus === 'verified'
                  ? 'its verified outline could not be read from the CAD State snapshot' 
                  : `its boundary is ${located.boundaryStatus}: ${located.boundaryEvidence ?? 'no single closed ring contains the label'}`
                    + (room.boundary
                      ? ' — a typed polygon was supplied but is rejected for a room the drawing already names; close the real ring in the drawing (or pass elevatorPickPoints) instead of typing coordinates'
                      : '')
              if (room.usage === 'elevator') {
                // A shaft is a hole in the design, not a room to protect: an unbounded elevator still
                // gets traced from its label rather than blocking the whole plan.
                if (located) elevatorLabelPoints.push(located.labelPosition)
                else
                  regionProblems.push(
                    `ROOM_REF_UNRESOLVED: "${room.id}" is an elevator with ref/name ` +
                      `${room.ref ?? `"${room.name}"`} that this sheet does not report, so the shaft ` +
                      `cannot be excluded — pass elevatorShafts polygons or elevatorPickPoints.`
                  )
                continue
              }
              regionProblems.push(
                `ROOM_REF_UNRESOLVED: "${room.id}" (${room.usage}) has no boundary and ${why}. ` +
                  `Rooms this read resolved: ${resolvedRoomSummary(designRegion.rooms)}. ` +
                  `Nothing is drawn over a room whose outline the drawing cannot confirm — reference it ` +
                  `by ref from drawing.inspect_floorplan, or acceptCallerGeometry:true with a boundary ` +
                  `from entity.traceBoundary — not coordinates written in the brief.`
              )
              continue
            }
            if (
              !fromDrawing &&
              room.boundary &&
              callerBoundaryIsFloorEnvelope(boundary, designRegion.bounds)
            ) {
              regionProblems.push(
                `ROOM_IS_FLOOR_ENVELOPE: "${name}" boundary matches the attributed floor frame itself ` +
                  `(${input.floorplanName} at [${designRegion.bounds.join(', ')}]), not a room inside ` +
                  `it — nothing is protected as "one room" the size of the whole floor. Take the ` +
                  `room's own closed outline from the drawing (drawing.inspect_floorplan rooms, ` +
                  `entity.traceBoundary), not the floor-plan frame.`
              )
              continue
            }
            // Spaces to skip coverage for inside this room. Their outlines come from the drawing
            // (excludedRefs resolved against the same CAD read as the room), never a box typed around
            // where the model thinks the space stands. A typed ring is accepted only with
            // acceptCallerGeometry:true, and every ring must actually overlap the room — the planner
            // subtracts an exclusion's whole area regardless of where it sits, so a zone that misses
            // the room would overstate coverage while protecting the space it was named for.
            const excluded = resolveExcludedRings(
              designRegion.rooms,
              room.excludedRefs ?? [],
              input.acceptCallerGeometry === true ? (room.excludedBoundaries ?? []) : [],
              boundary
            )
            regionProblems.push(...excluded.problems)
            plannedRooms.push({
              id: room.id,
              name,
              usage: room.usage,
              boundary,
              ...(room.heightMm !== undefined && { heightMm: room.heightMm }),
              ...(excluded.rings.length > 0 && { excludedBoundaries: excluded.rings })
            })
            plannedGeometry.push({
              id: room.id,
              name,
              // `cad` means the outline is the drawing's own closed ring; `caller` means the polygon in
              // the request, which was still checked against the plan region. Area is only reported for
              // a CAD-derived ring — the assembler measured it in the drawing's own units.
              boundarySource: fromDrawing ? 'cad' : 'caller',
              ...(located?.ref && { ref: located.ref }),
              ...(fromDrawing && located?.areaM2 !== undefined && { areaM2: located.areaM2 })
            })
            const box = bboxOf(boundary)
            if (box && leavesRegion(box, designRegion.bounds)) {
              regionProblems.push(
                `ROOM_OUTSIDE_FLOORPLAN: "${name}" spans x[${box.minX}..${box.maxX}] ` +
                  `y[${box.minY}..${box.maxY}], outside ${input.floorplanName} at ` +
                  `[${designRegion.bounds.join(', ')}] (${designRegion.basis}). Its detectors and ` +
                  `wiring would be drawn on the wrong part of the sheet — take the boundary from CAD ` +
                  `geometry (drawing.inspect_floorplan rooms, entity.traceBoundary) rather than from ` +
                  `coordinates written in the brief.`
              )
            }
          }
          if (plannedRooms.length === 0 && regionProblems.length === 0)
            regionProblems.push(
              `NO_ROOM_GEOMETRY: no room in this request resolved to a boundary. Rooms this read ` +
                `resolved: ${resolvedRoomSummary(designRegion.rooms) || '(none — the sheet has no room labels in model space)'}.`
            )
        }

        // Resolve the symbol set against block definitions that ACTUALLY exist in the target drawing,
        // importing them from the library DWG when absent. Names are read from block.list, never
        // hardcoded — hardcoded guesses matched nothing, every blockReference was refused, and the
        // layout degraded into hand-drawn white circles.
        // THIS STEP IS READ-ONLY: it may verify a symbol library holds the definitions the plan needs,
        // but the clone itself happens when the plan is drawn. An import here mutated the user's
        // drawing, moved its revision mid-preview, and was classified `read` by RunService's operation
        // table, so the mutation never invalidated the CAD State cache nor recorded a mutation.
        let symbolProblem: string | null = null
        let pendingImport: PendingSymbolImport | null = null
        let pendingDefinitions: Array<{
          blockName: string
          entities: Record<string, unknown>[]
        }> | null = null

        const targetNames = await listBlockNames(bridge, doc)
        const fromTarget = resolvePcccBlocks(targetNames)
        // The plan's block map starts as the drawing's own definitions; the library only fills the
        // device types the drawing lacks, and those are exactly what the draw step will clone.
        const blockMap: PcccBlockAssignment = { ...fromTarget.blocks }

        if (fromTarget.missing.length > 0) {
          if (!input.symbolLibraryPath) {
            // No library DWG named: resolve every missing type through the workspace's approved
            // cad_symbol_catalog entry (geometryJson-sourced) or Aleph's own built-in default
            // geometry (Slice 06 of pccc-cad-drawing-truth) — this never fails the way the
            // library-DWG path can, so a workspace with no symbol library file still gets a plan.
            const workspaceId = callerWorkspaceId(ctx)
            const resolved = await resolveDefaultSymbols(workspaceId, fromTarget.missing)
            for (const [type, blockName] of Object.entries(resolved.blockMap)) {
              blockMap[type as FireAlarmDeviceType] = blockName
            }
            pendingDefinitions = resolved.pendingDefinitions
          } else {
            try {
              const library = await bridge.request(
                RpcMethod.DrawingOpen,
                { path: input.symbolLibraryPath, readOnly: true },
                { timeoutMs: DRAWING_OPEN_TIMEOUT_MS }
              )
              try {
                const libraryNames = await listBlockNames(bridge, library.name)
                const fromLibrary = resolvePcccBlocks(libraryNames)
                const importFor = fromTarget.missing.filter((type) => fromLibrary.blocks[type])
                const stillMissing = fromTarget.missing.filter((type) => !fromLibrary.blocks[type])
                if (stillMissing.length > 0) {
                  // Naming the library's definitions is what lets the caller see whether the symbol
                  // exists under another spelling. Truncating silently is actively harmful: it reads as
                  // "this is the whole library", so a caller can conclude a symbol is absent when it is
                  // simply past the cut. Report the real total and say the list is partial.
                  const shown = libraryNames.slice(0, 40)
                  symbolProblem =
                    `"${input.symbolLibraryPath}" has no block definition matching: ` +
                    `${stillMissing.join(', ')} — the library defines ${libraryNames.length} block(s)` +
                    `${libraryNames.length > shown.length ? `, showing ${shown.length}:` : ':'} ` +
                    `${shown.join(', ') || '(none)'}. Do not retry this call with different wording: ` +
                    `the same definitions are on disk. Either add the missing symbol to the library ` +
                    `drawing, or drop the device type from the plan.`
                } else {
                  for (const type of importFor) blockMap[type] = fromLibrary.blocks[type]!
                  pendingImport = {
                    libraryPath: input.symbolLibraryPath,
                    blockNames: [...new Set(importFor.map((type) => fromLibrary.blocks[type]!))]
                  }
                }
              } finally {
                // Never leave the library tab open in the user's AutoCAD, even if the probe failed.
                await bridge
                  .request(RpcMethod.DrawingClose, { documentName: library.name })
                  .catch(() => undefined)
              }
            } catch (err) {
              symbolProblem =
                `symbol library "${input.symbolLibraryPath}" could not be read: ` +
                `${(err as Error).message}`
            }
          }
        }

        const resolvedBlocks: PcccBlockAssignment = blockMap

        // E7 auto-derivation: if the caller left `junctionBoxLocation` empty, look for the real
        // block instance the planner would otherwise ask for by name. Exactly one real instance in
        // the attributed region is trusted; zero or several are left to the existing NO_PANEL_ANCHOR
        // fail-closed path — this never guesses between candidates.
        const evidenceRows = 'problem' in designRegion ? [] : designRegion.evidenceRows
        let effectiveJunctionBoxLocation = input.junctionBoxLocation
        if (!effectiveJunctionBoxLocation && resolvedBlocks.JUNCTION_BOX) {
          const candidates = blockEvidence(evidenceRows, resolvedBlocks.JUNCTION_BOX)
          if (candidates.length === 1) {
            effectiveJunctionBoxLocation = candidates[0]!.point
          } else if (candidates.length > 1) {
            regionProblems.push(
              `PANEL_ANCHOR_AMBIGUOUS: ${candidates.length} "${resolvedBlocks.JUNCTION_BOX}" ` +
                `instances exist in this region (handles: ${candidates.map((c) => c.handle).join(', ')}) ` +
                `— pass junctionBoxLocation naming the one real panel this plan feeds.`
            )
          }
        }

        // E-beam auto-derivation: real structural-layer line/polyline evidence in the attributed
        // region, never a guessed axis. Absent evidence leaves beamYHighways empty, same as today.
        const effectiveBeamYHighways =
          input.beamYHighways && input.beamYHighways.length > 0
            ? input.beamYHighways
            : deriveBeamYHighways(evidenceRows, units?.unitsPerMetre ?? null)
        const effectiveBeamXHighways =
          input.beamXHighways && input.beamXHighways.length > 0
            ? input.beamXHighways
            : deriveBeamXHighways(evidenceRows, units?.unitsPerMetre ?? null)

        // Elevator shafts named by an interior point become real polygons through the plugin's native
        // boundary trace — the bridge between "the model can see the elevator" and "the router must
        // avoid it" on drawings whose architecture is a single merged block.
        const elevatorShafts = [
          ...(input.acceptCallerGeometry === true ? (input.elevatorShafts ?? []) : [])
        ]
        const shaftProblems: string[] = []

        // Auto-harvest candidate elevator pick points: an elevator the sheet named but could not bound
        // still gets its shaft traced from the label, so it excludes detectors and reroutes wiring
        // instead of quietly becoming an unprotected hole.
        const effectivePickPoints = [...(input.elevatorPickPoints ?? []), ...elevatorLabelPoints]

        if (effectivePickPoints.length > 0) {
          console.log(
            `\x1b[36m[PCCC-FIRE-ALARM]\x1b[0m Tracing ${effectivePickPoints.length} elevator candidate pick point(s):`,
            effectivePickPoints
          )
          const traced = await traceRegionBoundaries(
            (request) => bridge.request(RpcMethod.EntityTraceBoundary, request),
            effectivePickPoints.map((point) => ({
              point,
              suggestedClass: 'elevator_shaft' as const
            })),
            { documentName: doc, ...(units && { unitsPerMetre: units.unitsPerMetre }) }
          )
          for (const region of traced.regions) elevatorShafts.push(region.outer)
          if (traced.unresolvedPoints.length > 0) {
            shaftProblems.push(
              `ELEVATOR_UNTRACED: ${traced.unresolvedPoints.length} elevator pick point(s) produced no closed ` +
                `boundary in "${target.name}" — pass elevatorShafts polygons directly, or pick a point further ` +
                `inside the shaft.`
            )
          }
          for (const region of traced.regions) {
            if (region.confidence !== 'high') {
              shaftProblems.push(
                `ELEVATOR_AREA_SUSPECT: ${region.id} traced to ${region.areaM2.toFixed(2)} m2, outside a ` +
                  `plausible shaft size — verify the pick point is inside the elevator and not its lobby.`
              )
            }
          }
        }

        const planResult: FireAlarmFullPlanResult = planHighwayFireAlarm({
          // Only rooms with a real closed ring reach the planner: CAD-derived when the caller named the
          // room, caller-supplied (and region-checked) when it drew one.
          rooms: plannedRooms,
          ...(elevatorShafts.length > 0 && { elevatorShafts }),
          ...(input.forbiddenZones && input.forbiddenZones.length > 0 && {
            forbiddenZones: input.forbiddenZones
          }),
          ...(effectiveJunctionBoxLocation && {
            junctionBoxLocation: effectiveJunctionBoxLocation
          }),
          stairDoors: input.stairDoors,
          beamYHighways: effectiveBeamYHighways,
          ...(effectiveBeamXHighways.length > 0 && { beamXHighways: effectiveBeamXHighways }),
          symbolScale: input.symbolScale,
          layerDevices: input.layerDevices,
          layerWiring: input.layerWiring,
          layerText: input.layerText,
          blockNames: resolvedBlocks,
          // E8: the drawing's real units, resolved above — never an assumed millimetre.
          ...(units && { insUnits: units.insUnits }),
          // E7: the real junction-box block name in this drawing, named in NO_PANEL_ANCHOR
          // when no junctionBoxLocation was supplied.
          junctionBoxCandidates: resolvedBlocks.JUNCTION_BOX ? [resolvedBlocks.JUNCTION_BOX] : []
        })
        if (symbolProblem) planResult.violations.push(`MISSING_SYMBOL: ${symbolProblem}`)
        planResult.violations.push(...shaftProblems, ...regionProblems)

        // The room polygons being inside the frame is necessary, not sufficient: what gets drawn also
        // includes call points at caller-typed door points, resistor/label offsets, and wire along
        // caller-supplied beam highways. Check the emitted batch itself against the same region.
        if (!('problem' in designRegion) && planResult.cadOperations.length > 0) {
          const stray = operationsOutsideRegion(planResult.cadOperations, designRegion.bounds)
          if (stray.length > 0) {
            const shown = stray.slice(0, 6)
            planResult.violations.push(
              `DRAWN_OUTSIDE_FLOORPLAN: ${stray.length} of the ${planResult.cadOperations.length} ` +
                `entities this plan would draw fall outside ${input.floorplanName} at ` +
                `[${designRegion.bounds.join(', ')}] (${designRegion.basis}): ${shown.join('; ')}` +
                `${stray.length > shown.length ? ` (+${stray.length - shown.length} more)` : ''}. ` +
                `Devices, wiring and labels are only ever drawn on the plan they belong to — check ` +
              `stairDoors[].doorPoint, beamYHighways and symbolScale against that frame.`
            )
          }

          let externalDefinitionDocumentName: string | undefined
          let libraryToClose: string | undefined
          let footprintCheck: Awaited<ReturnType<typeof verifyBlockFootprints>>
          try {
            if (pendingImport) {
              const library = await bridge.request(
                RpcMethod.DrawingOpen,
                { path: pendingImport.libraryPath, readOnly: true },
                { timeoutMs: DRAWING_OPEN_TIMEOUT_MS }
              )
              externalDefinitionDocumentName = library.name
              libraryToClose = library.name
            }
            const allKnownDefinitions = [
              ...(pendingDefinitions ?? []),
              ...Object.entries(DEFAULT_PCCC_BLOCK_NAMES).map(([type, blockName]) => ({
                blockName,
                entities: DEFAULT_PCCC_SYMBOL_GEOMETRY[type as FireAlarmDeviceType]
              }))
            ]
            footprintCheck = await verifyBlockFootprints(
              bridge,
              planResult.cadOperations,
              designRegion.bounds,
              target.name,
              {
                inlineDefinitions: allKnownDefinitions,
                externalDefinitionDocumentName,
                externalBlockNames: pendingImport?.blockNames ?? []
              }
            )
          } catch (error) {
            footprintCheck = {
              status: 'unverified',
              reason: error instanceof Error ? error.message : String(error)
            }
          } finally {
            if (libraryToClose) {
              await bridge.request(RpcMethod.DrawingClose, { documentName: libraryToClose }).catch(() => undefined)
            }
          }
          if (footprintCheck.status === 'outside') {
            planResult.violations.push(
              `BLOCK_FOOTPRINT_OUTSIDE_FLOORPLAN: AutoCAD's transformed block extents ` +
                `[${footprintCheck.bounds?.join(', ') ?? 'unknown'}] leave ${input.floorplanName} ` +
                `at [${designRegion.bounds.join(', ')}], even though the insert anchor may be inside. ` +
                `Reduce symbolScale or choose a symbol that fits.`
            )
          } else if (footprintCheck.status === 'unverified') {
            planResult.violations.push(
              `BLOCK_FOOTPRINT_UNVERIFIED: the complete transformed symbol footprint could not be ` +
                `confirmed inside ${input.floorplanName}: ${footprintCheck.reason ?? 'no extents returned'}. ` +
                `Nothing will be drawn without a verified footprint.`
            )
          }
        }
        // E9: every planner-placed detector must lie inside one of the planned room polygons.
        // The junction box and call points sit on caller-supplied anchors, and the wires
        // legitimately traverse corridors outside the rooms, so those are not gated here.
        if (units) {
          const scopeViolation = outOfScopeViolation(
            planResult.layout.devices
              .filter((d) => d.type === 'HEAT_DETECTOR' || d.type === 'SMOKE_DETECTOR')
              .map((d) => [d.x, d.y] as [number, number]),
            plannedRooms.map((r) => r.boundary),
            SCOPE_TOLERANCE_MM * units.unitsPerMm
          )
          if (scopeViolation) planResult.violations.push(scopeViolation)
        }
        // Resolution/trace failures found here still block: a plan that cannot name its symbols or
        // confirm a shaft polygon must not be drawn, even when the geometry planner said PASS.
        if (planResult.status === 'PASS' && planResult.violations.length > 0)
          planResult.status = 'FAIL'

        const planId = `fa_plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        // Fail closed on ANY non-PASS status, not just FAIL. `INSUFFICIENT_DATA` means the planner
        // could not produce a design at all; drawing "nothing" and reporting a committed batch is the
        // worst outcome available. `status` is a three-valued union, so `=== 'FAIL'` silently admits
        // the third value the moment a caller can reach it.
        const blocked = planResult.status !== 'PASS'
        console.log(
          `\x1b[36m[PCCC-FIRE-ALARM]\x1b[0m Plan minted: ${planId} | Status: ${planResult.status} | Devices: ${planResult.totalDevices} | Wire: ${planResult.totalWireLengthM}m | Elevator Shafts: ${elevatorShafts.length}`
        )
        if (planResult.violations.length > 0) {
          console.log(
            `\x1b[33m[PCCC-FIRE-ALARM] VIOLATIONS (${planResult.violations.length}):\x1b[0m`,
            planResult.violations
          )
        }

        const plan: FireAlarmPlanRecord = {
          planId,
          documentName: doc,
          revisionAtPreview: revision,
          createdAt: Date.now(),
          expiresAt: Date.now() + PLAN_TTL_MS,
          consumed: false,
          blocked,
          blockedReasons: planResult.violations,
          deviceCount: planResult.totalDevices,
          wireLengthM: planResult.totalWireLengthM,
          layoutStatus: planResult.status,
          // The planner's records are checked against the same schema the public `entity`/`operations`
          // tools use, so a kind the plugin has no handler for, or a point that is not a wire point,
          // fails here with the offending field named instead of aborting inside the AutoCAD
          // transaction after part of the batch was attempted.
          cadOperations: toWireOperations(planResult.cadOperations),
          blockNames: resolvedBlocks,
          pendingImport,
          pendingDefinitions,
          scope: plannedRooms.map((r) => r.boundary),
          unitsPerMetre: units?.unitsPerMetre ?? null,
          insUnits: units?.insUnits ?? null,
          lastApplyReceipt: null
        }
        plans.set(planId, plan)

        return {
          plan,
          blocked,
          violations: planResult.violations,
          summary: {
            planId,
            status: planResult.status,
            deviceCount: planResult.totalDevices,
            deviceSummary: planResult.layout.deviceCounts,
            wireLengthM: planResult.totalWireLengthM,
            symbols: resolvedBlocks,
            elevatorZones: elevatorShafts.length,
            rooms: plannedGeometry,
            ...(pendingImport && {
              importAtApply: pendingImport.blockNames,
              importNote: `drawing the plan clones ${pendingImport.blockNames.length} symbol definition(s) from "${pendingImport.libraryPath}" before the batch — the compile step itself wrote nothing.`
            }),
            ...(pendingDefinitions && {
              importAtApply: pendingDefinitions.map((def) => def.blockName),
              importNote: `drawing the plan builds ${pendingDefinitions.length} symbol definition(s) from catalog/default geometry — no library DWG involved, nothing has been written to the drawing yet.`
            })
          }
        }
      }

      if (input.operation === 'status') {
        const plan = plans.get(input.planId)
        if (!plan) {
          return textResult({
            planId: input.planId,
            state: 'unknown',
            hint: 'Plan not found in this session; run preview to mint a new plan.'
          })
        }
        return textResult({
          planId: plan.planId,
          state: plan.consumed ? 'applied' : plan.blocked ? 'blocked' : 'ready',
          deviceCount: plan.deviceCount,
          wireLengthM: plan.wireLengthM,
          layoutStatus: plan.layoutStatus,
          ...(plan.lastReadback && { readback: plan.lastReadback })
        })
      }

      if (input.operation === 'apply') {
        const plan = plans.get(input.planId)
        if (!plan) {
          throw new Error(`No plan "${input.planId}" in this session — run preview first.`)
        }
        if (plan.consumed) {
          throw new Error(`Plan "${input.planId}" was already applied.`)
        }
        if (plan.expiresAt < Date.now()) {
          plans.delete(input.planId)
          throw new Error(`Plan "${input.planId}" expired.`)
        }
        if (plan.blocked) {
          throw new Error(
            `Plan "${input.planId}" is blocked and cannot be drawn: ${plan.blockedReasons.join('; ')}`
          )
        }

        console.log(
          `\x1b[32m[PCCC-FIRE-ALARM]\x1b[0m APPLY request on planId="${input.planId}" (devices: ${plan.deviceCount}, wire: ${plan.wireLengthM}m)`
        )
        return drawCommittedPlan(plan, {
          result: input.result,
          capture: input.capture,
          visualReview: input.visualReview,
          width: input.width,
          height: input.height,
          idempotencyKey: input.idempotencyKey
        })
      }

      // `execute` runs the SAME compile+gate path as `preview` and draws only when every gate
      // passed: a blocked plan is never drawn, and the response carries the violations exactly as
      // `preview` would report them. This is the single-step path; `preview` + `apply` stay for
      // plans a human must review in between.
      if (input.operation === 'execute') {
        const compiled = await compilePlan(input)
        if (compiled.blocked) {
          return textResult({
            ...compiled.summary,
            drawn: false,
            violations: compiled.violations,
            hint: `Plan blocked; nothing was drawn. Resolve these, then preview or execute again: ${compiled.violations.join('; ')}`
          })
        }
        console.log(
          `\x1b[32m[PCCC-FIRE-ALARM]\x1b[0m EXECUTE: plan ${compiled.plan.planId} passed every gate; drawing in one step (devices: ${compiled.plan.deviceCount}, wire: ${compiled.plan.wireLengthM}m)`
        )
        const drawn = await drawCommittedPlan(compiled.plan, {
          result: input.result,
          capture: input.capture,
          visualReview: input.visualReview,
          width: input.width,
          height: input.height,
          idempotencyKey: input.idempotencyKey
        })
        // One call, one full answer: the compile report (which geometry each room used, the symbol
        // map, elevator zones) rides on the draw receipt instead of being dropped. The text block is
        // this tool's own JSON, but a parse miss must never lose the commit receipt, so on failure
        // the receipt is returned untouched with `drawn` noted beside it.
        const textBlock = drawn.content.find((c) => c.type === 'text')
        if (textBlock && 'text' in textBlock && typeof textBlock.text === 'string') {
          try {
            const receipt = JSON.parse(textBlock.text) as Record<string, unknown>
            textBlock.text = JSON.stringify({ ...compiled.summary, ...receipt, drawn: true })
          } catch {
            textBlock.text = JSON.stringify({
              ...compiled.summary,
              drawn: true,
              drawReceipt: textBlock.text
            })
          }
        }
        return drawn
      }

      // preview
      const compiled = await compilePlan(input)
      return textResult({
        ...compiled.summary,
        violations: compiled.violations,
        hint: compiled.blocked
          ? `Plan blocked; nothing will be drawn until these are resolved: ${compiled.violations.join('; ')}`
          : `Call pccc_fire_alarm_overlay with operation: 'apply' and planId: '${compiled.plan.planId}' to draw in one step, or operation: 'execute' to compile and draw in a single call.`
      })
    })
  )
}
