import type { Point2D } from '../src/schemas/semantic-model'
import { describe, expect, it } from 'bun:test'
import {
  calculateHazenWilliamsLossBar,
  calculateElevationLossBar,
  solveHydraulicSystem,
  verifyEngineeringDesign,
  generateSprinklerLayout,
  routeSprinklerPipes,
  type HydraulicSystem,
  type StandardsRule
} from '../src/index'

describe('Deterministic Hydraulic Calculation Engine', () => {
  it('calculates friction pressure loss using Hazen-Williams equation accurately', () => {
    // Flow 200 L/min through 50mm internal diam steel pipe (C=120), 10 meters long
    const lossBar = calculateHazenWilliamsLossBar(200, 50, 10, 120)
    expect(lossBar).toBeGreaterThan(0)
    expect(lossBar).toBeLessThan(0.1) // Typical small friction loss for 10m DN50
  })

  it('returns 0 loss for zero flow or zero length', () => {
    expect(calculateHazenWilliamsLossBar(0, 50, 10)).toBe(0)
    expect(calculateHazenWilliamsLossBar(200, 50, 0)).toBe(0)
  })

  it('calculates static elevation pressure change', () => {
    // 10 meters upward elevation delta = ~0.98 bar drop
    const elevLoss = calculateElevationLossBar(10)
    expect(elevLoss).toBeCloseTo(0.981, 2)
  })

  it('solves multi-segment pipe network and detects adequate vs inadequate source pressure', () => {
    const testSystem: HydraulicSystem = {
      systemId: 'SYS_01',
      sourceNodeId: 'RISER',
      availableSourcePressureBar: 3.0, // 3 bar available
      segments: [
        {
          id: 'SEG_MAIN',
          fromNode: 'RISER',
          toNode: 'JUNCTION_1',
          lengthM: 20,
          nominalDiameterMm: 80,
          internalDiameterMm: 80.8,
          roughnessC: 120,
          fittingsEquivalentLengthM: 5,
          elevationChangeM: 3 // 3m upward
        },
        {
          id: 'SEG_BRANCH_1',
          fromNode: 'JUNCTION_1',
          toNode: 'SPK_01',
          lengthM: 10,
          nominalDiameterMm: 50,
          internalDiameterMm: 53.0,
          roughnessC: 120,
          fittingsEquivalentLengthM: 2,
          elevationChangeM: 0
        }
      ],
      demandNodes: [
        {
          id: 'SPK_01',
          requiredFlowLpm: 120,
          minPressureBar: 0.5
        }
      ]
    }

    const result = solveHydraulicSystem(testSystem)
    expect(result.totalDemandFlowLpm).toBe(120)
    expect(result.requiredSourcePressureBar).toBeGreaterThan(0.5)
    expect(result.isPressureAdequate).toBe(true)
    expect(result.nodePressuresBar['SPK_01']).toBeCloseTo(0.5, 1)

    // Now test with inadequate available pressure (e.g. 0.4 bar)
    const inadequateSystem = { ...testSystem, availableSourcePressureBar: 0.4 }
    const resultInadequate = solveHydraulicSystem(inadequateSystem)
    expect(resultInadequate.isPressureAdequate).toBe(false)
  })

  it('detects cycles and disconnected nodes cleanly', () => {
    const cyclicSystem: HydraulicSystem = {
      systemId: 'SYS_CYCLE',
      sourceNodeId: 'N1',
      segments: [
        {
          id: 'S1',
          fromNode: 'N1',
          toNode: 'N2',
          lengthM: 5,
          nominalDiameterMm: 50,
          internalDiameterMm: 50,
          roughnessC: 120,
          elevationChangeM: 0,
          fittingsEquivalentLengthM: 0
        },
        {
          id: 'S2',
          fromNode: 'N2',
          toNode: 'N1',
          lengthM: 5,
          nominalDiameterMm: 50,
          internalDiameterMm: 50,
          roughnessC: 120,
          elevationChangeM: 0,
          fittingsEquivalentLengthM: 0
        }
      ],
      demandNodes: [{ id: 'N2', requiredFlowLpm: 60, minPressureBar: 0.5 }]
    }

    expect(() => solveHydraulicSystem(cyclicSystem)).toThrow(/Cycle detected/)
  })
})

describe('Engineering Design Verification Engine', () => {
  const roomBoundary = [
    [0, 0],
    [20000, 0],
    [20000, 10000],
    [0, 10000]
  ] as const

  /** A standards rule actually marked verified — the only way `CHK_SPRINKLER_SPACING` can ever
   * reach PASS/FAIL instead of INSUFFICIENT_DATA. Mirrors `CANONICAL_PCCC_RULES`'s Group 2 entry
   * except for `evidenceStatus`. */
  const verifiedSpacingRule: StandardsRule = {
    id: 'rule_test_verified_spacing_group2',
    standardId: 'TCVN 7336',
    edition: '2021',
    sourceDoc: 'TCVN 7336:2021 (test fixture, treated as verified for this test only)',
    clauseRef: 'Bảng 1, Điều 5.2.3',
    jurisdiction: 'VN',
    isMandatory: true,
    conditions: { hazardGroup: 'Group 2' },
    requirement: { parameter: 'sprinkler_head_spacing_m', operator: '<=', value: 3.5, unit: 'm' },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'verified'
  }

  // aleph-platform#279 Part A: geometry satisfying a demo threshold is not the same claim as
  // "complies with a cited standard" — without a verified rule, neither PASS nor FAIL can be
  // asserted, because the threshold itself is unverified (an unverified "FAIL" is just as false
  // a certainty as an unverified "PASS"). This replaces the old test of the same shape, which
  // expected a false PASS from exactly the unverified-rule/no-hydraulic-evidence combination the
  // issue's regression example calls out.
  it('never claims normative PASS or FAIL from the unverified demo rule set, however clean the geometry', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary: roomBoundary as never,
      hazardGroup: 'Group 2'
    })
    const route = routeSprinklerPipes({ insUnits: 'mm',  heads: layout.heads, riserLocation: [0, 5000] })

    const report = verifyEngineeringDesign({
      targetDocument: 'test_plan.dwg',
      sprinklerLayout: layout,
      pipeRoute: route,
      riserLocation: [0, 5000],
      availableWaterPressureBar: 5.0
      // No hydraulicResult, no verified standardsRules — exactly the minimal deterministic
      // regression example from aleph-platform#279.
    })

    expect(report.overallStatus).toBe('INSUFFICIENT_DATA')
    expect(report.summary.failCount).toBe(0)
    expect(report.findings.find((f) => f.checkId === 'CHK_SPRINKLER_SPACING')?.status).toBe(
      'INSUFFICIENT_DATA'
    )
    expect(report.findings.find((f) => f.checkId === 'CHK_HYDRAULIC_PRESSURE')?.status).toBe(
      'INSUFFICIENT_DATA'
    )
    // Connectivity is a structural fact, not a numeric-threshold claim, so it's independently
    // verifiable and genuinely PASSes here — this is not held back by the unverified rule set.
    expect(report.findings.find((f) => f.checkId === 'CHK_PIPE_CONNECTIVITY')?.status).toBe('PASS')
  })

  it('PASSes the spacing check once a genuinely verified rule backs it, with compliant geometry', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary: roomBoundary as never,
      hazardGroup: 'Group 2'
    })

    const report = verifyEngineeringDesign({
      sprinklerLayout: layout,
      standardsRules: [verifiedSpacingRule]
    })

    const finding = report.findings.find((f) => f.checkId === 'CHK_SPRINKLER_SPACING')
    expect(finding?.status).toBe('PASS')
    expect(finding?.thresholdValue).toBe(3.5)
  })

  it('FAILs the spacing check against a verified rule when the measured spacing truly violates it', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary: roomBoundary as never,
      hazardGroup: 'Group 2'
    })
    // A verified rule tighter than what this geometry actually achieves.
    const tighterRule: StandardsRule = {
      ...verifiedSpacingRule,
      requirement: { ...verifiedSpacingRule.requirement, value: 0.5 }
    }

    const report = verifyEngineeringDesign({
      sprinklerLayout: layout,
      standardsRules: [tighterRule]
    })

    expect(report.overallStatus).toBe('FAIL')
    const finding = report.findings.find((f) => f.checkId === 'CHK_SPRINKLER_SPACING')
    expect(finding?.status).toBe('FAIL')
  })

  it('aleph-platform#279 regression: a bar number with no hydraulic calculation is INSUFFICIENT_DATA, never a silent PASS', () => {
    // Before the fix, supplying availableWaterPressureBar with no hydraulicResult skipped the
    // CHK_HYDRAULIC_PRESSURE finding entirely, so overallStatus could read PASS with the
    // network's actual demand/pressure never computed.
    const report = verifyEngineeringDesign({
      availableWaterPressureBar: 5.0
    })

    const finding = report.findings.find((f) => f.checkId === 'CHK_HYDRAULIC_PRESSURE')
    expect(finding).toBeDefined()
    expect(finding?.status).toBe('INSUFFICIENT_DATA')
    expect(report.overallStatus).toBe('INSUFFICIENT_DATA')
  })

  it('returns INSUFFICIENT_DATA when water supply pressure is missing', () => {
    const report = verifyEngineeringDesign({
      hydraulicResult: {
        totalDemandFlowLpm: 240,
        requiredSourcePressureBar: 2.8,
        isPressureAdequate: true,
        nodePressuresBar: {},
        segmentFlowsLpm: {},
        segmentHeadLossesBar: {},
        mostRemoteNodeId: 'SPK_01',
        calculationMethod: 'Hazen-Williams',
        calculatedAt: Date.now()
        // availableSourcePressureBar is undefined!
      }
    })

    expect(report.overallStatus).toBe('INSUFFICIENT_DATA')
    const hydroFinding = report.findings.find((f) => f.checkId === 'CHK_HYDRAULIC_PRESSURE')
    expect(hydroFinding?.status).toBe('INSUFFICIENT_DATA')
  })

  it('aleph-platform#279 regression: forged connectivity flags with zero segments can never reach overall PASS', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary: roomBoundary as never,
      hazardGroup: 'Group 2'
    })
    const forgedRoute = {
      segments: [],
      totalLengthM: 0,
      mainLengthM: 0,
      branchLengthM: 0,
      disconnectedHeads: [], // forged: claims nothing is disconnected
      isFullyConnected: true, // forged: claims fully connected with zero segments
      cadOperations: [],
      violations: [],
      blocked: false
    }

    const report = verifyEngineeringDesign({
      sprinklerLayout: layout,
      pipeRoute: forgedRoute,
      riserLocation: [0, 5000]
    })

    expect(report.overallStatus).toBe('FAIL')
    const connFinding = report.findings.find((f) => f.checkId === 'CHK_PIPE_CONNECTIVITY')
    expect(connFinding?.status).toBe('FAIL')
    // report §5 item 6: a routing FAIL must say the measurement came from the router's segments, so
    // the model fixes the pipe run instead of nudging head coordinates until the check goes quiet.
    expect(connFinding?.source).toBe('router_geometry')
  })

  it('CHK_PIPE_CONNECTIVITY is INSUFFICIENT_DATA, not a trusted PASS, when no riserLocation is given', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary: roomBoundary as never,
      hazardGroup: 'Group 2'
    })
    const route = routeSprinklerPipes({ insUnits: 'mm',  heads: layout.heads, riserLocation: [0, 5000] })

    const report = verifyEngineeringDesign({
      sprinklerLayout: layout,
      pipeRoute: route
      // riserLocation omitted — the router's own `isFullyConnected: true` must not be trusted.
    })

    const connFinding = report.findings.find((f) => f.checkId === 'CHK_PIPE_CONNECTIVITY')
    expect(connFinding?.status).toBe('INSUFFICIENT_DATA')
  })

  it('CHK_PIPE_EXCLUDED_ZONES fails when pipe route has violations, and returns INSUFFICIENT_DATA when violation data is missing', () => {
    const layout = generateSprinklerLayout({ insUnits: 'mm',
      roomBoundary: roomBoundary as never,
      hazardGroup: 'Group 2'
    })

    const excluded = [
      [
        [-1000, 2000],
        [1000, 2000],
        [1000, 3000],
        [-1000, 3000]
      ]
    ] as Point2D[][]

    // 1. Pipe route with violations -> FAIL
    const routeWithViolations = routeSprinklerPipes({ insUnits: 'mm',
      heads: layout.heads,
      riserLocation: [0, 5000],
      excludedBoundaries: excluded
    })

    const failReport = verifyEngineeringDesign({
      sprinklerLayout: layout,
      pipeRoute: routeWithViolations,
      riserLocation: [0, 5000],
      excludedBoundaries: excluded
    })

    const failFinding = failReport.findings.find((f) => f.checkId === 'CHK_PIPE_EXCLUDED_ZONES')
    expect(failFinding?.status).toBe('FAIL')
    expect(failReport.overallStatus).toBe('FAIL')

    // 2. Exclusions supplied, but route without violations array -> INSUFFICIENT_DATA (never false PASS)
    const routeMissingData = {
      ...routeWithViolations,
      violations: undefined as never
    }

    const noDataReport = verifyEngineeringDesign({
      sprinklerLayout: layout,
      pipeRoute: routeMissingData,
      riserLocation: [0, 5000],
      excludedBoundaries: excluded
    })

    const noDataFinding = noDataReport.findings.find((f) => f.checkId === 'CHK_PIPE_EXCLUDED_ZONES')
    expect(noDataFinding?.status).toBe('INSUFFICIENT_DATA')
  })
})
