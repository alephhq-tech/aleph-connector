import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { ViewCaptureParams } from '@aleph-connector/cad-protocol'
import { COMMIT_EVIDENCE_META_KEY } from '@aleph-connector/operation-protocol'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { imageResult, textResult } from './textResult.js'

/**
 * Optional on every tool that draws: also return a PNG of the result, so the model can check what
 * it drew looks right instead of trusting entity handles alone. Off by default — an image costs
 * tokens and needs a vision-capable client.
 */
export const captureOption = z
  .enum(['changed', 'all'])
  .optional()
  .describe(
    'After drawing, also return a PNG to check the result visually. changed: frame the entities ' +
      'this call created or changed. all: frame the whole drawing. Omit for no picture.'
  )

/** A batch this big drew something no handle list describes: walls, corridors and shafts all commit
 * the same way a correct protected area does. report §5.4 — the SUNLAND run drew 141 entities over
 * the whole floor after `view.capture` failed, and never looked. */
export const BULK_REVIEW_MIN_ENTITIES = 20

export const visualReviewOption = z
  .literal('unavailable')
  .optional()
  .describe(
    `Required on a batch of ${BULK_REVIEW_MIN_ENTITIES}+ entities that does not ask for a \`capture\`: ` +
      'declares that no picture of the result is obtainable, and records that on the receipt. ' +
      'Prefer \`capture\` — an unreviewed bulk draw is unverifiable.'
  )

/** Refuses an unreviewed bulk batch BEFORE anything is drawn; a refused batch has zero side effects. */
export function requireVisualReview(
  entityCount: number,
  mode: CaptureMode,
  review: 'unavailable' | undefined
): void {
  if (entityCount < BULK_REVIEW_MIN_ENTITIES || mode !== undefined || review !== undefined) return
  throw new Error(
    `${entityCount} entities is a bulk draw: pass \`capture\` ("changed" or "all") so the result is ` +
      'actually checked, or `visualReview: "unavailable"` if a picture cannot be produced — that ' +
      'declaration goes on the receipt. Nothing was drawn.'
  )
}

export const captureSize = {
  width: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .optional()
    .describe('Image width in pixels (default 1024).'),
  height: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .optional()
    .describe('Image height in pixels (default 768).')
}

type CaptureMode = z.infer<typeof captureOption>

/** The wire-form params to look at one call's result, or `undefined` when no picture was asked for. */
function paramsFor(
  mode: CaptureMode,
  handles: string[],
  rest: Pick<ViewCaptureParams, 'documentName' | 'width' | 'height'>
): ViewCaptureParams | undefined {
  if (mode === undefined) return undefined
  if (mode === 'changed') {
    if (handles.length === 0) return undefined
    return { ...rest, handles }
  }
  return { ...rest }
}

/**
 * Wraps a drawing tool's payload with the picture `mode` asks for. A failed capture never fails the
 * drawing that already happened: the payload is returned with `capture: { error }` instead.
 *
 * `attestation` (issue #388 §C) rides out-of-band in `_meta` on every return path, including the
 * no-capture and capture-failed ones — what committed is decided by the batch, not by whether a
 * screenshot worked. It is a 4th parameter rather than a key of the options object because that
 * object's remainder is spread into the `view.capture` wire params.
 *
 * The same attestation records whether the batch was ever *looked at* (`visualEvidence`), so a bulk
 * draw that no picture backs is auditable afterwards instead of indistinguishable from a checked one.
 */
export async function withCapture(
  bridge: BridgeClient,
  payload: Record<string, unknown>,
  {
    mode,
    handles,
    review,
    ...rest
  }: {
    mode: CaptureMode
    handles: string[]
    /** The caller's declaration that no picture is obtainable on a bulk batch (`requireVisualReview`
     * forces that choice); recorded so the ledger shows an unviewed draw, not a silent one. */
    review?: 'unavailable'
  } & Pick<ViewCaptureParams, 'documentName' | 'width' | 'height'>,
  attestation?: Record<string, unknown>
) {
  if (mode === 'changed' && handles.length === 0) {
    return textResult(
      { ...payload, capture: { error: 'No changed entities to frame.' } },
      stampVisualEvidence(attestation, 'unavailable')
    )
  }
  const params = paramsFor(mode, handles, rest)
  // An aborted batch drew nothing — a picture of the unchanged drawing would only mislead.
  if (!params || payload.status === 'aborted')
    return textResult(payload, stampVisualEvidence(attestation, review))
  try {
    const { data, mimeType, ...captureMeta } = await bridge.request(RpcMethod.ViewCapture, params)
    return imageResult(
      { ...payload, capture: captureMeta },
      { data, mimeType },
      stampVisualEvidence(attestation, 'captured')
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return textResult(
      { ...payload, capture: { error: message } },
      stampVisualEvidence(attestation, 'unavailable')
    )
  }
}

function stampVisualEvidence(
  attestation: Record<string, unknown> | undefined,
  evidence: 'captured' | 'unavailable' | undefined
): Record<string, unknown> | undefined {
  if (!attestation || !evidence) return attestation
  const commit = (attestation[COMMIT_EVIDENCE_META_KEY] ?? {}) as Record<string, unknown>
  return {
    ...attestation,
    [COMMIT_EVIDENCE_META_KEY]: { ...commit, visualEvidence: evidence }
  }
}
