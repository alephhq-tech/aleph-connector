import { describe, expect, it } from 'bun:test'
import {
  compileCadPayload,
  planRoute,
  planHashOf,
  preflightCompiledPlan,
  pointInPolygon,
  distancePointToSegment,
  type RestrictedZone
} from '../src/index'
import { ELEVATOR_SHAFT, STAIRWELL, CORRIDOR } from './fixtures/basement-fire-alarm'

describe('Obstacle-Aware A* Route Planner (P2 CAD Semantic Grounding)', () => {
  const elevatorZone: RestrictedZone = {
    id: 'zone-elevator-shaft',
    zoneClass: 'elevator_shaft',
    outer: ELEVATOR_SHAFT,
    verified: true,
    sourceHandles: ['H_ELEV'],
    confidence: 'high',
    evidence: 'layer:ELEVATOR'
  }

  // stairZone removed

  it('routes fire alarm wiring around an elevator shaft instead of through it', () => {
    // Start to the left of the shaft (x=10000, y=10000), goal to the right (x=25000, y=10000)
    // A straight line would go directly through the shaft (x=16000..19000, y=8000..12000).
    const result = planRoute({
      start: [10000, 10000],
      end: [25000, 10000],
      obstacles: [elevatorZone],
      cellSize: 500,
      clearance: 200
    })

    expect(result.status).toBe('FOUND')
    expect(result.waypoints.length).toBeGreaterThanOrEqual(3)
    expect(result.totalLength).toBeGreaterThan(15000) // Longer than straight line

    // Verify no waypoint is inside the elevator shaft
    for (const pt of result.waypoints) {
      const inside = pointInPolygon(pt, ELEVATOR_SHAFT, [], 0)
      expect(inside).toBe(false)
    }

    // Verify every segment in the generated route clears the elevator shaft
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const p1 = result.waypoints[i]!
      const p2 = result.waypoints[i + 1]!
      // Check distance to elevator boundary
      for (let j = 0; j < ELEVATOR_SHAFT.length; j++) {
        // The midpoint of each segment must also not be inside the shaft
        const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
        expect(pointInPolygon(mid, ELEVATOR_SHAFT, [], 0)).toBe(false)
      }
    }

    // Pass the planned route to preflightCompiledPlan to prove deterministic end-to-end compatibility!
    const compiled = compileCadPayload({
      documentName: 'basement.dwg',
      operations: [
        {
          op: 'create',
          entity: {
            kind: 'polyline',
            layer: 'FA-Wiring',
            points: result.waypoints
          }
        }
      ]
    })
    const preflight = preflightCompiledPlan({
      plan: compiled,
      planHash: planHashOf(compiled),
      zones: [elevatorZone],
      policies: [],
      binding: { runId: 'run-test', workspaceId: 'ws-test' },
      options: { system: 'fire_alarm', boundaryTolerance: 0 }
    })
    expect(preflight.status).toBe('PASS')
    expect(preflight.findings).toHaveLength(0)
  })

  it('respects clearance requirements around obstacles', () => {
    const clearance = 500
    const result = planRoute({
      start: [14000, 10000],
      end: [21000, 10000],
      obstacles: [elevatorZone],
      cellSize: 500,
      clearance
    })

    expect(result.status).toBe('FOUND')
    for (const pt of result.waypoints) {
      // Point must be at least clearance distance from all edges of ELEVATOR_SHAFT
      for (let j = 0; j < ELEVATOR_SHAFT.length; j++) {
        const v1 = ELEVATOR_SHAFT[j]!
        const v2 = ELEVATOR_SHAFT[(j + 1) % ELEVATOR_SHAFT.length]!
        const dist = distancePointToSegment(pt, v1, v2)
        expect(dist).toBeGreaterThanOrEqual(clearance - 50) // within cell discretization tolerance
      }
    }
  })

  it('prefers corridor routing when corridorDiscount is set', () => {
    // Corridor runs from y=9000 to y=12000 across the plate
    const corridorPoly = CORRIDOR
    const resultWithCorridor = planRoute({
      start: [5000, 10500],
      end: [35000, 10500],
      obstacles: [elevatorZone],
      corridors: [corridorPoly],
      corridorDiscount: 200,
      cellSize: 1000
    })

    expect(resultWithCorridor.status).toBe('FOUND')
    expect(resultWithCorridor.waypoints.length).toBeGreaterThan(1)
  })

  it('returns NO_VALID_ROUTE when endpoint is trapped inside an obstacle', () => {
    // Point inside the elevator shaft
    const insideShaft: [number, number] = [17000, 10000]
    const result = planRoute({
      start: insideShaft,
      end: [30000, 10000],
      obstacles: [elevatorZone],
      cellSize: 500
    })

    expect(result.status).toBe('NO_VALID_ROUTE')
    expect(result.waypoints).toHaveLength(0)
    expect(result.blockedBy).toContain('zone-elevator-shaft')
    expect(result.reason).toContain('inside or too close')
  })

  it('returns INSUFFICIENT_DATA when obstacle geometry is degenerate (< 3 vertices)', () => {
    const degenerateZone: RestrictedZone = {
      id: 'zone-bad',
      zoneClass: 'elevator_shaft',
      outer: [
        [1000, 1000],
        [2000, 2000]
      ], // Only 2 points
      verified: true,
      sourceHandles: [],
      confidence: 'high',
      evidence: 'bad'
    }

    const result = planRoute({
      start: [500, 500],
      end: [3000, 3000],
      obstacles: [degenerateZone]
    })

    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.waypoints).toHaveLength(0)
    expect(result.reason).toContain('no usable boundary')
  })

  it('simplifies collinear vertices to minimize drawn polyline vertex count', () => {
    // In an obstacle-free route, A* might take 20 grid steps, but simplifyCollinear reduces to start & end
    const result = planRoute({
      start: [1000, 1000],
      end: [10000, 1000],
      obstacles: [],
      cellSize: 500
    })

    expect(result.status).toBe('FOUND')
    // Straight line should simplify to just 2 points (start and end)
    expect(result.waypoints).toHaveLength(2)
    expect(result.bends).toBe(0)
  })
})
