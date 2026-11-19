import type { Point2D } from '../schemas/semantic-model'
import {
  SpatialModelSchema,
  type SpatialModel,
  type Space,
  type SpaceType,
  type SpaceUsage,
  type SpatialOpening,
  type Furniture,
  type FurnitureKind,
  type SpatialRelation,
  type ClassificationEvidence,
  type Confidence
} from './spatial-schema'
import {
  areaOf,
  bboxOf,
  bulgeToArcPoints,
  centroidOf,
  doorSweepPolygon,
  distanceToRingBoundary,
  pointInPolygon,
  ringInsidePolygon,
  ringsBoundaryIntersect,
  ringsOverlap,
  rotatedRect
} from './geometry'
import { SpatialIndex2D } from '../semantic/spatial-index'

/**
 * Derives the architectural `SpatialModel` from raw CAD entities.
 *
 * The governing rule: never invent geometry. A space is only emitted when its real boundary was
 * read (polyline vertices, bulges tessellated). When the boundary cannot be recovered the entity
 * is reported in `insufficientData` with a reason — an axis-aligned rectangle is never substituted,
 * because a fabricated rectangle is what let the agent place a garden inside a bedroom.
 */

/**
 * One polyline vertex, in every shape this repo actually carries. `entity.get`/`entity.list`
 * detail:"full" emits `{ point: { x, y } }` (plus `bulge` only on vertices that set it), while the
 * CAD tools also accept the bare point forms `{ x, y }` and `[x, y]`, and callers hand snapshots in
 * those shapes. Declaring all three keeps the type honest about the wire instead of pretending it
 * is one thing — and an unusual-but-real vertex is never rejected and then "recovered" as a
 * fabricated rectangle.
 */
export type SpatialRawVertex =
  { point?: { x: number; y: number }; x?: number; y?: number; bulge?: number } | [number, number]

export interface SpatialRawEntity {
  handle: string
  /** 'line' | 'polyline' | 'blockReference' | 'circle' | 'arc' | 'hatch' | 'text.singleLine' | 'mtext' */
  kind: string
  layer: string
  bounds?: { min: { x: number; y: number }; max: { x: number; y: number } }
  geometry?: {
    /**
     * Polyline vertices, in every shape this repo actually carries (see `SpatialRawVertex`): the
     * `{ point }` object `entity.get`/`entity.list` detail:"full" emits, the bare `{ x, y }` pair,
     * and the bare `[x, y]` point array the CAD tools accept. Declaring all three is deliberate —
     * a vertex of any of these shapes must read as geometry, never be rejected and then "recovered"
     * as a fabricated rectangle.
     */
    vertices?: SpatialRawVertex[]
    closed?: boolean
    start?: { x: number; y: number }
    end?: { x: number; y: number }
    center?: { x: number; y: number }
    radius?: number
    name?: string
    blockName?: string
    position?: { x: number; y: number }
    rotation?: number
    text?: string
  }
  attributes?: Record<string, string>
}

export interface SpatialExtractOptions {
  documentName?: string
  /** Drawing unit → metres: 1000 for millimetres, 1 for metres, 39.37 for inches. Optional, but
   * omitting it is an assumption the model reports rather than hides — the #413 SS11.1 native
   * audit found partner drawings declaring INSUNITS=1 (inches), so a millimetre default silently
   * shrinks every area by 25.4² and the clutter gate below then deletes real rooms. */
  unitsPerMetre?: number
  /** User-declared context that overrides layer guessing (e.g. "the polygon on KV_ is the garden"). */
  spaceHints?: Array<{ handle: string; usage?: SpaceUsage; spaceType?: SpaceType }>
  /** A closed polyline smaller than this (m²) is detail clutter, not a room. */
  minSpaceAreaM2?: number
}

const MM_PER_M = 1000

// --- classification signals ---------------------------------------------------------------------

// Tokens are written in the same folded form foldKey() produces (uppercase, `_` for any
// separator), so a match never depends on how the original name was punctuated.
const WALL_TOKENS = ['WALL', 'TUONG', 'A_WALL', 'PAREMENT']
const DOOR_TOKENS = ['DOOR', 'CUA_DI', 'A_DOOR', 'CUA']
const WINDOW_TOKENS = ['WINDOW', 'A_WIN', 'CUA_SO']
const FURNITURE_TOKENS = [
  'FURN',
  'NOI_THAT',
  'A_FURN',
  'SOFA',
  'BED',
  'TABLE',
  'DESK',
  'WARDROBE',
  'SAN_',
  'BAN_',
  'GHE',
  'KE_'
]
const OUTDOOR_TOKENS = [
  'GARDEN',
  'VUON',
  'SAN_VUON',
  'CAY',
  'TREE',
  'LANDSCAP',
  'EXTERNAL',
  'SAN_TRUOC'
]
const COURTYARD_TOKENS = ['GIENG_TROI', 'COURT', 'ATRIUM', 'QUANG_DUONG', 'SKYLIGHT']
const SITE_TOKENS = ['SITE', 'GIOI', 'PHAI_LY', 'LOT', 'PARCEL', 'RANH']
const ROOM_TOKENS = ['ROOM', 'PHONG', 'KV', 'SPACE', 'DIEN_TICH', 'TANG']
// Structural columns are building fabric, not furniture: they block a placement but are never a
// movable item. Matched as whole words so `TRU` (Trụ) cannot fire inside `SAN_TRUOC` (terrace).
const COLUMN_TOKENS = ['COLUMN', 'COLUMNS', 'COL', 'COLS', 'PIER', 'COT', 'TRU']

/**
 * Fold a name to a comparable ASCII key: NFD, drop combining marks, đ→d, uppercase, then every
 * non-alphanumeric run becomes `_`. Without this, a real Vietnamese layer ("Tường", "Cửa đi",
 * "Phòng ngủ") loses its diacritics to a plain strip and matches none of the ASCII tokens above.
 */
function foldKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const hasToken = (upper: string, tokens: string[]): boolean => tokens.some((t) => upper.includes(t))

/** Whole-word variant: the folded key is split on `_`, so `TRU` matches `TRU` and `A_TRU_01` but
 * never `SAN_TRUOC`. Used for the short structural tokens, where a substring hit is a real risk. */
const hasWord = (upper: string, tokens: string[]): boolean => {
  const words = new Set(upper.split('_').filter(Boolean))
  return tokens.some((t) => words.has(t))
}
/**
 * Layer names are ONE signal among several, never the whole answer. Entity kind, block name,
 * attributes, annotation text, and geometric role (closed ring vs open run) all contribute, and
 * every classification carries the evidence that produced it so a wrong call is auditable.
 */
function classifyEntity(
  ent: SpatialRawEntity,
  ring: Point2D[] | null
): {
  role: 'wall' | 'door' | 'window' | 'furniture' | 'space' | 'site' | 'annotation' | 'unknown'
  confidence: Confidence
  evidence: ClassificationEvidence[]
} {
  const layerUpper = foldKey(ent.layer)
  const blockName = foldKey(ent.geometry?.name ?? ent.geometry?.blockName ?? '')
  const attrText = foldKey(Object.values(ent.attributes ?? {}).join(' '))
  const text = foldKey(ent.geometry?.text ?? '')
  const evidence: ClassificationEvidence[] = []
  const push = (source: ClassificationEvidence['source'], detail: string): void => {
    evidence.push({ source, detail })
  }
  const isClosedRing = ring !== null && ring.length >= 3

  if (ent.kind === 'line') {
    if (hasToken(layerUpper, WALL_TOKENS)) {
      push('layer', `layer "${ent.layer}" matches a wall token`)
      return { role: 'wall', confidence: 'high', evidence }
    }
    push('geometry', 'open line segment')
    return { role: 'unknown', confidence: 'low', evidence }
  }

  if (ent.kind === 'blockReference') {
    // Window before door: "CỬA SỔ" (window) folds to CUA_SO, which contains the door token CUA.
    if (hasToken(blockName, WINDOW_TOKENS) || hasToken(layerUpper, WINDOW_TOKENS)) {
      push('layer', `layer "${ent.layer}" / block "${blockName}" matches a window token`)
      return { role: 'window', confidence: 'medium', evidence }
    }
    if (hasToken(blockName, DOOR_TOKENS) || hasToken(layerUpper, DOOR_TOKENS)) {
      if (blockName) push('blockName', `block "${blockName}"`)
      if (hasToken(layerUpper, DOOR_TOKENS)) push('layer', `layer "${ent.layer}"`)
      return { role: 'door', confidence: blockName ? 'high' : 'medium', evidence }
    }
    // Column before furniture: a structural pier is building fabric. It is modelled with the
    // furniture footprint machinery (so it gets a real rotated footprint) but kinded as 'column',
    // which the constraint engine turns into a fixed obstacle nothing may be placed inside.
    if (hasWord(blockName, COLUMN_TOKENS) || hasWord(layerUpper, COLUMN_TOKENS)) {
      if (blockName) push('blockName', `block "${blockName}"`)
      if (hasWord(layerUpper, COLUMN_TOKENS)) push('layer', `layer "${ent.layer}"`)
      return { role: 'furniture', confidence: 'high', evidence }
    }
    if (hasToken(blockName, FURNITURE_TOKENS) || hasToken(layerUpper, FURNITURE_TOKENS)) {
      if (blockName) push('blockName', `block "${blockName}"`)
      if (hasToken(layerUpper, FURNITURE_TOKENS)) push('layer', `layer "${ent.layer}"`)
      return { role: 'furniture', confidence: blockName ? 'high' : 'medium', evidence }
    }
    if (attrText) push('attribute', `attributes: ${attrText.slice(0, 80)}`)
    return { role: 'unknown', confidence: 'unknown', evidence }
  }

  if (ent.kind === 'hatch' || ent.kind === 'polyline') {
    // A polyline on a space/site layer is a space candidate even when its vertices could not be
    // read — the caller then reports it in `insufficientData`. Classifying it as "unknown" would
    // hide the fact that a room boundary exists but is unusable, which is exactly the case where
    // an agent invents a rectangle.
    if (hasToken(layerUpper, COURTYARD_TOKENS)) {
      push('layer', `layer "${ent.layer}" matches a courtyard token`)
      return { role: 'space', confidence: 'high', evidence }
    }
    if (hasToken(layerUpper, OUTDOOR_TOKENS)) {
      push('layer', `layer "${ent.layer}" matches an outdoor token`)
      return { role: 'space', confidence: 'high', evidence }
    }
    if (hasToken(layerUpper, SITE_TOKENS)) {
      push('layer', `layer "${ent.layer}" matches a site-boundary token`)
      return { role: 'site', confidence: 'high', evidence }
    }
    if (hasToken(layerUpper, ROOM_TOKENS)) {
      push('layer', `layer "${ent.layer}" matches a room token`)
      return { role: 'space', confidence: 'high', evidence }
    }
    if (hasToken(layerUpper, WALL_TOKENS) && !isClosedRing) {
      push('layer', `layer "${ent.layer}" matches a wall token`)
      return { role: 'wall', confidence: 'medium', evidence }
    }
    // A closed ring on an unremarkable layer is still a candidate space — but only a candidate,
    // so confidence is low and validation treats it as such.
    if (isClosedRing) {
      push('geometry', `closed ${ring!.length}-vertex ring`)
      return { role: 'space', confidence: 'low', evidence }
    }
    return { role: 'unknown', confidence: 'unknown', evidence }
  }

  if (ent.kind.startsWith('text') || ent.kind === 'mtext') {
    if (text) push('text', `annotation "${text.slice(0, 60)}"`)
    return { role: 'annotation', confidence: 'high', evidence }
  }

  return { role: 'unknown', confidence: 'unknown', evidence }
}

/** Usage from layer / block / annotation text. Unknown stays unknown rather than guessing "living". */
function inferUsage(haystacks: string[]): {
  usage: SpaceUsage
  evidence: ClassificationEvidence[]
} {
  const joined = foldKey(haystacks.join(' '))
  const table: Array<[SpaceUsage, string[]]> = [
    ['bedroom', ['BEDROOM', 'PHONG_NGU', 'PHONG NGU']],
    ['kitchen', ['KITCHEN', 'BEP']],
    ['bathroom', ['BATH', 'WC', 'VE_SINH', 'TOILET']],
    ['dining', ['PHONG_AN', 'DINING']],
    ['living', ['PHONG_KHACH', 'LIVING']],
    ['office', ['OFFICE', 'LAM_VIEC']],
    ['hallway', ['HALL', 'HANH_LANG', 'CORRIDOR', 'LOI_DI']],
    ['staircase', ['STAIR', 'CAU_THANG']],
    ['garage', ['GARAGE', 'OX_DUNG']],
    ['storage', ['STORAGE', 'KHO']],
    ['laundry', ['LAUNDRY', 'GIAT']],
    ['garden', ['GARDEN', 'VUON']],
    ['courtyard', ['COURT', 'GIENG_TROI', 'QUANG_DUONG']],
    ['atrium', ['ATRIUM']],
    ['terrace', ['TERRACE', 'SAN_TRUOC', 'LOGIA']],
    ['driveway', ['DRIVE', 'DUONG_XE']],
    ['utility', ['UTILITY', 'KY_THUAT']]
  ]
  for (const [usage, tokens] of table) {
    const hit = tokens.find((t) => joined.includes(t))
    if (hit) {
      return {
        usage,
        evidence: [{ source: 'layer', detail: `name matches "${hit}"` }]
      }
    }
  }
  return { usage: 'unknown', evidence: [] }
}

/**
 * Indoor vs outdoor is decided by topology and name, never by a convex-hull envelope. A hull
 * swallows the notch of an L-shaped building, so a garden sitting in that notch (genuinely outside
 * the building) reads as "inside the footprint" and gets mislabelled indoor — the exact inversion
 * this replaces. Instead:
 *   - a ring named as a courtyard, or carved as a hole in a floor plate, is a courtyard;
 *   - a ring named outdoor (garden/driveway) is outdoor regardless of position;
 *   - a ring whose centroid lies inside another room's real boundary is indoor (nested containment);
 *   - a ring named as a room is indoor even when isolated;
 *   - otherwise it is an open outdoor region.
 */
function inferSpaceType(
  ring: Point2D[],
  nameHaystack: string,
  buildingRings: Point2D[][],
  isHole: boolean
): { spaceType: SpaceType; evidence: ClassificationEvidence[] } {
  const evidence: ClassificationEvidence[] = []
  const folded = foldKey(nameHaystack)
  if (hasToken(folded, COURTYARD_TOKENS)) {
    evidence.push({ source: 'layer', detail: 'name marks a courtyard/atrium space' })
    return { spaceType: 'courtyard', evidence }
  }
  if (isHole) {
    evidence.push({
      source: 'geometry',
      detail: 'ring is a hole carved out of a larger floor plate'
    })
    return { spaceType: 'courtyard', evidence }
  }
  if (hasToken(folded, OUTDOOR_TOKENS)) {
    evidence.push({ source: 'layer', detail: 'name marks an outdoor region' })
    return { spaceType: 'outdoor', evidence }
  }
  // The centroid, not a vertex: a garden ring sharing a fence line with the building has vertices ON
  // the building boundary, and a vertex test would call it indoor.
  const centroid = centroidOf(ring)
  const nested = buildingRings.some((other) => other !== ring && pointInPolygon(centroid, other))
  if (nested) {
    evidence.push({ source: 'adjacency', detail: 'centroid lies inside another room boundary' })
    return { spaceType: 'indoor', evidence }
  }
  if (hasToken(folded, ROOM_TOKENS)) {
    evidence.push({
      source: 'layer',
      detail: 'name marks a room; a room is indoor even if isolated'
    })
    return { spaceType: 'indoor', evidence }
  }
  if (buildingRings.length) {
    evidence.push({
      source: 'geometry',
      detail: 'ring lies outside every room boundary — an open region'
    })
    return { spaceType: 'outdoor', evidence }
  }
  evidence.push({
    source: 'geometry',
    detail: 'no room boundaries available to classify indoor/outdoor'
  })
  return { spaceType: 'unknown', evidence }
}

function furnitureKindOf(blockName: string, layer: string): FurnitureKind {
  const h = foldKey(`${blockName} ${layer}`)
  if (hasWord(h, COLUMN_TOKENS)) return 'column'
  const table: Array<[FurnitureKind, string[]]> = [
    ['bed', ['BED', 'GIUONG']],
    ['sofa', ['SOFA']],
    ['diningTable', ['BAN_AN', 'DINING']],
    ['table', ['TABLE', 'BAN']],
    ['chair', ['CHAIR', 'GHE']],
    ['wardrobe', ['WARDROBE', 'TU_QUAN']],
    ['cabinet', ['CABINET', 'KE']],
    ['counter', ['COUNTER', 'QUAT_BEP']],
    ['desk', ['DESK']],
    ['sanitary', ['TOILET', 'LAVABO']],
    ['appliance', ['APPLIANCE', 'MAY']],
    ['plant', ['PLANT', 'CAY']]
  ]
  for (const [kind, tokens] of table) if (tokens.some((t) => h.includes(t))) return kind
  return blockName ? 'generic' : 'unknown'
}

/**
 * Read a real ring from a polyline's vertices (bulges tessellated), or null when unusable.
 *
 * A vertex is accepted in any shape this repo carries: the `{ point: { x, y } }` object the wire
 * emits, the bare `{ x, y }` pair, or the bare `[x, y]` point array. A vertex whose x or y is not
 * finite (NaN, null, a missing coordinate) is dropped and its bulge is dropped with it, so the two
 * lists stay aligned — a bulge never describes a segment it was not written against. Fewer than 3
 * usable vertices is not a ring: return null and let the caller report the entity in
 * `insufficientData`. No box is substituted, ever.
 */
function ringFromEntity(ent: SpatialRawEntity): Point2D[] | null {
  const verts = ent.geometry?.vertices
  if (!verts || verts.length < 3) return null
  const pts: Point2D[] = []
  const bulges: number[] = []
  for (const v of verts) {
    const p = Array.isArray(v) ? { x: v[0], y: v[1] } : 'point' in v && v.point ? v.point : v
    const x = p.x
    const y = p.y
    // Non-numbers (null, undefined, a string on the wire) never survive: `Number(null)` would turn
    // a missing coordinate into a real-looking 0. A tuple carries no bulge, and a dropped vertex
    // must not shift the bulge list onto a segment it was not written against.
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    pts.push([x, y])
    bulges.push(Array.isArray(v) ? 0 : (v.bulge ?? 0))
  }
  if (pts.length < 3) return null
  const closed = ent.geometry?.closed ?? true
  if (!closed) return null // an open polyline is not a usable boundary
  const tessellated = bulgeToArcPoints(pts, bulges, true)
  return tessellated.length >= 3 ? tessellated : null
}

const toM2 = (areaUnits: number, unitsPerMetre: number): number =>
  Math.round((areaUnits / (unitsPerMetre * unitsPerMetre)) * 100) / 100

const nearestEndpoint = (p: Point2D, a: Point2D, b: Point2D): Point2D =>
  Math.hypot(p[0] - a[0], p[1] - a[1]) <= Math.hypot(p[0] - b[0], p[1] - b[1]) ? a : b

const angleOf = (a: Point2D, b: Point2D): number =>
  (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI

/**
 * Invert the axis-aligned bounding box of a rotated rectangle back into its local extents.
 *   aabbW = |w·cosθ| + |d·sinθ|,  aabbH = |w·sinθ| + |d·cosθ|
 * Degenerate angles fall back to the box itself, which is conservative (over-estimates).
 */
export function extentsFromAabb(
  aabbW: number,
  aabbH: number,
  rotationDeg: number
): [number, number] {
  const rad = (rotationDeg * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  const denom = c * c - s * s
  // At θ=45° the two equations are linearly dependent: w and d cannot be recovered from the box.
  // Fall back to the box itself, which over-estimates the footprint — the conservative direction
  // for a collision check (a false PASS is what let furniture block door swings).
  if (Math.abs(denom) < 1e-6) return [aabbW, aabbH]
  const w = (aabbW * c - aabbH * s) / denom
  const d = (aabbH * c - aabbW * s) / denom
  if (!(w > 0) || !(d > 0)) return [aabbW, aabbH]
  return [w, d]
}

/**
 * The room rings that make up "the building", used ONLY to answer "is this ring inside a room".
 * Deliberately a list of real rings, not one envelope: a convex hull swallows the notch of an
 * L-shaped plan and would call a garden in that notch indoor. Named outdoor/courtyard rings are
 * excluded so a garden never becomes part of the building it is being tested against.
 */
function deriveBuildingRings(candidates: Array<{ ring: Point2D[]; layer: string }>): Point2D[][] {
  return candidates
    .filter((c) => {
      const folded = foldKey(c.layer)
      return !hasToken(folded, OUTDOOR_TOKENS) && !hasToken(folded, COURTYARD_TOKENS)
    })
    .map((c) => c.ring)
}

/**
 * Explicit door metadata a block may carry as attributes. A real door library often stores the
 * hinge point and swing side; when it does, that beats any geometric guess. Absent stays absent —
 * the engine then reports the hinge as a guess rather than dressing up a guess as a fact.
 */
function openingMetadata(ent: SpatialRawEntity): {
  hinge?: Point2D
  swing?: 'inward' | 'outward'
} {
  const out: { hinge?: Point2D; swing?: 'inward' | 'outward' } = {}
  for (const [key, value] of Object.entries(ent.attributes ?? {})) {
    const k = foldKey(key)
    if (!out.hinge && (k === 'HINGE' || k === 'HINGE_POINT' || k === 'DIEN_XOAY')) {
      const m = value.match(/(-?\d+(?:\.\d+)?)\s*[;,\s]\s*(-?\d+(?:\.\d+)?)/)
      if (m) {
        const x = Number(m[1])
        const y = Number(m[2])
        if (Number.isFinite(x) && Number.isFinite(y)) out.hinge = [x, y]
      }
    }
    if (!out.swing && (k === 'SWING' || k === 'SWING_DIRECTION' || k === 'HUONG_MO')) {
      const v = foldKey(value)
      if (v.includes('IN') || v === 'VAO' || v.includes('NOI')) out.swing = 'inward'
      else if (v.includes('OUT') || v === 'RA' || v.includes('NGOAI')) out.swing = 'outward'
    }
  }
  return out
}

/**
 * Which way the quarter-disc sweep should open from the leaf's rest direction. The leaf lies along
 * the wall; the arc can fall on either side of it, and the side that matters is where a space
 * actually is — an arc thrown into the wall itself clears furniture the leaf would hit. Chosen by
 * the majority side of the connected spaces' centroids; a tie (the usual interior door, one room
 * per side) keeps the historical +90 so existing verdicts do not shift.
 */
function sweepSignFor(
  hinge: Point2D,
  leafAngleDeg: number,
  connectsSpaces: string[],
  spacesById: Map<string, Space>
): 1 | -1 {
  const rad = (leafAngleDeg * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  let positive = 0
  let negative = 0
  for (const id of connectsSpaces) {
    const sp = spacesById.get(id)
    if (!sp) continue
    const c = centroidOf(sp.boundary)
    const cross = dx * (c[1] - hinge[1]) - dy * (c[0] - hinge[0])
    if (cross > 0) positive++
    else if (cross < 0) negative++
  }
  if (negative > positive) return -1
  return 1
}

/**
 * Does the wall actually stop where the opening is? A door symbol dropped on an unbroken wall line
 * is decoration, not an opening — the same failure mode as a door with no wall at all, and the
 * single continuous wall line is exactly what a careless redraw leaves behind. Project every
 * wall segment that runs along the host wall's line onto that line and ask whether wall material
 * covers the opening's centre. Null when there is no host wall to measure against.
 */
function wallGapAt(
  segments: Array<{ a: Point2D; b: Point2D }>,
  hostA: Point2D | null,
  hostB: Point2D | null,
  center: Point2D,
  width: number
): boolean | null {
  if (!hostA || !hostB) return null
  const dx = hostB[0] - hostA[0]
  const dy = hostB[1] - hostA[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  const ux = dx / len
  const uy = dy / len
  const perpTol = Math.max(width * 0.15, 100)
  const project = (p: Point2D): { along: number; off: number } => ({
    along: (p[0] - hostA[0]) * ux + (p[1] - hostA[1]) * uy,
    off: Math.abs((p[0] - hostA[0]) * -uy + (p[1] - hostA[1]) * ux)
  })
  const centre = project(center)
  for (const s of segments) {
    const pa = project(s.a)
    const pb = project(s.b)
    if (pa.off > perpTol || pb.off > perpTol) continue
    // Parallel check: a segment crossing the host line is not part of it.
    const sdx = s.b[0] - s.a[0]
    const sdy = s.b[1] - s.a[1]
    const slen = Math.hypot(sdx, sdy)
    if (slen < 1e-9) continue
    if (Math.abs((sdx / slen) * uy - (sdy / slen) * ux) > 0.2) continue
    const lo = Math.min(pa.along, pb.along)
    const hi = Math.max(pa.along, pb.along)
    if (centre.along >= lo - perpTol && centre.along <= hi + perpTol) return false // wall runs through it
  }
  return true
}

/**
 * Interior vs exterior from what the opening joins. One indoor space = a way to the outside;
 * two indoor spaces = an interior link; anything touching an outdoor/courtyard region is an
 * exterior boundary. Unknown when the spaces on either side could not be typed — the accessibility
 * roots read this, so a wrong guess here would silently seal or open a whole floor.
 */
function classifyConnection(
  connectsSpaces: string[],
  spacesById: Map<string, Space>
): 'interior' | 'exterior' | 'unknown' {
  const typed = connectsSpaces.map((id) => spacesById.get(id)).filter((s): s is Space => Boolean(s))
  if (typed.length === 0) return 'unknown'
  const outdoorish = typed.some(
    (s) =>
      s.spaceType === 'outdoor' || s.spaceType === 'courtyard' || s.spaceType === 'semi_outdoor'
  )
  if (outdoorish) return 'exterior'
  if (typed.length === 1) return 'exterior'
  if (typed.every((s) => s.spaceType === 'indoor')) return 'interior'
  return 'unknown'
}

export function extractSpatialModel(
  entities: SpatialRawEntity[],
  options: SpatialExtractOptions = {}
): SpatialModel {
  const unitsDeclared = options.unitsPerMetre !== undefined
  const unitsPerMetre = options.unitsPerMetre ?? MM_PER_M
  const minSpaceAreaM2 = options.minSpaceAreaM2 ?? 1
  const hintByHandle = new Map((options.spaceHints ?? []).map((h) => [h.handle, h]))

  const insufficient: Array<{ handle: string; reason: string }> = []
  const unclassified: string[] = []
  const spaceCandidates: Array<{
    ent: SpatialRawEntity
    ring: Point2D[]
    role: 'space' | 'site'
    confidence: Confidence
    evidence: ClassificationEvidence[]
  }> = []
  const openingEntities: Array<{ ent: SpatialRawEntity; kind: 'door' | 'window' }> = []
  const furnitureEntities: Array<{ ent: SpatialRawEntity; evidence: ClassificationEvidence[] }> = []
  const wallSegments: Array<{ handle: string; a: Point2D; b: Point2D }> = []

  for (const ent of entities) {
    const ring = ringFromEntity(ent)
    const cls = classifyEntity(ent, ring)

    if (cls.role === 'wall') {
      const a = ent.geometry?.start
      const b = ent.geometry?.end
      if (a && b) wallSegments.push({ handle: ent.handle, a: [a.x, a.y], b: [b.x, b.y] })
      else if (ent.bounds)
        wallSegments.push({
          handle: ent.handle,
          a: [ent.bounds.min.x, ent.bounds.min.y],
          b: [ent.bounds.max.x, ent.bounds.max.y]
        })
      else insufficient.push({ handle: ent.handle, reason: 'wall entity carries no endpoints' })
      continue
    }

    if (cls.role === 'door' || cls.role === 'window') {
      openingEntities.push({ ent, kind: cls.role })
      continue
    }

    if (cls.role === 'furniture') {
      furnitureEntities.push({ ent, evidence: cls.evidence })
      continue
    }

    if (cls.role === 'space' || cls.role === 'site') {
      if (!ring) {
        insufficient.push({
          handle: ent.handle,
          reason:
            'closed boundary could not be read (no vertices on the wire) — not fabricating a rectangle'
        })
        continue
      }
      spaceCandidates.push({
        ent,
        ring,
        role: cls.role,
        confidence: cls.confidence,
        evidence: cls.evidence
      })
      continue
    }

    if (cls.role === 'annotation') continue
    unclassified.push(ent.handle)
  }

  const closedRings = spaceCandidates.filter((c) => c.role === 'space').map((c) => c.ring)
  // The building is the set of room rings, not one envelope. A convex hull of these vertices
  // swallows the notch of an L-shaped plan and would call a garden sitting in that notch indoor.
  const buildingRings = deriveBuildingRings(
    spaceCandidates
      .filter((c) => c.role === 'space')
      .map((c) => ({ ring: c.ring, layer: c.ent.layer }))
  )

  const spaces: Space[] = []
  const siteRings: Point2D[][] = []
  for (const cand of spaceCandidates) {
    const hint = hintByHandle.get(cand.ent.handle)
    if (cand.role === 'site') {
      siteRings.push(cand.ring)
      continue
    }
    const areaUnits = areaOf(cand.ring)
    const areaM2 = toM2(areaUnits, unitsPerMetre)
    if (areaM2 < minSpaceAreaM2) {
      // A too-small area under an assumed unit basis is not evidence of clutter: on an
      // inch-declared drawing every genuine room reads as clutter. Record why it was dropped
      // rather than losing it silently (Epic #413 SS11.2 honesty rule).
      unclassified.push(cand.ent.handle)
      if (!unitsDeclared) {
        insufficient.push({
          handle: cand.ent.handle,
          reason: `dropped as clutter only because the drawing unit was assumed (millimetres): measured ${areaM2} m². Declare unitsPerMetre if this drawing is not millimetres.`
        })
      }
      continue
    }
    const isHole = closedRings.some(
      (other) =>
        other !== cand.ring && ringInsidePolygon(cand.ring, other) && areaOf(other) > areaUnits
    )
    const nameHay = `${cand.ent.layer} ${cand.ent.geometry?.text ?? ''} ${Object.values(cand.ent.attributes ?? {}).join(' ')}`
    const typeResult = hint?.spaceType
      ? {
          spaceType: hint.spaceType,
          evidence: [{ source: 'user' as const, detail: 'user-declared space type' }]
        }
      : inferSpaceType(cand.ring, nameHay, buildingRings, isHole)
    const usageResult = hint?.usage
      ? {
          usage: hint.usage,
          evidence: [{ source: 'user' as const, detail: 'user-declared usage' }]
        }
      : inferUsage([
          cand.ent.layer,
          cand.ent.geometry?.text ?? '',
          ...Object.values(cand.ent.attributes ?? [])
        ])

    spaces.push({
      id: `sp_${cand.ent.handle}`,
      name: cand.ent.layer || undefined,
      usage: usageResult.usage,
      spaceType: typeResult.spaceType,
      boundary: cand.ring,
      holes: [],
      level: 0,
      areaM2,
      bbox: bboxOf(cand.ring) ?? undefined,
      adjacentSpaces: [],
      accessPoints: [],
      sourceHandles: [cand.ent.handle],
      confidence: cand.confidence,
      evidence: [...cand.evidence, ...typeResult.evidence, ...usageResult.evidence]
    })
  }

  // A ring contained in another ring is a hole of the outer space, not a separate floor plate.
  for (const inner of spaces) {
    for (const outer of spaces) {
      if (inner === outer) continue
      if (ringInsidePolygon(inner.boundary, outer.boundary)) {
        outer.holes.push(inner.boundary)
        outer.areaM2 = toM2(
          Math.max(0, areaOf(outer.boundary) - areaOf(inner.boundary)),
          unitsPerMetre
        )
      }
    }
  }

  const index = new SpatialIndex2D<Space>(2000)
  for (const sp of spaces) if (sp.bbox) index.insert(sp.id, sp.bbox, sp)
  const spacesById = new Map(spaces.map((sp) => [sp.id, sp]))

  // Openings: host wall by real distance to the wall segment; connected spaces by boundary
  // topology, not "the first two rooms whose vertices happen to be near". A window records the
  // wall it sits in but gets no hinge/sweep — it is not a leaf and not a way through.
  const openings: SpatialOpening[] = []
  for (const { ent, kind } of openingEntities) {
    const center: Point2D | null = ent.bounds
      ? [(ent.bounds.min.x + ent.bounds.max.x) / 2, (ent.bounds.min.y + ent.bounds.max.y) / 2]
      : ent.geometry?.position
        ? [ent.geometry.position.x, ent.geometry.position.y]
        : ent.geometry?.center
          ? [ent.geometry.center.x, ent.geometry.center.y]
          : null
    if (!center) {
      insufficient.push({
        handle: ent.handle,
        reason: 'opening carries no position — not defaulting to [0,0]'
      })
      continue
    }
    const width = ent.bounds
      ? Math.max(ent.bounds.max.x - ent.bounds.min.x, ent.bounds.max.y - ent.bounds.min.y)
      : ent.geometry?.radius
        ? ent.geometry.radius * 2
        : 0
    if (width <= 0) {
      insufficient.push({ handle: ent.handle, reason: 'opening width could not be measured' })
      continue
    }

    let hostWallHandle: string | null = null
    let hostDist = Infinity
    let hostA: Point2D | null = null
    let hostB: Point2D | null = null
    for (const w of wallSegments) {
      const d = distanceToRingBoundary(center, [w.a, w.b])
      if (d < hostDist) {
        hostDist = d
        hostWallHandle = w.handle
        hostA = w.a
        hostB = w.b
      }
    }
    const wallTolerance = Math.max(width * 0.6, 300)
    if (hostWallHandle === null || hostDist > wallTolerance) hostWallHandle = null

    const nearby = index.query({
      minX: center[0] - width,
      minY: center[1] - width,
      maxX: center[0] + width,
      maxY: center[1] + width
    })
    const connectsSpaces = nearby
      .map((sp) => ({ sp, d: distanceToRingBoundary(center, sp.boundary) }))
      .filter((t) => t.d <= wallTolerance)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map((t) => t.sp.id)

    // Hinge and leaf direction, in order of trust. A door block whose insertion point is NOT the
    // centre of its own bounds was inserted at its base point — for door blocks that base point is
    // the hinge, and `rotation` is the leaf's direction at rest. When the insertion sits at the
    // bounds centre the block carries no hinge information at all, so the only remaining source is
    // the nearer end of the host wall: a guess, recorded as such, and it lowers confidence, because
    // a confidently-wrong hinge clears furniture that the leaf would actually hit.
    let hinge: Point2D | undefined
    let leafAngleDeg: number | undefined
    let hingeSource: 'attribute' | 'block-insertion' | 'wall-endpoint' | 'unknown' = 'unknown'
    const meta = openingMetadata(ent)
    const insertion = ent.geometry?.position
    const offsetFromCentre =
      insertion && ent.bounds
        ? Math.hypot(
            insertion.x - (ent.bounds.min.x + ent.bounds.max.x) / 2,
            insertion.y - (ent.bounds.min.y + ent.bounds.max.y) / 2
          )
        : Infinity
    if (kind === 'door' && insertion && offsetFromCentre > width * 0.15) {
      hinge = [insertion.x, insertion.y]
      leafAngleDeg = ent.geometry?.rotation ?? 0
      hingeSource = 'block-insertion'
    } else if (kind === 'door' && meta.hinge) {
      hinge = meta.hinge
      leafAngleDeg = hostA && hostB ? angleOf(hostA, hostB) : (ent.geometry?.rotation ?? 0)
      hingeSource = 'attribute'
    } else if (kind === 'door' && hostA && hostB) {
      hinge = nearestEndpoint(center, hostA, hostB)
      leafAngleDeg = angleOf(hostA, hostB)
      hingeSource = 'wall-endpoint'
    }

    // Which side the leaf swings. Only explicit metadata says; guessing it from "the side with more
    // floor" invents a fact the drawing does not carry.
    const swingDirection: 'inward' | 'outward' | 'unknown' = meta.swing ?? 'unknown'

    // The sweep must land on the side a space actually occupies. Sweeping an arbitrary fixed 90°
    // can point the arc into a wall and clear furniture the leaf would hit, so the sign is chosen
    // by which candidate arc reaches a connected space; a tie keeps the wall-side default.
    const sweptArea = hinge
      ? doorSweepPolygon(
          hinge,
          width,
          leafAngleDeg ?? 0,
          sweepSignFor(hinge, leafAngleDeg ?? 0, connectsSpaces, spacesById) * 90
        )
      : undefined

    openings.push({
      handle: ent.handle,
      kind,
      hostWallHandle,
      openingCenter: center,
      width,
      hinge,
      leafAngleDeg,
      swingDirection,
      swingAngleDeg: 90,
      sweptArea,
      hingeSource,
      cutsWall: wallGapAt(wallSegments, hostA, hostB, center, width),
      connectionType: classifyConnection(connectsSpaces, spacesById),
      connectsSpaces,
      confidence: hostWallHandle ? (hingeSource === 'wall-endpoint' ? 'medium' : 'high') : 'low',
      evidence: [
        { source: 'geometry', detail: `opening measured width ${Math.round(width)} units` },
        hostWallHandle
          ? {
              source: 'geometry',
              detail: `host wall ${hostWallHandle} at ${Math.round(hostDist)} units`
            }
          : {
              source: 'geometry',
              detail: `no wall within ${Math.round(wallTolerance)} units — opening may not cut a wall`
            },
        ...(kind === 'door'
          ? [
              {
                source:
                  hingeSource === 'wall-endpoint'
                    ? ('geometry' as const)
                    : hingeSource === 'attribute'
                      ? ('attribute' as const)
                      : ('blockName' as const),
                detail:
                  hingeSource === 'block-insertion'
                    ? `hinge from block insertion+rotation at (${Math.round(hinge![0])}, ${Math.round(hinge![1])})`
                    : hingeSource === 'attribute'
                      ? 'hinge from explicit block attribute'
                      : hingeSource === 'wall-endpoint'
                        ? 'hinge guessed from the nearer wall end — no block base point or attribute'
                        : 'no hinge source available'
              }
            ]
          : [])
      ]
    })
  }

  // Furniture: real rotated footprint, never a dimensionless point and never the world AABB.
  const furniture: Furniture[] = []
  for (const { ent, evidence } of furnitureEntities) {
    const insertion: Point2D | null = ent.geometry?.position
      ? [ent.geometry.position.x, ent.geometry.position.y]
      : ent.bounds
        ? [(ent.bounds.min.x + ent.bounds.max.x) / 2, (ent.bounds.min.y + ent.bounds.max.y) / 2]
        : null
    if (!insertion) {
      insufficient.push({ handle: ent.handle, reason: 'furniture block has no insertion point' })
      continue
    }
    const aabbW = ent.bounds ? ent.bounds.max.x - ent.bounds.min.x : 0
    const aabbH = ent.bounds ? ent.bounds.max.y - ent.bounds.min.y : 0
    if (aabbW <= 0 || aabbH <= 0) {
      insufficient.push({
        handle: ent.handle,
        reason: 'furniture block carries no measurable size'
      })
      continue
    }
    const rotationDeg = ent.geometry?.rotation ?? 0
    const [localW, localD] = extentsFromAabb(aabbW, aabbH, rotationDeg)
    const footprint = rotatedRect(insertion, localW, localD, rotationDeg)
    const assigned = spaces.find((sp) => pointInPolygon(insertion, sp.boundary, sp.holes))
    furniture.push({
      handle: ent.handle,
      kind: furnitureKindOf(ent.geometry?.name ?? ent.geometry?.blockName ?? '', ent.layer),
      assignedSpaceId: assigned?.id ?? null,
      insertion,
      width: localW,
      depth: localD,
      rotationDeg,
      footprint,
      blockName: ent.geometry?.name ?? ent.geometry?.blockName,
      confidence: ent.geometry?.name ? 'high' : 'medium',
      evidence
    })
  }

  // Relationships from real geometry.
  const relationships: SpatialRelation[] = []
  for (let i = 0; i < spaces.length; i++) {
    for (let j = i + 1; j < spaces.length; j++) {
      const a = spaces[i]!
      const b = spaces[j]!
      if (!a.bbox || !b.bbox) continue
      if (ringsBoundaryIntersect(a.boundary, b.boundary)) {
        relationships.push({
          sourceId: a.id,
          targetId: b.id,
          kind: 'touches',
          evidence: { detail: 'boundaries share an edge' }
        })
        a.adjacentSpaces.push(b.id)
        b.adjacentSpaces.push(a.id)
      } else if (ringsOverlap(a.boundary, b.boundary)) {
        relationships.push({
          sourceId: a.id,
          targetId: b.id,
          kind: 'intersects',
          evidence: { detail: 'interiors overlap' }
        })
      } else {
        const d = Math.min(
          distanceToRingBoundary(a.boundary[0]!, b.boundary),
          distanceToRingBoundary(b.boundary[0]!, a.boundary)
        )
        if (d <= 500) {
          relationships.push({
            sourceId: a.id,
            targetId: b.id,
            kind: 'adjacent_to',
            evidence: { boundaryDistance: Math.round(d) }
          })
          a.adjacentSpaces.push(b.id)
          b.adjacentSpaces.push(a.id)
        }
      }
    }
  }
  // Only doors carry people between spaces; a window joins the wall, not the circulation graph.
  for (const o of openings) {
    if (o.kind !== 'door') continue
    for (const spId of o.connectsSpaces) {
      relationships.push({ sourceId: o.handle, targetId: spId, kind: 'connects_to' })
      const sp = spaces.find((s) => s.id === spId)
      if (sp) sp.accessPoints.push(o.handle)
    }
  }
  for (const f of furniture) {
    if (f.assignedSpaceId) {
      relationships.push({
        sourceId: f.handle,
        targetId: f.assignedSpaceId,
        kind: 'belongs_to_space'
      })
    }
  }

  return SpatialModelSchema.parse({
    documentName: options.documentName,
    site: siteRings.length
      ? {
          boundary: siteRings[0],
          buildingRings,
          outdoorRegions: spaces.filter((s) => s.spaceType === 'outdoor'),
          noPlacementRegions: [],
          sourceHandles: spaceCandidates.filter((c) => c.role === 'site').map((c) => c.ent.handle),
          confidence: 'medium'
        }
      : undefined,
    spaces,
    openings,
    furniture,
    relationships,
    unclassifiedHandles: unclassified,
    insufficientData: insufficient,
    units: { perMetre: unitsPerMetre, declared: unitsDeclared },
    analyzedAt: Date.now()
  })
}
