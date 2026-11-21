import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@aleph-connector/cad-protocol'
import type {
  EntityOperation,
  EntityRef,
  HatchLoop,
  OperationsApplyResult,
  PhaseExecutionInfo,
  StateConflict
} from '@aleph-connector/cad-protocol'
import { arrayCopyCount, type EntityTransformInput } from '@aleph-connector/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'

/**
 * Batch-local entity references (#19): `step.id` labels a step's resulting entity/entities; `"@id"`
 * anywhere a handle is accepted in a later step resolves to the real handle(s) AutoCAD assigned
 * that step. Entirely a `server` concern — `EntityOperation.id` and `"@ref"` strings never reach
 * the wire; `resolveStep` below always produces real hex handles.
 *
 * A single `operations.apply` call from the tool's perspective may become more than one
 * `RpcMethod.OperationsApply` request to the bridge: a real handle for step N only exists once step
 * N has actually run, so any step that references an id produced earlier **in the same,
 * not-yet-sent batch** forces that batch to flush first. Batches with no refs — the common case —
 * still make exactly one request, byte-identical to before this feature (see `partitionWaves`'s
 * empty-ref fast path), which is why `MockBridgeClient` needed no changes for this issue.
 */

const BATCH_REF_RE = /^@([A-Za-z0-9_-]+)$/

function refId(value: string): string | undefined {
  return BATCH_REF_RE.exec(value)?.[1]
}

function invalidOperation(message: string): BridgeRpcError {
  return new BridgeRpcError(BridgeErrorCode.InvalidOperation, message)
}

/** Every `@id` a step's handle-bearing fields reference (erase/transform handles, hatch loops). */
function stepRefs(op: EntityOperation): string[] {
  const refs: string[] = []
  const collect = (list: string[] | undefined) => {
    for (const h of list ?? []) {
      const id = refId(h)
      if (id != null) refs.push(id)
    }
  }
  if (op.op === 'create') {
    const e = op.entity
    if (e.kind === 'hatch') {
      collect(e.boundaryHandles)
      for (const loop of e.loops ?? []) if ('handles' in loop) collect(loop.handles)
    }
  } else if (op.op === 'erase') {
    collect(op.handles)
  } else if (op.op === 'update') {
    collect([op.update.handle])
  } else {
    collect(op.transform.handles)
    if (op.transform.op === 'arrayPath' && 'handle' in op.transform.path) {
      const id = refId(op.transform.path.handle)
      if (id != null) refs.push(id)
    }
  }
  return refs
}

function resolveHandleList(list: string[], idMap: Map<string, string[]>, ctx: string): string[] {
  const out: string[] = []
  for (const h of list) {
    const id = refId(h)
    if (id == null) {
      out.push(h)
      continue
    }
    const resolved = idMap.get(id)
    if (!resolved) throw invalidOperation(`${ctx}: "@${id}" has not been produced yet`)
    out.push(...resolved)
  }
  return out
}

function resolveSingleHandle(h: string, idMap: Map<string, string[]>, ctx: string): string {
  const id = refId(h)
  if (id == null) return h
  const resolved = idMap.get(id)
  if (!resolved) throw invalidOperation(`${ctx}: "@${id}" has not been produced yet`)
  if (resolved.length !== 1) {
    throw invalidOperation(
      `${ctx}: "@${id}" resolved to ${resolved.length} entities, but exactly one handle is required here`
    )
  }
  return resolved[0]!
}

/** Builds the real, wire-ready step: every `@ref` replaced with the handle(s) it resolved to. */
function resolveStep(
  op: EntityOperation,
  idMap: Map<string, string[]>,
  index: number
): EntityOperation {
  const ctx = `operations[${index}]`
  const { id: _id, ...rest } = op
  if (rest.op === 'create') {
    const e = rest.entity
    if (e.kind !== 'hatch') return rest
    const boundaryHandles = e.boundaryHandles
      ? resolveHandleList(e.boundaryHandles, idMap, ctx)
      : undefined
    const loops = e.loops?.map((loop): HatchLoop =>
      'handles' in loop ? { ...loop, handles: resolveHandleList(loop.handles, idMap, ctx) } : loop
    )
    return {
      ...rest,
      entity: { ...e, ...(boundaryHandles && { boundaryHandles }), ...(loops && { loops }) }
    }
  }
  if (rest.op === 'erase') {
    return { ...rest, handles: resolveHandleList(rest.handles, idMap, ctx) }
  }
  if (rest.op === 'update') {
    return {
      ...rest,
      update: { ...rest.update, handle: resolveSingleHandle(rest.update.handle, idMap, ctx) }
    }
  }
  const t = rest.transform
  const handles = resolveHandleList(t.handles, idMap, ctx)
  if (t.op === 'arrayPath') {
    const path =
      'handle' in t.path ? { handle: resolveSingleHandle(t.path.handle, idMap, ctx) } : t.path
    return { ...rest, transform: { ...t, handles, path } }
  }
  return { ...rest, transform: { ...t, handles } }
}

/**
 * Entities a step produces, known before it runs — `null` only for `arrayPath` `spacing` along a
 * `path.handle` (the curve's length, and so the item count, is only known once resolved against the
 * drawing). `arrayCopyCount` reads the same fields on both the wire and pre-wire transform shapes
 * (op/handles/rows/columns/count/path/spacing); it never constructs or validates one.
 */
function producedCount(op: EntityOperation): number | null {
  if (op.op === 'create') return 1
  if (op.op === 'erase') return op.handles.length
  if (op.op === 'update') return 1 // preserves the one existing entity handle
  const t = op.transform
  if (t.op === 'arrayRect' || t.op === 'arrayPolar' || t.op === 'arrayPath') {
    if (t.op === 'arrayPath' && t.spacing != null && 'handle' in t.path) return null
    return arrayCopyCount(t as unknown as EntityTransformInput)
  }
  return t.handles.length // move, rotate, scale, copy, mirror: unchanged count, no clones or 1:1
}

/**
 * Splits `steps` into contiguous waves, each sent to the bridge as one `operations.apply` call. A
 * new wave starts before any step whose `@ref` targets an id still pending in the current (unsent)
 * wave, and right after any step whose own produced count isn't known ahead of execution — so
 * counting entities back to steps within one wave (`applyOperationsBatch` below) never needs a
 * count it doesn't have.
 */
function partitionWaves(steps: EntityOperation[]): number[][] {
  const waves: number[][] = []
  let current: number[] = []
  const pending = new Set<string>()
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    if (current.length > 0 && stepRefs(step).some((id) => pending.has(id))) {
      waves.push(current)
      current = []
      pending.clear()
    }
    current.push(i)
    if (step.id != null) pending.add(step.id)
    if (producedCount(step) == null) {
      waves.push(current)
      current = []
      pending.clear()
    }
  }
  if (current.length > 0) waves.push(current)
  return waves
}

/** Duplicate ids, and `@ref`s that are unknown or reference a step that hasn't run yet. */
function validateRefs(steps: EntityOperation[]): void {
  const idDefinedAt = new Map<string, number>()
  for (let i = 0; i < steps.length; i++) {
    const id = steps[i]!.id
    if (id == null) continue
    const prior = idDefinedAt.get(id)
    if (prior != null) {
      throw invalidOperation(
        `operations[${i}]: duplicate id "${id}" (already used at operations[${prior}])`
      )
    }
    idDefinedAt.set(id, i)
  }
  for (let i = 0; i < steps.length; i++) {
    for (const id of stepRefs(steps[i]!)) {
      const producer = idDefinedAt.get(id)
      if (producer == null) {
        throw invalidOperation(
          `operations[${i}]: unknown batch reference "@${id}" — no step defines id "${id}"`
        )
      }
      if (producer >= i) {
        throw invalidOperation(
          `operations[${i}]: "@${id}" references operations[${producer}], which hasn't run yet — ` +
            `forward references aren't allowed`
        )
      }
    }
  }
}

interface ApplyOperationsOptions {
  documentName: string | undefined
  taskId?: string
  view?: { follow?: 'off' | 'fit' | 'pan' }
  progressive?: boolean
  paceMs?: number
  /**
   * Dedupe key for the resulting `operations.apply` call(s) (#9). When `steps` splits into more
   * than one wave (a same-call `@ref` chain), each wave gets its own `${idempotencyKey}#${wave}` —
   * the common single-wave case sends the key unchanged.
   */
  idempotencyKey?: string
  /** Forwarded to the Device Gateway so an MCP client cancellation can reach the Bridge (#9). */
  signal?: AbortSignal
  /**
   * Native revision precondition (#413 phase A). Forwarded ONLY on the first wave's wire call --
   * a multi-wave batch's own earlier waves legitimately advance the revision, so re-sending it on
   * wave 2+ would always spuriously conflict.
   */
  expectedRevision?: string
  /**
   * Per-entity write-set precondition (#413 phase B): handle -> state digest from a prior
   * entity.get(detail:"full"). Unlike expectedRevision this is forwarded on EVERY wave — a handle's
   * own digest only moves if something else edited it, which is exactly the conflict being guarded.
   */
  expectedState?: Record<string, string>
}

/**
 * Resolves `@ref`s against the handles each `id`-tagged step actually produces and sends `steps` to
 * the bridge, in as few `operations.apply` requests as the refs in it require (one, when there are
 * none). Returns the same shape one `RpcMethod.OperationsApply` call would, with `entityRefs` and
 * `failedStep` in original-array order/index regardless of how many waves ran.
 */
export async function applyOperationsBatch(
  bridge: BridgeClient,
  steps: EntityOperation[],
  options: ApplyOperationsOptions
): Promise<OperationsApplyResult> {
  validateRefs(steps)
  const waves = partitionWaves(steps)
  const idMap = new Map<string, string[]>()
  const mergedRefs: EntityRef[] = []
  // #413 phase B: stale-fingerprint skips accumulate across waves.
  const mergedConflicts: StateConflict[] = []
  const committedBatchIds: string[] = []
  const phases: PhaseExecutionInfo[] = []
  let batchId: string | undefined
  let sequence: number | undefined
  let undo: OperationsApplyResult['undo']
  const executionId = options.idempotencyKey ?? `exec_${Date.now()}`

  for (const [waveIndex, waveIndices] of waves.entries()) {
    if (options.signal?.aborted) {
      const hasPriorCommits = committedBatchIds.length > 0 || mergedRefs.length > 0
      phases.push({
        phase: waveIndex,
        status: 'cancelled',
        entityCount: 0,
        error: 'Execution cancelled before wave started'
      })
      return {
        executionId,
        status: 'cancelled',
        partial: hasPriorCommits,
        batchId,
        sequence,
        undo,
        committedBatchIds,
        completedPhases: waveIndex,
        totalPhases: waves.length,
        phases,
        entityRefs: mergedRefs,
        error: {
          code: BridgeErrorCode.TransactionFailed,
          message: 'Operation cancelled',
          failedStep: waveIndices[0] ?? null
        }
      }
    }

    const waveOps = waveIndices.map((i) => resolveStep(steps[i]!, idMap, i))
    let result: OperationsApplyResult
    try {
      result = await bridge.request(
        RpcMethod.OperationsApply,
        {
          operations: waveOps,
          documentName: options.documentName,
          taskId: options.taskId,
          view: options.view,
          progressive: options.progressive,
          paceMs: options.paceMs,
          idempotencyKey: options.idempotencyKey
            ? waves.length > 1
              ? `${options.idempotencyKey}#${waveIndex}`
              : options.idempotencyKey
            : undefined,
          expectedRevision: waveIndex === 0 ? options.expectedRevision : undefined,
          expectedState: options.expectedState
        },
        { signal: options.signal }
      )
    } catch (err: unknown) {
      const hasPriorCommits = committedBatchIds.length > 0 || mergedRefs.length > 0
      const isCancelled = options.signal?.aborted
      phases.push({
        phase: phases.length,
        status: isCancelled ? 'cancelled' : 'failed',
        entityCount: 0,
        error: err instanceof Error ? err.message : String(err)
      })
      const status = isCancelled ? 'cancelled' : hasPriorCommits ? 'partial' : 'outcome_unknown'
      return {
        executionId,
        status,
        partial: hasPriorCommits,
        ...(mergedConflicts.length > 0 && { conflicts: mergedConflicts }),
        batchId,
        sequence,
        undo,
        committedBatchIds,
        completedPhases: waveIndex,
        totalPhases: waves.length,
        phases,
        entityRefs: mergedRefs,
        error: {
          code: BridgeErrorCode.TransactionFailed,
          message: err instanceof Error ? err.message : String(err),
          failedStep: waveIndices[0] ?? null,
          ...(err instanceof BridgeRpcError ? { causeCode: err.code } : {})
        }
      }
    }

    const localFailed = result.error?.failedStep
    const failedOriginalStep =
      localFailed != null ? (waveIndices[localFailed] ?? null) : (waveIndices[0] ?? null)
    const incomingBatchIds =
      result.committedBatchIds && result.committedBatchIds.length > 0
        ? result.committedBatchIds
        : result.batchId
          ? [result.batchId]
          : []

    if (result.status === 'committed') {
      committedBatchIds.push(...incomingBatchIds)
      if (result.phases && result.phases.length > 0) {
        for (const p of result.phases) {
          phases.push({ ...p, phase: phases.length })
        }
      } else {
        phases.push({
          phase: phases.length,
          status: 'committed',
          batchId: result.batchId,
          entityCount: result.entityRefs.length
        })
      }

      let cursor = 0
      for (const i of waveIndices) {
        const step = steps[i]!
        const count = producedCount(step)
        if (count == null) {
          // Unknown count: partitionWaves guarantees this is the wave's last step, so everything
          // from here to the end of this wave's refs belongs to it.
          if (step.id != null)
            idMap.set(
              step.id,
              result.entityRefs.slice(cursor).map((r) => r.handle)
            )
          break
        }
        if (step.id != null) {
          idMap.set(
            step.id,
            result.entityRefs.slice(cursor, cursor + count).map((r) => r.handle)
          )
        }
        cursor += count
      }
      mergedRefs.push(...result.entityRefs)
      if (result.conflicts?.length) mergedConflicts.push(...result.conflicts)
      batchId = result.batchId ?? incomingBatchIds[incomingBatchIds.length - 1] ?? batchId
      sequence = result.sequence ?? sequence
      undo = result.undo ?? undo
      continue
    }

    // Non-committed statuses: partial, requires_revalidation, cancelled, aborted, failed, busy, outcome_unknown, or unknown
    committedBatchIds.push(...incomingBatchIds)
    if (result.entityRefs && result.entityRefs.length > 0) {
      mergedRefs.push(...result.entityRefs)
    }
    // Skips recorded by a wave's COMMITTED phases must stay truthful on partial/aborted merges too.
    if (result.conflicts?.length) mergedConflicts.push(...result.conflicts)
    if (result.phases && result.phases.length > 0) {
      for (const p of result.phases) {
        phases.push({ ...p, phase: phases.length })
      }
    } else {
      phases.push({
        phase: phases.length,
        status: result.status,
        batchId: result.batchId,
        entityCount: result.entityRefs?.length ?? 0,
        error: result.error?.message
      })
    }

    const hasPriorCommits = committedBatchIds.length > 0 || mergedRefs.length > 0
    const isCancelled = options.signal?.aborted || result.status === 'cancelled'

    let finalStatus: OperationsApplyResult['status']
    if (isCancelled) {
      finalStatus = 'cancelled'
    } else if (result.status === 'partial') {
      finalStatus = 'partial'
    } else if (result.status === 'requires_revalidation') {
      finalStatus = 'requires_revalidation'
    } else if (
      result.status === 'aborted' ||
      result.status === 'failed' ||
      result.status === 'busy' ||
      result.status === 'outcome_unknown'
    ) {
      finalStatus = hasPriorCommits ? 'partial' : result.status
    } else {
      // Unknown status -> fail closed
      finalStatus = hasPriorCommits ? 'partial' : 'failed'
    }

    return {
      executionId,
      status: finalStatus,
      partial: hasPriorCommits || result.status === 'partial',
      ...(mergedConflicts.length > 0 && { conflicts: mergedConflicts }),
      batchId: result.batchId ?? incomingBatchIds[incomingBatchIds.length - 1] ?? batchId,
      sequence: sequence ?? result.sequence,
      undo: undo ?? result.undo,
      committedBatchIds,
      completedPhases: waveIndex + (result.completedPhases ? 1 : 0),
      totalPhases: waves.length,
      phases,
      entityRefs: mergedRefs,
      error: {
        code: result.error?.code ?? BridgeErrorCode.TransactionFailed,
        message:
          result.error?.message ??
          (result.status === 'requires_revalidation'
            ? 'Execution requires revalidation'
            : result.status === 'partial'
              ? 'Wave execution partially committed'
              : 'Wave execution aborted'),
        failedStep: failedOriginalStep,
        causeCode: result.error?.causeCode
      }
    }
  }

  return {
    executionId,
    status: 'committed',
    partial: false,
    entityRefs: mergedRefs,
    ...(mergedConflicts.length > 0 && { conflicts: mergedConflicts }),
    batchId,
    sequence,
    undo,
    committedBatchIds,
    completedPhases: waves.length,
    totalPhases: waves.length,
    phases
  }
}
