import {
  COMMIT_EVIDENCE_META_KEY,
  OUTCOME_META_KEY,
  type ToolCommitReceipt,
  type ToolExecutionOutcomeState
} from '@arcdio/operation-protocol'
import type { OperationsApplyResult } from '@arcdio/cad-protocol'

/**
 * Server-side attestation of what a batch mutation ACTUALLY did (issue #388 §C).
 *
 * The AutoCAD plugin already reports commit truth: `operations.apply` answers with a `status` plus
 * the `committedBatchIds` its transactions really committed, and `applyOperationsBatch` folds
 * multi-wave execution into one honest verdict (a wave that failed after an earlier commit becomes
 * `partial`; a transport loss with nothing committed becomes `outcome_unknown`). Until now Cloud's
 * tool layer flattened all of that into success/failure for the model — which is exactly how a
 * retry after a timeout ends up drawing the same entities twice, because nothing downstream could
 * tell "definitely not applied" from "applied, then the connection died".
 *
 * This maps that domain truth onto Aleph's single outcome vocabulary and carries it out-of-band in
 * the MCP result's `_meta`, where `McpCapabilityProvider` reads it into the operation ledger.
 * Out-of-band matters: the model still reads the same JSON payload it always did, while the ledger
 * is fed a server-side claim the model cannot forge — an `outcomeState` the model wrote into tool
 * arguments would be self-reporting, which §C forbids.
 *
 * The mapping fails closed: an unrecognised `status` is `failed`, never `succeeded`.
 */

/** Upper bound on committed batch ids carried in the attestation: enough to reconcile against,
 * never an unbounded copy of a huge batch's internals. */
const MAX_ATTESTED_COMMIT_IDS = 32

export interface BatchOutcomeClaim {
  outcomeState: ToolExecutionOutcomeState
  commitReceipt?: ToolCommitReceipt
}

type NativeBatchResult = Pick<
  OperationsApplyResult,
  'status' | 'committedBatchIds' | 'entityRefs' | 'executionId'
>

export function attestBatchOutcome(result: NativeBatchResult): BatchOutcomeClaim {
  const commitIds = (result.committedBatchIds ?? []).slice(0, MAX_ATTESTED_COMMIT_IDS)
  const committed = commitIds.length > 0
  const evidence: ToolCommitReceipt = {
    // The source system's own idempotency key for this batch (#9): re-sending it makes the plugin
    // return the original result instead of drawing twice, so a reconciliation has something it
    // can replay safely.
    ...(result.executionId && { executionId: result.executionId }),
    ...(committed && { commitIds }),
    entityCount: result.entityRefs?.length ?? 0
  }
  switch (result.status) {
    case 'committed':
      return { outcomeState: 'succeeded', commitReceipt: evidence }
    case 'partial':
      return { outcomeState: 'partial_commit', commitReceipt: evidence }
    case 'outcome_unknown':
      // Nothing is confirmed written; the ids are kept only as a reconciliation lead.
      return { outcomeState: 'outcome_unknown', commitReceipt: evidence }
    case 'cancelled':
      return { outcomeState: 'cancelled', commitReceipt: committed ? evidence : undefined }
    case 'requires_revalidation':
      // The document changed under the batch. With prior commits that IS a partial write;
      // without any, nothing landed.
      return {
        outcomeState: committed ? 'partial_commit' : 'failed',
        commitReceipt: committed ? evidence : undefined
      }
    default:
      // aborted | failed | busy | any future status: no confirmed commit, treated as failed.
      return { outcomeState: 'failed', commitReceipt: committed ? evidence : undefined }
  }
}

/** The `_meta` fragment a batch-producing tool attaches to its MCP result. */
export function outcomeMeta(claim: BatchOutcomeClaim): Record<string, unknown> {
  return {
    [OUTCOME_META_KEY]: claim.outcomeState,
    ...(claim.commitReceipt && { [COMMIT_EVIDENCE_META_KEY]: claim.commitReceipt })
  }
}
