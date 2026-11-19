import type { Point2D } from '../schemas/semantic-model'
import type { SpatialModel, Space, Furniture, SpatialOpening } from './spatial-schema'
import {
  areaOf,
  bboxOf,
  bboxOverlap,
  clearWidthThrough,
  distanceToRingBoundary,
  doorSweepPolygon,
  minClearWidth,
  pointInPolygon,
  ringInsidePolygon,
  ringsOverlap,
  rotatedRect
} from './geometry'

/**
 * Deterministic architectural constraint engine.
 *
 * Every finding is measured from real geometry — never copied from a generator's `valid` flag, and
 * never reported PASS when the geometry needed to evaluate it is missing. `INSUFFICIENT_DATA` is
 * the honest answer whenever a required input is absent; claiming compliance without evidence is
 * exactly the failure mode this module exists to prevent.
 *
 * This is geometric/architectural QA. It is NOT building-code compliance: no minimum dimension or
 * clearance is asserted here unless it was supplied by a Design Basis, a library, or an explicit
 * caller-provided value.
 */

export type FindingSeverity = 'error' | 'warning' | 'info'
export type FindingStatus = 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA' | 'NOT_APPLICABLE'

export interface SpatialFinding {
  code: string
  severity: FindingSeverity
  status: FindingStatus
  /** CAD handles or model ids the finding involves, so the caller can map back to entities. */
  entityIds: string[]
  constraintId?: string
  /** Measured evidence: numbers, not adjectives. */
  measurements?: Record<string, number>
  involvedGeometry?: Record<string, Point2D[]>
  message: string
  /** A deterministic correction when one is computable; otherwise absent. */
  suggestedCorrection?: string
}

/** A placement the caller wants checked before anything is drawn. */
export interface ProposedPlacement {
  id: string
  kind: Furniture['kind'] | 'door' | 'garden' | 'generic'
  /** Target space. Omit to let the engine infer it from geometry (and report if it lands nowhere). */
  spaceId?: string
  center: Point2D
  width: number
  depth: number
  rotationDeg?: number
  /** Explicit footprint override for non-rectangular items. */
  footprint?: Point2D[]
  /** Authorized exceptions, e.g. a door leaf legitimately inside its own wall opening. */
  exemptions?: string[]
  /**
   * What a green placement IS. `outdoor-landscape` (a garden, a lawn) needs open air;
   * `indoor-planting` (a planting bed, a green wall, an atrium planter) belongs inside a room.
   * Inferred from `kind` when omitted — garden → outdoor, plant → indoor — but the agent can state
   * it directly, which is what lets "vườn trong nhà / cây xanh nội thất" be validated on its own
   * terms instead of being forced through a fake courtyard reclassification.
   */
  intent?: 'outdoor-landscape' | 'indoor-planting'
}

export interface ValidateOptions {
  /** Furniture may sit this far outside its space (flush against a wall line) without failing. */
  containmentTolerance?: number
  /** Minimum free walking width a circulation route must keep, in drawing units. Only applied
   * when supplied — an invented number would be a fake regulation. */
  requiredCirculationWidth?: number
  /** Treat low-confidence spaces as usable evidence. Default false: weak geometry → INSUFFICIENT_DATA. */
  acceptLowConfidence?: boolean
  /** Existing drawing items this batch is deliberately replacing, so they are not obstacles to
   * themselves. Only handles the caller names — never inferred. */
  excludeObstacleHandles?: string[]
}

const DEFAULT_TOLERANCE = 1

// --- helpers ------------------------------------------------------------------------------------

function footprintOf(p: ProposedPlacement): Point2D[] {
  if (p.footprint?.length) return p.footprint
  return rotatedRect(p.center, p.width, p.depth, p.rotationDeg ?? 0)
}

function usablePolygon(space: Space): { outer: Point2D[]; holes: Point2D[][] } {
  return { outer: space.boundary, holes: space.holes }
}

/** Spaces whose geometry is trustworthy enough to validate against. */
function evaluableSpaces(model: SpatialModel, opts: ValidateOptions): Space[] {
  return model.spaces.filter((s) => {
    if (s.boundary.length < 3) return false
    if (!opts.acceptLowConfidence && s.confidence === 'low') return false
    return true
  })
}

/**
 * How far an opening's centre may sit from a space's boundary ring and still be *in that space's
 * wall*: the caller's containment tolerance plus half the leaf's own thickness. A door is not a
 * piece of furniture standing clear of the structure — it is set into the wall, so its rectangle
 * straddles the boundary by construction. Deriving the reach from the measured leaf depth (never
 * from the caller's word) keeps it honest: an opening 3 m away from every ring is still outside.
 */
function openingReach(opening: ProposedPlacement, opts: ValidateOptions): number {
  return (
    (opts.containmentTolerance ?? DEFAULT_TOLERANCE) +
    Math.min(Math.abs(opening.width), Math.abs(opening.depth)) / 2
  )
}

/**
 * The spaces whose boundary ring a proposed opening actually sits in — measured, never taken from
 * the caller's `spaceId`. An opening onto exactly one ring is an exterior door (the other side is
 * the unmodelled outside); one onto two rings joins them; one onto no ring is a swing symbol
 * dropped in the middle of a room, which opens nothing and is credited with nothing.
 */
function spacesOpeningOnto(
  spaces: readonly Space[],
  opening: ProposedPlacement,
  opts: ValidateOptions
): string[] {
  const reach = openingReach(opening, opts)
  return spaces
    .filter((s) => distanceToRingBoundary(opening.center, s.boundary) <= reach)
    .map((s) => s.id)
}

/**
 * Openings this batch intends to draw IN `space`. Preflight judges the drawing as it will be once
 * the batch commits, so a planned opening supplies the door geometry the model does not carry yet:
 * the batch that cuts the door is the fix for a doorless space, not evidence against it. Only
 * openings sitting on THIS space's ring are credited — a decorative door in another room cannot
 * silence the finding — and a credited opening is still validated as a placement in its own right,
 * so a leaf that collides, pinches circulation or sits outside the space still fails the batch.
 */
function plannedOpeningsIn(
  space: Space,
  placements: readonly ProposedPlacement[],
  opts: ValidateOptions
): ProposedPlacement[] {
  return placements.filter(
    (p) => p.kind === 'door' && spacesOpeningOnto([space], p, opts).length > 0
  )
}

// --- hard constraints ---------------------------------------------------------------------------

/**
 * Furniture footprint must lie inside its assigned space's usable polygon (boundary minus holes).
 * Concave and L-shaped rooms are handled by the real ring, so a sofa in the notch of an L-room
 * fails even though it sits inside the room's bounding box.
 */
export function checkContainment(
  placement: ProposedPlacement,
  space: Space,
  opts: ValidateOptions = {}
): SpatialFinding {
  const fp = footprintOf(placement)
  const tol = opts.containmentTolerance ?? DEFAULT_TOLERANCE
  const { outer, holes } = usablePolygon(space)
  if (outer.length < 3) {
    return {
      code: 'CONTAINMENT_INSUFFICIENT_DATA',
      severity: 'warning',
      status: 'INSUFFICIENT_DATA',
      entityIds: [placement.id, space.id],
      constraintId: 'containment',
      message: `space ${space.id} has no usable boundary to validate containment against`
    }
  }
  // An opening is allowed to straddle the ring by its own half-thickness (it sits in the wall); a
  // piece of furniture is not. `ringInsidePolygon`'s tolerance is a boundary allowance, so widening
  // it for an opening is exactly the wall band, nothing more.
  const inside = ringInsidePolygon(
    fp,
    outer,
    holes,
    placement.kind === 'door' ? Math.max(tol, openingReach(placement, opts)) : tol
  )
  if (inside) {
    return {
      code: 'CONTAINMENT_OK',
      severity: 'info',
      status: 'PASS',
      entityIds: [placement.id, space.id],
      constraintId: 'containment',
      message: `${placement.id} lies within the usable area of ${space.id}`
    }
  }
  const fpBox = bboxOf(fp)
  const spBox = bboxOf(outer)
  return {
    code: 'FURNITURE_OUTSIDE_SPACE',
    severity: 'error',
    status: 'FAIL',
    entityIds: [placement.id, space.id],
    constraintId: 'containment',
    measurements:
      fpBox && spBox
        ? {
            footprintMinX: fpBox.minX,
            footprintMaxX: fpBox.maxX,
            spaceMinX: spBox.minX,
            spaceMaxX: spBox.maxX
          }
        : undefined,
    involvedGeometry: { footprint: fp, spaceBoundary: outer },
    message: `${placement.id} does not fit inside the usable area of ${space.id} (real polygon, not its bounding box)`,
    suggestedCorrection: `move ${placement.id} inside ${space.id}'s boundary, or reduce its footprint`
  }
}

/**
 * Furniture must not sit in a door's swept area. The sweep is the real quarter-disc polygon, so a
 * sofa that clips only the arc's edge is caught while a sofa along the wall beside the door is not.
 */
export function checkDoorSwing(placement: ProposedPlacement, door: SpatialOpening): SpatialFinding {
  if (!door.sweptArea || door.sweptArea.length < 3) {
    return {
      code: 'DOOR_SWING_INSUFFICIENT_DATA',
      severity: 'warning',
      status: 'INSUFFICIENT_DATA',
      entityIds: [placement.id, door.handle],
      constraintId: 'door-swing-clear',
      measurements: { width: door.width },
      message: `door ${door.handle} has no hinge/swing geometry, so its swept area cannot be evaluated`,
      suggestedCorrection: `supply hinge + swing direction for ${door.handle} before placing furniture in that room`
    }
  }
  const fp = footprintOf(placement)
  if (placement.exemptions?.includes('door-swing')) {
    return {
      code: 'DOOR_SWING_EXEMPT',
      severity: 'info',
      status: 'NOT_APPLICABLE',
      entityIds: [placement.id, door.handle],
      constraintId: 'door-swing-clear',
      message: `${placement.id} is exempted from door-swing clearance by explicit authorization`
    }
  }
  if (ringsOverlap(fp, door.sweptArea)) {
    return {
      code: 'DOOR_SWING_COLLISION',
      severity: 'error',
      status: 'FAIL',
      entityIds: [placement.id, door.handle],
      constraintId: 'door-swing-clear',
      measurements: { doorWidth: door.width, swingAngleDeg: door.swingAngleDeg },
      involvedGeometry: { footprint: fp, sweptArea: door.sweptArea },
      message: `${placement.id} obstructs the swing of door ${door.handle}`,
      suggestedCorrection: `move ${placement.id} clear of door ${door.handle}'s swept arc, or reverse the door's swing direction`
    }
  }
  return {
    code: 'DOOR_SWING_CLEAR',
    severity: 'info',
    status: 'PASS',
    entityIds: [placement.id, door.handle],
    constraintId: 'door-swing-clear',
    message: `${placement.id} does not obstruct door ${door.handle}`
  }
}

/** Two placements must not overlap each other — the batch case where each is valid alone. */
export function checkPairwiseCollision(
  a: ProposedPlacement,
  b: ProposedPlacement
): SpatialFinding | null {
  const fa = footprintOf(a)
  const fb = footprintOf(b)
  const ba = bboxOf(fa)
  const bb = bboxOf(fb)
  if (!ba || !bb || !bboxOverlap(ba, bb)) return null // broad-phase rejection only
  if (!ringsOverlap(fa, fb)) return null
  return {
    code: 'PLACEMENT_COLLISION',
    severity: 'error',
    status: 'FAIL',
    entityIds: [a.id, b.id],
    constraintId: 'no-overlap',
    involvedGeometry: { footprintA: fa, footprintB: fb },
    message: `${a.id} and ${b.id} overlap each other`,
    suggestedCorrection: `separate ${a.id} and ${b.id}, or re-rank candidate positions`
  }
}

/**
 * The fixed obstacles already present in the drawing. A DWG being furnished already contains
 * columns, equipment and the furniture someone else placed; a new item must not be drawn inside
 * any of it. Deriving this from the model is the point — requiring the caller to enumerate the
 * obstacles it is standing in the middle of is how a plan "passes" validation and then lands a
 * wardrobe through a structural pier.
 *
 * `excludeHandles` lets a caller name items it is deliberately replacing, so re-placing a sofa
 * does not collide with the old copy of itself.
 */
export function deriveObstacles(
  model: SpatialModel,
  excludeHandles: readonly string[] = []
): Array<{ id: string; footprint: Point2D[] }> {
  const skip = new Set(excludeHandles)
  return model.furniture
    .filter((f) => !skip.has(f.handle) && f.footprint.length >= 3)
    .map((f) => ({ id: f.handle, footprint: f.footprint }))
}

/** Furniture must not collide with fixed obstacles already in the space (columns, equipment). */
export function checkObstacleCollision(
  placement: ProposedPlacement,
  obstacles: Array<{ id: string; footprint: Point2D[] }>
): SpatialFinding[] {
  const fp = footprintOf(placement)
  const out: SpatialFinding[] = []
  for (const ob of obstacles) {
    if (ob.footprint.length < 3) continue
    if (ringsOverlap(fp, ob.footprint)) {
      out.push({
        code: 'OBSTACLE_COLLISION',
        severity: 'error',
        status: 'FAIL',
        entityIds: [placement.id, ob.id],
        constraintId: 'no-obstacle-overlap',
        involvedGeometry: { footprint: fp, obstacle: ob.footprint },
        message: `${placement.id} collides with fixed object ${ob.id}`
      })
    }
  }
  return out
}

/**
 * A door must actually cut a wall and must join two distinct spaces. A door drawn over an intact
 * wall, or one that touches only one room, is a finding — this is what stops a decorative swing
 * symbol being reported as a working opening. Windows are excluded: they join a wall but are not a
 * way through, so the two-space rule does not apply to them.
 */
export function checkDoorValidity(
  door: SpatialOpening,
  model: SpatialModel,
  opts: ValidateOptions = {}
): SpatialFinding[] {
  const out: SpatialFinding[] = []
  if (!door.hostWallHandle) {
    out.push({
      code: 'DOOR_WITHOUT_HOST_WALL',
      severity: 'error',
      status: 'FAIL',
      constraintId: 'door-host-wall',
      entityIds: [door.handle],
      measurements: { width: door.width },
      message: `door ${door.handle} does not sit on any wall — it is a symbol over open space, not an opening`,
      suggestedCorrection: `attach ${door.handle} to a wall segment, or remove it`
    })
  } else if (door.cutsWall === false) {
    // The wall line runs intact through the opening, so the leaf has no gap to stand in. Drawings
    // very often carry a wall as one continuous centreline with the door symbol dropped on top, so
    // this is a correction to make, not a reason to refuse the batch.
    out.push({
      code: 'DOOR_ON_UNCUT_WALL',
      severity: 'warning',
      status: 'PASS',
      constraintId: 'door-host-wall',
      entityIds: [door.handle, door.hostWallHandle],
      measurements: { width: door.width },
      message: `wall ${door.hostWallHandle} runs intact through door ${door.handle} — the opening was never cut in the wall geometry`,
      suggestedCorrection: `break wall ${door.hostWallHandle} at ${door.handle} with a ${Math.round(door.width)}-unit gap so the drawing reflects the built opening`
    })
  }
  const spaces = evaluableSpaces(model, opts)
  const connected = door.connectsSpaces.filter((id) => spaces.some((s) => s.id === id))
  // An exterior door legitimately joins exactly one modelled space — the other side is the
  // unmodelled outside, which is how `extract` classifies it (`connectionType: "exterior"` when it
  // touches one space). Demanding two spaces from it is a false FAIL: a single bedroom with a front
  // door is a valid drawing, and read-back verification would otherwise call a faithful drawing
  // unfaithful. Only a door that is NOT exterior must join two spaces; zero connected spaces is
  // always wrong, exterior included — that is a symbol floating over open ground.
  if (connected.length === 0) {
    out.push({
      code: 'DOOR_CONNECTS_NOTHING',
      severity: 'error',
      status: 'FAIL',
      entityIds: [door.handle],
      constraintId: 'door-connects-two-spaces',
      measurements: { connectedSpaces: 0 },
      message: `door ${door.handle} connects no space — it is a symbol over open ground, not an opening`,
      suggestedCorrection: `reposition ${door.handle} on the boundary of a space`
    })
  } else if (connected.length === 1 && door.connectionType !== 'exterior') {
    out.push({
      code: 'DOOR_CONNECTS_ONE_SPACE',
      severity: 'error',
      status: 'FAIL',
      entityIds: [door.handle, ...connected],
      constraintId: 'door-connects-two-spaces',
      measurements: { connectedSpaces: connected.length },
      message: `door ${door.handle} connects 1 space(s); an interior opening must join exactly two`,
      suggestedCorrection: `reposition ${door.handle} on the shared boundary of two spaces, or mark it exterior if it opens to the outside`
    })
  }
  // The interior/exterior label and the typing of the spaces it joins come from the same geometry,
  // so a contradiction between them means one of them is wrong — and the accessibility roots read
  // that typing, so an unnoticed contradiction silently seals or opens a whole floor.
  if (door.connectionType !== 'unknown' && connected.length) {
    const types = connected
      .map((id) => spaces.find((s) => s.id === id)?.spaceType)
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
    const touchesOutside = types.some(
      (t) => t === 'outdoor' || t === 'courtyard' || t === 'semi_outdoor'
    )
    if (door.connectionType === 'interior' && touchesOutside) {
      out.push({
        code: 'DOOR_CONNECTION_CONTRADICTION',
        severity: 'warning',
        status: 'INSUFFICIENT_DATA',
        entityIds: [door.handle, ...connected],
        constraintId: 'door-connection-type',
        message: `door ${door.handle} is classified interior but a space it joins is typed outdoor — the space typing is inconsistent`,
        suggestedCorrection: `confirm the space type on each side of ${door.handle} (spaceHints overrides layer guessing)`
      })
    } else if (door.connectionType === 'exterior' && !touchesOutside && connected.length >= 2) {
      out.push({
        code: 'DOOR_CONNECTION_CONTRADICTION',
        severity: 'warning',
        status: 'INSUFFICIENT_DATA',
        entityIds: [door.handle, ...connected],
        constraintId: 'door-connection-type',
        message: `door ${door.handle} is classified exterior but joins two enclosed spaces — it is an interior link`,
        suggestedCorrection: `confirm the space type on each side of ${door.handle}`
      })
    }
  }
  return out
}

/**
 * Every occupied space must be reachable from an entrance through doors. Reachability is computed
 * on the door graph, so a bedroom sealed off by furniture-free-but-doorless walls is caught even
 * when each individual door passes its own check.
 *
 * `plannedPlacements` is what the batch is about to draw. Preflight judges the drawing as it will be
 * once the batch commits, so an opening supplied by the batch is a real link: the batch that cuts the
 * door IS the fix for a sealed room. This does not soften the check — a plan with no opening for a
 * room still FAILs, and every credited door is validated as a placement in its own right (a leaf that
 * floats in no space, collides or pinches circulation fails the batch on its own terms).
 */
export function checkAccessibility(
  model: SpatialModel,
  opts: ValidateOptions = {},
  plannedPlacements: readonly ProposedPlacement[] = []
): { findings: SpatialFinding[]; reachable: Set<string> } {
  const spaces = evaluableSpaces(model, opts)
  const findings: SpatialFinding[] = []
  if (spaces.length === 0) {
    return {
      findings: [
        {
          code: 'ACCESSIBILITY_INSUFFICIENT_DATA',
          severity: 'warning',
          status: 'INSUFFICIENT_DATA',
          entityIds: [],
          constraintId: 'accessibility',
          message: 'no evaluable spaces in the model — accessibility cannot be determined',
          // A non-PASS verdict has to name the ONE call that changes the outcome, or the caller's
          // only remaining move is to re-send the payload that just failed — which is how a run
          // deadlocks on a drawing it cannot read.
          suggestedCorrection:
            'spatial_analyze to see which rings the extractor recovered and why they were rejected; then ' +
            'read the missing boundary with entity.list (detail:"full", layer/window scoped) or declare it ' +
            'via spaceHints, and re-run spatial_validate_layout'
        }
      ],
      reachable: new Set()
    }
  }
  // Adjacency through doors only — a window is not a way through.
  const graph = new Map<string, string[]>()
  for (const s of spaces) graph.set(s.id, [])
  // Openings this batch will draw, resolved to the rings they actually sit on (measured, not the
  // caller's `spaceId`): one ring = a way in from outside, two = a link between them, none = a swing
  // symbol that opens nothing and is credited with nothing.
  const plannedDoors = plannedPlacements
    .filter((p) => p.kind === 'door')
    .map((p) => ({ id: p.id, spaceIds: spacesOpeningOnto(spaces, p, opts) }))
  for (const d of model.openings) {
    if (d.kind !== 'door') continue
    const [a, b] = d.connectsSpaces
    if (a && b && graph.has(a) && graph.has(b)) {
      graph.get(a)!.push(b)
      graph.get(b)!.push(a)
    }
  }
  for (const d of plannedDoors) {
    const [a, b] = d.spaceIds
    if (a && b) {
      graph.get(a)!.push(b)
      graph.get(b)!.push(a)
    }
  }
  // Roots: spaces that are themselves entrances (outdoor, circulation, garage) or that have a door
  // with only one connected space (an exterior door).
  const roots = spaces
    .filter(
      (s) =>
        s.spaceType === 'outdoor' ||
        s.spaceType === 'circulation' ||
        s.usage === 'garage' ||
        s.usage === 'hallway' ||
        s.usage === 'staircase'
    )
    .map((s) => s.id)
  for (const d of model.openings) {
    if (d.kind !== 'door') continue
    // An exterior door is a way in from outside. When the outside is not itself a modelled space
    // the door joins only one, which is the same signal the classifier uses; `connectionType`
    // carries it explicitly when the outside IS modelled (a courtyard, a garden).
    const candidates =
      d.connectionType === 'exterior'
        ? d.connectsSpaces
        : d.connectsSpaces.length === 1
          ? d.connectsSpaces
          : []
    for (const id of candidates) if (graph.has(id)) roots.push(id)
  }
  for (const d of plannedDoors) {
    if (d.spaceIds.length === 1) roots.push(d.spaceIds[0]!)
  }
  const reachable = new Set<string>()
  const queue = [...roots]
  while (queue.length) {
    const cur = queue.shift()!
    if (reachable.has(cur)) continue
    reachable.add(cur)
    for (const next of graph.get(cur) ?? []) if (!reachable.has(next)) queue.push(next)
  }
  for (const s of spaces) {
    if (s.spaceType === 'outdoor') continue // an open garden needs no door
    if (s.usage === 'storage' || s.usage === 'utility') continue // non-occupied service space
    if (!reachable.has(s.id)) {
      findings.push({
        code: 'ROOM_INACCESSIBLE',
        severity: 'error',
        status: 'FAIL',
        entityIds: [s.id],
        constraintId: 'accessibility',
        measurements: { areaM2: s.areaM2, plannedOpenings: plannedDoors.length },
        message: `${s.id} (${s.usage}) has no door path from any entrance`,
        // One call must unlock this, or a doorless drawing loops on the same refusal forever.
        suggestedCorrection:
          `add a door between ${s.id} and an adjacent reachable space — re-run spatial_validate_layout ` +
          `with that opening in the SAME batch: a placement {id, kind:"door", center:[x,y], width, depth} ` +
          `on the shared wall of ${s.id} (plus the matching construct -> walls openings:[{along, width}] ` +
          `step in plannedOperation), then draw that batch`
      })
    }
  }
  if (findings.length === 0) {
    findings.push({
      code: 'ACCESSIBILITY_OK',
      severity: 'info',
      status: 'PASS',
      entityIds: spaces.map((s) => s.id),
      constraintId: 'accessibility',
      message: `all ${reachable.size} occupied space(s) are reachable through the door graph${
        plannedDoors.length
          ? ` (including ${plannedDoors.length} opening(s) this batch will draw)`
          : ''
      }`
    })
  }
  return { findings, reachable }
}

/**
 * Green placements are validated by what they ARE, not by which layer they landed on. An outdoor
 * landscape (garden, lawn) inside an indoor room is an architectural error; an indoor planting
 * (planting bed, green wall, atrium planter) inside a room is legitimate and must not be forced
 * through a fake courtyard reclassification. The intent is stated explicitly when the caller knows
 * it, and inferred from `kind` otherwise — garden → outdoor, plant → indoor.
 */
export function checkSpaceAssignment(
  placement: ProposedPlacement,
  model: SpatialModel,
  opts: ValidateOptions = {}
): SpatialFinding {
  const spaces = evaluableSpaces(model, opts)
  const fp = footprintOf(placement)
  const containing = spaces.filter((s) => pointInPolygon(placement.center, s.boundary, s.holes))
  const target = placement.spaceId ? spaces.find((s) => s.id === placement.spaceId) : containing[0]
  if (!target) {
    return {
      code: 'PLACEMENT_IN_NO_SPACE',
      severity: 'error',
      status: 'FAIL',
      entityIds: [placement.id],
      constraintId: 'space-assignment',
      message: `${placement.id} lands in no modelled space — it is floating in unallocated area`,
      suggestedCorrection: `assign ${placement.id} to a specific space, or model that space first`
    }
  }
  const intent =
    placement.intent ??
    (placement.kind === 'garden'
      ? 'outdoor-landscape'
      : placement.kind === 'plant'
        ? 'indoor-planting'
        : undefined)

  if (intent === 'outdoor-landscape') {
    if (
      target.spaceType === 'outdoor' ||
      target.spaceType === 'courtyard' ||
      target.spaceType === 'semi_outdoor'
    ) {
      return {
        code: 'GARDEN_ASSIGNED_OK',
        severity: 'info',
        status: 'PASS',
        entityIds: [placement.id, target.id],
        constraintId: 'space-assignment',
        message: `${placement.id} sits in ${target.id} (${target.spaceType}) — a valid outdoor/courtyard location`
      }
    }
    if (target.spaceType === 'indoor') {
      return {
        code: 'GARDEN_IN_INDOOR_ROOM',
        severity: 'error',
        status: 'FAIL',
        entityIds: [placement.id, target.id],
        constraintId: 'space-assignment',
        involvedGeometry: { footprint: fp, spaceBoundary: target.boundary },
        message: `${placement.id} is an outdoor landscape placed inside indoor space ${target.id} (${target.usage})`,
        suggestedCorrection: `move ${placement.id} to an outdoor/courtyard region, or declare it intent:"indoor-planting" if indoor landscaping was intended`
      }
    }
    return {
      code: 'GARDEN_SPACE_TYPE_UNKNOWN',
      severity: 'warning',
      status: 'INSUFFICIENT_DATA',
      entityIds: [placement.id, target.id],
      constraintId: 'space-assignment',
      message: `${target.id} has no determined space type, so an outdoor placement cannot be validated`
    }
  }

  if (intent === 'indoor-planting') {
    // A planting bed belongs inside the envelope. Outdoors is not an error — a planter on a terrace
    // is fine — but it is worth naming, because the caller asked for indoor.
    if (target.spaceType === 'outdoor') {
      return {
        code: 'PLANTING_OUTDOORS',
        severity: 'info',
        status: 'PASS',
        entityIds: [placement.id, target.id],
        constraintId: 'space-assignment',
        message: `${placement.id} is an indoor planting placed in outdoor space ${target.id} — allowed, but not indoors`
      }
    }
    if (target.spaceType === 'unknown') {
      return {
        code: 'PLANTING_SPACE_TYPE_UNKNOWN',
        severity: 'warning',
        status: 'INSUFFICIENT_DATA',
        entityIds: [placement.id, target.id],
        constraintId: 'space-assignment',
        message: `${target.id} has no determined space type, so an indoor planting cannot be placed with confidence`
      }
    }
    return {
      code: 'PLANTING_ASSIGNED_OK',
      severity: 'info',
      status: 'PASS',
      entityIds: [placement.id, target.id],
      constraintId: 'space-assignment',
      message: `${placement.id} is an indoor planting in ${target.id} (${target.spaceType}/${target.usage})`
    }
  }

  return {
    code: 'SPACE_ASSIGNMENT_OK',
    severity: 'info',
    status: 'PASS',
    entityIds: [placement.id, target.id],
    constraintId: 'space-assignment',
    message: `${placement.id} is assigned to ${target.id}`
  }
}

/**
 * Furniture must not pinch a circulation route below a caller-supplied free width. The route's own
 * width is the narrowest perpendicular chord along it (`minClearWidth`), not the bounding-box short
 * side: an L-corridor or a corridor already pinched by a column reports its real bottleneck, where a
 * bbox would read the wide leg and pass a route nobody can walk.
 */
export function checkCirculation(
  placements: ProposedPlacement[],
  model: SpatialModel,
  requiredWidth: number | undefined,
  opts: ValidateOptions = {}
): SpatialFinding[] {
  if (!requiredWidth || requiredWidth <= 0) {
    return [
      {
        code: 'CIRCULATION_NOT_CONFIGURED',
        severity: 'info',
        status: 'NOT_APPLICABLE',
        entityIds: [],
        constraintId: 'circulation-width',
        message: 'no required circulation width supplied — not inventing a regulatory minimum'
      }
    ]
  }
  const findings: SpatialFinding[] = []
  const corridors = evaluableSpaces(model, opts).filter(
    (s) => s.spaceType === 'circulation' || s.usage === 'hallway' || s.usage === 'staircase'
  )
  for (const sp of corridors) {
    const box = bboxOf(sp.boundary)
    if (!box) continue
    const clearWidth = minClearWidth(sp.boundary, sp.holes)
    if (clearWidth > 0 && clearWidth < requiredWidth) {
      findings.push({
        code: 'CIRCULATION_TOO_NARROW',
        severity: 'error',
        status: 'FAIL',
        entityIds: [sp.id],
        constraintId: 'circulation-width',
        measurements: { clearWidth: Math.round(clearWidth), requiredWidth },
        message: `circulation space ${sp.id} narrows to ${Math.round(clearWidth)} units of free width, below the required ${requiredWidth}`
      })
    }
    // The route runs along the longer axis of its extent; free width is measured across it.
    const axis: 'x' | 'y' = box.maxX - box.minX >= box.maxY - box.minY ? 'x' : 'y'
    for (const p of placements) {
      const fp = footprintOf(p)
      if (!pointInPolygon(p.center, sp.boundary, sp.holes)) continue
      if (!ringsOverlap(fp, sp.boundary)) continue
      const remaining = clearWidthThrough(sp.boundary, [...sp.holes, fp], p.center, axis)
      if (remaining < requiredWidth) {
        findings.push({
          code: 'CIRCULATION_BLOCKED',
          severity: 'error',
          status: 'FAIL',
          entityIds: [p.id, sp.id],
          constraintId: 'circulation-width',
          measurements: { remainingWidth: Math.round(remaining), requiredWidth },
          involvedGeometry: { footprint: fp, circulationBoundary: sp.boundary },
          message: `${p.id} reduces circulation in ${sp.id} to ${Math.round(remaining)} units, below the required ${requiredWidth}`,
          suggestedCorrection: `move ${p.id} out of the circulation route ${sp.id}`
        })
      }
    }
  }
  return findings
}

// --- top-level validation -----------------------------------------------------------------------

export interface ValidatePlacementRequest {
  model: SpatialModel
  placement: ProposedPlacement
  /** Other proposed items in the same batch, so mutual collisions are caught before drawing. */
  batch?: ProposedPlacement[]
  obstacles?: Array<{ id: string; footprint: Point2D[] }>
  options?: ValidateOptions
}

/**
 * Validate one placement against the model AND against the rest of the batch. Batch-awareness is
 * the point: two sofas can each be valid in an empty room and still overlap each other.
 */
export function validatePlacement(req: ValidatePlacementRequest): {
  status: FindingStatus
  findings: SpatialFinding[]
} {
  const { model, placement, batch = [], obstacles = [], options = {} } = req
  const findings: SpatialFinding[] = []

  const spaces = evaluableSpaces(model, options)
  if (spaces.length === 0) {
    findings.push({
      code: 'MODEL_INSUFFICIENT_DATA',
      severity: 'warning',
      status: 'INSUFFICIENT_DATA',
      entityIds: [placement.id],
      message:
        'the model has no evaluable spaces; placement cannot be validated rather than assumed valid',
      suggestedCorrection:
        'spatial_analyze to see the rejected rings and their confidence; then read the real boundary with ' +
        'entity.list (detail:"full", layer/window scoped), declare it with spaceHints, or pass ' +
        'options:{acceptLowConfidence:true} to validate against a low-confidence ring knowingly'
    })
    return { status: 'INSUFFICIENT_DATA', findings }
  }

  findings.push(checkSpaceAssignment(placement, model, options))

  const target = placement.spaceId
    ? spaces.find((s) => s.id === placement.spaceId)
    : spaces.find((s) => pointInPolygon(placement.center, s.boundary, s.holes))
  if (target) {
    findings.push(checkContainment(placement, target, options))
    const doorsInSpace = model.openings.filter(
      (d) => d.kind === 'door' && d.connectsSpaces.includes(target.id)
    )
    if (doorsInSpace.length === 0) {
      // The opening this space lacks may be the very thing the batch is about to draw. Preflight
      // judges the drawing AS IT WOULD BE AFTER this batch, so planned openings count: a batch that
      // cuts the door is the fix for a doorless space, not evidence against it. Only an opening that
      // sits on THIS space's ring is credited, and the credited door is still validated like any
      // other placement — a leaf that collides, pinches circulation or sits outside the space fails
      // the batch on its own terms.
      const planned = plannedOpeningsIn(target, [placement, ...batch], options)
      const plannedIds = [...new Set(planned.map((p) => p.id))]
      if (planned.length > 0) {
        findings.push({
          code: 'SPACE_DOOR_GEOMETRY_MISSING',
          severity: 'info',
          status: 'NOT_APPLICABLE',
          entityIds: [placement.id, target.id, ...plannedIds],
          constraintId: 'door-swing-clear',
          measurements: { plannedOpenings: planned.length },
          message:
            `${target.id} has no door yet; this batch draws ${plannedIds.join(', ')} on its boundary, ` +
            `so swing clearance is not evaluated against the current drawing — it will be, on the geometry this batch commits`,
          suggestedCorrection: `after this batch commits, spatial_readback_verify with the reported handles re-runs the swing check on the drawn door`
        })
      } else {
        findings.push({
          code: 'SPACE_DOOR_GEOMETRY_MISSING',
          severity: 'warning',
          status: 'INSUFFICIENT_DATA',
          entityIds: [placement.id, target.id],
          constraintId: 'door-swing-clear',
          measurements: { modelledOpenings: 0, plannedOpenings: 0 },
          message: `no door is modelled for ${target.id}; swing clearance was not evaluated`,
          // The refusal has to be breakable in ONE call, or an agent with a doorless drawing loops
          // on it forever: re-validating the same payload returns the same non-PASS verdict.
          suggestedCorrection:
            `re-run spatial_validate_layout with the opening in the SAME batch: add a placement ` +
            `{id, kind:"door", center:[x,y], width, depth} set into ${target.id}'s boundary ring (and the matching ` +
            `construct -> walls openings:[{along, width}] step in plannedOperation). This finding clears for a batch ` +
            `that draws an opening on that ring; nothing else about the batch changes.`
        })
      }
    }
    for (const d of doorsInSpace) findings.push(checkDoorSwing(placement, d))
  }

  // Caller-supplied obstacles plus everything already standing in the drawing. A placement that
  // shares a handle with an existing item is that item being re-placed, so it is excluded from the
  // derived set rather than colliding with itself.
  const allObstacles = [
    ...obstacles,
    ...deriveObstacles(model, [placement.id, ...(options.excludeObstacleHandles ?? [])])
  ]
  findings.push(...checkObstacleCollision(placement, allObstacles))

  for (const other of batch) {
    if (other.id === placement.id) continue
    const hit = checkPairwiseCollision(placement, other)
    if (hit) findings.push(hit)
  }

  findings.push(
    ...checkCirculation([placement, ...batch], model, options.requiredCirculationWidth, options)
  )

  const status: FindingStatus = findings.some((f) => f.status === 'FAIL')
    ? 'FAIL'
    : findings.some((f) => f.status === 'INSUFFICIENT_DATA')
      ? 'INSUFFICIENT_DATA'
      : 'PASS'
  return { status, findings }
}

/** Validate a whole batch at once, including every pairwise interaction. */
export function validateBatch(req: {
  model: SpatialModel
  placements: ProposedPlacement[]
  obstacles?: Array<{ id: string; footprint: Point2D[] }>
  options?: ValidateOptions
}): { status: FindingStatus; findings: SpatialFinding[] } {
  const { model, placements, obstacles = [], options = {} } = req
  const findings: SpatialFinding[] = []
  for (const p of placements) {
    findings.push(
      ...validatePlacement({ model, placement: p, batch: placements, obstacles, options }).findings
    )
  }
  const access = checkAccessibility(model, options, placements)
  findings.push(...access.findings)
  for (const d of model.openings)
    if (d.kind === 'door') findings.push(...checkDoorValidity(d, model, options))

  const unique = dedupeFindings(findings)
  const status: FindingStatus = unique.some((f) => f.status === 'FAIL')
    ? 'FAIL'
    : unique.some((f) => f.status === 'INSUFFICIENT_DATA')
      ? 'INSUFFICIENT_DATA'
      : 'PASS'
  return { status, findings: unique }
}

function dedupeFindings(findings: SpatialFinding[]): SpatialFinding[] {
  const seen = new Set<string>()
  const out: SpatialFinding[] = []
  for (const f of findings) {
    const key = `${f.code}|${[...f.entityIds].sort().join(',')}|${f.constraintId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** Candidate placements for a furniture item inside a space, ranked by fit. */
export function suggestCorrections(
  model: SpatialModel,
  placement: ProposedPlacement,
  options: ValidateOptions = {},
  gridStep = 500
): Array<{ center: Point2D; rotationDeg: number; score: number }> {
  const spaces = evaluableSpaces(model, options)
  const target = placement.spaceId
    ? spaces.find((s) => s.id === placement.spaceId)
    : spaces.find((s) => pointInPolygon(placement.center, s.boundary, s.holes))
  if (!target) return []
  const box = bboxOf(target.boundary)
  if (!box) return []
  const doors = model.openings.filter(
    (d) => d.kind === 'door' && d.connectsSpaces.includes(target.id)
  )
  const suggestions: Array<{ center: Point2D; rotationDeg: number; score: number }> = []
  for (let x = box.minX; x <= box.maxX; x += gridStep) {
    for (let y = box.minY; y <= box.maxY; y += gridStep) {
      for (const rotationDeg of [0, 90]) {
        const candidate: ProposedPlacement = { ...placement, center: [x, y], rotationDeg }
        const result = validatePlacement({
          model,
          placement: candidate,
          batch: [],
          obstacles: [],
          options
        })
        if (result.status !== 'PASS') continue
        const moved = Math.hypot(x - placement.center[0], y - placement.center[1])
        suggestions.push({ center: [x, y], rotationDeg, score: -moved })
      }
    }
  }
  return suggestions.sort((a, b) => b.score - a.score).slice(0, 5)
}

/** Area of a door's swept region, exposed so callers can report the number they validated against. */
export const sweptAreaOf = (hinge: Point2D, width: number, sweepDeg = 90): number =>
  areaOf(doorSweepPolygon(hinge, width, 0, sweepDeg))
