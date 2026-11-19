import { z } from 'zod'
import type { SpatialFinding } from './constraints'

/**
 * Server-issued proof that a specific layout was validated against a specific drawing state, and
 * that the operations about to be dispatched are the operations that were validated.
 *
 * The threat this closes: `engineering_plan_format` used to grant `ready_for_drafting` from a
 * `validation.status` field the model typed into its own tool arguments, and nothing in the CAD path
 * checked anything. A record is only ever created by the server, inside the call that ran the
 * constraint engine, and only ever consumed by the server, inside the call that dispatches the
 * mutation. A model that wants a PASS has to produce geometry that passes.
 *
 * One record authorizes exactly one CAD batch. After that batch commits, the drawing genuinely
 * changed — new walls make new spaces — so validating the next batch against the model that existed
 * before them would be validating a fiction. Re-validating between batches is the honest cost.
 *
 * Every field is a binding: workspace, run, device, document, drawing revision, layout, the exact
 * operation payload, the compiled plan hash, and the policy set the verdict was reached under. A
 * record that fails any binding is rejected rather than downgraded.
 */

export const ValidationVerdictSchema = z.enum(['PASS', 'FAIL', 'INSUFFICIENT_DATA'])
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>

/**
 * Lifecycle of an authorization. Every state is observable on the record, so "what happened to this
 * ticket" is answered from data instead of inferred:
 *
 *   issued            validated, never dispatched
 *   claimed           dispatched under this record; the provider's result has not come back yet
 *   committed         the provider reported an actual commit (native receipt)
 *   failed            the provider reported it did not commit
 *   outcome_unknown   dispatched, then lost — timeout, abort, dropped connection. The write MAY
 *                     have landed, so the answer is "reconcile the receipt", never "replay it"
 *
 * `state` replaces the old "marked committed at dispatch" marker. Previously a record was written as
 * committed BEFORE the provider ran, so a lost or failed write still looked spent, and the
 * read-check-then-mark sequence let two racing dispatches both pass. The only transition out of
 * `issued` is a synchronous claim, so exactly one caller can win one record.
 */
export type ValidationRecordState =
  'issued' | 'claimed' | 'committed' | 'failed' | 'outcome_unknown'

/** Terminal states: the record can never authorize another dispatch. */
export const SETTLED_STATES: readonly ValidationRecordState[] = [
  'committed',
  'failed',
  'outcome_unknown'
]

export const SpatialValidationRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workspaceId: z.string(),
  /** The device whose AutoCAD the geometry was read from, when the run is device-scoped. */
  deviceId: z.string().nullable().default(null),
  /** Document identity as the caller named it (`documentName`/`documentId`), never a bare guess. */
  documentName: z.string(),
  /**
   * The drawing revision the validation ran against, read from the plugin (`drawing.info`'s
   * `revision` = `Database.Tduupdate` ticks + `NumberOfSaves`). The entity snapshot pasted into
   * `spatial_validate_layout` is only as good as the caller's word; the revision is something
   * AutoCAD itself reports, so a mutation that moved the drawing between validation and commit is
   * caught even when the caller never mentions it.
   */
  documentRevision: z.string(),
  /** Server-computed digest of the entity snapshot the spatial model was extracted from. */
  drawingFingerprint: z.string(),
  /** Server-computed digest of the placements that were validated. */
  layoutFingerprint: z.string(),
  /** Server-computed digest of the single CAD payload this record authorizes. */
  operationFingerprint: z.string(),
  /**
   * Digest of the COMPILED operations — the line/polyline legs and block inserts the payload will
   * actually execute as. `operationFingerprint` hashes the wrapper the model sent; this binds the
   * geometry, so a batch whose real writes are hidden behind a planId or generator spec cannot match
   * a record issued over explicit operations (and vice versa).
   */
  planHash: z.string().default(''),
  /** The policy set the verdict was reached under, so a PASS cannot be replayed under new rules. */
  policyVersion: z.string().default(''),
  /** Where the spatial evidence came from: zone ids, source handles, CAD State snapshot refs. */
  evidenceRefs: z.array(z.string()).default([]),
  result: ValidationVerdictSchema,
  /** Codes only — the full findings already went back to the caller in the validate response. */
  blockingCodes: z.array(z.string()).default([]),
  createdAt: z.number(),
  expiresAt: z.number().nullable().default(null),
  state: z.enum(['issued', 'claimed', 'committed', 'failed', 'outcome_unknown']).default('issued'),
  claimedAt: z.number().nullable().default(null),
  settledAt: z.number().nullable().default(null),
  /** Native commit evidence (batch id / execution id) when the provider reported one. */
  commitReceipt: z.string().nullable().default(null)
})
export type SpatialValidationRecord = z.infer<typeof SpatialValidationRecordSchema>

/** What the guard needs in order to decide whether a dispatch is authorized. */
export interface RecordBindingCheck {
  recordId: string
  runId: string
  workspaceId: string
  deviceId?: string | null
  documentName: string
  /**
   * Live revision read by the guard's probe. Empty means "no probe available" and skips the
   * comparison — staleness then rests on TTL + single-use + run invalidation.
   */
  documentRevision: string
  /**
   * Digest of a snapshot to compare against. Empty at dispatch time (the server holds no fresh entity
   * snapshot mid-mutation) and supplied on the commit path, where the caller did pass one.
   */
  drawingFingerprint: string
  /** Digest of the single payload about to be dispatched. */
  operationFingerprint: string
  /** Digest of the compiled operations. Absent/empty skips the check (legacy records). */
  planHash?: string
  /** Digest of the policy set. Absent/empty skips the check (legacy records). */
  policyVersion?: string
  now?: number
}

export type RecordRejectionCode =
  | 'RECORD_NOT_FOUND'
  | 'RECORD_NOT_PASS'
  | 'RECORD_EXPIRED'
  | 'RECORD_SCOPE_MISMATCH'
  | 'RECORD_DOCUMENT_MISMATCH'
  | 'RECORD_REVISION_STALE'
  | 'RECORD_DRAWING_STALE'
  | 'RECORD_OPERATION_MISMATCH'
  | 'RECORD_PLAN_MISMATCH'
  | 'RECORD_POLICY_MISMATCH'
  | 'RECORD_ALREADY_USED'
  | 'RECORD_IN_FLIGHT'
  | 'RECORD_OUTCOME_UNRECONCILED'

export type RecordRejection =
  | { ok: false; code: RecordRejectionCode; message: string }
  | { ok: true; record: SpatialValidationRecord }

/**
 * Default record lifetime. A record is a claim about a drawing state that anyone with AutoCAD open
 * can change at any moment, so it is deliberately short-lived: long enough to validate then commit
 * one batch, short enough that a verdict cannot be hoarded across a whole conversation.
 */
export const DEFAULT_RECORD_TTL_MS = 15 * 60 * 1000

/** A claim with no settle after this long is abandoned — reported, never silently re-issued. */
export const DEFAULT_CLAIM_STALE_MS = 5 * 60 * 1000

export interface IssueRecordInput {
  runId: string
  workspaceId: string
  deviceId?: string | null
  documentName: string
  documentRevision: string
  drawingFingerprint: string
  layoutFingerprint: string
  operationFingerprint: string
  planHash?: string
  policyVersion?: string
  evidenceRefs?: string[]
  result: ValidationVerdict
  findings: SpatialFinding[]
  ttlMs?: number
  now?: number
}

/**
 * Mints a record. Only ever called by the server-side capability that just ran the constraint
 * engine — the id is random and unguessable, which is what makes presenting one meaningful: the
 * holder must have made the server compute it.
 */
export function issueValidationRecord(input: IssueRecordInput): SpatialValidationRecord {
  const now = input.now ?? Date.now()
  return SpatialValidationRecordSchema.parse({
    id: `svr_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    runId: input.runId,
    workspaceId: input.workspaceId,
    deviceId: input.deviceId ?? null,
    documentName: input.documentName,
    documentRevision: input.documentRevision,
    drawingFingerprint: input.drawingFingerprint,
    layoutFingerprint: input.layoutFingerprint,
    operationFingerprint: input.operationFingerprint,
    planHash: input.planHash ?? '',
    policyVersion: input.policyVersion ?? '',
    evidenceRefs: input.evidenceRefs ?? [],
    result: input.result,
    blockingCodes: input.findings.filter((f) => f.status === 'FAIL').map((f) => f.code),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_RECORD_TTL_MS),
    state: 'issued',
    claimedAt: null,
    settledAt: null,
    commitReceipt: null
  })
}

/**
 * The single decision function behind the store's claim. Pure and total: every rejection names a
 * code, so a test can assert the exact reason a mutation was blocked, not just that it was.
 */
export function checkRecord(
  stored: SpatialValidationRecord | undefined,
  binding: RecordBindingCheck
): RecordRejection {
  const now = binding.now ?? Date.now()
  if (!stored) {
    return {
      ok: false,
      code: 'RECORD_NOT_FOUND',
      message: `no validation record '${binding.recordId}' exists for this run — a record is issued only by spatial_validate_layout, never by the caller`
    }
  }
  if (stored.result !== 'PASS') {
    return {
      ok: false,
      code: 'RECORD_NOT_PASS',
      message: `record '${stored.id}' verdict is ${stored.result}, not PASS — ${stored.blockingCodes.join(', ') || 'no blocking codes recorded'}`
    }
  }
  if (stored.expiresAt !== null && now > stored.expiresAt) {
    return {
      ok: false,
      code: 'RECORD_EXPIRED',
      message: `record '${stored.id}' expired at ${new Date(stored.expiresAt).toISOString()} — re-validate against the current drawing`
    }
  }
  if (stored.runId !== binding.runId || stored.workspaceId !== binding.workspaceId) {
    return {
      ok: false,
      code: 'RECORD_SCOPE_MISMATCH',
      message: `record '${stored.id}' belongs to a different run/workspace — a record id alone never authorizes a mutation`
    }
  }
  if (stored.deviceId !== (binding.deviceId ?? null)) {
    return {
      ok: false,
      code: 'RECORD_SCOPE_MISMATCH',
      message: `record '${stored.id}' was issued for device '${stored.deviceId ?? 'none'}', not '${binding.deviceId ?? 'none'}'`
    }
  }
  if (stored.documentName !== binding.documentName) {
    return {
      ok: false,
      code: 'RECORD_DOCUMENT_MISMATCH',
      message: `record '${stored.id}' validated document '${stored.documentName}', this call targets '${binding.documentName}'`
    }
  }
  if (binding.documentRevision !== '' && stored.documentRevision !== binding.documentRevision) {
    return {
      ok: false,
      code: 'RECORD_REVISION_STALE',
      message: `the drawing moved after record '${stored.id}' was issued (revision '${stored.documentRevision}' -> '${binding.documentRevision}') — re-read the geometry and re-validate before drawing`
    }
  }
  // `drawingFingerprint` is compared only when a snapshot was supplied (the commit path). At
  // dispatch time the server holds no fresh entity snapshot, so the live revision above is the
  // staleness signal there.
  if (
    binding.drawingFingerprint !== '' &&
    stored.drawingFingerprint !== binding.drawingFingerprint
  ) {
    return {
      ok: false,
      code: 'RECORD_DRAWING_STALE',
      message: `the drawing changed after record '${stored.id}' was issued — re-read the geometry and re-validate before drawing`
    }
  }
  if (stored.operationFingerprint !== binding.operationFingerprint) {
    return {
      ok: false,
      code: 'RECORD_OPERATION_MISMATCH',
      message: `the operations being dispatched are not the operations record '${stored.id}' validated — validate the exact batch, then send that batch`
    }
  }
  // The compiled-geometry binding: the wrapper payload can match while the operations behind it
  // differ (a planId swapped for explicit ops, or ops reordered into different geometry).
  if (binding.planHash && stored.planHash && stored.planHash !== binding.planHash) {
    return {
      ok: false,
      code: 'RECORD_PLAN_MISMATCH',
      message: `the compiled geometry being dispatched is not the geometry record '${stored.id}' was preflighted against — re-preflight the exact operations`
    }
  }
  if (
    binding.policyVersion &&
    stored.policyVersion &&
    stored.policyVersion !== binding.policyVersion
  ) {
    return {
      ok: false,
      code: 'RECORD_POLICY_MISMATCH',
      message: `the engineering policy set changed after record '${stored.id}' was issued (${stored.policyVersion} -> ${binding.policyVersion}) — re-validate under the current policies`
    }
  }
  // State, not a boolean: an in-flight claim and a settled record are different failures whose
  // remedies are opposite (wait/reconcile vs re-validate).
  if (stored.state === 'claimed') {
    return {
      ok: false,
      code: 'RECORD_IN_FLIGHT',
      message: `record '${stored.id}' is already claimed by a dispatch whose outcome is not settled — one record draws one batch; reconcile the receipt before validating another`
    }
  }
  if (SETTLED_STATES.includes(stored.state)) {
    if (stored.state === 'outcome_unknown') {
      return {
        ok: false,
        code: 'RECORD_OUTCOME_UNRECONCILED',
        message: `record '${stored.id}' was dispatched but its commit outcome is unknown — replaying it could apply the same writes twice. Read the drawing back (spatial_readback_verify, or the operations history) and re-validate what is actually there`
      }
    }
    return {
      ok: false,
      code: 'RECORD_ALREADY_USED',
      message: `record '${stored.id}' already authorized a dispatched mutation (state ${stored.state}) — one record draws one batch, re-validate for the next`
    }
  }
  return { ok: true, record: stored }
}
