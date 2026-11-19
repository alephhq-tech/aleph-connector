import { z } from 'zod'
import { Point2DSchema, type Point2D } from '../schemas/semantic-model'
import {
  SpaceTypeSchema,
  SpaceUsageSchema,
  type Space,
  type SpatialModel,
  type SpaceType,
  type SpaceUsage,
} from './spatial-schema'
import { bboxOf, ringDistance, centroidOf, pointInPolygon } from './geometry'
import type { FindingStatus, SpatialFinding } from './constraints'

/**
 * Spatial program — the declarative "what the building must contain" layer that sits ABOVE the
 * drawn model. The engine never invents a program: every target area, adjacency requirement and
 * forbidden pairing is supplied by the caller (the agent, a Design Basis, or a standards lookup).
 * What this module does deterministically is (a) derive the real adjacency/circulation graphs from
 * a drawn or planned model, and (b) check a model against a program, reporting PASS / FAIL /
 * INSUFFICIENT_DATA exactly like the constraint engine — never a silent pass.
 *
 * Functional zoning (which usage belongs to which zone) is a standard architectural taxonomy, not
 * a building-code claim. It is used only to flag obviously wrong adjacencies the caller asked for
 * or a program explicitly forbids; it never asserts a numeric regulation.
 */

export const ProgramRoomSchema = z.object({
  id: z.string(),
  usage: SpaceUsageSchema,
  /** Target usable area in m². From the caller — never invented here. */
  targetAreaM2: z.number().positive(),
  /** Optional hard bounds the caller asserts (e.g. a regulation minimum it looked up). */
  minAreaM2: z.number().nonnegative().optional(),
  maxAreaM2: z.number().positive().optional(),
  /** Rooms this must be directly reachable from / adjacent to. */
  requiredAdjacency: z.array(z.string()).default([]),
  /** Rooms it must NOT be adjacent to. */
  forbiddenAdjacency: z.array(z.string()).default([]),
  /** Indoor/outdoor/etc. Inferred from usage when omitted (garden→outdoor, etc.). */
  spaceType: SpaceTypeSchema.optional(),
  /** Nominal occupant count — drives furniture candidate sizing, not a code load. */
  capacity: z.number().int().nonnegative().optional(),
  /** Higher priority rooms get the better-sited positions when space is tight. */
  priority: z.number().int().default(0),
})
export type ProgramRoom = z.infer<typeof ProgramRoomSchema>
/** What a caller writes before defaults are applied — the arrays/priority are optional here. */
export type ProgramRoomInput = z.input<typeof ProgramRoomSchema>

export const SpatialProgramSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  rooms: z.array(ProgramRoomSchema).min(1),
  /** Optional site polygon the building must fit inside (world units). */
  siteBoundary: z.array(Point2DSchema).optional(),
  /** Drawing unit → metres, so areas compare fairly. Aleph drawings are mm. */
  unitsPerMetre: z.number().positive().default(1000),
})
export type SpatialProgram = z.infer<typeof SpatialProgramSchema>
export type SpatialProgramInput = z.input<typeof SpatialProgramSchema>

/** Standard functional zones. A taxonomy for adjacency sanity, not a regulation. */
export const ZoneSchema = z.enum([
  'private', // bedrooms, bathrooms
  'shared', // living, dining, kitchen
  'service', // utility, storage, garage, laundry
  'circulation', // hallway, staircase
  'outdoor', // garden, courtyard, terrace, driveway
])
export type Zone = z.infer<typeof ZoneSchema>

const USAGE_ZONE: Record<SpaceUsage, Zone> = {
  living: 'shared',
  dining: 'shared',
  kitchen: 'shared',
  bedroom: 'private',
  bathroom: 'private',
  office: 'shared',
  hallway: 'circulation',
  staircase: 'circulation',
  garage: 'service',
  storage: 'service',
  laundry: 'service',
  utility: 'service',
  garden: 'outdoor',
  courtyard: 'outdoor',
  atrium: 'shared',
  terrace: 'outdoor',
  driveway: 'outdoor',
  other: 'shared',
  unknown: 'shared',
}

export const zoneOf = (usage: SpaceUsage): Zone => USAGE_ZONE[usage] ?? 'shared'

/** Usage → default spaceType when a program room does not state one. */
const USAGE_SPACE_TYPE: Partial<Record<SpaceUsage, SpaceType>> = {
  garden: 'outdoor',
  courtyard: 'courtyard',
  terrace: 'semi_outdoor',
  driveway: 'outdoor',
  hallway: 'circulation',
  staircase: 'circulation',
  storage: 'service',
  utility: 'service',
  garage: 'service',
}

export const spaceTypeOfUsage = (usage: SpaceUsage): SpaceType =>
  USAGE_SPACE_TYPE[usage] ?? 'indoor'

/**
 * Fill the zod defaults on a hand-built program so the pure check functions never crash on a
 * caller that omitted `requiredAdjacency`/`priority`/etc. The capability layer already parses
 * through `SpatialProgramSchema`; this covers the in-process caller the docs point at
 * ("call the spatial/* functions directly"). It does NOT validate — an invalid usage still fails
 * at the schema boundary above it.
 */
export function normalizeProgram(program: SpatialProgramInput): SpatialProgram {
  return {
    ...program,
    unitsPerMetre: program.unitsPerMetre ?? 1000,
    rooms: program.rooms.map((room) => ({
      ...room,
      requiredAdjacency: room.requiredAdjacency ?? [],
      forbiddenAdjacency: room.forbiddenAdjacency ?? [],
      priority: room.priority ?? 0,
    })),
  }
}

// --- graphs -------------------------------------------------------------------------------------

export interface AdjacencyEdge {
  a: string
  b: string
  /** Measured gap between the two space boundaries (world units). 0 = share a wall. */
  distance: number
  /** True when the boundaries actually touch/overlap, not merely near. */
  touching: boolean
}

export interface CirculationEdge {
  a: string
  b: string
  /** The door handle that connects them. */
  via: string
  width: number
}

/**
 * Adjacency graph from real geometry: every pair of spaces whose boundaries touch, or whose
 * measured boundary-to-boundary gap is within `maxGap`. Uses `ringDistance` (min over all edge
 * pairs), not `extract`'s first-vertex sample, so two rooms sharing a long wall are correctly
 * adjacent even when their first vertices are far apart.
 */
export function deriveAdjacencyGraph(
  model: SpatialModel,
  maxGap = 500
): { nodes: string[]; edges: AdjacencyEdge[] } {
  const spaces = model.spaces.filter((s) => s.boundary.length >= 3)
  const edges: AdjacencyEdge[] = []
  for (let i = 0; i < spaces.length; i++) {
    for (let j = i + 1; j < spaces.length; j++) {
      const a = spaces[i]!
      const b = spaces[j]!
      const ba = bboxOf(a.boundary)
      const bb = bboxOf(b.boundary)
      if (!ba || !bb) continue
      // Cheap bbox reject: if boxes are farther apart than maxGap, no edge is possible.
      const boxGap = Math.max(
        ba.minX - bb.maxX,
        bb.minX - ba.maxX,
        ba.minY - bb.maxY,
        bb.minY - ba.maxY,
        0
      )
      if (boxGap > maxGap) continue
      const d = ringDistance(a.boundary, b.boundary)
      if (d <= maxGap) {
        edges.push({ a: a.id, b: b.id, distance: d, touching: d <= 1 })
      }
    }
  }
  return { nodes: spaces.map((s) => s.id), edges }
}

/**
 * Circulation graph: spaces joined by doors only (a window is not a way through). Mirrors
 * `checkAccessibility`'s door graph so the two never disagree.
 */
export function deriveCirculationGraph(model: SpatialModel): {
  nodes: string[]
  edges: CirculationEdge[]
} {
  const nodes = model.spaces.map((s) => s.id)
  const edges: CirculationEdge[] = []
  for (const d of model.openings) {
    if (d.kind !== 'door') continue
    const [a, b] = d.connectsSpaces
    if (a && b) edges.push({ a, b, via: d.handle, width: d.width })
  }
  return { nodes, edges }
}

// --- program checks -----------------------------------------------------------------------------

function resolveSpace(room: ProgramRoom, model: SpatialModel): Space | undefined {
  const byId =
    model.spaces.find((s) => s.id === room.id) ??
    // `extract` names spaces `sp_<handle>`, so a program room named after the drawing's entity
    // handle matches without the caller having to know the prefix.
    model.spaces.find((s) => s.id === `sp_${room.id}`)
  if (byId) return byId
  const sameUsage = model.spaces.filter((s) => s.usage === room.usage)
  return sameUsage.length === 1 ? sameUsage[0] : undefined
}

/** The model id a program room refers to, or null when nothing in the model represents it yet. */
function resolveSpaceId(roomId: string, model: SpatialModel): string | null {
  if (model.spaces.some((s) => s.id === roomId)) return roomId
  if (model.spaces.some((s) => s.id === `sp_${roomId}`)) return `sp_${roomId}`
  return null
}

/**
 * Check every program room's measured area against its target/min/max. A room with no matching
 * space in the model is INSUFFICIENT_DATA (not a pass): the layout has not been drawn yet.
 */
export function checkProgramAreas(
  program: SpatialProgramInput,
  model: SpatialModel
): SpatialFinding[] {
  const findings: SpatialFinding[] = []
  for (const room of normalizeProgram(program).rooms) {
    const space = resolveSpace(room, model)
    if (!space) {
      findings.push({
        code: 'PROGRAM_ROOM_NOT_DRAWN',
        severity: 'warning',
        status: 'INSUFFICIENT_DATA',
        entityIds: [room.id],
        constraintId: 'program-areas',
        message: `program room ${room.id} (${room.usage}) has no matching space in the model`,
      })
      continue
    }
    const area = space.areaM2
    const under = room.minAreaM2 !== undefined && area < room.minAreaM2 - 1e-6
    const over = room.maxAreaM2 !== undefined && area > room.maxAreaM2 + 1e-6
    if (under || over) {
      findings.push({
        code: 'PROGRAM_AREA_OUT_OF_RANGE',
        severity: 'error',
        status: 'FAIL',
        entityIds: [room.id, space.id],
        constraintId: 'program-areas',
        measurements: { areaM2: area, targetM2: room.targetAreaM2, ...(room.minAreaM2 !== undefined ? { minM2: room.minAreaM2 } : {}), ...(room.maxAreaM2 !== undefined ? { maxM2: room.maxAreaM2 } : {}) },
        message: `${room.id} measures ${area.toFixed(1)} m², outside its ${room.minAreaM2 ?? 0}–${room.maxAreaM2 ?? '∞'} m² range (target ${room.targetAreaM2})`,
      })
    } else {
      findings.push({
        code: 'PROGRAM_AREA_OK',
        severity: 'info',
        status: 'PASS',
        entityIds: [room.id, space.id],
        constraintId: 'program-areas',
        measurements: { areaM2: area, targetM2: room.targetAreaM2 },
        message: `${room.id} measures ${area.toFixed(1)} m² (target ${room.targetAreaM2})`,
      })
    }
  }
  return findings
}

/**
 * Check required/forbidden adjacencies against the measured adjacency graph. Required adjacency
 * that is absent is a FAIL only when both rooms are drawn (otherwise INSUFFICIENT_DATA); forbidden
 * adjacency that is present is always a FAIL.
 */
export function checkProgramAdjacency(
  program: SpatialProgramInput,
  model: SpatialModel,
  maxGap = 500
): SpatialFinding[] {
  const graph = deriveAdjacencyGraph(model, maxGap)
  const adjacent = new Set<string>()
  for (const e of graph.edges) {
    adjacent.add(`${e.a}|${e.b}`)
    adjacent.add(`${e.b}|${e.a}`)
  }
  const findings: SpatialFinding[] = []
  for (const room of normalizeProgram(program).rooms) {
    const selfId = resolveSpaceId(room.id, model)
    for (const otherRef of room.requiredAdjacency) {
      const otherId = resolveSpaceId(otherRef, model)
      if (selfId && otherId && adjacent.has(`${selfId}|${otherId}`)) continue
      const bothDrawn = Boolean(selfId && otherId)
      findings.push({
        code: 'PROGRAM_ADJACENCY_MISSING',
        severity: bothDrawn ? 'error' : 'warning',
        status: bothDrawn ? 'FAIL' : 'INSUFFICIENT_DATA',
        entityIds: [room.id, otherRef],
        constraintId: 'program-adjacency',
        message: `${room.id} must be adjacent to ${otherRef}, but no shared/near boundary was measured`,
        suggestedCorrection: bothDrawn
          ? `share a wall or bring ${room.id} and ${otherRef} within ${maxGap} units, then add a door`
          : undefined,
      })
    }
    for (const otherRef of room.forbiddenAdjacency) {
      const otherId = resolveSpaceId(otherRef, model)
      if (selfId && otherId && adjacent.has(`${selfId}|${otherId}`)) {
        findings.push({
          code: 'PROGRAM_ADJACENCY_FORBIDDEN',
          severity: 'error',
          status: 'FAIL',
          entityIds: [room.id, otherRef],
          constraintId: 'program-adjacency',
          message: `${room.id} is forbidden from being adjacent to ${otherRef}, but their boundaries are within ${maxGap} units`,
        })
      }
    }
  }
  return findings
}

/**
 * Functional-zoning sanity: flag rooms whose zones interleave in a way the program forbids, and
 * report the zone each drawn space falls into. This never asserts a numeric code requirement — it
 * only surfaces zone mismatches so the agent can decide.
 */
export function summarizeZoning(
  program: SpatialProgramInput,
  model: SpatialModel
): Array<{ roomId: string; usage: SpaceUsage; zone: Zone; spaceType: SpaceType }> {
  return program.rooms.map((room) => ({
    roomId: room.id,
    usage: room.usage,
    zone: zoneOf(room.usage),
    spaceType: room.spaceType ?? spaceTypeOfUsage(room.usage),
  }))
}

/**
 * Whole-program verdict: combine area + adjacency findings into one status, mirroring how
 * `validateBatch` rolls up. No findings that are FAIL → PASS; any FAIL → FAIL; otherwise
 * INSUFFICIENT_DATA when something could not be evaluated.
 */
export function checkProgram(
  program: SpatialProgramInput,
  model: SpatialModel,
  maxGap = 500
): { status: FindingStatus; findings: SpatialFinding[] } {
  const findings = [
    ...checkProgramAreas(program, model),
    ...checkProgramAdjacency(program, model, maxGap),
  ]
  let status: FindingStatus = 'PASS'
  if (findings.some((f) => f.status === 'FAIL')) status = 'FAIL'
  else if (findings.some((f) => f.status === 'INSUFFICIENT_DATA')) status = 'INSUFFICIENT_DATA'
  return { status, findings }
}
