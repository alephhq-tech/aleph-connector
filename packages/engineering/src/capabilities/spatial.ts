import {
  extractSpatialModel,
  type SpatialExtractOptions,
  type SpatialRawEntity
} from '../spatial/extract'
import {
  validateBatch,
  type FindingStatus,
  type ProposedPlacement,
  type SpatialFinding,
  type ValidateOptions
} from '../spatial/constraints'
import { drawingFingerprint, layoutFingerprint, operationFingerprint } from '../spatial/fingerprint'
import {
  verifyDrawnLayout,
  type PlannedItem,
  type ReadbackOptions,
  type ItemMatch,
  type RepairPlan
} from '../spatial/readback'
import type { SpatialModel } from '../spatial/spatial-schema'

/** Compact, polygon-free view of a finding for the model context (see call sites). */
function stripFinding(f: SpatialFinding) {
  return {
    code: f.code,
    severity: f.severity,
    status: f.status,
    entityIds: f.entityIds,
    constraintId: f.constraintId,
    measurements: f.measurements,
    message: f.message,
    suggestedCorrection: f.suggestedCorrection
  }
}

/** Human-readable `CODE: message — correction` lines for every FAIL finding. */
function blockingMessages(findings: SpatialFinding[]): string[] {
  return findings
    .filter((f) => f.status === 'FAIL')
    .map(
      (f) => `${f.code}: ${f.message}${f.suggestedCorrection ? ` — ${f.suggestedCorrection}` : ''}`
    )
}

/**
 * Agent-callable spatial analysis + preflight validation.
 *
 * The Agent supplies the CAD entities it already read through the AutoCAD MCP (`entity.list` with
 * `detail: "full"`, which carries real polyline vertices); this module never dials AutoCAD itself.
 * That keeps the split the architecture requires: MCP reads and writes CAD, the Engineering Engine
 * reasons deterministically about geometry, the Agent orchestrates.
 *
 * Output is deliberately compact — bounding boxes and counts, not full vertex dumps — because the
 * result goes into a model context window. A caller that needs exact polygons calls
 * `extractSpatialModel` directly in-process.
 */

export interface SpatialAnalyzeInput {
  entities: SpatialRawEntity[]
  documentName?: string
  unitsPerMetre?: number
  spaceHints?: SpatialExtractOptions['spaceHints']
}

export interface SpatialValidateInput extends SpatialAnalyzeInput {
  placements: ProposedPlacement[]
  obstacles?: Array<{ id: string; footprint: Array<[number, number]> }>
  options?: ValidateOptions
  /**
   * The exact CAD call this validated layout will be executed as. The server digests its payload and
   * binds the resulting validation record to it, so a PASS cannot be carried over to a different
   * batch: dispatching anything else is refused. One validation authorizes one batch — after a batch
   * commits the drawing has genuinely changed (new walls make new spaces), so the next batch is
   * validated against the drawing as it now is, not as it was.
   */
  plannedOperation?: { capability: string; input: Record<string, unknown> }
  /**
   * The drawing revision the snapshot was read at, from `drawing.info`'s `revision`. The guard
   * re-reads the live revision at dispatch time and refuses if it moved, so this is the value the
   * claim is checked against rather than something taken on trust.
   */
  documentRevision?: string
}

/** Model-facing view of one space: identity, role, size, and where to find its source entities. */
export interface SpaceSummary {
  id: string
  name: string | null
  usage: string
  spaceType: string
  areaM2: number
  holes: number
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null
  adjacentSpaces: string[]
  accessPoints: string[]
  confidence: string
  sourceHandles: string[]
}

/** Model-facing view of one opening: door or window, and whether a door's sweep was computable. */
export interface OpeningSummary {
  handle: string
  kind: 'door' | 'window'
  hostWallHandle: string | null
  center: [number, number] | null
  width: number
  hinge: [number, number] | null
  swingAngleDeg: number
  connectsSpaces: string[]
  hasSweptArea: boolean
  /** Where the hinge came from: 'block-insertion'/'attribute' are facts from the drawing,
   * 'wall-endpoint' is a guess. A guessed hinge must not be trusted to clear furniture. */
  hingeSource: string
  /** Which way the leaf swings — only ever set from explicit block metadata. */
  swingDirection: string
  /** Whether the wall is actually broken at the opening; null when it could not be told. */
  cutsWall: boolean | null
  /** interior | exterior | unknown — an exterior door is a way in from outside. */
  connectionType: string
  confidence: string
}

/** Model-facing view of one furniture item with its real measured extents. */
export interface FurnitureSummary {
  handle: string
  kind: string
  assignedSpaceId: string | null
  insertion: [number, number]
  width: number
  depth: number
  rotationDeg: number
  blockName: string | null
}

/** Compact, model-facing view of a spatial model: enough to reason and cite, small enough to re-read. */
export interface SpatialModelSummary {
  documentName: string | null
  /** Unit basis the geometry was read with. declared:false means the caller never stated the
   * drawing unit and millimetres were assumed - every areaM2 below is then unverified (#413 SS11.2). */
  units: { perMetre: number; declared: boolean }
  spaces: SpaceSummary[]
  openings: OpeningSummary[]
  furniture: FurnitureSummary[]
  relationships: Array<{ sourceId: string; targetId: string; kind: string }>
  site: {
    hasBoundary: boolean
    outdoorRegions: string[]
    confidence: string
  } | null
  insufficientData: Array<{ handle: string; reason: string }>
  unclassifiedCount: number
  unclassifiedHandles: string[]
}

export interface SpatialAnalyzeResult {
  success: boolean
  error?: string
  summary?: SpatialModelSummary
}

/**
 * Preflight verdict for a proposed layout. `blocking` lists only the FAIL findings, so a caller can
 * act on the gate without re-filtering the whole finding set.
 *
 * `validationId` (added by the capability layer, not by this pure function) is present only when the
 * caller declared both `plannedOperation` and `documentRevision`. It is issued for every verdict —
 * a FAIL record exists to be reported honestly and can never authorize a mutation, because the CAD
 * guard rejects any record whose verdict is not PASS.
 */
export interface SpatialValidateResult {
  success: boolean
  error?: string
  status?: FindingStatus
  findings: SpatialFinding[]
  blocking: string[]
  summary?: SpatialModelSummary
  /** Server-computed digest of the declared payload, echoed so the caller can confirm the binding. */
  operationFingerprint?: string
  documentRevision?: string
  drawingFingerprint?: string
  layoutFingerprint?: string
}

const round = (n: number): number => Math.round(n * 100) / 100

function summarizeModel(model: SpatialModel): SpatialModelSummary {
  return {
    documentName: model.documentName ?? null,
    units: model.units,
    spaces: model.spaces.map((s) => ({
      id: s.id,
      name: s.name ?? null,
      usage: s.usage,
      spaceType: s.spaceType,
      areaM2: s.areaM2,
      holes: s.holes.length,
      bbox: s.bbox ?? null,
      adjacentSpaces: s.adjacentSpaces,
      accessPoints: s.accessPoints,
      confidence: s.confidence,
      sourceHandles: s.sourceHandles
    })),
    openings: model.openings.map((d) => ({
      handle: d.handle,
      kind: d.kind,
      hostWallHandle: d.hostWallHandle,
      center: d.openingCenter ?? null,
      width: d.width,
      hinge: d.hinge ?? null,
      swingAngleDeg: d.swingAngleDeg,
      connectsSpaces: d.connectsSpaces,
      hasSweptArea: Boolean(d.sweptArea),
      hingeSource: d.hingeSource,
      swingDirection: d.swingDirection,
      cutsWall: d.cutsWall,
      connectionType: d.connectionType,
      confidence: d.confidence
    })),
    furniture: model.furniture.map((f) => ({
      handle: f.handle,
      kind: f.kind,
      assignedSpaceId: f.assignedSpaceId,
      insertion: f.insertion,
      width: round(f.width),
      depth: round(f.depth),
      rotationDeg: f.rotationDeg,
      blockName: f.blockName ?? null
    })),
    relationships: model.relationships.map((r) => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      kind: r.kind
    })),
    site: model.site
      ? {
          hasBoundary: Boolean(model.site.boundary),
          outdoorRegions: model.site.outdoorRegions.map((s) => s.id),
          confidence: model.site.confidence
        }
      : null,
    insufficientData: model.insufficientData,
    unclassifiedCount: model.unclassifiedHandles.length,
    unclassifiedHandles: model.unclassifiedHandles.slice(0, 40)
  }
}

export function analyzeSpatialDrawing(input: SpatialAnalyzeInput): SpatialAnalyzeResult {
  if (!Array.isArray(input.entities) || input.entities.length === 0) {
    return {
      success: false,
      error:
        'entities is required and must be non-empty. Read them first with the AutoCAD MCP tool ' +
        'entity.list (detail: "full", and a layer/window filter on large drawings) and pass them here.'
    }
  }
  try {
    const model = extractSpatialModel(input.entities, {
      documentName: input.documentName,
      unitsPerMetre: input.unitsPerMetre,
      spaceHints: input.spaceHints
    })
    return { success: true, summary: summarizeModel(model) }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Preflight gate for an architectural batch: validates every proposed placement against the drawn
 * geometry AND against the rest of the batch, then reports a single verdict.
 *
 * `status: "FAIL"` means the batch must not be committed. `INSUFFICIENT_DATA` means the geometry
 * needed to decide was missing — it is NOT a pass, and the caller must not draw and hope.
 */
export function validateSpatialLayout(input: SpatialValidateInput): SpatialValidateResult {
  if (!Array.isArray(input.entities) || input.entities.length === 0) {
    return {
      success: false,
      error:
        'entities is required: validation must run against the actual drawing, not an assumed one. ' +
        'Read it with entity.list (detail: "full") first.',
      findings: [],
      blocking: []
    }
  }
  if (!Array.isArray(input.placements)) {
    return {
      success: false,
      error:
        'placements must be an array of proposed items (id, center, width, depth, rotationDeg).',
      findings: [],
      blocking: []
    }
  }
  try {
    const model = extractSpatialModel(input.entities, {
      documentName: input.documentName,
      unitsPerMetre: input.unitsPerMetre,
      spaceHints: input.spaceHints
    })
    const result = validateBatch({
      model,
      placements: input.placements,
      obstacles: input.obstacles,
      options: input.options
    })
    const blocking = blockingMessages(result.findings)
    // The digests are computed here, from the payload the server actually received, so the record the
    // caller mints binds to this exact drawing state and this exact CAD call.
    const operationDigest = input.plannedOperation
      ? operationFingerprint(input.plannedOperation.input)
      : undefined
    const drawing = drawingFingerprint(input.entities)
    const layout = layoutFingerprint(input.placements)
    return {
      success: true,
      status: result.status,
      // Findings are returned without their polygon payloads: the codes, measurements and
      // entity ids are what the Agent acts on; dumping rings would blow the context budget.
      findings: result.findings.map(stripFinding),
      blocking,
      summary: summarizeModel(model),
      operationFingerprint: operationDigest,
      documentRevision: input.documentRevision ?? '',
      drawingFingerprint: drawing,
      layoutFingerprint: layout
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      findings: [],
      blocking: []
    }
  }
}

export interface SpatialReadbackInput {
  /** The placements the batch intended to draw, with the handles the mutation reported. */
  planned: PlannedItem[]
  /** The drawing read back AFTER the mutation (entity.list detail:"full"). */
  entities: SpatialRawEntity[]
  documentName?: string
  unitsPerMetre?: number
  spaceHints?: SpatialExtractOptions['spaceHints']
  options?: ReadbackOptions
}

export interface SpatialReadbackResult {
  success: boolean
  error?: string
  /** Verdict on the drawing as it actually is now — independent of the plan's earlier PASS. */
  status?: FindingStatus
  /** True when every planned item landed where planned AND the re-validated layout passes. */
  faithful?: boolean
  matches: ItemMatch[]
  discrepancies: string[]
  findings: SpatialFinding[]
  blocking: string[]
  /** Bounded next action: mechanical edits to apply, or escalate. */
  repair?: RepairPlan
}

/**
 * Post-mutation read-back: verify that what is ACTUALLY on the drawing is still the layout that was
 * validated. The preflight gate proved the plan; this proves the result. A tool that snapped a
 * coordinate, dropped an entity, or drew a different block turns a PASS plan into a FAIL drawing, and
 * only re-reading the drawing can see it. `faithful` is the completion signal: it is true only when
 * every planned item matched within tolerance and re-validating the drawn geometry still passes.
 */
export function verifySpatialReadback(input: SpatialReadbackInput): SpatialReadbackResult {
  if (!Array.isArray(input.entities) || input.entities.length === 0) {
    return {
      success: false,
      error:
        'entities is required: read the drawing back with entity.list (detail:"full") AFTER the ' +
        'mutation, then pass it here. Read-back verifies the drawing, not the plan.',
      matches: [],
      discrepancies: [],
      findings: [],
      blocking: []
    }
  }
  if (!Array.isArray(input.planned)) {
    return {
      success: false,
      error: 'planned must be an array of the placements the batch intended to draw.',
      matches: [],
      discrepancies: [],
      findings: [],
      blocking: []
    }
  }
  try {
    const report = verifyDrawnLayout(
      input.planned,
      input.entities,
      {
        documentName: input.documentName,
        unitsPerMetre: input.unitsPerMetre,
        spaceHints: input.spaceHints
      },
      input.options
    )
    const blocking = blockingMessages(report.findings)
    return {
      success: true,
      status: report.status,
      faithful: report.faithful,
      matches: report.matches,
      discrepancies: report.discrepancies,
      repair: report.repair,
      // Findings without polygon payloads, same context-budget rule as validateSpatialLayout.
      findings: report.findings.map(stripFinding),
      blocking
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      matches: [],
      discrepancies: [],
      findings: [],
      blocking: []
    }
  }
}
