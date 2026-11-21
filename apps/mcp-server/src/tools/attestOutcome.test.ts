import { describe, expect, test } from 'bun:test'
import type { OperationsApplyResult } from '@aleph-connector/cad-protocol'
import { attestBatchOutcome, outcomeMeta } from './attestOutcome.js'

/**
 * The CAD server's contribution to issue #388 §C: mapping the plugin's own commit truth onto
 * Aleph's outcome vocabulary. What matters here is not the happy path but that the mapping never
 * turns an unknown into a lie — a `succeeded` for a batch that did not fully commit is what makes
 * a model retry and draw the same entities twice.
 */
function result(
  fields: Partial<
    Pick<OperationsApplyResult, 'status' | 'committedBatchIds' | 'entityRefs' | 'executionId'>
  >
): Pick<OperationsApplyResult, 'status' | 'committedBatchIds' | 'entityRefs' | 'executionId'> {
  return {
    status: 'committed',
    committedBatchIds: [],
    entityRefs: [],
    ...fields
  } as Pick<OperationsApplyResult, 'status' | 'committedBatchIds' | 'entityRefs' | 'executionId'>
}

describe('attestBatchOutcome', () => {
  test('a fully committed batch carries its native batch ids and execution id', () => {
    const claim = attestBatchOutcome(
      result({
        status: 'committed',
        committedBatchIds: ['b_1'],
        entityRefs: [{ handle: '1A', type: 'LINE' } as never],
        executionId: 'exec_9'
      })
    )
    expect(claim.outcomeState).toBe('succeeded')
    expect(claim.commitReceipt).toEqual({
      executionId: 'exec_9',
      commitIds: ['b_1'],
      entityCount: 1
    })
  })

  test('a wave that died after an earlier commit is a partial commit, not a failure', () => {
    const claim = attestBatchOutcome(
      result({ status: 'partial', committedBatchIds: ['b_1'], executionId: 'exec_9' })
    )
    expect(claim.outcomeState).toBe('partial_commit')
    expect(claim.commitReceipt?.commitIds).toEqual(['b_1'])
  })

  test('a transport loss with nothing confirmed keeps the batch ids only as a lead', () => {
    // `executionId` is the plugin's idempotency key, so a reconciliation can re-send the batch and
    // get the original result instead of a second draw. `commitIds` are leads here, not proof —
    // which is why the state stays indeterminate rather than becoming `partial_commit`.
    const claim = attestBatchOutcome(
      result({ status: 'outcome_unknown', committedBatchIds: ['b_1'], executionId: 'exec_9' })
    )
    expect(claim.outcomeState).toBe('outcome_unknown')
    expect(claim.commitReceipt?.executionId).toBe('exec_9')
  })

  test('a revalidation refusal with prior commits is still a partial write', () => {
    const withCommits = attestBatchOutcome(
      result({ status: 'requires_revalidation', committedBatchIds: ['b_1'] })
    )
    expect(withCommits.outcomeState).toBe('partial_commit')
    const withoutCommits = attestBatchOutcome(result({ status: 'requires_revalidation' }))
    expect(withoutCommits.outcomeState).toBe('failed')
    expect(withoutCommits.commitReceipt).toBeUndefined()
  })

  test('an unrecognised status fails closed', () => {
    const claim = attestBatchOutcome(
      result({ status: 'some_future_status' as OperationsApplyResult['status'] })
    )
    expect(claim.outcomeState).toBe('failed')
    expect(claim.commitReceipt).toBeUndefined()
  })

  test('attested commit ids are bounded', () => {
    // A huge multi-wave batch must not turn the ledger's evidence column into a copy of its
    // internals; the ids are a reconciliation reference, not a payload.
    const claim = attestBatchOutcome(
      result({
        status: 'partial',
        committedBatchIds: Array.from({ length: 200 }, (_, i) => `b_${i}`)
      })
    )
    expect(claim.commitReceipt?.commitIds?.length).toBe(32)
  })
})

describe('outcomeMeta', () => {
  test('omits the evidence key when there is none', () => {
    expect(outcomeMeta({ outcomeState: 'failed' })).toEqual({ 'aleph.io/outcome': 'failed' })
  })

  test('carries state and evidence side by side', () => {
    expect(
      outcomeMeta({ outcomeState: 'cancelled', commitReceipt: { commitIds: ['b_1'] } })
    ).toEqual({
      'aleph.io/outcome': 'cancelled',
      'aleph.io/commit': { commitIds: ['b_1'] }
    })
  })
})
