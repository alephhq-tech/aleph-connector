import type { CreateEntityParams } from '@arcdio/cad-protocol'
import {
  add,
  arcLengths,
  centroid,
  containsPoint,
  invalidGeometry,
  offsetPolyline,
  projectOntoPolyline,
  pointAtArc,
  scale,
  signedArea,
  type Vec2
} from './geometry.js'

/**
 * Drafting-intent generators for the `construct` tool (#21): each turns one intent into plain
 * `entity.create` payloads, which the tool sends as a single `operations.apply` batch. Pure
 * functions — no AutoCAD, fully unit-testable — so the plugin needs no new RPC methods.
 */

/** One generated entity plus a stable label (`grid.axis.A`, `room.name`, …) for the result map. */
export interface ConstructStep {
  label: string
  entity: CreateEntityParams
}

const p3 = (p: Vec2) => ({ x: p.x, y: p.y, z: 0 })

/**
 * Approximate insertion for single-line text centred on `center`: the plugin's text is
 * baseline-left, so shift left by half the estimated width (≈0.7 × height per character for
 * standard fonts) and down by half the height.
 */
function centredText(
  label: string,
  text: string,
  center: Vec2,
  height: number,
  layer?: string
): ConstructStep {
  const insertion = { x: center.x - 0.35 * height * text.length, y: center.y - height / 2 }
  return {
    label,
    entity: { kind: 'text.singleLine', layer, insertion: p3(insertion), text, height, rotation: 0 }
  }
}

// --- walls -------------------------------------------------------------------------------------

/** One opening cut out of a wall run. */
interface WallOpening {
  /**
   * Where the opening sits. `at` is a point near the wall (it is projected onto the centreline, so
   * it need not sit exactly on it); `along` is the arc-length distance from the run's start.
   * Give one of the two.
   */
  at?: Vec2
  along?: number
  /** Clear width of the opening, measured along the wall. */
  width: number
}

interface WallsIntent {
  centerline: Vec2[]
  thickness: number
  closed?: boolean
  /**
   * Where the given line sits in the wall: its centre, its left face or its right face (by travel
   * direction).
   */
  justification?: 'center' | 'left' | 'right'
  /**
   * Doors/windows to cut out of the run. The wall is built as separate pieces with real gaps at
   * each opening — the opening is NOT drawn on top of a continuous wall, so the room stays
   * genuinely open and a hatch or area take-off of the wall cross-section stays correct.
   */
  openings?: WallOpening[]
  layer?: string
}

/** Resolve every opening to an arc-length interval on the run, sorted and merged. */
function resolveOpenings(
  centerline: Vec2[],
  closed: boolean,
  openings: WallOpening[]
): Array<{ from: number; to: number }> {
  const { total } = arcLengths(centerline, closed)
  const resolved = openings.map((o, i) => {
    let centre: number
    if (o.at) {
      const proj = projectOntoPolyline(centerline, closed, o.at)
      if (!proj)
        throw invalidGeometry(`openings[${i}].at could not be projected onto the centreline`)
      centre = proj.s
    } else if (o.along !== undefined) {
      centre = o.along
    } else {
      throw invalidGeometry(
        `openings[${i}]: give at (a point near the wall) or along (distance from the run's start)`
      )
    }
    if (!(o.width > 0)) throw invalidGeometry(`openings[${i}].width must be positive`)
    const half = o.width / 2
    if (closed) {
      // Keep a seam-straddling opening as one wrapped interval; it is split below.
      return {
        from: (((centre - half) % total) + total) % total,
        to: (((centre + half) % total) + total) % total
      }
    }
    return {
      from: Math.max(0, centre - half),
      to: Math.min(total, centre + half)
    }
  })

  const linear: Array<{ from: number; to: number }> = []
  for (const o of resolved) {
    if (o.from <= o.to) linear.push(o)
    else {
      linear.push({ from: o.from, to: total })
      linear.push({ from: 0, to: o.to })
    }
  }
  linear.sort((a, b) => a.from - b.from)

  // Merge overlapping openings so two nearby doors never leave a hairline sliver of wall.
  const merged: Array<{ from: number; to: number }> = []
  for (const o of linear) {
    const last = merged[merged.length - 1]
    if (last && o.from <= last.to) last.to = Math.max(last.to, o.to)
    else merged.push({ ...o })
  }
  return merged
}

/** The piece of `points` between arc-lengths `a` and `b`, with both ends interpolated. */
function sliceRun(points: Vec2[], closed: boolean, a: number, b: number): Vec2[] {
  const { cumulative } = arcLengths(points, closed)
  const at = (s: number) => pointAtArc(points, closed, s)!.point
  const out: Vec2[] = [at(a)]
  const segments = closed ? points.length : points.length - 1
  for (let i = 0; i < segments; i++) {
    // Keep a vertex only when its arc-length lies strictly inside the span; the span's own ends
    // are added by at(a)/at(b) below.
    const s = cumulative[i + 1]!
    if (s > a + 1e-9 && s < b - 1e-9) out.push(points[(i + 1) % points.length]!)
  }
  const end = at(b)
  const prev = out[out.length - 1]!
  if (Math.hypot(end.x - prev.x, end.y - prev.y) > 1e-9) out.push(end)
  return out
}

/** Closed outline of one solid wall piece: left face out, right face back. */
function wallPiece(centerline: Vec2[], leftOffset: number, rightOffset: number): Vec2[] {
  const left = offsetPolyline(centerline, leftOffset, false)
  const right = offsetPolyline(centerline, rightOffset, false)
  return [...left, ...right.reverse()]
}

export function walls(intent: WallsIntent): ConstructStep[] {
  const {
    centerline,
    thickness,
    closed = false,
    justification = 'center',
    openings = [],
    layer
  } = intent
  const [leftOffset, rightOffset] =
    justification === 'left'
      ? [0, -thickness]
      : justification === 'right'
        ? [thickness, 0]
        : [thickness / 2, -thickness / 2]

  const polyline = (label: string, points: Vec2[]): ConstructStep => ({
    label,
    entity: { kind: 'polyline', layer, points: points.map(p3), closed: true }
  })

  if (openings.length === 0) {
    // A closed run has two faces; an open run is one closed outline so it can be hatched as a
    // single boundary.
    if (closed)
      return [
        polyline('walls.leftFace', offsetPolyline(centerline, leftOffset, true)),
        polyline('walls.rightFace', offsetPolyline(centerline, rightOffset, true))
      ]
    return [polyline('walls.outline', wallPiece(centerline, leftOffset, rightOffset))]
  }

  // Opening-aware: cut the run into solid spans between openings and draw each span as its own
  // closed outline, so every opening is a real gap in the wall.
  const { total } = arcLengths(centerline, closed)
  const cuts = resolveOpenings(centerline, closed, openings)
  const spans: Array<{ from: number; to: number }> = []
  if (closed) {
    // The solid pieces are the gaps between consecutive cuts, walking round the ring — including
    // the gap that wraps the start/end seam, which is why the last cut is paired with the first.
    for (let i = 0; i < cuts.length; i++) {
      const from = cuts[i]!.to
      const next = cuts[(i + 1) % cuts.length]!
      const to = i === cuts.length - 1 ? next.from + total : next.from
      if (to <= from + 1e-9) continue
      if (to <= total) spans.push({ from, to })
      else {
        // A piece that straddles the seam is drawn as two pieces meeting at the start vertex.
        spans.push({ from, to: total })
        spans.push({ from: 0, to: to - total })
      }
    }
  } else {
    let cursor = 0
    for (const c of cuts) {
      if (c.from > cursor) spans.push({ from: cursor, to: c.from })
      cursor = Math.max(cursor, c.to)
    }
    if (cursor < total - 1e-9) spans.push({ from: cursor, to: total })
  }

  const solid = spans.filter((s) => s.to - s.from > 1e-9)
  if (solid.length === 0)
    throw invalidGeometry('the openings cover the whole wall run; nothing would be left to draw')

  return solid.flatMap((span, i) => {
    const run = sliceRun(centerline, closed, span.from, span.to)
    if (run.length < 2) return []
    return [polyline(`walls.segment${i + 1}`, wallPiece(run, leftOffset, rightOffset))]
  })
}

// --- grid --------------------------------------------------------------------------------------

interface GridAxisSpec {
  /** Distances between consecutive axes (n spacings → n + 1 axes). */
  spacings?: number[]
  /** Alternative to `spacings`: this many axes, `spacing` apart. */
  count?: number
  spacing?: number
  labels?: string[]
}

interface GridIntent {
  origin: Vec2
  x: GridAxisSpec
  y: GridAxisSpec
  /** How far axis lines run past the outermost axes before the bubble. */
  extension: number
  bubbleRadius: number
  textHeight?: number
  bubbles?: 'start' | 'both'
  layer?: string
}

function axisOffsets(spec: GridAxisSpec, axis: 'x' | 'y'): number[] {
  const spacings =
    spec.spacings ??
    (spec.count !== undefined && spec.spacing !== undefined
      ? Array.from({ length: Math.max(spec.count - 1, 0) }, () => spec.spacing!)
      : undefined)
  if (!spacings) throw invalidGeometry(`grid.${axis}: give spacings, or count + spacing`)
  return spacings.reduce<number[]>((acc, spacing) => [...acc, acc[acc.length - 1]! + spacing], [0])
}

/** Letters for grid rows, skipping I and O (read as 1 and 0 on drawings): A…H, J…N, P…Z, AA… */
function letterLabel(index: number): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  let label = ''
  let n = index
  do {
    label = letters[n % letters.length] + label
    n = Math.floor(n / letters.length) - 1
  } while (n >= 0)
  return label
}

export function grid(intent: GridIntent): ConstructStep[] {
  const { origin, extension, bubbleRadius: r, bubbles = 'start', layer } = intent
  const height = intent.textHeight ?? r
  const xs = axisOffsets(intent.x, 'x').map((dx) => origin.x + dx)
  const ys = axisOffsets(intent.y, 'y').map((dy) => origin.y + dy)
  const [x0, xN, y0, yN] = [xs[0]!, xs[xs.length - 1]!, ys[0]!, ys[ys.length - 1]!]
  const steps: ConstructStep[] = []

  const axis = (id: string, start: Vec2, end: Vec2, bubbleAt: Vec2[], text: string) => {
    steps.push({
      label: `grid.axis.${id}`,
      entity: { kind: 'line', layer, start: p3(start), end: p3(end) }
    })
    bubbleAt.forEach((center, i) => {
      const suffix = bubbleAt.length > 1 ? (i === 0 ? '.start' : '.end') : ''
      steps.push({
        label: `grid.bubble.${id}${suffix}`,
        entity: { kind: 'circle', layer, center: p3(center), radius: r }
      })
      steps.push(centredText(`grid.label.${id}${suffix}`, text, center, height, layer))
    })
  }

  xs.forEach((x, i) => {
    const text = intent.x.labels?.[i] ?? String(i + 1)
    const start = { x, y: y0 - extension }
    const end = { x, y: yN + extension }
    const ends = [
      add(start, { x: 0, y: -r }),
      ...(bubbles === 'both' ? [add(end, { x: 0, y: r })] : [])
    ]
    axis(text, start, end, ends, text)
  })
  ys.forEach((y, i) => {
    const text = intent.y.labels?.[i] ?? letterLabel(i)
    const start = { x: x0 - extension, y }
    const end = { x: xN + extension, y }
    const ends = [
      add(start, { x: -r, y: 0 }),
      ...(bubbles === 'both' ? [add(end, { x: r, y: 0 })] : [])
    ]
    axis(text, start, end, ends, text)
  })
  return steps
}

// --- room --------------------------------------------------------------------------------------

interface RoomIntent {
  outline: Vec2[]
  name: string
  showArea?: boolean
  /** What one drawing unit is, for the area label. */
  unit?: 'mm' | 'cm' | 'm'
  areaDecimals?: number
  textHeight: number
  layer?: string
}

const SQUARE_METRES_PER_UNIT2 = { mm: 1e-6, cm: 1e-4, m: 1 } as const

export function roomArea(outline: Vec2[], unit: RoomIntent['unit'] = 'mm'): number {
  return Math.abs(signedArea(outline)) * SQUARE_METRES_PER_UNIT2[unit]
}

export function room(intent: RoomIntent): ConstructStep[] {
  const {
    outline,
    name,
    showArea = true,
    unit = 'mm',
    areaDecimals = 2,
    textHeight,
    layer
  } = intent
  // Non-convex rooms can have their centroid outside; fall back to the vertex average, then to the
  // first vertex nudged inward, so the label lands inside the room.
  const vertexAverage = scale(outline.reduce(add, { x: 0, y: 0 }), 1 / outline.length)
  const anchor =
    [centroid(outline), vertexAverage].find((p) => containsPoint(outline, p)) ?? centroid(outline)
  const steps: ConstructStep[] = [
    {
      label: 'room.outline',
      entity: { kind: 'polyline', layer, points: outline.map(p3), closed: true }
    },
    centredText(
      'room.name',
      name,
      showArea ? add(anchor, { x: 0, y: 0.75 * textHeight }) : anchor,
      textHeight,
      layer
    )
  ]
  if (showArea) {
    const text = `${roomArea(outline, unit).toFixed(areaDecimals)} m²`
    steps.push(
      centredText(
        'room.area',
        text,
        add(anchor, { x: 0, y: -0.75 * textHeight }),
        textHeight * 0.8,
        layer
      )
    )
  }
  return steps
}

// --- dimension chains ----------------------------------------------------------------------------

interface DimensionChainIntent {
  /** Points to dimension, in order along the chain. */
  points: Vec2[]
  /**
   * Continue: consecutive pairs on one line (DIMCONTINUE); baseline: all from points[0]
   * (DIMBASELINE).
   */
  mode: 'continue' | 'baseline'
  direction: 'horizontal' | 'vertical'
  /**
   * Distance from points[0] to the (first) dimension line, perpendicular to the measured direction: +
   * is above for horizontal, right for vertical.
   */
  offset: number
  /** Baseline only: step between stacked dimension lines (default = offset). */
  spacing?: number
  layer?: string
}

export function dimensionChain(intent: DimensionChainIntent): ConstructStep[] {
  const { points, mode, direction, offset, layer } = intent
  const spacing = intent.spacing ?? offset
  const first = points[0]!
  const vertical = direction === 'vertical'
  const pairs =
    mode === 'continue'
      ? points.slice(1).map((p, i) => [points[i]!, p] as const)
      : points.slice(1).map((p) => [first, p] as const)

  return pairs.map(([a, b], i) => {
    const along = vertical ? b.y - a.y : b.x - a.x
    if (Math.abs(along) < 1e-9) {
      throw invalidGeometry(
        `dimensions: points ${i} and ${i + 1} coincide along the ${direction} direction`
      )
    }
    const distance = mode === 'baseline' ? offset + i * spacing : offset
    const dimLinePoint = vertical
      ? { x: first.x + distance, y: a.y }
      : { x: a.x, y: first.y + distance }
    return {
      label: `dimensions.${i + 1}`,
      entity: {
        kind: 'dimension.linear',
        layer,
        extLine1: p3(a),
        extLine2: p3(b),
        dimLinePoint: p3(dimLinePoint),
        rotation: vertical ? Math.PI / 2 : 0
      }
    }
  })
}
