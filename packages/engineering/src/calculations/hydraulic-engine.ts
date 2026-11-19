import {
  HydraulicSystemSchema,
  HydraulicResultSchema,
  type HydraulicSystem,
  type HydraulicResult
} from '../schemas/hydraulic-system'

/**
 * Metric Hazen-Williams equation for pipe friction pressure loss (bar):
 *
 *   ΔP (bar) = 6.05e5 * (Q ^ 1.85) / (C ^ 1.85 * d ^ 4.87) * L
 *
 * where:
 *   Q: flow in L/min
 *   C: Hazen-Williams roughness coefficient (e.g. 120 for carbon steel)
 *   d: internal pipe diameter in mm
 *   L: equivalent length of pipe in meters (pipe length + fittings)
 */
export function calculateHazenWilliamsLossBar(
  flowLpm: number,
  internalDiamMm: number,
  lengthM: number,
  cFactor = 120
): number {
  if (flowLpm <= 0 || lengthM <= 0) return 0
  if (internalDiamMm <= 0 || cFactor <= 0) {
    throw new Error(`Invalid hydraulic parameters: d=${internalDiamMm}mm, C=${cFactor}`)
  }

  const numerator = 6.05e5 * Math.pow(flowLpm, 1.85)
  const denominator = Math.pow(cFactor, 1.85) * Math.pow(internalDiamMm, 4.87)
  const lossPerMeter = numerator / denominator
  return Math.round(lossPerMeter * lengthM * 10000) / 10000
}

/**
 * Calculates static elevation pressure change (bar):
 * ΔP_elev = ρ * g * Δh * 1e-5 ≈ 0.0981 * Δh (meters)
 * Positive Δh means flowing uphill (pressure drop).
 */
export function calculateElevationLossBar(elevationDeltaM: number): number {
  return Math.round(0.0980665 * elevationDeltaM * 10000) / 10000
}

/**
 * Deterministic Hydraulic Network Solver for Fire Sprinkler Piping.
 * Traverses pipe tree from most remote demand heads back to water supply source.
 */
export function solveHydraulicSystem(systemInput: HydraulicSystem): HydraulicResult {
  const system = HydraulicSystemSchema.parse(systemInput)

  const nodePressuresBar: Record<string, number> = {}
  const segmentFlowsLpm: Record<string, number> = {}
  const segmentHeadLossesBar: Record<string, number> = {}

  // Build adjacency map
  const segmentMap = new Map(system.segments.map((s) => [s.id, s]))
  const incoming = new Map<string, string[]>() // toNode -> segmentIds
  const outgoing = new Map<string, string[]>() // fromNode -> segmentIds

  for (const s of system.segments) {
    if (!outgoing.has(s.fromNode)) outgoing.set(s.fromNode, [])
    outgoing.get(s.fromNode)!.push(s.id)

    if (!incoming.has(s.toNode)) incoming.set(s.toNode, [])
    incoming.get(s.toNode)!.push(s.id)
  }

  // 1. Calculate cumulative flow for each segment
  // Find leaf/demand nodes and propagate flow backward to source
  let totalDemandFlowLpm = 0
  const nodeDemandFlow = new Map<string, number>()

  for (const d of system.demandNodes) {
    nodeDemandFlow.set(d.id, d.requiredFlowLpm)
    totalDemandFlowLpm += d.requiredFlowLpm
  }

  // Determine flow through each segment by backwards topological traversal
  function getSubtreeFlow(nodeId: string, visited = new Set<string>()): number {
    if (visited.has(nodeId)) {
      throw new Error(`Cycle detected in pipe network at node "${nodeId}"`)
    }
    visited.add(nodeId)

    let flow = nodeDemandFlow.get(nodeId) ?? 0
    const outSegs = outgoing.get(nodeId) ?? []

    for (const segId of outSegs) {
      const seg = segmentMap.get(segId)!
      const branchFlow = getSubtreeFlow(seg.toNode, new Set(visited))
      segmentFlowsLpm[seg.id] = Math.round(branchFlow * 100) / 100
      flow += branchFlow
    }

    return flow
  }

  getSubtreeFlow(system.sourceNodeId)

  // 2. Compute friction and elevation head loss for each segment
  for (const seg of system.segments) {
    const flow = segmentFlowsLpm[seg.id] ?? 0
    const eqLength = seg.lengthM + (seg.fittingsEquivalentLengthM ?? 0)
    const frictionLoss = calculateHazenWilliamsLossBar(
      flow,
      seg.internalDiameterMm,
      eqLength,
      seg.roughnessC
    )
    const elevLoss = calculateElevationLossBar(seg.elevationChangeM ?? 0)
    const totalSegLoss = Math.round((frictionLoss + elevLoss) * 10000) / 10000
    segmentHeadLossesBar[seg.id] = totalSegLoss
  }

  // 3. Find most remote demand head and calculate pressure requirements
  let maxRequiredSourcePressure = 0
  let mostRemoteNodeId = system.demandNodes[0]!.id

  for (const d of system.demandNodes) {
    // Trace path from source to demand node d
    const pathSegments: string[] = []
    let curr = d.id
    const visited = new Set<string>()

    while (curr !== system.sourceNodeId) {
      if (visited.has(curr)) break
      visited.add(curr)
      const inSegs = incoming.get(curr) ?? []
      if (inSegs.length === 0) {
        throw new Error(`Demand node "${d.id}" is disconnected from source "${system.sourceNodeId}"`)
      }
      const segId = inSegs[0]!
      pathSegments.push(segId)
      curr = segmentMap.get(segId)!.fromNode
    }

    let accumulatedLossBar = 0
    for (const segId of pathSegments) {
      accumulatedLossBar += segmentHeadLossesBar[segId] ?? 0
    }

    const requiredAtSourceForHead = d.minPressureBar + accumulatedLossBar
    if (requiredAtSourceForHead > maxRequiredSourcePressure) {
      maxRequiredSourcePressure = requiredAtSourceForHead
      mostRemoteNodeId = d.id
    }
  }

  const requiredSourcePressureBar = Math.round(maxRequiredSourcePressure * 1000) / 1000

  // 4. Calculate forward pressures at each node
  nodePressuresBar[system.sourceNodeId] = requiredSourcePressureBar

  function propagatePressureForward(nodeId: string, currentPressure: number, visited = new Set<string>()) {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    nodePressuresBar[nodeId] = Math.round(currentPressure * 1000) / 1000

    const outSegs = outgoing.get(nodeId) ?? []
    for (const segId of outSegs) {
      const seg = segmentMap.get(segId)!
      const loss = segmentHeadLossesBar[seg.id] ?? 0
      const nextPressure = Math.max(0, currentPressure - loss)
      propagatePressureForward(seg.toNode, nextPressure, new Set(visited))
    }
  }

  propagatePressureForward(system.sourceNodeId, requiredSourcePressureBar)

  const isPressureAdequate =
    system.availableSourcePressureBar !== undefined
      ? system.availableSourcePressureBar >= requiredSourcePressureBar
      : true

  return HydraulicResultSchema.parse({
    totalDemandFlowLpm: Math.round(totalDemandFlowLpm * 100) / 100,
    requiredSourcePressureBar,
    availableSourcePressureBar: system.availableSourcePressureBar,
    isPressureAdequate,
    nodePressuresBar,
    segmentFlowsLpm,
    segmentHeadLossesBar,
    mostRemoteNodeId,
    calculationMethod: 'Hazen-Williams',
    calculatedAt: Date.now()
  })
}
