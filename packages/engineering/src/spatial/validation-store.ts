import {
  DEFAULT_CLAIM_STALE_MS,
  checkRecord,
  issueValidationRecord,
  type IssueRecordInput,
  type RecordBindingCheck,
  type RecordRejection,
  type SpatialValidationRecord,
  type ValidationRecordState
} from './validation-record'

/**
 * The server-side ledger of issued validation records.
 *
 * This is what makes a PASS non-forgeable: a record only ever exists because the server computed it
 * while running the constraint engine, and the guard looks it up here rather than reading anything
 * the caller sent. A caller that wants a different verdict has to change the geometry, not the JSON.
 *
 * In-memory and run-scoped by design. A record is a claim about a drawing state that AutoCAD can
 * invalidate at any moment (the `documentRevision` binding), so persisting it across processes would
 * imply a durability the claim itself does not have. Re-validating after a restart costs one
 * `spatial_validate_layout` call; trusting a stale record costs a wrong building.
 *
 * Single-use is enforced by `claim`, which is synchronous: JS has no preemption inside it, so the
 * "check then mark" window that let two racing dispatches both authorize is gone. A record moves
 * `issued -> claimed` here and only reaches `committed` when the caller that ran the provider
 * reports an actual commit receipt — a claim whose outcome never came back is settled as
 * `outcome_unknown` and can never be replayed.
 */
export class ValidationStore {
  /** Keyed by record id; the run/workspace bindings are re-checked on every read, never assumed. */
  private readonly records = new Map<string, SpatialValidationRecord>()

  /**
   * Runs whose session is protected — every CAD mutation in such a run must carry a valid record.
   * Armed explicitly by `spatial_design_begin`, by the guard once a run has placed enough geometry
   * to be drawing a layout, or immediately when the workspace has engineering design policies.
   */
  private readonly protectedRuns = new Set<string>()

  /** Entity placements counted per run — the cumulative half of the arming rule. */
  private readonly placementsByRun = new Map<string, number>()

  issue(input: IssueRecordInput): SpatialValidationRecord {
    const record = issueValidationRecord(input)
    this.records.set(record.id, record)
    return record
  }

  get(recordId: string): SpatialValidationRecord | undefined {
    return this.records.get(recordId)
  }

  /** Read-only authorization check — never mutates. Use `claim` to authorize a dispatch. */
  check(binding: RecordBindingCheck): RecordRejection {
    return checkRecord(this.records.get(binding.recordId), binding)
  }

  /**
   * Authorize one dispatch. Atomic and single-use: the record moves to `claimed` inside this call,
   * so a second caller asking about the same record is refused with `RECORD_IN_FLIGHT`.
   */
  claim(binding: RecordBindingCheck): RecordRejection {
    const verdict = checkRecord(this.records.get(binding.recordId), binding)
    if (!verdict.ok) return verdict
    const claimed: SpatialValidationRecord = {
      ...verdict.record,
      state: 'claimed',
      claimedAt: binding.now ?? Date.now()
    }
    this.records.set(claimed.id, claimed)
    return { ok: true, record: claimed }
  }

  /** The provider reported an actual commit. Pass the native receipt when there is one. */
  markCommitted(recordId: string, receipt?: string, now = Date.now()): void {
    const record = this.records.get(recordId)
    if (!record) return
    this.records.set(recordId, {
      ...record,
      state: 'committed',
      settledAt: now,
      commitReceipt: receipt ?? record.commitReceipt
    })
  }

  /** The provider ran and reported no commit: the record is spent, never silently replayable. */
  markFailed(recordId: string, now = Date.now()): void {
    const record = this.records.get(recordId)
    if (!record) return
    this.records.set(recordId, { ...record, state: 'failed', settledAt: now })
  }

  /**
   * Dispatched but the outcome is unobservable (timeout, abort mid-flight, dropped connection).
   * The write may have landed, so the record is never returned to `issued`: replaying it risks
   * applying the same operations twice.
   */
  markOutcomeUnknown(recordId: string, now = Date.now()): void {
    const record = this.records.get(recordId)
    if (!record) return
    this.records.set(recordId, { ...record, state: 'outcome_unknown', settledAt: now })
  }

  /** Current lifecycle state, or `undefined` for an unknown id. */
  stateOf(recordId: string): ValidationRecordState | undefined {
    return this.records.get(recordId)?.state
  }

  /** True once the provider itself confirmed a commit — never before. */
  isCommitted(recordId: string): boolean {
    return this.records.get(recordId)?.state === 'committed'
  }

  /**
   * Claims that were never settled (a provider that threw, or a process that died mid-flight).
   * They are reported rather than auto-released: releasing them would hand the same authorization
   * to a retry that could double-apply the writes.
   */
  staleClaims(olderThanMs = DEFAULT_CLAIM_STALE_MS, now = Date.now()): SpatialValidationRecord[] {
    return Array.from(this.records.values()).filter(
      (r) => r.state === 'claimed' && r.claimedAt !== null && now - r.claimedAt > olderThanMs
    )
  }

  /**
   * Drops every record for a run except `keepId`. Called when a mutation is authorized: the drawing
   * state the other records described is now false, so they must not authorize follow-up work. The
   * record just claimed is kept so post-mutation read-back verification can name what the batch was
   * validated against.
   */
  invalidateRun(runId: string, keepId?: string): void {
    for (const [id, record] of this.records) {
      if (record.runId === runId && id !== keepId) this.records.delete(id)
    }
  }

  /** Adds to a run's placement count and returns the new total. */
  addPlacements(runId: string, count: number): number {
    const total = (this.placementsByRun.get(runId) ?? 0) + count
    this.placementsByRun.set(runId, total)
    return total
  }

  placementsFor(runId: string): number {
    return this.placementsByRun.get(runId) ?? 0
  }

  arm(runId: string): void {
    this.protectedRuns.add(runId)
  }

  disarm(runId: string): void {
    this.protectedRuns.delete(runId)
  }

  isProtected(runId: string): boolean {
    return this.protectedRuns.has(runId)
  }

  /** Diagnostic/test seam: how many records a run currently holds. */
  countForRun(runId: string): number {
    let n = 0
    for (const record of this.records.values()) if (record.runId === runId) n += 1
    return n
  }

  clear(): void {
    this.records.clear()
    this.protectedRuns.clear()
    this.placementsByRun.clear()
  }
}
