import type { EntityOperation, EntityRef } from '@aleph-connector/cad-protocol'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { ensureLayers, layersOf } from './normalize.js'
import { applyOperationsBatch } from './refs.js'
import { attestBatchOutcome, type BatchOutcomeClaim } from './attestOutcome.js'
import { shapeRefs, type refsResultMode } from './resultShape.js'
import { bridgeErrorHint } from './toolError.js'
import type * as z from 'zod/v4'

interface ApplyBatchOptions {
  documentName: string | undefined
  taskId?: string
  ensureLayer: boolean | undefined
  result: z.infer<typeof refsResultMode>
  view?: { follow?: 'off' | 'fit' | 'pan' }
  progressive?: boolean
  paceMs?: number
  /**
   * `idempotencyKey`.
   */
  idempotencyKey?: string
  /** Forwarded to the Device Gateway so an MCP client cancellation can reach the Bridge (#9). */
  signal?: AbortSignal
  /** Native revision precondition (#413 phase A); see `ApplyOperationsOptions` for semantics. */
  expectedRevision?: string
  /** Per-entity write-set precondition (#413 phase B); see `ApplyOperationsOptions` for semantics. */
  expectedState?: Record<string, string>
}

/**
 * Resolves `id`/`@ref`s (#19) and sends `operations` (already in wire form) and shapes its result
 * the way every batch-producing tool reports it: optional `createdLayers`, `entityRefs` per the
 * `result` mode, and a next-step `hint` on an aborted batch's error. Also returns the raw refs, in
 * step order, for callers that map them back to what they generated.
 *
 * `claim` is the server-side attestation of what the batch ACTUALLY committed (issue #388 §C),
 * computed here while the native `OperationsApplyResult` is still whole — so a caller can never
 * attest from the model-facing, result-mode-shaped subset and lose the commit truth.
 */
export async function applyBatch(
  bridge: BridgeClient,
  operations: EntityOperation[],
  options: ApplyBatchOptions
): Promise<{ refs: EntityRef[]; payload: Record<string, unknown>; claim: BatchOutcomeClaim }> {
  const createdLayers = options.ensureLayer
    ? await ensureLayers(
        bridge,
        layersOf(operations.flatMap((step) => (step.op === 'create' ? [step.entity] : []))),
        options.documentName
      )
    : []
  const native = await applyOperationsBatch(bridge, operations, {
    documentName: options.documentName,
    taskId: options.taskId,
    view: options.view ?? { follow: 'off' },
    // Machine batch by default: one transaction, no Live-Drawing per-stroke pacing. Callers doing
    // genuine interactive co-work opt in to progressive:true explicitly (see AGENT_WORKFLOW).
    progressive: options.progressive ?? false,
    paceMs: options.paceMs ?? 0,
    idempotencyKey: options.idempotencyKey,
    signal: options.signal,
    expectedRevision: options.expectedRevision,
    expectedState: options.expectedState
  })
  // Attested from `native`, the untouched wire result: `applied` below has already had
  // `entityRefs` re-shaped (under `result: 'handles'`/`'summary'` it is a bare count+handles
  // object), which would understate what actually committed.
  const claim = attestBatchOutcome(native)
  const { entityRefs, error, ...applied } = native
  const payload = {
    ...applied,
    ...(createdLayers.length > 0 && { createdLayers }),
    entityRefs: shapeRefs(entityRefs, options.result),
    // A committed batch is live in the open drawing's database, NOT in its .dwg: nothing on this
    // path saves, only `drawing.save` does. Without this the agent reports "vẽ xong" and the user
    // closes AutoCAD losing the work (report §5.11).
    ...(claim.commitReceipt?.commitIds?.length && {
      savedToFile: false,
      saveHint:
        'Committed entities are live in the open drawing, not written to its .dwg. Use drawing → save only if the user asked; otherwise say the changes are still unsaved.'
    }),
    // An aborted batch is a normal result, not a thrown error; give it the same next-step hint.
    ...(error && { error: { ...error, hint: bridgeErrorHint(error.causeCode ?? error.code) } })
  }
  return { refs: entityRefs, payload, claim }
}
