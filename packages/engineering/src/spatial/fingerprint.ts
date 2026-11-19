import type { SpatialRawEntity } from './extract'
import type { ProposedPlacement } from './constraints'

/**
 * Canonical serialization + stable digests for spatial validation.
 *
 * The whole point of this module is that a validation verdict is only meaningful while it is bound
 * to the exact geometry and the exact proposed operation set it was computed from. A digest the
 * model computes itself is worthless, so every fingerprint here is computed by the server from the
 * payload it actually received — and the guard re-computes it from the payload it actually
 * dispatches. Two payloads that mean the same drawing change must hash the same; two payloads that
 * move one wall must not.
 *
 * FNV-1a 64-bit (XOR-folded into two 32-bit halves for JS) rather than `Bun.hash`: the digest is
 * stored in records and compared across processes, so it must not depend on a runtime-specific
 * hash function.
 */

/** Keys that carry no geometric meaning and must not affect a fingerprint. */
const VOLATILE_KEYS = new Set([
  'idempotencyKey',
  'view',
  'result',
  'dryRun',
  'progressive',
  'ensureLayer',
  'timeoutMs',
])

const round = (n: number): string => {
  if (!Number.isFinite(n)) return 'nan'
  // 1e-6 drawing units is far below any real tolerance (mm drawings: a nanometre), and rounding
  // keeps a 0.1+0.2-style float wobble from producing a different digest for the same geometry.
  return (Math.round(n * 1e6) / 1e6).toFixed(6)
}

/**
 * Deterministic JSON: object keys sorted, arrays order-preserving, numbers normalized. `undefined`
 * and volatile keys are dropped so an omitted field and an explicit `undefined` agree.
 */
export function canonicalize(value: unknown, dropKeys: ReadonlySet<string> = VOLATILE_KEYS): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'number') return round(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v, dropKeys)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => !dropKeys.has(k) && v !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, dropKeys)}`).join(',')}}`
  }
  return 'null'
}

/** FNV-1a, 64-bit folded to a 16-hex-char digest. Stable across runs and runtimes. */
export function digest(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193) >>> 0
    h2 = Math.imul((h2 + c) ^ (h1 >>> 16), 0x811c9dc5) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export const hashCanonical = (value: unknown): string => digest(canonicalize(value))

/**
 * Fingerprint of the drawing geometry a validation ran against. Derived from the entity snapshot the
 * caller supplied (the same snapshot the spatial model was extracted from), so it changes whenever
 * the read geometry changes — a record bound to one drawing state cannot authorize work against a
 * different one.
 */
export function drawingFingerprint(entities: SpatialRawEntity[]): string {
  const compact = entities
    .map((e) => ({
      handle: e.handle,
      kind: e.kind,
      layer: e.layer,
      bounds: e.bounds
        ? {
            min: { x: e.bounds.min.x, y: e.bounds.min.y },
            max: { x: e.bounds.max.x, y: e.bounds.max.y },
          }
        : null,
      geometry: e.geometry ?? null,
      attributes: e.attributes ?? null,
    }))
    // Entity order is not semantic: the same drawing read in a different order is the same drawing.
    .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))
  return digest(canonicalize(compact))
}

/** Fingerprint of the proposed layout — the placements the constraint engine was run against. */
export function layoutFingerprint(placements: ProposedPlacement[]): string {
  const compact = placements
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      spaceId: p.spaceId ?? null,
      center: p.center,
      width: p.width,
      depth: p.depth,
      rotationDeg: p.rotationDeg ?? 0,
      footprint: p.footprint ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return digest(canonicalize(compact))
}

/**
 * Fingerprint of the CAD operation payload that a validated layout will actually be executed as.
 * Computed by the server from the real tool arguments at both the commit and the dispatch site, so
 * the model cannot authorize one set of operations and then draw another.
 */
export function operationFingerprint(payload: unknown): string {
  return digest(canonicalize(payload))
}
