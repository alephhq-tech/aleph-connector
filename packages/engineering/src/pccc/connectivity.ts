import type { Point2D } from '../schemas/semantic-model'
import { distancePointToSegment, segmentDistance } from '../spatial/geometry'
import type { PipeSegmentRoute } from './pipe-router'
import type { SprinklerHead } from './sprinkler-layout'

export interface ConnectivityInput {
  riserLocation: Point2D
  heads: SprinklerHead[]
  segments: PipeSegmentRoute[]
  /** mm. Default 10mm absorbs `pipe-router.ts`'s own `Math.round()` rounding without being loose
   * enough to call two genuinely separate pipe runs "connected". */
  toleranceMm?: number
}

export interface ConnectivityResult {
  isFullyConnected: boolean
  /** Head ids with no graph-reachable-from-riser segment passing within tolerance of them. */
  disconnectedHeads: string[]
  /** Segment ids actually reachable from the riser — distinct from "every segment present",
   * since a segment that doesn't connect to anything reachable is dead pipe. */
  reachableSegmentIds: string[]
  /** True only when the riser itself touches no segment — nothing in the network is live. */
  riserDisconnected: boolean
}

/**
 * Independently recomputes pipe-network connectivity from actual geometry — never trusts a
 * router's own `isFullyConnected`/`disconnectedHeads` claim (aleph-platform#279 Part A:
 * `routeSprinklerPipes` returns those fields unconditionally true, which is the router's design
 * intent, not a measurement). Builds an undirected graph over segments (two are adjacent when their
 * true segment-to-segment distance is within `toleranceMm`, which covers both a T-junction at an
 * endpoint and a cross-junction mid-span), finds every segment graph-reachable from whichever
 * segment sits within tolerance of the riser, then tests each head against
 * the actual line of every reachable segment (point-to-segment distance, not endpoint matching —
 * a row's middle heads sit ON a branch segment's line, not at either of its ends).
 */
export function verifyPipeConnectivity(input: ConnectivityInput): ConnectivityResult {
  const toleranceMm = input.toleranceMm ?? 10

  if (input.heads.length === 0) {
    // Nothing to connect — vacuously true, matching `routeSprinklerPipes`'s own empty-input
    // convention. Never reached with a nonempty `segments` from that function in practice.
    return {
      isFullyConnected: true,
      disconnectedHeads: [],
      reachableSegmentIds: [],
      riserDisconnected: input.segments.length === 0
    }
  }

  if (input.segments.length === 0) {
    // The exact "forged connectivity flags with zero segments" case the issue calls out: heads
    // exist, nothing routes to them, so this is unconnected, full stop.
    return {
      isFullyConnected: false,
      disconnectedHeads: input.heads.map((h) => h.id),
      reachableSegmentIds: [],
      riserDisconnected: true
    }
  }

  // Adjacency between two segments: true segment-to-segment distance. The common case is a T where
  // one segment's ENDPOINT lies on the OTHER's LINE (a branch butting onto the main partway along
  // its run). But `routeSprinklerPipes` also produces CROSS junctions: the main is drawn at the
  // riser's X and every branch spans its whole row, so when the riser sits between the first and
  // last head of a row, the branch passes right through the main with no endpoint anywhere near it.
  // Endpoint-only matching called that grid disconnected (70 of 88 heads in the SUNLAND run).
  const adjacency = new Map<number, Set<number>>()
  for (let i = 0; i < input.segments.length; i++) adjacency.set(i, new Set())
  for (let i = 0; i < input.segments.length; i++) {
    for (let j = i + 1; j < input.segments.length; j++) {
      const a = input.segments[i]!
      const b = input.segments[j]!
      if (segmentDistance(a.start, a.end, b.start, b.end) <= toleranceMm) {
        adjacency.get(i)!.add(j)
        adjacency.get(j)!.add(i)
      }
    }
  }

  // Anchor: which segment(s) actually touch the riser — not "the one named 'main'", since a
  // mislabeled or mis-geometried router output must fail this, not be trusted by role.
  const rootSegments = input.segments
    .map((s, i) => i)
    .filter((i) => {
      const s = input.segments[i]!
      return distancePointToSegment(input.riserLocation, s.start, s.end) <= toleranceMm
    })

  if (rootSegments.length === 0) {
    return {
      isFullyConnected: false,
      disconnectedHeads: input.heads.map((h) => h.id),
      reachableSegmentIds: [],
      riserDisconnected: true
    }
  }

  // BFS over the segment-adjacency graph from every riser-touching segment.
  const reachable = new Set<number>(rootSegments)
  const queue = [...rootSegments]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next)
        queue.push(next)
      }
    }
  }

  const reachableSegments = [...reachable].map((i) => input.segments[i]!)
  const disconnectedHeads = input.heads
    .filter(
      (h) =>
        !reachableSegments.some(
          (s) => distancePointToSegment([h.x, h.y], s.start, s.end) <= toleranceMm
        )
    )
    .map((h) => h.id)

  return {
    isFullyConnected: disconnectedHeads.length === 0,
    disconnectedHeads,
    reachableSegmentIds: reachableSegments.map((s) => s.id),
    riserDisconnected: false
  }
}
