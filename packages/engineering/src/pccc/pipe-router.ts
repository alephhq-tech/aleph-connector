import type { Point2D } from '../schemas/semantic-model'
import type { SprinklerHead } from './sprinkler-layout'
import { unitsPerMetreFor, unitsPerMmFor } from './drawing-units'
import type { DrawingUnits } from './drawing-units'
import {
  bboxOf,
  bboxOverlap,
  pointInPolygon,
  segmentDistance,
  distancePointToSegment,
  type BBox
} from '../spatial/geometry'

export interface PipeRouterInput {
  heads: SprinklerHead[]
  riserLocation: Point2D
  mainPipeOrientation?: 'horizontal' | 'vertical'
  layerMain?: string
  layerBranch?: string
  excludedBoundaries?: Point2D[][]
  clearanceMm?: number
  detourObstacles?: boolean
  /** Drawing units from `drawing.summary` `insUnits` (E8). Absent/`unitless` blocks the route. */
  insUnits?: DrawingUnits
}

export interface PipeSegmentRoute {
  id: string
  kind: 'main' | 'branch'
  start: Point2D
  end: Point2D
  nominalDiameterMm: number
  connectedHeadIds: string[]
  lengthM: number
}

export interface PipeRouteViolation {
  segmentId: string
  excludedIndex: number
  code: 'PIPE_CROSSES_EXCLUDED_ZONE' | 'PIPE_CLIPS_EXCLUDED_ZONE' | 'UNKNOWN_DRAWING_UNITS'
  distanceMm?: number
  segment: { start: Point2D; end: Point2D }
}

export interface PipeRouteResult {
  segments: PipeSegmentRoute[]
  totalLengthM: number
  mainLengthM: number
  branchLengthM: number
  disconnectedHeads: string[]
  isFullyConnected: boolean
  cadOperations: Array<{
    kind: 'line'
    layer: string
    start: Point2D
    end: Point2D
  }>
  violations: PipeRouteViolation[]
  blocked: boolean
}

/**
 * Standard Pipe Sizing table for Sprinkler Branch Lines per TCVN 7336:2021 Table 4:
 * - 1 head: DN 25 (25 mm)
 * - 2 heads: DN 32 (32 mm)
 * - 3 heads: DN 40 (40 mm)
 * - 4-5 heads: DN 50 (50 mm)
 * - 6-8 heads: DN 65 (65 mm)
 * - 9-15 heads: DN 80 (80 mm)
 * - >15 heads: DN 100 (100 mm)
 */
export function getRecommendedPipeDiameter(headCount: number): number {
  if (headCount <= 1) return 25
  if (headCount <= 2) return 32
  if (headCount <= 3) return 40
  if (headCount <= 5) return 50
  if (headCount <= 8) return 65
  if (headCount <= 15) return 80
  return 100
}

/**
 * Deterministic Sprinkler Pipe Network Router.
 * Builds logical branch lines grouped by row, connects branch lines to a main cross-pipe,
 * and feeds from the riser connection point.
 */
export function routeSprinklerPipes(input: PipeRouterInput): PipeRouteResult {
  const segments: PipeSegmentRoute[] = []
  const cadOperations: Array<{ kind: 'line'; layer: string; start: Point2D; end: Point2D }> = []
  const layerMain = input.layerMain ?? 'PCCC_PIPE_MAIN'
  const layerBranch = input.layerBranch ?? 'PCCC_PIPE_BRANCH'
  const clearanceMm = input.clearanceMm ?? 0
  const excludedBoundaries = input.excludedBoundaries ?? []

  // E8: pipe lengths are metres and clearances are millimetres — both need the real unit
  // basis, resolved from insUnits. Unknown units block the route outright.
  const unitsPerMetre = unitsPerMetreFor(input.insUnits)
  const unitsPerMm = unitsPerMmFor(input.insUnits)
  if (unitsPerMetre === null || unitsPerMm === null) {
    return {
      segments: [],
      totalLengthM: 0,
      mainLengthM: 0,
      branchLengthM: 0,
      disconnectedHeads: [],
      isFullyConnected: false,
      cadOperations: [],
      violations: [
        {
          segmentId: 'PIPE_NETWORK',
          excludedIndex: -1,
          code: 'UNKNOWN_DRAWING_UNITS',
          segment: { start: input.riserLocation, end: input.riserLocation }
        }
      ],
      blocked: true
    }
  }
  const toMetres = (drawingUnits: number): number => drawingUnits / unitsPerMetre
  const toMm = (drawingUnits: number): number => drawingUnits / unitsPerMm
  // Clearance is a physical-mm input; the segment boxes below are in drawing units.
  const clearance = clearanceMm * unitsPerMm

  if (input.heads.length === 0) {
    return {
      segments: [],
      totalLengthM: 0,
      mainLengthM: 0,
      branchLengthM: 0,
      disconnectedHeads: [],
      isFullyConnected: true,
      cadOperations: [],
      violations: [],
      blocked: false
    }
  }

  // Group heads by row (branch lines)
  const rowsMap = new Map<number, SprinklerHead[]>()
  for (const h of input.heads) {
    let rowList = rowsMap.get(h.row)
    if (!rowList) {
      rowList = []
      rowsMap.set(h.row, rowList)
    }
    rowList.push(h)
  }

  const sortedRows = Array.from(rowsMap.keys()).sort((a, b) => a - b)
  const riser = input.riserLocation

  // Main Cross Pipe: Runs from Riser along Y to meet each branch row's Y level
  // Main connects at the branch start (X of riser or X of first head)
  const mainX = riser[0]
  const minY = Math.min(riser[1], ...input.heads.map((h) => h.y))
  const maxY = Math.max(riser[1], ...input.heads.map((h) => h.y))

  // Main Pipe segment
  const mainLengthM = Math.round(toMetres(Math.abs(maxY - minY)) * 100) / 100
  const mainTotalHeads = input.heads.length
  const mainDiameter = Math.max(65, getRecommendedPipeDiameter(mainTotalHeads))

  const mainSegment: PipeSegmentRoute = {
    id: 'PIPE_MAIN_01',
    kind: 'main',
    start: [mainX, minY],
    end: [mainX, maxY],
    nominalDiameterMm: mainDiameter,
    connectedHeadIds: input.heads.map((h) => h.id),
    lengthM: mainLengthM
  }
  segments.push(mainSegment)
  cadOperations.push({
    kind: 'line',
    layer: layerMain,
    start: mainSegment.start,
    end: mainSegment.end
  })

  // Branch lines: For each row, route pipe from mainX to each head in row
  let branchTotalLengthMm = 0
  let segIdx = 1

  for (const rowNum of sortedRows) {
    const rowHeads = rowsMap.get(rowNum)!.sort((a, b) => a.x - b.x)
    const rowY = rowHeads[0]!.y

    // Segment connecting main pipe at (mainX, rowY) to the first head in row
    const firstHead = rowHeads[0]!
    const lastHead = rowHeads[rowHeads.length - 1]!

    // Connect from main to row start/end
    const minRowX = Math.min(mainX, firstHead.x)
    const maxRowX = Math.max(mainX, lastHead.x)

    // Find any intersecting excluded ring for this horizontal row
    const intersectingRings = excludedBoundaries
      .map((ring) => ({ ring, box: bboxOf(ring) }))
      .filter(
        (r) =>
          r.box &&
          rowY >= r.box.minY &&
          rowY <= r.box.maxY &&
          maxRowX > r.box.minX &&
          minRowX < r.box.maxX
      )
      .sort((a, b) => a.box!.minX - b.box!.minX)

    const branchDiameter = getRecommendedPipeDiameter(rowHeads.length)

    if (intersectingRings.length === 0 || !input.detourObstacles) {
      const branchSegLengthM = Math.round(toMetres(Math.abs(maxRowX - minRowX)) * 100) / 100
      branchTotalLengthMm += Math.abs(maxRowX - minRowX)

      const branchSegment: PipeSegmentRoute = {
        id: `PIPE_BRANCH_${segIdx++}`,
        kind: 'branch',
        start: [minRowX, rowY],
        end: [maxRowX, rowY],
        nominalDiameterMm: branchDiameter,
        connectedHeadIds: rowHeads.map((h) => h.id),
        lengthM: branchSegLengthM
      }
      segments.push(branchSegment)
      cadOperations.push({
        kind: 'line',
        layer: layerBranch,
        start: branchSegment.start,
        end: branchSegment.end
      })
    } else {
      let curX = minRowX

      for (const obs of intersectingRings) {
        const b = obs.box!
        const margin = Math.max(300 * unitsPerMm, clearance + 50 * unitsPerMm)
        const xLeft = Math.max(curX, b.minX - margin)
        const xRight = b.maxX + margin

        if (xLeft > curX) {
          const segLen = Math.abs(xLeft - curX)
          branchTotalLengthMm += segLen
          const seg: PipeSegmentRoute = {
            id: `PIPE_BRANCH_${segIdx++}`,
            kind: 'branch',
            start: [curX, rowY],
            end: [xLeft, rowY],
            nominalDiameterMm: branchDiameter,
            connectedHeadIds: rowHeads.filter((h) => h.x >= curX && h.x <= xLeft).map((h) => h.id),
            lengthM: Math.round(toMetres(segLen) * 100) / 100
          }
          segments.push(seg)
          cadOperations.push({ kind: 'line', layer: layerBranch, start: seg.start, end: seg.end })
        }

        const detourY =
          Math.abs(rowY - b.minY) <= Math.abs(rowY - b.maxY)
            ? b.minY - margin
            : b.maxY + margin

        const pts: Point2D[] = [
          [xLeft, rowY],
          [xLeft, detourY],
          [xRight, detourY],
          [xRight, rowY]
        ]
        for (let p = 0; p < 3; p++) {
          const p1 = pts[p]!
          const p2 = pts[p + 1]!
          const d = Math.abs(p2[0] - p1[0]) + Math.abs(p2[1] - p1[1])
          branchTotalLengthMm += d
          const seg: PipeSegmentRoute = {
            id: `PIPE_BRANCH_${segIdx++}`,
            kind: 'branch',
            start: p1,
            end: p2,
            nominalDiameterMm: branchDiameter,
            connectedHeadIds: [],
            lengthM: Math.round(toMetres(d) * 100) / 100
          }
          segments.push(seg)
          cadOperations.push({ kind: 'line', layer: layerBranch, start: seg.start, end: seg.end })
        }

        curX = xRight
      }

      if (curX < maxRowX) {
        const segLen = Math.abs(maxRowX - curX)
        branchTotalLengthMm += segLen
        const seg: PipeSegmentRoute = {
          id: `PIPE_BRANCH_${segIdx++}`,
          kind: 'branch',
          start: [curX, rowY],
          end: [maxRowX, rowY],
          nominalDiameterMm: branchDiameter,
          connectedHeadIds: rowHeads.filter((h) => h.x >= curX && h.x <= maxRowX).map((h) => h.id),
          lengthM: Math.round(toMetres(segLen) * 100) / 100
        }
        segments.push(seg)
        cadOperations.push({ kind: 'line', layer: layerBranch, start: seg.start, end: seg.end })
      }
    }
  }

  const branchLengthM = Math.round(toMetres(branchTotalLengthMm) * 100) / 100
  const totalLengthM = Math.round((mainLengthM + branchLengthM) * 100) / 100

  // Check violations against excluded boundaries
  const violations: PipeRouteViolation[] = []
  if (excludedBoundaries.length > 0) {
    const ringBoxes = excludedBoundaries.map((ring) => bboxOf(ring))

    for (const seg of segments) {
      const segBox: BBox = {
        minX: Math.min(seg.start[0], seg.end[0]) - clearance,
        maxX: Math.max(seg.start[0], seg.end[0]) + clearance,
        minY: Math.min(seg.start[1], seg.end[1]) - clearance,
        maxY: Math.max(seg.start[1], seg.end[1]) + clearance
      }

      for (let ringIdx = 0; ringIdx < excludedBoundaries.length; ringIdx++) {
        const ring = excludedBoundaries[ringIdx]!
        const rBox = ringBoxes[ringIdx]
        if (!rBox || !bboxOverlap(segBox, rBox)) {
          continue
        }

        // Measure distance to ring boundary
        let minDist = Infinity
        for (let i = 0; i < ring.length; i++) {
          const edgeStart = ring[i]!
          const edgeEnd = ring[(i + 1) % ring.length]!
          const d = segmentDistance(seg.start, seg.end, edgeStart, edgeEnd)
          if (d < minDist) {
            minDist = d
          }
        }

        // Check crossing / interior containment
        const crosses =
          minDist <= 1e-9 || pointInPolygon(seg.start, ring) || pointInPolygon(seg.end, ring)
        if (crosses) {
          violations.push({
            segmentId: seg.id,
            excludedIndex: ringIdx,
            code: 'PIPE_CROSSES_EXCLUDED_ZONE',
            distanceMm: 0,
            segment: { start: seg.start, end: seg.end }
          })
        } else if (clearance > 0 && minDist <= clearance) {
          violations.push({
            segmentId: seg.id,
            excludedIndex: ringIdx,
            code: 'PIPE_CLIPS_EXCLUDED_ZONE',
            distanceMm: Math.round(toMm(minDist) * 100) / 100,
            segment: { start: seg.start, end: seg.end }
          })
        }
      }
    }
  }

  return {
    segments,
    totalLengthM,
    mainLengthM,
    branchLengthM,
    disconnectedHeads: [],
    isFullyConnected: true,
    cadOperations,
    violations,
    blocked: violations.length > 0
  }
}
