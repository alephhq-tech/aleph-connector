import type { StandardsRule } from '../schemas/standards-rule'

export interface StandardsCheckInput {
  standardId: string
  edition?: string
  clauseRef?: string
  parameter: string
  proposedValue: number
  unit: string
  conditions?: Record<string, unknown>
}

export interface StandardsCheckResult {
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
  rule?: StandardsRule
  measuredValue: number
  thresholdValue?: number
  unit: string
  message: string
}

/**
 * Demo PCCC rule set. These thresholds are transcribed from memory of TCVN 7336:2021 /
 * QCVN 06:2022-BXD and are NOT verified against a fetched authoritative source, so every rule
 * carries `evidenceStatus: 'unverified'` and `isMandatory: false`. `checkEngineeringStandard`
 * refuses to assert a normative PASS/FAIL from an unverified rule — it returns INSUFFICIENT_DATA
 * instead. Verified rules arrive only once the clause-verification pipeline (PR 5) sources them
 * from the gazette; until then this set exists to exercise the machinery, not to certify designs.
 */
export const CANONICAL_PCCC_RULES: StandardsRule[] = [
  {
    id: 'rule_tcvn7336_sprinkler_spacing_group1',
    standardId: 'TCVN 7336',
    edition: '2021',
    sourceDoc: 'TCVN 7336:2021 PCCC - Hệ thống chữa cháy tự động bằng nước',
    clauseRef: 'Bảng 1, Điều 5.2.3',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: { hazardGroup: 'Group 1' },
    requirement: {
      parameter: 'sprinkler_head_spacing_m',
      operator: '<=',
      value: 4.0,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7336_sprinkler_spacing_group2',
    standardId: 'TCVN 7336',
    edition: '2021',
    sourceDoc: 'TCVN 7336:2021 PCCC - Hệ thống chữa cháy tự động bằng nước',
    clauseRef: 'Bảng 1, Điều 5.2.3',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: { hazardGroup: 'Group 2' },
    requirement: {
      parameter: 'sprinkler_head_spacing_m',
      operator: '<=',
      value: 3.5,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7336_sprinkler_wall_clearance_max',
    standardId: 'TCVN 7336',
    edition: '2021',
    sourceDoc: 'TCVN 7336:2021 PCCC - Hệ thống chữa cháy tự động bằng nước',
    clauseRef: 'Điều 5.2.4',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: {},
    requirement: {
      parameter: 'sprinkler_wall_distance_m',
      operator: '<=',
      value: 2.0,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7336_sprinkler_wall_clearance_min',
    standardId: 'TCVN 7336',
    edition: '2021',
    sourceDoc: 'TCVN 7336:2021 PCCC - Hệ thống chữa cháy tự động bằng nước',
    clauseRef: 'Điều 5.2.4',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: {},
    requirement: {
      parameter: 'sprinkler_wall_distance_min_m',
      operator: '>=',
      value: 0.1,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  // TCVN 7568-14:2025 - Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt. Its Lời nói đầu states it
  // replaces TCVN 7568-14:2015 AND TCVN 5738:2021, so the 5738 entries at the end exist only to name
  // what a drawing may still cite, and are marked `superseded`: checkEngineeringStandard refuses a
  // normative verdict from anything that is not `verified`.
  //
  // These figures are transcribed from the standard's own text (5.7.2.1, 5.9.1.1.2, 5.9.1.1.4,
  // 5.9.2.1.2, 5.9.2.1.4) as published by VSQI, read from a hosted copy of the PDF - so they stay
  // `unverified`: they exercise the machinery, and certify nothing, until the clause-verification
  // pipeline sources each rule from a document the workspace itself holds.
  {
    id: 'rule_tcvn7568p14_smoke_detector_reach',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.9.1.1.2',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: { ceiling: 'flat' },
    requirement: {
      // "khoảng cách từ điểm bất kỳ trên trần phẳng đến đầu báo cháy gần nhất không vượt quá 7,2 m".
      // This is the coverage limit for point detectors: the 2025 text states no m2-per-detector quota.
      parameter: 'smoke_detector_reach_m',
      operator: '<=',
      value: 7.2,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7568p14_smoke_detector_spacing',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.9.1.1.2',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: { ceiling: 'flat' },
    requirement: {
      parameter: 'smoke_detector_spacing_m',
      operator: '<=',
      value: 10.2,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7568p14_smoke_detector_wall_distance',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.9.1.1.4 a)',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: {},
    requirement: {
      parameter: 'smoke_detector_wall_distance_m',
      operator: 'between',
      value: [0.5, 5.1],
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7568p14_heat_detector_reach',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.9.2.1.2',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: { ceiling: 'flat' },
    requirement: {
      // "khoảng cách từ bất cứ điểm nào trên bề mặt bằng phẳng đến đầu báo cháy gần nhất cũng không
      // được vượt quá 5,1 m"
      parameter: 'heat_detector_reach_m',
      operator: '<=',
      value: 5.1,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7568p14_heat_detector_spacing',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.9.2.1.2',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: { ceiling: 'flat' },
    requirement: {
      parameter: 'heat_detector_spacing_m',
      operator: '<=',
      value: 7.2,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7568p14_heat_detector_wall_distance',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.9.2.1.4 a)',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: {},
    requirement: {
      parameter: 'heat_detector_wall_distance_m',
      operator: 'between',
      value: [0.3, 3.6],
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7568p14_detection_zone_max_area',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.7.2.1',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: {},
    requirement: {
      parameter: 'fire_detection_zone_area_m2',
      operator: '<=',
      value: 2000,
      unit: 'm2'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  // TCVN 7568-14:2025's manual-call-point clauses, replacing the TCVN 5738:2021 pair that used to
  // sit here. 5738 was cancelled by this same standard, so no rule of it remains in the set: an
  // agent asking about a call-point height used to be handed a value from a cancelled document.
  {
    id: 'rule_tcvn7568p14_call_point_height',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.10.4',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: {},
    requirement: {
      // "chiều cao (1,4 ± 0,2) m tính từ mặt đường đi lại"
      parameter: 'manual_call_point_height_m',
      operator: 'between',
      value: [1.2, 1.6],
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  },
  {
    id: 'rule_tcvn7568p14_call_point_spacing',
    standardId: 'TCVN 7568-14',
    edition: '2025',
    sourceDoc:
      'TCVN 7568-14:2025 Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình',
    clauseRef: '5.10.3',
    jurisdiction: 'VN',
    isMandatory: false,
    conditions: {},
    requirement: {
      // "Khoảng cách giữa các hộp nút ấn báo cháy không được vượt quá 45 m"
      parameter: 'manual_call_point_spacing_m',
      operator: '<=',
      value: 45,
      unit: 'm'
    },
    provenance: 'knowledge_base',
    verificationMethod: 'geometric_measurement',
    evidenceStatus: 'unverified'
  }
]

/** A rule with conditions applies only when the caller supplies every one of them with a matching value. */
function conditionsMatch(
  ruleConditions: Record<string, unknown>,
  callerConditions?: Record<string, unknown>
): boolean {
  const keys = Object.keys(ruleConditions)
  if (keys.length === 0) return true
  if (!callerConditions) return false
  for (const key of keys) {
    if (!(key in callerConditions)) return false
    if (callerConditions[key] !== ruleConditions[key]) return false
  }
  return true
}

/** Condition keys the caller would need to disambiguate a set of candidate rules. */
function missingConditionKeys(candidates: StandardsRule[]): string[] {
  const keys = new Set<string>()
  for (const rule of candidates) for (const key of Object.keys(rule.conditions)) keys.add(key)
  return [...keys]
}

const normalizeUnit = (unit: string): string => unit.trim().toLowerCase()

/**
 * Compare a proposed value against a single standards rule.
 *
 * The rule set is injectable so the deterministic machinery (applicability, evidence gating,
 * unit validation, comparison) can be exercised against verified fixtures independently of the
 * unverified demo set. The default is the demo set, which — being unverified — can only ever
 * yield INSUFFICIENT_DATA from this function.
 */
export function checkEngineeringStandard(
  input: StandardsCheckInput,
  rules: StandardsRule[] = CANONICAL_PCCC_RULES
): StandardsCheckResult {
  const candidates = rules.filter((r) => {
    if (r.standardId !== input.standardId) return false
    if (input.edition && r.edition !== input.edition) return false
    if (input.clauseRef && r.clauseRef !== input.clauseRef) return false
    return r.requirement.parameter === input.parameter
  })

  if (candidates.length === 0) {
    return {
      status: 'INSUFFICIENT_DATA',
      measuredValue: input.proposedValue,
      unit: input.unit,
      message: `No standard rule found for ${input.standardId} ${input.parameter}${
        input.edition ? ` (edition ${input.edition})` : ''
      }. Check the edition, clause reference, and parameter name.`
    }
  }

  const applicable = candidates.filter((r) => conditionsMatch(r.conditions, input.conditions))
  if (applicable.length === 0) {
    const needed = missingConditionKeys(candidates)
    return {
      status: 'INSUFFICIENT_DATA',
      measuredValue: input.proposedValue,
      unit: input.unit,
      message: `Rules exist for ${input.standardId} ${input.parameter} but applicability cannot be resolved — supply the discriminating condition(s): ${
        needed.length ? needed.join(', ') : 'design conditions'
      }.`
    }
  }
  if (applicable.length > 1) {
    return {
      status: 'INSUFFICIENT_DATA',
      measuredValue: input.proposedValue,
      unit: input.unit,
      message: `Ambiguous: ${applicable.length} rules match ${input.standardId} ${input.parameter}. Narrow with a clause reference or conditions.`
    }
  }

  const rule = applicable[0]!

  // Evidence gate: an unverified or superseded rule can never produce a normative verdict.
  if (rule.evidenceStatus !== 'verified') {
    return {
      status: 'INSUFFICIENT_DATA',
      rule,
      measuredValue: input.proposedValue,
      unit: input.unit,
      message: `Rule ${rule.id} (${rule.standardId}:${rule.edition} ${rule.clauseRef}) is ${rule.evidenceStatus}, not verified against an authoritative source — no normative PASS/FAIL can be asserted.`
    }
  }

  // Unit validation: never compare raw numbers across incompatible units.
  if (normalizeUnit(input.unit) !== normalizeUnit(rule.requirement.unit)) {
    return {
      status: 'INSUFFICIENT_DATA',
      rule,
      measuredValue: input.proposedValue,
      unit: input.unit,
      message: `Unit mismatch: proposed value is in "${input.unit}" but ${rule.standardId} ${rule.requirement.parameter} is specified in "${rule.requirement.unit}". Convert before checking.`
    }
  }

  const threshold = typeof rule.requirement.value === 'number' ? rule.requirement.value : 0
  let pass = false

  switch (rule.requirement.operator) {
    case '<=':
      pass = input.proposedValue <= threshold
      break
    case '>=':
      pass = input.proposedValue >= threshold
      break
    case '<':
      pass = input.proposedValue < threshold
      break
    case '>':
      pass = input.proposedValue > threshold
      break
    case '==':
      pass = Math.abs(input.proposedValue - threshold) < 1e-4
      break
    case 'between': {
      const range = Array.isArray(rule.requirement.value) ? rule.requirement.value : []
      const [lo, hi] = [range[0] ?? 0, range[1] ?? 0]
      pass = input.proposedValue >= lo && input.proposedValue <= hi
      break
    }
    default:
      pass = false
  }

  return {
    status: pass ? 'PASS' : 'FAIL',
    rule,
    measuredValue: input.proposedValue,
    thresholdValue: threshold,
    unit: rule.requirement.unit,
    message: pass
      ? `PASS: ${input.parameter} ${input.proposedValue} ${input.unit} complies with ${rule.standardId}:${rule.edition} ${rule.clauseRef} (${rule.requirement.operator} ${threshold} ${rule.requirement.unit}).`
      : `FAIL: ${input.parameter} ${input.proposedValue} ${input.unit} violates ${rule.standardId}:${rule.edition} ${rule.clauseRef} (must be ${rule.requirement.operator} ${threshold} ${rule.requirement.unit}).`
  }
}
