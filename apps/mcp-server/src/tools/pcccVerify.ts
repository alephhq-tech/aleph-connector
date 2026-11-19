import { RpcMethod } from '@arcdio/cad-protocol'
import type { EntityOperation } from '@arcdio/cad-protocol'
import {
  compileCadPayload,
  findOutOfScopePoint,
  unitsPerMetreFor,
  verifyCompiledPlanReadback,
  type DrawingUnits,
  type PlanReadbackReport,
  type Point2D,
  type SpatialRawEntity
} from '@arcdio/engineering'
import type { BridgeClient } from '../bridge/BridgeClient.js'

/**
 * Shared apply-time machinery for both PCCC tools: units (E8), scope gate (E9),
 * and post-apply read-back. A batch that did not land faithfully is never `committed`.
 */

/** 50 mm of read-back tolerance, in drawing units (the read-back default). */
export const READBACK_TOLERANCE_MM = 50
/** 1 mm of scope tolerance, in drawing units — a device on a shared wall still counts. */
export const SCOPE_TOLERANCE_MM = 1

export interface ResolvedDrawingUnits {
  insUnits: DrawingUnits
  unitsPerMetre: number
  /** Drawing units per millimetre (1 for mm drawings, 0.001 for metre drawings). */
  unitsPerMm: number
}

/**
 * Resolve `drawing.summary` `insUnits`, or `null` when unknown/unreadable.
 * Callers must block the plan on `null`, never measure in millimetres.
 */
export async function resolveDrawingUnits(
  bridge: BridgeClient,
  documentName: string | undefined
): Promise<ResolvedDrawingUnits | null> {
  let summary: { insUnits?: string }
  try {
    summary = await bridge.request(RpcMethod.DrawingSummary, { documentName })
  } catch {
    return null
  }
  const unitsPerMetre = unitsPerMetreFor(summary.insUnits as DrawingUnits | undefined)
  if (unitsPerMetre === null) return null
  return {
    insUnits: summary.insUnits as DrawingUnits,
    unitsPerMetre,
    unitsPerMm: unitsPerMetre / 1000
  }
}

export interface ScopeCheckOptions {
  /** Tolerance in drawing units for on-boundary points (default: 1 mm in drawing units). */
  tolerance?: number
  /** Block names whose placements are anchors, not planner-placed devices (panel, MCP). */
  exemptBlockNames?: string[]
  /** Also gate line/polyline endpoints (sprinkler pipes). Wires are excluded by default. */
  checkLines?: boolean
  /** Points exempt from the gate (e.g. the riser anchor, which sits outside the room). */
  exemptPoints?: Point2D[]
}

function pointEquals(a: Point2D, b: Point2D, tolerance: number): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance
}

function toPoint2D(value: unknown): Point2D | null {
  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [value[0], value[1]]
  }
  if (value && typeof value === 'object') {
    const rec = value as { x?: unknown; y?: unknown }
    if (typeof rec.x === 'number' && typeof rec.y === 'number') return [rec.x, rec.y]
  }
  return null
}

/**
 * E9 re-check on the stored batch. Returns the OUT_OF_SCOPE violation, or `null`
 * when every planner-placed device (and, when `checkLines`, pipe endpoint) is in scope.
 */
export function checkOperationsScope(
  operations: readonly EntityOperation[],
  scopeRings: readonly Point2D[][],
  options: ScopeCheckOptions = {}
): string | null {
  const tolerance = options.tolerance ?? 0
  const exemptBlocks = new Set(options.exemptBlockNames ?? [])
  const points: Point2D[] = []
  // Fail closed on positions that cannot be read: an ungateable device must refuse the
  // batch, not slip past the gate because its coordinates did not parse.
  const unreadable: string[] = []
  for (let opIndex = 0; opIndex < operations.length; opIndex++) {
    const op = operations[opIndex]!
    if (op.op !== 'create') continue
    const entity = op.entity as unknown as Record<string, unknown>
    if (entity.kind === 'blockReference') {
      if (typeof entity.blockName === 'string' && exemptBlocks.has(entity.blockName)) continue
      const pt = toPoint2D(entity.position)
      if (pt) points.push(pt)
      else unreadable.push(`operation ${opIndex} (${entity.blockName ?? 'blockReference'})`)
      continue
    }
    if (!options.checkLines) continue
    if (entity.kind === 'line') {
      for (const end of [toPoint2D(entity.start), toPoint2D(entity.end)]) {
        if (!end) {
          unreadable.push(`operation ${opIndex} (line endpoint)`)
          continue
        }
        if ((options.exemptPoints ?? []).some((ex) => pointEquals(end, ex, tolerance))) continue
        points.push(end)
      }
    } else if (entity.kind === 'polyline' && Array.isArray(entity.points)) {
      for (const raw of entity.points as unknown[]) {
        const pt = toPoint2D(raw)
        if (!pt) {
          unreadable.push(`operation ${opIndex} (polyline vertex)`)
          continue
        }
        if ((options.exemptPoints ?? []).some((ex) => pointEquals(pt, ex, tolerance))) continue
        points.push(pt)
      }
    }
  }
  if (unreadable.length > 0) {
    return (
      `OUT_OF_SCOPE: ${unreadable.join('; ')} has a position that cannot be read, so the ` +
      `batch cannot be proven inside the inspected region — it was refused before drawing.`
    )
  }
  if (points.length === 0) return null
  const bad = findOutOfScopePoint(points, scopeRings, tolerance)
  if (!bad) return null
  return (
    `OUT_OF_SCOPE: planned point [${bad.point[0]}, ${bad.point[1]}] (point ${bad.index + 1} of ` +
    `${points.length}) lies outside the inspected region (${scopeRings.length} room ` +
    `polygon(s)) — the batch was refused before drawing. Re-inspect the region that ` +
    `contains it, or narrow the plan to the region already inspected.`
  )
}

/**
 * Post-apply read-back: re-read the drawing and verify every planned step landed.
 * Throws when the read-back itself cannot be performed; an unverifiable batch
 * is never reported `committed`.
 */
export async function verifyPcccApply(
  bridge: BridgeClient,
  documentName: string | undefined,
  operations: readonly EntityOperation[],
  unitsPerMetre: number
): Promise<PlanReadbackReport> {
  const plan = compileCadPayload({
    documentName: documentName ?? '',
    operations: operations as unknown as Record<string, unknown>[]
  })
  if (plan.opaque) {
    throw new Error(
      `Post-apply read-back cannot verify this batch: the compiled plan is opaque ` +
        `(${plan.opaqueReasons.join('; ')}) — the batch is not reported committed.`
    )
  }
  const entities: SpatialRawEntity[] = []
  const limit = 1000
  let pages = 0
  for (let offset = 0; ; offset += limit) {
    const page = await bridge.request(RpcMethod.EntityList, {
      documentName,
      detail: 'full',
      limit,
      offset
    })
    // A snapshot that cannot be paged through is unverifiable, not a pass: an empty page
    // or missing total means the bridge is misbehaving, and an unbounded count would loop forever.
    if (++pages > 10000) {
      throw new Error(
        `Post-apply read-back could not page through the drawing (over 10000 pages of ` +
          `${limit}) — the batch is not reported committed.`
      )
    }
    if (page.entities.length === 0 && (page.total ?? 0) > offset) {
      throw new Error(
        `Post-apply read-back got an empty entity.list page at offset ${offset} while the ` +
          `drawing reports ${page.total} entities — the batch is not reported committed.`
      )
    }
    // An entry the bridge could not materialise is unreadable, not a match: drop it
    // rather than crashing; the step that needed it then reports MISSING.
    for (const ent of page.entities as unknown as Array<SpatialRawEntity | null | undefined>) {
      if (ent) entities.push(ent)
    }
    if (offset + page.entities.length >= (page.total ?? 0)) break
  }
  const positionTolerance = READBACK_TOLERANCE_MM * (unitsPerMetre / 1000)
  return verifyCompiledPlanReadback(plan, entities, { positionTolerance })
}
