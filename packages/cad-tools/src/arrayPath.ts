/**
 * Pure arc-length path math for `entity.transform` `arrayPath` (#20) — no AutoCAD dependency, so
 * it's unit-testable directly and shared by `MockBridgeClient` (count/cap math) and the pre-wire
 * cap check in `arrayCopyCount` below. The plugin (`EntityHandlers.ApplyArrayPath`) does the
 * equivalent placement using AutoCAD's own `Curve.GetPointAtDist`/`GetFirstDerivative`, not this
 * module — see its doc comment for why duplicating this math there isn't necessary.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export type ArrayPathSegment =
  | { kind: 'line'; from: Vec3; to: Vec3 }
  | { kind: 'arc'; center: Vec3; radius: number; startAngle: number; endAngle: number }

function segmentLength(segment: ArrayPathSegment): number {
  if (segment.kind === 'line') {
    return Math.hypot(
      segment.to.x - segment.from.x,
      segment.to.y - segment.from.y,
      segment.to.z - segment.from.z
    )
  }
  return segment.radius * Math.abs(segment.endAngle - segment.startAngle)
}

/** Point at arc-length `s` (0..segment length) from the segment's start. */
function pointAt(segment: ArrayPathSegment, s: number): Vec3 {
  if (segment.kind === 'line') {
    const len = segmentLength(segment)
    const t = len === 0 ? 0 : s / len
    return {
      x: segment.from.x + (segment.to.x - segment.from.x) * t,
      y: segment.from.y + (segment.to.y - segment.from.y) * t,
      z: segment.from.z + (segment.to.z - segment.from.z) * t
    }
  }
  const sign = Math.sign(segment.endAngle - segment.startAngle) || 1
  const angle = segment.startAngle + sign * (s / segment.radius)
  return {
    x: segment.center.x + segment.radius * Math.cos(angle),
    y: segment.center.y + segment.radius * Math.sin(angle),
    z: segment.center.z
  }
}

/**
 * Unit-tangent direction (radians, XY plane only — the plane every arc/polyline here lives in) at
 * arc-length `s`.
 */
function tangentAt(segment: ArrayPathSegment, s: number): number {
  if (segment.kind === 'line') {
    return Math.atan2(segment.to.y - segment.from.y, segment.to.x - segment.from.x)
  }
  const sign = Math.sign(segment.endAngle - segment.startAngle) || 1
  const angle = segment.startAngle + sign * (s / segment.radius)
  return angle + sign * (Math.PI / 2)
}

/**
 * Straight segments through consecutive points — used for both an explicit `points` path and
 * (bulges ignored, same simplification `entityLength`'s zeroLength check already makes) a
 * `polyline`-handle path.
 */
export function segmentsFromPoints(points: Vec3[]): ArrayPathSegment[] {
  if (points.length < 2) throw new Error('arrayPath: path needs at least 2 points')
  const segments: ArrayPathSegment[] = []
  for (let i = 1; i < points.length; i++) {
    segments.push({ kind: 'line', from: points[i - 1]!, to: points[i]! })
  }
  return segments
}

/** Same as `segmentsFromPoints`, closing the loop back to the first point. */
export function segmentsFromPolyline(points: Vec3[], closed: boolean): ArrayPathSegment[] {
  const segments = segmentsFromPoints(points)
  if (closed) segments.push({ kind: 'line', from: points[points.length - 1]!, to: points[0]! })
  return segments
}

export function segmentsFromLine(start: Vec3, end: Vec3): ArrayPathSegment[] {
  return [{ kind: 'line', from: start, to: end }]
}

export function segmentsFromArc(
  center: Vec3,
  radius: number,
  startAngle: number,
  endAngle: number
): ArrayPathSegment[] {
  return [{ kind: 'arc', center, radius, startAngle, endAngle }]
}

export function pathLength(segments: ArrayPathSegment[]): number {
  return segments.reduce((total, segment) => total + segmentLength(segment), 0)
}

export interface ArrayPathSample {
  point: Vec3
  tangentAngle: number
}

/** Point + tangent at total arc-length `s` (clamped to the path) from the path's start. */
export function samplePathAt(segments: ArrayPathSegment[], s: number): ArrayPathSample {
  if (segments.length === 0) throw new Error('arrayPath: path has no segments')
  let remaining = Math.max(0, s)
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const len = segmentLength(segment)
    if (remaining <= len || i === segments.length - 1) {
      const clamped = Math.min(remaining, len)
      return { point: pointAt(segment, clamped), tangentAngle: tangentAt(segment, clamped) }
    }
    remaining -= len
  }
  /* istanbul ignore next -- unreachable: the loop above always returns on its last iteration */
  throw new Error('arrayPath: unreachable')
}

/**
 * `count` items evenly spaced across the whole path including both endpoints (`count - 1` equal
 * gaps) — AutoCAD ARRAYPATH's "Divide" method.
 */
export function sampleByCount(segments: ArrayPathSegment[], count: number): ArrayPathSample[] {
  if (count < 1) throw new Error('arrayPath: count must be >= 1')
  if (count === 1) return [samplePathAt(segments, 0)]
  const length = pathLength(segments)
  const step = length / (count - 1)
  return Array.from({ length: count }, (_, i) => samplePathAt(segments, i * step))
}

/**
 * Items every `spacing` from the path's start; the last item lands at or before the path's end (no
 * item exactly on the end unless the length is an exact multiple of `spacing`) — AutoCAD
 * ARRAYPATH's "Measure" method.
 */
export function sampleBySpacing(segments: ArrayPathSegment[], spacing: number): ArrayPathSample[] {
  if (spacing <= 0) throw new Error('arrayPath: spacing must be > 0')
  const length = pathLength(segments)
  const EPS = 1e-9
  const extraItems = Math.floor(length / spacing + EPS)
  return Array.from({ length: extraItems + 1 }, (_, i) =>
    samplePathAt(segments, Math.min(i * spacing, length))
  )
}

export interface ArrayPathPlacement {
  /** Offset from `samples[0]`'s point — apply as a translation to the source's own current position. */
  delta: Vec3
  /**
   * Tangent-angle change (radians) from `samples[0]` — apply as a rotation about the placement
   * point when `align`.
   */
  angleDelta: number
}

/**
 * Converts absolute path samples into placements relative to the first sample (the source's own
 * position).
 */
export function arrayPathPlacements(samples: ArrayPathSample[]): ArrayPathPlacement[] {
  const origin = samples[0]
  if (!origin) return []
  return samples.map((sample) => ({
    delta: {
      x: sample.point.x - origin.point.x,
      y: sample.point.y - origin.point.y,
      z: sample.point.z - origin.point.z
    },
    angleDelta: sample.tangentAngle - origin.tangentAngle
  }))
}
