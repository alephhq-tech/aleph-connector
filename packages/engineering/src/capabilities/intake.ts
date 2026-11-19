import { DesignBasisSchema, type DesignBasis } from '../schemas/design-basis'

export interface IntakeValidationInput {
  discipline: string
  projectRef: string
  drawingRef?: string
  designScope: string
  buildingUsage?: string
  hazardClassification?: string
  knownInputs?: Record<string, unknown>
  assumptions?: string[]
  units?: {
    length?: 'mm' | 'm'
    area?: 'm2'
    flow?: 'L/s' | 'L/min'
    pressure?: 'bar' | 'MPa' | 'kPa'
  }
}

export function validateEngineeringIntake(raw: IntakeValidationInput): {
  success: boolean
  basis?: DesignBasis
  missingCriticalInputs: string[]
  approvalStatus: 'ready_for_planning' | 'needs_input'
  error?: string
} {
  const missingCriticalInputs: string[] = []

  // Check discipline-specific safety critical parameters
  if (raw.discipline === 'pccc') {
    if (!raw.hazardClassification && !raw.buildingUsage) {
      missingCriticalInputs.push('hazardClassification or buildingUsage (TCVN 7336 / QCVN 06)')
    }
  }

  const approvalStatus = missingCriticalInputs.length > 0 ? 'needs_input' : 'ready_for_planning'

  const parseResult = DesignBasisSchema.safeParse({
    id: `db_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    discipline: raw.discipline,
    projectRef: raw.projectRef,
    drawingRef: raw.drawingRef,
    designScope: raw.designScope,
    buildingUsage: raw.buildingUsage,
    hazardClassification: raw.hazardClassification,
    knownInputs: raw.knownInputs ?? {},
    missingInputs: missingCriticalInputs.map((field) => ({
      field,
      description: `Missing safety-critical input: ${field}`,
      safetyCritical: true
    })),
    assumptions: raw.assumptions ?? [],
    units: raw.units,
    approvalStatus
  })

  if (!parseResult.success) {
    return {
      success: false,
      missingCriticalInputs,
      approvalStatus: 'needs_input',
      error: parseResult.error.message
    }
  }

  return {
    success: true,
    basis: parseResult.data,
    missingCriticalInputs,
    approvalStatus
  }
}
