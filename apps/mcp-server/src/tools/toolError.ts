import {
  BridgeErrorCode,
  BridgeRpcError,
  describeBridgeErrorCode
} from '@arcdio/cad-protocol'
import { DeviceGatewayError, GatewayErrorCode } from '@arcdio/device-contracts'
import {
  PinnedDocumentGoneError,
  PinnedInstanceMismatchError
} from '../bridge/PinnedBridgeClient.js'
import { OUTCOME_META_KEY } from '@arcdio/operation-protocol'

/**
 * Tool execution failures as `isError: true` results the model can act on (#13, #71): the error
 * code and name, the original message, one concrete next step, and whether retrying the same call
 * can help. Protocol-level errors stay reserved for malformed requests (the SDK's input
 * validation).
 */
export interface ToolErrorInfo {
  code?: number
  name: string
  message: string
  hint?: string
  retryable: boolean
}

type Advice = { hint: string; retryable: boolean }

const BRIDGE_ADVICE: Record<number, Advice> = {
  [BridgeErrorCode.BridgeBusy]: {
    hint: 'AutoCAD is busy (a command or dialog is active). Ask the user to finish or press Esc, then retry once.',
    retryable: true
  },
  [BridgeErrorCode.NoActiveDocument]: {
    hint: 'No drawing is open. Ask the user to open or create one; drawing → list_open shows what is open.',
    retryable: false
  },
  [BridgeErrorCode.EntityNotFound]: {
    hint: "That handle doesn't exist in this document (erased, or another tab). Re-read handles with entity → list and check documentName.",
    retryable: false
  },
  [BridgeErrorCode.LayerNotFound]: {
    hint: 'Create the layer first (layer → create {"name": …}) or use one from layer → list.',
    retryable: false
  },
  [BridgeErrorCode.TransactionFailed]: {
    hint: 'Nothing was changed. The message names the real cause (missing layer, unloaded linetype, bad value); fix that step and resend the whole call.',
    retryable: false
  },
  [BridgeErrorCode.InvalidGeometry]: {
    hint: 'Fix the field the message names (angles are radians, radius > 0, polylines need ≥ 2 points, only Continuous linetype is loaded) and resend.',
    retryable: false
  },
  [BridgeErrorCode.BlockNotFound]: {
    hint: "That block isn't defined in this drawing. Check the exact name; only blocks already in the drawing can be inserted.",
    retryable: false
  },
  [BridgeErrorCode.UndoNotTop]: {
    hint: "Only the most recent batch can be undone. Undo newer batches first, or erase this batch's handles (ask the user).",
    retryable: false
  },
  [BridgeErrorCode.UndoStackDiverged]: {
    hint: "The user ran AutoCAD commands after this batch, so native undo is unsafe. Erase the batch's handles instead (ask first).",
    retryable: false
  },
  [BridgeErrorCode.BatchNotFound]: {
    hint: 'Unknown batchId for this document. operations → history lists recent batches.',
    retryable: false
  },
  [BridgeErrorCode.DocumentNotFound]: {
    hint: 'Call drawing → list_open and pass a `name` it returns as documentName (a bare file name like A-101.dwg works if only one tab has it; if several do, pass the full name).',
    retryable: false
  },
  [BridgeErrorCode.LayerProtected]: {
    hint: "Layer 0, Defpoints, and the current layer can't be deleted. Switch the current layer first, or pick a different target.",
    retryable: false
  },
  [BridgeErrorCode.LayerInUse]: {
    hint: 'This layer still has entities on it. Erase or move them first, or leave the layer as-is.',
    retryable: false
  },
  [BridgeErrorCode.UndoUnsupported]: {
    hint: "Native undo only works on the active tab. Erase the batch's entityRefs by handle instead (ask first), or ask the user to switch to that tab and press Ctrl+Z.",
    retryable: false
  },
  [BridgeErrorCode.InvalidScope]: {
    hint: 'Requested capture scope is invalid or could not be resolved (non-finite window coordinates or requested handles do not resolve to drawable entities). Verify handles with entity list.',
    retryable: false
  },
  [BridgeErrorCode.CaptureFailed]: {
    hint: "Nothing was changed. An empty drawing cannot be captured. Do not change the user's camera to retry off-screen rendering; report visual review unavailable and use entity → list with its limitations.",
    retryable: false
  },
  [BridgeErrorCode.LayerNameConflict]: {
    hint: 'A layer with the target name already exists. Pick a different name, or delete the existing one first (ask before deleting).',
    retryable: false
  },
  [BridgeErrorCode.StyleNotFound]: {
    hint: "The named linetype/text style/dimension style doesn't exist in this drawing. Call style → linetypes.list / textStyles.list / dimStyles.list, or load/create it first (style → linetypes.load for a linetype).",
    retryable: false
  },
  [BridgeErrorCode.StyleNameConflict]: {
    hint: 'A style with this name already exists. Pass update: true to overwrite it, or pick a different name.',
    retryable: false
  },
  [BridgeErrorCode.AuditUnsupported]: {
    hint: 'drawing → cleanup\'s "audit" fix isn\'t implemented (AutoCAD\'s managed API has no general Database.Audit(fix) entry point). Retry cleanup without "audit" in fixes, or ask the user to run the AUDIT command in AutoCAD by hand.',
    retryable: false
  },
  [BridgeErrorCode.CaptureTooLarge]: {
    hint: 'The rendered PNG is over the per-capture size cap. Pass smaller width/height, or scope the capture to fewer handles/a tighter window.',
    retryable: false
  },
  [BridgeErrorCode.InvalidOperation]: {
    hint: "A batch-local @id reference in operations.apply is invalid — a duplicate id, a reference to a step that hasn't run yet, an unknown id, or a @ref that resolved to more entities than a single-handle field accepts. Fix the id/@ref and resend; nothing was sent to AutoCAD.",
    retryable: false
  },
  [BridgeErrorCode.ViewFailed]: {
    hint: 'AutoCAD rejected the camera move; nothing else changed (a view call never touches drawing data). Verify the drawing with entity → list instead of relying on the camera, or ask the user to zoom in AutoCAD once and retry.',
    retryable: false
  },
  [BridgeErrorCode.PathNotAllowed]: {
    hint: "Nothing was written. `path` must be an absolute .dwg path inside this drawing's own folder — no other directory, no UNC/device path. For a never-saved drawing, no path is accepted yet: ask the user to Save As once in AutoCAD first.",
    retryable: false
  },
  [BridgeErrorCode.FileExists]: {
    hint: "That file already exists and isn't this drawing's own current file. Pass overwrite: true if replacing it is really intended, or pick a different name.",
    retryable: false
  },
  [BridgeErrorCode.PipeOccupied]: {
    hint: 'Another CadAI Bridge process on this machine already owns the connection to this AutoCAD instance, so this one can only ever be refused — retrying the same call will not help. Ask the user to restart the Bridge once (Settings → Plugin → "Khởi động lại Bridge"), which leaves a single Bridge owning every AutoCAD connection.',
    retryable: false
  },
  [BridgeErrorCode.EditNotRestorable]: {
    hint: 'An entity targeted for editing cannot be rebuilt by entity.create/entity.update (e.g. hatch, kind "other", rotated MText, variable-width polyline). Modify or exclude the entity, or inspect the pre-image restorability verdict.',
    retryable: false
  },
  [BridgeErrorCode.EditStorageFailed]: {
    hint: 'Failed to persist the edit session locally before committing the transaction. The transaction was aborted and no changes were made. Check local disk space and permissions under %LOCALAPPDATA%\\CadAI\\edits.',
    retryable: false
  },
  [BridgeErrorCode.EditNotFound]: {
    hint: 'The requested editId does not exist or has expired. Start a new edit session with edit.begin or check existing sessions.',
    retryable: false
  },
  [BridgeErrorCode.EditDocumentMismatch]: {
    hint: 'The edit session belongs to a different document than the targeted one. Ensure operations target the document where edit.begin was opened.',
    retryable: false
  },
  [BridgeErrorCode.EditStalePreImage]: {
    hint: 'The pre-image is stale: the document revision has moved or a source entity was modified/erased since edit.begin was called. Start a fresh edit session.',
    retryable: false
  },
  [BridgeErrorCode.EditConflict]: {
    hint: 'Conflict in edit session: an operation targeted an entity outside the candidate set or the candidate was modified externally. Check candidate handles.',
    retryable: false
  },
  [BridgeErrorCode.EditRequiresHumanApproval]: {
    hint: 'This edit session requires explicit human approval via Aleph Desktop before it can be accepted. Prompt the user for approval.',
    retryable: false
  },
  [BridgeErrorCode.EditAlreadyApplied]: {
    hint: 'This edit session has already been accepted and committed. It cannot be accepted a second time. Start a new edit session with edit.begin.',
    retryable: false
  },
  [BridgeErrorCode.SharedDefinitionScopeRequired]: {
    hint: 'This operation affects a shared block definition across all its instances. Pass sharedScope: true if modifying all references is intentional, or use block.uniquify to isolate this reference.',
    retryable: false
  },
  [BridgeErrorCode.BlockUniquifyUnsupported]: {
    hint: 'This block reference cannot be safely uniquified (it may be an anonymous/dynamic block, xref, or nested block). Modify instances directly or ask the user.',
    retryable: false
  },
  [BridgeErrorCode.RevertConflict]: {
    hint: 'One or more entities in this change set have been modified or deleted since commit, preventing a clean selective revert. Check the drawing state or ask the user.',
    retryable: false
  },
  [BridgeErrorCode.IdempotencyKeyConflict]: {
    hint: 'That idempotencyKey already stands for a different call, so the changed arguments were refused and nothing was sent to AutoCAD (#388). The call you mean is either the original one (retry it unchanged to get its result back) or new work: send it with a fresh key. Verify what actually landed with operations → history / entity → list.',
    retryable: false
  },
  [BridgeErrorCode.ProtectedEntity]: {
    hint: "The target entities are the user's, not yours, and cannot be erased directly. Erasing them requires the human-approved edit flow (edit.begin → edit.accept) or the user doing it in AutoCAD; do not retry the erase with different handles.",
    retryable: false
  },
  [BridgeErrorCode.RevisionConflict]: {
    hint: 'The drawing changed since the expectedRevision you supplied was captured, so nothing from this batch was applied. Re-read the document (drawing.info/entity.get) to see what changed, then send the batch again with the fresh revision — do not retry this exact call unchanged.',
    retryable: false
  }
}

const GATEWAY_ADVICE: Record<number, Advice> = {
  [GatewayErrorCode.DeviceNotFound]: {
    hint: "This session's device has never connected. Ask the user to start the CadAI Bridge on their PC; `context` shows the connection.",
    retryable: false
  },
  [GatewayErrorCode.DeviceOffline]: {
    hint: "The CadAI Bridge on the user's PC is offline. Ask the user to start or reconnect it, then check `context`.",
    retryable: false
  },
  [GatewayErrorCode.InstanceNotFound]: {
    hint: 'No AutoCAD with the CadAI plugin is running. Ask the user to start AutoCAD; `context` lists instances.',
    retryable: false
  },
  [GatewayErrorCode.InstanceAmbiguous]: {
    hint: "Several AutoCAD instances are running and this call can't pick one yet. Ask the user to close the extra instances.",
    retryable: false
  },
  [GatewayErrorCode.RequestTimeout]: {
    hint: 'Timed out — the mutation may already be applied or still committing in AutoCAD (autocad-mcp#9). Do not resend blindly: retry the exact same call (its idempotencyKey, auto-derived from this request unless you set one, makes a retry return the original result instead of duplicating it) once, or check operations → history / entity → list first. Split large batches if this keeps happening.',
    retryable: true
  },
  [GatewayErrorCode.ProtocolIncompatible]: {
    hint: "The Bridge/plugin version doesn't match this server. Ask the user to update the CadAI Bridge and plugin.",
    retryable: false
  }
}

const GATEWAY_NAME_BY_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(GatewayErrorCode).map(([name, code]) => [code, name])
)

export function describeToolError(err: unknown): ToolErrorInfo {
  if (err instanceof BridgeRpcError) {
    return {
      code: err.code,
      name: describeBridgeErrorCode(err.code),
      message: err.message,
      ...(BRIDGE_ADVICE[err.code] ?? { retryable: false })
    }
  }
  if (err instanceof DeviceGatewayError) {
    return {
      code: err.code,
      name: GATEWAY_NAME_BY_CODE[err.code] ?? `GatewayError(${err.code})`,
      message: err.message,
      ...(GATEWAY_ADVICE[err.code] ?? { retryable: false })
    }
  }
  if (err instanceof PinnedDocumentGoneError) {
    return {
      name: 'PinnedDocumentGone',
      message: err.message,
      hint: "The pinned tab's `documentId` stopped existing — the tab closed or the plugin reloaded (CADAIRELOAD), which re-issues every documentId. Call drawing → list_open with the pinned instanceId to read the new ids, then drawing → use again; do not guess a tab.",
      retryable: false
    }
  }
  if (err instanceof PinnedInstanceMismatchError) {
    return {
      name: 'PinnedInstanceMismatch',
      message: err.message,
      hint: 'This session pinned a document in one AutoCAD process, so an unscoped call cannot be sent to another. Either drop `instanceId` to keep working in the pinned window, or pass an explicit `documentName` together with `instanceId` to work in the other one.',
      retryable: false
    }
  }
  return {
    name: 'Error',
    message: err instanceof Error ? err.message : String(err),
    retryable: false
  }
}

/** The `hint` for a plugin error code, for results that report an error without throwing. */
export function bridgeErrorHint(code: number): string | undefined {
  return BRIDGE_ADVICE[code]?.hint
}

export function toolErrorResult(err: unknown, meta?: Record<string, unknown>) {
  const error = describeToolError(err)
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
    structuredContent: { error } as Record<string, unknown>,
    ...(meta && { _meta: meta })
  }
}

/**
 * Whether a thrown failure leaves the SOURCE SYSTEM's state unknowable (issue #388 §C).
 *
 * Only a post-dispatch timeout qualifies: the request reached the Bridge and AutoCAD may have
 * committed before the connection gave up. Every other failure here is refused before anything is
 * sent — an offline device, an unknown instance, a busy AutoCAD holding the document gate, an
 * approval gate that rejected the call — so `failed` is the honest answer and a retry is safe.
 * Reading this as "unknown" too broadly would block retries that are genuinely safe.
 */
export function outcomeIsUnknown(err: unknown): boolean {
  return err instanceof DeviceGatewayError && err.code === GatewayErrorCode.RequestTimeout
}

/**
 * Wraps a tool handler so every thrown failure becomes a structured `isError` result.
 *
 * `mutating` marks a tool that changes the drawing: for those, a post-dispatch timeout is
 * attested out-of-band as `outcome_unknown` so Cloud's ledger records an operation whose commit is
 * indeterminate instead of a plain failure a model would blindly retry. A tool that never
 * changes anything (every `readOnlyHint: true` tool) is never marked, so its timeouts stay `failed`.
 *
 * `mutating` is per TOOL, not per operation, since these tools are operation unions (`entity` =
 * list/get/create/transform/erase/…): a timeout on one of a write tool's READ operations is
 * recorded as `outcome_unknown` too. That is the conservative direction, and it is diagnostic-only
 * today — nothing yet refuses a retry on that state, whereas guessing "committed" for a write that
 * timed out would risk a real duplicate draw. Per-operation claims are the follow-up, not
 * something to fake here.
 */
export function guarded<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>,
  options: { mutating?: boolean } = {}
) {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (err) {
      const meta =
        options.mutating && outcomeIsUnknown(err)
          ? { [OUTCOME_META_KEY]: 'outcome_unknown' as const }
          : undefined
      return toolErrorResult(err, meta)
    }
  }
}

/** `guarded` for a tool that changes the drawing, so its post-dispatch timeouts attest
 * `outcome_unknown`. Its own name rather than a second argument: the handler stays the last
 * argument, which is what keeps these operation-union handlers' existing layout intact. */
export function mutatingGuarded<A extends unknown[], R>(handler: (...args: A) => Promise<R>) {
  return guarded(handler, { mutating: true })
}
