import type { Point2D } from '../schemas/semantic-model'
import { areaOf, bboxOf, ensureCCW, pointInPolygon, type BBox } from './geometry'
import { extractSpatialModel, type SpatialExtractOptions, type SpatialRawEntity } from './extract'
import type { SpatialFinding } from './constraints'
import type { Space, SpatialModel } from './spatial-schema'
import type { RestrictedZone } from './preflight'

/**
 * Region-scoped semantic grounding.
 *
 * The gap this closes: an agent can *see* an elevator shaft in a viewport capture and then draw a
 * wire straight through it, because nothing converted what it understood into authoritative CAD
 * coordinates with an enforceable restriction. A `RegionContext` is that conversion — a small,
 * evidence-backed statement about the part of the drawing a task touches:
 *
 *   AutoCAD geometry is the source of truth for the polygon;
 *   classification (what the region IS) may come from layers, blocks, and labels;
 *   a zone whose ring was not read from real entities is reported as unverified, never as a boundary.
 *
 * Vision may *name* a region; it never makes a polygon authoritative. That is why every zone here
 * carries `sourceHandles` and a `verified` flag derived from the entity that produced the ring.
 *
 * Reuse is deliberate: this reads through `extractSpatialModel` rather than building a second
 * geometric database, and the result is small enough to hand to a model (zones + bboxes + counts),
 * not a raw entity dump.
 */

/** Bump when the shape of a cached region interpretation changes. */
export const REGION_SCHEMA_VERSION = 'region-1'

/** Zone classes this module knows how to derive from drawing evidence. */
export type KnownZoneClass =
  | 'elevator_shaft'
  | 'stairwell'
  | 'electrical_riser'
  | 'fire_compartment'
  | 'restricted'
  | 'unknown'

/**
 * Classification signals. Tokens are in `foldKey` form (uppercase, `_` separators), matching
 * `extract.ts`, so a Vietnamese layer name ("Thang máy") folds to THANG_MAY and matches. These are
 * project-vocabulary signals, not code clauses: an unrecognised region stays `unknown`, which
 * preflight treats as "cannot be drawn through", not as "free to draw through".
 */
const ZONE_TOKENS: Array<[KnownZoneClass, string[]]> = [
  ['elevator_shaft', ['ELEVATOR', 'ELEV', 'LIFT', 'THANG_MAY', 'THANG_MAY', 'ELEV_SHAFT']],
  ['stairwell', ['STAIR', 'STAIRWELL', 'CAU_THANG', 'THANG_BO']],
  ['electrical_riser', ['ELEC_RISER', 'DIEP_THE', 'HOP_THE', 'ELECTRICAL_SHAFT', 'TELECOM_SHAFT']],
  ['fire_compartment', ['FIRE_COMPART', 'KHO_CHAY', 'PCCC_KHU']]
]

/** Layers whose whole purpose is to mark a volume nothing may enter. */
const RESTRICTED_LAYER_TOKENS = ['KHOANG_CAM', 'RESTRICTED', 'NO_GO', 'SHAFT']

/** How many entities one region read may return before it is truncated as too broad. */
const MAX_REGION_ENTITIES = 4000

export interface RegionQuery {
  documentName?: string
  documentRevision?: string
  /** World XY rectangle the task touches. Region-scoped reads are the point: no full rescans. */
  window?: { min: Point2D; max: Point2D }
  /** Free-text target, e.g. "basement level B1" — carried into the result, never guessed at. */
  floorHint?: string
  unitsPerMetre?: number
  /** User-declared classification overrides (e.g. "the ring on ELEV_ is the lift shaft"). */
  zoneHints?: Array<{ handle: string; zoneClass: KnownZoneClass }>
}

export interface RegionCoverage {
  /** complete: every entity in the window was supplied. partial: the caller's source was capped or
   * filtered, so absence of a zone is NOT evidence that no zone exists. */
  status: 'complete' | 'partial' | 'unknown'
  entityCount: number
  /** What bounded it, when partial — a truncation cap, a layer filter, a CAD State page. */
  limitReason?: string
  window?: { min: Point2D; max: Point2D }
}

export interface RegionContext {
  schemaVersion: string
  drawing: {
    documentName: string
    documentRevision: string
    /** Digest of the geometry this interpretation was built from. */
    drawingFingerprint: string
    units: { perMetre: number; declared: boolean }
  }
  region: {
    window: { min: Point2D; max: Point2D } | null
    floorHint: string | null
  }
  /** Enforceable output: the restricted volumes in this region, with their source evidence. */
  zones: RestrictedZone[]
  /** The spatial model the zones were derived from (spaces/openings/furniture, already extracted). */
  model: SpatialModel
  coverage: RegionCoverage
  /** Geometry that could not be reconstructed — reported, never silently dropped. */
  findings: SpatialFinding[]
  /** Cache key for reuse across tasks; see `regionCacheKey`. */
  cacheKey: string
}

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** Classify one space from its name, layer, usage and attributes, with the evidence attached. */
function classifyZoneClass(
  space: Space,
  hints: Map<string, KnownZoneClass>
): { zoneClass: KnownZoneClass; evidence: string; confidence: RestrictedZone['confidence'] } {
  const handleHit = space.sourceHandles.map((h) => hints.get(h)).find((z) => z !== undefined)
  if (handleHit) {
    return {
      zoneClass: handleHit,
      evidence: 'user-declared hint',
      confidence: 'high'
    }
  }
  const haystacks = [
    space.name ?? '',
    space.usage,
    ...space.sourceHandles.map((h) => h),
    ...space.evidence.map((e) => e.detail)
  ].map(fold)
  const joined = haystacks.join(' ')
  for (const [zoneClass, tokens] of ZONE_TOKENS) {
    const hit = tokens.find((t) => joined.includes(t))
    if (hit) {
      return { zoneClass, evidence: `name/usage matches "${hit}"`, confidence: 'high' }
    }
  }
  // A space whose usage already says staircase is a stairwell even if the label was odd.
  if (space.usage === 'staircase') {
    return { zoneClass: 'stairwell', evidence: 'extractor usage = staircase', confidence: 'high' }
  }
  const layerHit = RESTRICTED_LAYER_TOKENS.find((t) => joined.includes(t))
  if (layerHit) {
    return {
      zoneClass: 'restricted',
      evidence: `layer matches "${layerHit}"`,
      confidence: 'medium'
    }
  }
  return { zoneClass: 'unknown', evidence: 'no classification signal', confidence: 'unknown' }
}

function windowOf(
  entities: SpatialRawEntity[],
  explicit?: RegionQuery['window']
): RegionContext['region']['window'] {
  if (explicit) return explicit
  const points = entities.flatMap((e) => {
    if (e.bounds)
      return [
        [e.bounds.min.x, e.bounds.min.y],
        [e.bounds.max.x, e.bounds.max.y]
      ]
    const g = e.geometry
    if (!g) return []
    if (g.start && g.end)
      return [
        [g.start.x, g.start.y],
        [g.end.x, g.end.y]
      ]
    if (g.position) return [[g.position.x, g.position.y]]
    if (Array.isArray(g.vertices))
      return g.vertices.map((v) =>
        Array.isArray(v) ? [v[0], v[1]] : [v.point?.x ?? v.x ?? 0, v.point?.y ?? v.y ?? 0]
      )
    return []
  })
  const box = bboxOf(points as Point2D[])
  return box ? { min: [box.minX, box.minY], max: [box.maxX, box.maxY] } : null
}

/** Does this entity lie (even partly) inside the requested window? Bbox prefilter only. */
function entityInWindow(
  ent: SpatialRawEntity,
  window: NonNullable<RegionQuery['window']>
): boolean {
  const box: BBox | null = ent.bounds
    ? {
        minX: ent.bounds.min.x,
        minY: ent.bounds.min.y,
        maxX: ent.bounds.max.x,
        maxY: ent.bounds.max.y
      }
    : (() => {
        const g = ent.geometry
        if (!g) return null
        const pts: Point2D[] = []
        if (g.start) pts.push([g.start.x, g.start.y])
        if (g.end) pts.push([g.end.x, g.end.y])
        if (g.position) pts.push([g.position.x, g.position.y])
        if (g.center && g.radius !== undefined) {
          pts.push([g.center.x - g.radius, g.center.y - g.radius])
          pts.push([g.center.x + g.radius, g.center.y + g.radius])
        }
        if (Array.isArray(g.vertices))
          for (const v of g.vertices)
            pts.push(
              Array.isArray(v) ? [v[0], v[1]] : [v.point?.x ?? v.x ?? 0, v.point?.y ?? v.y ?? 0]
            )
        return bboxOf(pts)
      })()
  if (!box) return true // no geometry to localize: keep it, do not silently drop entities
  return (
    box.minX <= window.max[0] &&
    box.maxX >= window.min[0] &&
    box.minY <= window.max[1] &&
    box.maxY >= window.min[1]
  )
}

/**
 * Derive enforceable restricted zones from the extracted model.
 *
 * A zone is `verified` only when its ring came from real read vertices (>= 3 points and non-zero
 * area). Extractor `insufficientData` entries become explicit findings: the region is not
 * "clear of shafts", it is "a shaft-like region exists whose boundary could not be recovered".
 */
/**
 * Entity-level sweep for protected volumes the model could not represent.
 *
 * A closed ring whose vertices could not be read never becomes a `Space`, so model-level
 * classification would report "no shaft here" — the silent-pass failure this exists to prevent.
 * Any entity whose layer or block names a zone class, but which produced no zone, is reported as
 * an unrecoverable candidate instead.
 */
function unrecoverableZoneCandidates(
  entities: SpatialRawEntity[],
  model: SpatialModel,
  zones: RestrictedZone[],
  hints: Map<string, KnownZoneClass>
): SpatialFinding[] {
  const explained = new Set(zones.flatMap((z) => z.sourceHandles))
  for (const space of model.spaces) for (const h of space.sourceHandles) explained.add(h)
  const findings: SpatialFinding[] = []
  for (const ent of entities) {
    if (explained.has(ent.handle)) continue
    const haystack = fold(
      [ent.layer, ent.geometry?.blockName ?? '', ent.geometry?.name ?? ''].join(' ')
    )
    const zoneClass =
      hints.get(ent.handle) ??
      ZONE_TOKENS.find(([, tokens]) => tokens.some((t) => haystack.includes(t)))?.[0]
    if (!zoneClass || zoneClass === 'unknown') continue
    findings.push({
      code: 'REGION_BOUNDARY_UNRECOVERABLE',
      severity: 'warning',
      status: 'INSUFFICIENT_DATA',
      entityIds: [ent.handle],
      constraintId: 'region-inspection',
      message: `${ent.handle} is on a ${zoneClass} layer but its boundary could not be reconstructed, so no zone could be enforced there`,
      suggestedCorrection: `read ${ent.handle} with entity.get detail:"full" (nested block contents and hatch loops included) and rebuild the ring before drawing near it`
    })
  }
  return findings
}

export function deriveRestrictedZones(
  model: SpatialModel,
  zoneHints: Map<string, KnownZoneClass>
): { zones: RestrictedZone[]; findings: SpatialFinding[] } {
  const zones: RestrictedZone[] = []
  const findings: SpatialFinding[] = []

  for (const space of model.spaces) {
    const classified = classifyZoneClass(space, zoneHints)
    if (classified.zoneClass === 'unknown') continue
    const ring = ensureCCW(space.boundary)
    const verified = ring.length >= 3 && areaOf(ring) > 0
    if (!verified) {
      findings.push({
        code: 'REGION_BOUNDARY_UNRECOVERABLE',
        severity: 'warning',
        status: 'INSUFFICIENT_DATA',
        entityIds: [space.id, ...space.sourceHandles],
        constraintId: 'region-inspection',
        message: `region ${space.id} looks like ${classified.zoneClass} but its boundary could not be recovered (${ring.length} vertices)`,
        suggestedCorrection: `read ${space.sourceHandles.join(', ') || space.id} with entity.get detail:"full", or reconstruct the ring from its wall segments`
      })
      continue
    }
    zones.push({
      id: `zone-${space.id}`,
      zoneClass: classified.zoneClass,
      outer: ring,
      holes: space.holes,
      verified,
      sourceHandles: space.sourceHandles.length > 0 ? space.sourceHandles : [space.id],
      confidence: classified.confidence,
      evidence: classified.evidence
    })
  }

  // Site-level no-placement regions are already asserted by the caller/model; they enter the same
  // enforcement path rather than a parallel one.
  for (const region of model.site?.noPlacementRegions ?? []) {
    const ring = ensureCCW(region.boundary)
    if (ring.length < 3 || areaOf(ring) === 0) continue
    if (zones.some((z) => z.sourceHandles.join() === region.sourceHandles.join())) continue
    zones.push({
      id: `zone-nopr-${region.id}`,
      zoneClass: 'restricted',
      outer: ring,
      holes: region.holes,
      verified: true,
      sourceHandles: region.sourceHandles.length > 0 ? region.sourceHandles : [region.id],
      confidence: 'high',
      evidence: 'declared no-placement region'
    })
  }

  for (const gap of model.insufficientData) {
    findings.push({
      code: 'REGION_GEOMETRY_INSUFFICIENT',
      severity: 'warning',
      status: 'INSUFFICIENT_DATA',
      entityIds: [gap.handle],
      constraintId: 'region-inspection',
      message: `geometry for ${gap.handle} could not be reconstructed: ${gap.reason}`,
      suggestedCorrection:
        're-read that entity with detail:"full" (nested block contents / hatch loops included) before drawing near it'
    })
  }

  return { zones, findings }
}

/**
 * Build the region interpretation for one task from native CAD entities.
 *
 * `entities` are what `entity.list detail:"full"` returns, optionally already filtered by a window
 * or layer. `coverage.status` is the caller's honest statement about that set: passing `complete`
 * when the read was capped is the one thing this module cannot detect for you, which is why the
 * capability layer derives it from the CAD State snapshot rather than taking the model's word.
 */
export function buildRegionContext(
  entities: SpatialRawEntity[],
  query: RegionQuery & { coverage?: RegionCoverage } = {}
): RegionContext {
  const window = windowOf(entities, query.window)
  const scoped =
    query.window && window ? entities.filter((e) => entityInWindow(e, query.window!)) : entities
  const truncated = scoped.length > MAX_REGION_ENTITIES
  const used = truncated ? scoped.slice(0, MAX_REGION_ENTITIES) : scoped

  const model = extractSpatialModel(used, {
    documentName: query.documentName,
    unitsPerMetre: query.unitsPerMetre,
    spaceHints: query.zoneHints?.map((h) => ({ handle: h.handle }))
  })

  const hints = new Map((query.zoneHints ?? []).map((h) => [h.handle, h.zoneClass]))
  const { zones, findings } = deriveRestrictedZones(model, hints)
  // Entities that name a protected volume but produced no zone: report them, so a missing
  // boundary reads as insufficient data rather than as an unobstructed region.
  findings.push(...unrecoverableZoneCandidates(used, model, zones, hints))

  const coverage: RegionCoverage = query.coverage ?? {
    status: truncated ? 'partial' : scoped.length === entities.length ? 'complete' : 'partial',
    entityCount: used.length,
    ...(truncated && { limitReason: `region window exceeded ${MAX_REGION_ENTITIES} entities` }),
    ...(window && { window })
  }

  return {
    schemaVersion: REGION_SCHEMA_VERSION,
    drawing: {
      documentName: model.documentName ?? query.documentName ?? '',
      documentRevision: query.documentRevision ?? '',
      drawingFingerprint: fingerprintEntities(used),
      units: model.units
    },
    region: { window, floorHint: query.floorHint ?? null },
    zones,
    model,
    coverage,
    findings,
    cacheKey: regionCacheKey({
      drawingId: model.documentName ?? query.documentName ?? '',
      revision: query.documentRevision ?? '',
      window,
      schemaVersion: REGION_SCHEMA_VERSION
    })
  }
}

/**
 * Cache key for reuse: same drawing, same revision, same region, same schema. A revision change
 * changes the key, which is what invalidates an authorization built on the old geometry.
 */
export function regionCacheKey(input: {
  drawingId: string
  revision: string
  window: { min: Point2D; max: Point2D } | null
  schemaVersion?: string
}): string {
  const w = input.window
  const region = w
    ? `${Math.round(w.min[0])},${Math.round(w.min[1])},${Math.round(w.max[0])},${Math.round(w.max[1])}`
    : 'full'
  return `${input.drawingId}|${input.revision}|${region}|${input.schemaVersion ?? REGION_SCHEMA_VERSION}`
}

/** Local digest fallback when the model did not carry one. */
function fingerprintEntities(entities: SpatialRawEntity[]): string {
  let h = 2166136261
  for (const e of entities) {
    const s = `${e.handle}:${e.kind}:${e.layer}:${e.bounds ? `${e.bounds.min.x},${e.bounds.min.y},${e.bounds.max.x},${e.bounds.max.y}` : ''}`
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Does a point fall inside any of the region's restricted zones? Reused by routers. */
export function pointInRestrictedZone(pt: Point2D, zones: RestrictedZone[]): RestrictedZone | null {
  for (const zone of zones) {
    if (pointInPolygon(pt, zone.outer, zone.holes ?? [], 0)) return zone
  }
  return null
}
