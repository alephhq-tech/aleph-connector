import {
  extractSpatialModel,
  type SpatialExtractOptions,
  type SpatialRawEntity
} from '../spatial/extract'
import {
  SpatialProgramSchema,
  checkProgram,
  summarizeZoning,
  deriveAdjacencyGraph,
  deriveCirculationGraph,
  type SpatialProgram
} from '../spatial/program'
import {
  generateLayoutCandidates,
  candidateToModel,
  siteBoundsOf,
  type SiteBounds,
  type LayoutCandidate
} from '../spatial/layout'
import { generateFurnitureCandidates, type FurnitureRequest } from '../spatial/furniture'
import {
  checkAccessibility,
  type FindingStatus,
  type SpatialFinding,
  type ValidateOptions
} from '../spatial/constraints'
import type { SpatialModelSummary } from './spatial'

/**
 * Agent-callable architectural planning: program checking, layout candidate generation, and
 * furniture suggestion. These are the "plan before you draw" capabilities — they turn a declarative
 * program (what the building must contain) into geometry-grounded candidates that then run through
 * the SAME preflight gate (`spatial_validate_layout`) as a drawn layout. Nothing here draws; the
 * AutoCAD MCP does that, and only after a candidate passes validation.
 *
 * Like the rest of the engine, output is compact (counts, scores, ids) because it goes into a model
 * context window. A caller that needs exact polygons calls the `spatial/*` functions in-process.
 */

// --- program check ------------------------------------------------------------------------------

export interface ProgramCheckInput {
  program: SpatialProgram
  /** The drawn model to check against, as CAD entities (entity.list detail:"full"). */
  entities?: SpatialRawEntity[]
  documentName?: string
  unitsPerMetre?: number
  spaceHints?: SpatialExtractOptions['spaceHints']
  /** Adjacency gap tolerance in drawing units (default 500). */
  maxGap?: number
}

export interface ProgramCheckResult {
  success: boolean
  error?: string
  status?: FindingStatus
  findings: SpatialFinding[]
  blocking: string[]
  /** Unit-basis caveats the verdict depends on; empty when the caller declared unitsPerMetre. */
  assumptions?: string[]
  zoning: Array<{ roomId: string; usage: string; zone: string; spaceType: string }>
  adjacency?: { nodes: string[]; edgeCount: number }
  circulation?: { nodes: string[]; edgeCount: number }
}

/**
 * Check a drawn (or planned) model against a spatial program: are the required rooms present, are
 * their areas in range, are the required/forbidden adjacencies honoured. A room that has not been
 * drawn yet is INSUFFICIENT_DATA, never a silent pass.
 */
export function checkSpatialProgram(input: ProgramCheckInput): ProgramCheckResult {
  const parsed = SpatialProgramSchema.safeParse(input.program)
  if (!parsed.success) {
    return {
      success: false,
      error: `invalid program: ${parsed.error.message}`,
      findings: [],
      blocking: [],
      zoning: []
    }
  }
  if (!Array.isArray(input.entities) || input.entities.length === 0) {
    return {
      success: false,
      error:
        'entities is required: a program is checked against a real model. Read the drawing with ' +
        'entity.list (detail: "full") first, or use spatial_layout_generate to plan from scratch.',
      findings: [],
      blocking: [],
      zoning: []
    }
  }
  try {
    // SpatialProgramSchema defaults unitsPerMetre to 1000, so parsed.data can never say "the caller
    // never told us". Read the declaration from the raw inputs; passing the default through would
    // let an assumed millimetre basis masquerade as a declared one (#413 SS11.2).
    const rawProgram = input.program as { unitsPerMetre?: number } | undefined
    const declaredUnits = input.unitsPerMetre ?? rawProgram?.unitsPerMetre
    const model = extractSpatialModel(input.entities, {
      documentName: input.documentName,
      unitsPerMetre: declaredUnits,
      spaceHints: input.spaceHints
    })
    const { status, findings } = checkProgram(parsed.data, model, input.maxGap)
    const adj = deriveAdjacencyGraph(model, input.maxGap)
    const circ = deriveCirculationGraph(model)
    const blocking = findings
      .filter((f) => f.status === 'FAIL')
      .map(
        (f) =>
          `${f.code}: ${f.message}${f.suggestedCorrection ? ` — ${f.suggestedCorrection}` : ''}`
      )
    // Areas, distances and the clutter threshold all depend on the unit basis, so an assumed one
    // has to be stated next to the verdict rather than left inside the model (#413 SS11.2).
    const assumptions = model.units.declared
      ? []
      : [
          `Drawing unit was not declared; geometry was read as millimetres (${model.units.perMetre} per metre). Native audits of real partner drawings found inch-declared files (INSUNITS=1), where this assumption makes every area 25.4² too small — pass unitsPerMetre explicitly before treating these numbers as physical.`
        ]
    return {
      success: true,
      status,
      findings: stripGeometry(findings),
      blocking,
      assumptions,
      zoning: summarizeZoning(parsed.data, model),
      adjacency: { nodes: adj.nodes, edgeCount: adj.edges.length },
      circulation: { nodes: circ.nodes, edgeCount: circ.edges.length }
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      findings: [],
      blocking: [],
      assumptions: [],
      zoning: []
    }
  }
}

// --- layout generation --------------------------------------------------------------------------

export interface LayoutGenerateInput {
  program: SpatialProgram
  /** Site as a polygon (via program.siteBoundary) or an explicit box. One is required. */
  bounds?: SiteBounds
  variants?: number
  /**
   * When true, each candidate is also run through the full preflight gate and carries its verdict,
   * so the agent can pick a candidate that is already known to validate. Costs more but saves a
   * round-trip.
   */
  validateCandidates?: boolean
}

export interface LayoutCandidateSummary {
  id: string
  adjacencyScore: number
  coverage: number
  roomCount: number
  openingCount: number
  unmetAdjacency: Array<{ room: string; needs: string }>
  rooms: Array<{
    roomId: string
    usage: string
    areaM2: number
    targetAreaM2: number
    bbox: SiteBounds | null
  }>
  /** Present when validateCandidates is true. */
  validation?: { status: FindingStatus; blocking: string[] }
}

export interface LayoutGenerateResult {
  success: boolean
  error?: string
  candidates: LayoutCandidateSummary[]
}

/**
 * Generate ranked layout candidates for a program on a site — the empty-DWG planning path. Each
 * candidate is a deterministic room packing plus the door openings its shared walls imply. The
 * agent picks one and feeds it to `spatial_validate_layout` (or asks for per-candidate validation
 * with `validateCandidates`).
 */
export function generateSpatialLayout(input: LayoutGenerateInput): LayoutGenerateResult {
  const parsed = SpatialProgramSchema.safeParse(input.program)
  if (!parsed.success) {
    return { success: false, error: `invalid program: ${parsed.error.message}`, candidates: [] }
  }
  const bounds = siteBoundsOf(parsed.data, input.bounds)
  if (!bounds) {
    return {
      success: false,
      error:
        'a site is required: supply program.siteBoundary (a polygon) or bounds {minX,minY,maxX,maxY}.',
      candidates: []
    }
  }
  try {
    const candidates = generateLayoutCandidates(parsed.data, bounds, input.variants)
    return {
      success: true,
      candidates: candidates.map((c) =>
        summarizeCandidate(c, parsed.data, input.validateCandidates)
      )
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      candidates: []
    }
  }
}

function summarizeCandidate(
  c: LayoutCandidate,
  program: SpatialProgram,
  validate: boolean | undefined
): LayoutCandidateSummary {
  const summary: LayoutCandidateSummary = {
    id: c.id,
    adjacencyScore: Math.round(c.adjacencyScore * 100) / 100,
    coverage: Math.round(c.coverage * 100) / 100,
    roomCount: c.rooms.length,
    openingCount: c.openings.length,
    unmetAdjacency: c.unmetAdjacency,
    rooms: c.rooms.map((r) => {
      const b = bboxOfRing(r.boundary)
      return {
        roomId: r.roomId,
        usage: r.usage,
        areaM2: Math.round(r.areaM2 * 100) / 100,
        targetAreaM2: r.targetAreaM2,
        bbox: b
      }
    })
  }
  if (validate) {
    // A room layout is judged on program fit + circulation, NOT on the furniture gate: rooms
    // legitimately share walls, so running them through `validateBatch` would report every shared
    // boundary as a collision. `checkProgram` measures areas and adjacencies; `checkAccessibility`
    // proves every room is reachable through the candidate's own door set.
    const model = candidateToModel(c, program)
    const programResult = checkProgram(program, model)
    const access = checkAccessibility(model)
    const blocking = [
      ...programResult.findings.filter((f) => f.status === 'FAIL'),
      ...access.findings.filter((f) => f.status === 'FAIL')
    ].map((f) => `${f.code}: ${f.message}`)
    const status: FindingStatus =
      blocking.length > 0
        ? 'FAIL'
        : programResult.status === 'INSUFFICIENT_DATA' ||
            access.findings.some((f) => f.status === 'INSUFFICIENT_DATA')
          ? 'INSUFFICIENT_DATA'
          : 'PASS'
    summary.validation = { status, blocking }
  }
  return summary
}

// --- furniture suggestion -----------------------------------------------------------------------

export interface FurnitureSuggestInput {
  entities: SpatialRawEntity[]
  documentName?: string
  unitsPerMetre?: number
  spaceHints?: SpatialExtractOptions['spaceHints']
  requests: FurnitureRequest[]
  options?: ValidateOptions
}

export interface FurnitureSuggestResult {
  success: boolean
  error?: string
  suggestions: Array<{
    requestId: string
    candidates: Array<{
      center: [number, number]
      rotationDeg: number
      spaceId: string
      status: string
      score: number
      reasons: string[]
    }>
  }>
  summary?: SpatialModelSummary
}

/**
 * Suggest ranked furniture placements for each request against the drawn model. Every candidate has
 * already passed `validatePlacement`, so the agent can commit the top pick without a second gate —
 * though a final `spatial_validate_layout` over the whole batch is still the safe move, because
 * per-item suggestions do not see each other.
 */
export function suggestSpatialFurniture(input: FurnitureSuggestInput): FurnitureSuggestResult {
  if (!Array.isArray(input.entities) || input.entities.length === 0) {
    return {
      success: false,
      error: 'entities is required: furniture is suggested against the actual drawing.',
      suggestions: []
    }
  }
  if (!Array.isArray(input.requests) || input.requests.length === 0) {
    return {
      success: false,
      error: 'requests must be a non-empty array of { id, kind, width, depth, spaceId? }.',
      suggestions: []
    }
  }
  try {
    const model = extractSpatialModel(input.entities, {
      documentName: input.documentName,
      unitsPerMetre: input.unitsPerMetre,
      spaceHints: input.spaceHints
    })
    const suggestions = input.requests.map((req) => ({
      requestId: req.id,
      candidates: generateFurnitureCandidates(model, req, input.options).map((c) => ({
        center: c.center,
        rotationDeg: c.rotationDeg,
        spaceId: c.spaceId,
        status: c.status,
        score: Math.round(c.score * 100) / 100,
        reasons: c.reasons
      }))
    }))
    return { success: true, suggestions }
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      suggestions: []
    }
  }
}

// --- helpers ------------------------------------------------------------------------------------

function stripGeometry(findings: SpatialFinding[]): SpatialFinding[] {
  return findings.map((f) => ({
    code: f.code,
    severity: f.severity,
    status: f.status,
    entityIds: f.entityIds,
    constraintId: f.constraintId,
    measurements: f.measurements,
    message: f.message,
    suggestedCorrection: f.suggestedCorrection
  }))
}

// Local bbox/centroid helpers to avoid importing geometry internals into the capability layer.
function bboxOfRing(ring: Array<[number, number]>): SiteBounds | null {
  if (!ring.length) return null
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}
function centroidOfRing(ring: Array<[number, number]>): [number, number] {
  const b = bboxOfRing(ring)
  return b ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : [0, 0]
}
