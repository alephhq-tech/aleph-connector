export type ToolExecutionOutcomeState =
  | 'succeeded'
  | 'failed'
  | 'partial_commit'
  | 'outcome_unknown'
  | 'blocked'
  | 'cancelled'

export interface ToolCommitReceipt {
  executionId?: string
  commitIds?: string[]
  entityCount?: number
  visualEvidence?: 'captured' | 'unavailable'
}

export const OUTCOME_META_KEY = 'arcdio.io/outcome'
export const OPERATION_META_KEY = 'arcdio.io/operation'
export const COMMIT_EVIDENCE_META_KEY = 'arcdio.io/commit'
