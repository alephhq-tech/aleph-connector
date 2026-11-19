import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@arcdio/cad-protocol'
import type { CreateEntityParams, EntityOperation, Point3d } from '@arcdio/cad-protocol'
import {
  generateSprinklerLayout,
  routeSprinklerPipes,
  verifyEngineeringDesign,
  hashCanonical,
  outOfScopeViolation
} from '@arcdio/engineering'
import type {
  Point2D,
  SprinklerHead,
  VerificationFinding,
  PlanReadbackReport
} from '@arcdio/engineering'
import {
  checkOperationsScope,
  resolveDrawingUnits,
  SCOPE_TOLERANCE_MM,
  verifyPcccApply
} from './pcccVerify.js'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { applyBatch } from './applyBatch.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { refsResultMode } from './resultShape.js'
import { idempotencyKey } from '@arcdio/cad-tools'
import { textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'
import { outcomeMeta } from './attestOutcome.js'
import {
  captureOption,
  captureSize,
  requireVisualReview,
  visualReviewOption,
  withCapture
} from './capture.js'
import { resolveSymbolCatalogEntry } from '@arcdio/cad-state'
import { DRAWING_OPEN_TIMEOUT_MS } from './drawing.js'
import type { RegionGeometrySource } from './floorplanCadState.js'
import {
  boundaryOutsideRegion,
  createRegionCache,
  designRegionCacheKey,
  locateRoom,
  operationsOutsideRegion,
  resolvedRoomSummary,
  type RegionCache,
  resolveDesignRegion,
  resolveExcludedRings,
  verifyBlockFootprints
} from './pcccRegion.js'

/**
 * Task-level PCCC overlay executor (Epic #413 §11.3/§13.3).
 *
 * The measured baseline (#413 §13.1) showed ~85 model calls per heavy CAD run for ~60 CAD
 * tool calls — the LLM was hand-drawing every head and pipe segment. This tool compiles the
 * WHOLE overlay inside this process: the existing @arcdio/engineering planners run in-process,
 * data moves as local variables, and the drawing receives ONE journaled operations.apply
 * batch. The model sees only bounded counts/verdicts, never hundreds of coordinate arrays.
 *
 * Safety posture (nothing here is trusted from the model):
 * - hazardGroup/riserLocation/symbol block name are REQUIRED inputs — no design-basis default
 *   is fabricated (§11.2). Missing hazard classification = no plan.
 * - Every referenced block must already exist in the target drawing (block.inspect); missing
 *   symbols fail closed with the drawing's block list instead of drawing primitives.
 * - preview stores a single-use, expiring plan keyed to the resolved document AND its
 *   revision; apply refuses stale/consumed/expired plans.
 * - Geometry FAIL findings (spacing violations) block apply. INSUFFICIENT_DATA never becomes
 *   a compliance claim — the tri-state verdict travels into the result verbatim.
 * - apply sends progressive:false + paceMs:0: the scheduler's 70 ms single-stroke pacing is
 *   Live Drawing UX for interactive drafting; a machine batch commits in one transaction
 *   (CadOperationScheduler partitions non-progressive batches whole, so no phase delays fire).
 */

interface OverlayPlanRecord {
  planId: string
  documentName: string
  documentRevision: string
  operations: EntityOperation[]
  /** Re-derived at apply; a planId cannot authorize ops it was not minted for. */
  planHash: string
  createdAt: number
  expiresAt: number
  consumed: boolean
  headCount: number
  pipeSegmentCount: number
  layoutStatus: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
  blocked: boolean
  blockedReasons: string[]
  verificationFindings: Array<{ checkId: string; status: string }>
  /** Approved catalog symbol the target lacks: preview only PROVES the library holds it, apply
   * clones it. Null when the drawing already has the block, no catalog entry applies, or the
   * entry is `geometryJson`-sourced (see `pendingDefinition` instead). */
  pendingImport: PendingSymbolImport | null
  /** Approved catalog symbol sourced from inline geometry (Slice 06): apply builds the definition
   * via `block.ensureDefinition`, no library DWG ever opens. Null when the drawing already has the
   * block or the entry is library-sourced instead (see `pendingImport`). */
  pendingDefinition: PendingBlockDefinition | null
  /** E9 scope: the room polygon(s) every placed device must stay inside, re-checked at apply. */
  scope: Point2D[][]
  /** Caller-supplied riser anchor (exempt from the scope gate: it sits outside the room). */
  riserLocation: Point2D
  /** Resolved drawing units (E8), for the apply-time scope tolerance and read-back. Null when
   * the drawing declares no physical unit: the plan is blocked, and the draw path refuses rather
   * than measuring in millimetres. */
  unitsPerMetre: number | null
  insUnits: string | null
  lastApplyReceipt?: Record<string, unknown>
  lastReadback?: { status: string; faithful: boolean; matchedSteps: number; totalSteps: number }
}

/** Kept out of `preview` on purpose: a read-only plan check must never write to the user's DWG.
 * `libraryHandle` is the model-space instance whose definition `entity.copyTo` deep-clones. */
interface PendingSymbolImport {
  libraryPath: string
  libraryHandle: string
  blockName: string
}

/** Kept out of `preview` on purpose, same reason as `PendingSymbolImport`: `block.ensureDefinition`
 * mutates (creates the definition), so it waits for `apply` even though no DWG ever opens. */
interface PendingBlockDefinition {
  blockName: string
  entities: Record<string, unknown>[]
}

const PLAN_TTL_MS = 15 * 60_000
const MAX_PLANS = 20
const plans = new Map<string, OverlayPlanRecord>()

function prunePlans(): void {
  const now = Date.now()
  for (const [id, plan] of plans) {
    if (plan.expiresAt < now) plans.delete(id)
  }
  while (plans.size > MAX_PLANS) {
    const oldest = plans.keys().next().value as string
    plans.delete(oldest)
  }
}

const point2d = z.tuple([z.number(), z.number()])

const previewInput = z
  .object({
    operation: z.literal('preview'),
    floorplanName: z
      .string()
      .min(1)
      .describe(
        'The floor plan being protected (the title as the sheet writes it, e.g. "MẶT BẰNG TẦNG 5"). ' +
          "The tool reads that plan's real region from CAD and refuses to design outside it."
      ),
    floorplanLayoutName: z
      .string()
      .min(1)
      .optional()
      .describe('Exact layout tab from drawing.summary; omit for the existing model-space behavior.'),
    // Preferred: name the room the drawing already told you about. `roomRef` is the handle
    // `drawing.inspect_floorplan` published for it on this revision; `roomName` is the sheet's own
    // label. Either resolves to the closed outline the drawing has, which is what stops a sprinkler
    // grid being laid over a box copied from a container's extents.
    roomRef: z.string().optional(),
    roomName: z.string().optional(),
    roomBoundary: z
      .array(point2d)
      .min(3)
      .optional()
      .describe(
        'Closed room polygon ONLY with acceptCallerGeometry:true, and ONLY when inspect could not ' +
          'bind a ring (boundaryStatus unresolved/ambiguous). Must come from entity.traceBoundary — ' +
          'never typed from a brief. Prefer roomRef/roomName so the outline comes from CAD.'
      ),
    acceptCallerGeometry: z
      .literal(true)
      .optional()
      .describe(
        'Required to use roomBoundary / excludedBoundaries. Marks the plan as drafting-only ' +
          'caller geometry. Omit this and pass roomRef/roomName instead whenever inspect published a ref.'
      ),
    candidateIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'When inspect reported several copies of this floor plan, the 0-based copy to design on — ' +
          'same field as drawing.inspect_floorplan.candidateIndex.'
      ),
    hazardGroup: z
      .enum(['Group 1', 'Group 2', 'Group 3'])
      .describe(
        'TCVN 7336 Table 1 hazard classification, EXPLICITLY confirmed by the user or a design record — this tool never defaults it; a wrong basis is a wrong design.'
      ),
    riserLocation: point2d.describe(
      'Riser connection point [x,y] in drawing units — required to verify connectivity.'
    ),
    sprinklerSymbol: z
      .string()
      .min(1)
      .describe(
        "Symbol-catalog key (cad_symbol_catalog.key, e.g. 'fire_sprinkler_pendant') — NOT an invented block name. An APPROVED catalog entry maps it to the real block definition; if that block is missing from the drawing, preview only PROVES the approved library DWG holds it and `apply` clones it in (the definition is not part of the batch's undo group; reverting removes the drawn entities). With no catalog entry, a block that already exists in this drawing is still usable and the plan comes back `draftingOnly: true` — content, no certification; a name matching neither is a fail-closed BLOCKED listing the drawing's blocks."
      ),
    blockRotation: z
      .number()
      .optional()
      .describe('Rotation (deg) applied to every inserted symbol.'),
    blockScale: z
      .object({ x: z.number().optional(), y: z.number().optional() })
      .optional()
      .describe('Uniform per-axis scale for the symbol insert (1 = native size).'),
    attributes: z
      .record(z.string(), z.string())
      .optional()
      .describe('Block attribute tags → text; "{headId}" in a value is replaced by the head id.'),
    headLayer: z.string().min(1).default('PCCC_SPRINKLER'),
    // Preferred: the spaces to skip are named by the same handles the inspect published, so an
    // excluded server room or stair void is the drawing's own outline, not a box drawn around where
    // the model thinks the equipment stands.
    excludedRefs: z
      .array(
        z
          .object({
            ref: z.string().optional(),
            name: z.string().optional()
          })
          .refine((entry) => entry.ref !== undefined || entry.name !== undefined, {
            message: 'an excluded room needs `ref` or `name`'
          })
      )
      .optional()
      .describe(
        'Spaces to skip coverage for, each addressed by the ref (or label) that ' +
          'drawing.inspect_floorplan reported. Their closed outlines come from the drawing.'
      ),
    excludedBoundaries: z
      .array(z.array(point2d).min(3))
      .optional()
      .describe(
        'Rings to skip coverage. Requires acceptCallerGeometry:true. Only for a space the inspect ' +
          'could not bind to a label, taken from entity.traceBoundary — never typed from a brief. Prefer excludedRefs.'
      ),
    wallClearanceMm: z.number().positive().optional(),
    customMaxSpacingMm: z.number().positive().optional(),
    mainPipeOrientation: z.enum(['horizontal', 'vertical']).optional(),
    layerMain: z.string().min(1).default('PCCC_PIPE_MAIN'),
    layerBranch: z.string().min(1).default('PCCC_PIPE_BRANCH'),
    documentName,
    instanceId
  })
  .refine(
    (input) =>
      input.roomRef !== undefined ||
      input.roomName !== undefined ||
      input.roomBoundary !== undefined,
    {
      message:
        "a room needs `roomRef` (from drawing.inspect_floorplan), the sheet's `roomName`, or a `roomBoundary`"
    }
  )

const applyInput = z.object({
  operation: z.literal('apply'),
  planId: z
    .string()
    .min(1)
    .describe('planId from a fresh pccc_overlay preview on the same drawing revision.'),
  result: refsResultMode,
  capture: captureOption,
  visualReview: visualReviewOption,
  ...captureSize,
  documentName,
  instanceId,
  idempotencyKey
})

const statusInput = z.object({
  operation: z.literal('status'),
  planId: z.string().min(1),
  documentName,
  instanceId
})

const inputSchema = z.discriminatedUnion('operation', [previewInput, applyInput, statusInput])
// Exported so tests pin the required design-basis fields through the real schema (§11.2).
export { inputSchema as pcccOverlayInputSchema }

/** The authenticated caller's workspaceId when the transport carries one (HTTP + device auth).
 * A transport without it (stdio smoke) gets no catalog resolution \u2014 the fail-closed block. */
function callerWorkspaceId(ctx: {
  http?: { authInfo?: { extra?: Record<string, unknown> } }
}): string | undefined {
  const ws = ctx.http?.authInfo?.extra?.workspaceId
  return typeof ws === 'string' && ws.length > 0 ? ws : undefined
}

function toPoint3([x, y]: Point2D): Point3d {
  return { x, y, z: 0 }
}

async function resolveDocument(
  bridge: BridgeClient,
  documentName: string | undefined
): Promise<{ name: string; revision: string }> {
  const info = await bridge.request(RpcMethod.DrawingInfo, { documentName })
  return { name: info.name, revision: info.revision ?? '' }
}

async function blockExists(
  bridge: BridgeClient,
  blockName: string,
  doc: string | undefined
): Promise<boolean> {
  try {
    await bridge.request(RpcMethod.BlockInspect, { blockName, documentName: doc })
    return true
  } catch {
    return false
  }
}

async function listBlockNames(bridge: BridgeClient, doc: string | undefined): Promise<string[]> {
  const result = await bridge.request(RpcMethod.BlockList, { documentName: doc })
  return result.blocks.map((b) => b.name)
}

export function registerPcccOverlayTools(
  server: McpServer,
  baseBridge: BridgeClient,
  // The same CAD State seam `drawing.inspect_floorplan` reads, so a room named by ref resolves
  // against the geometry that published the ref. Undefined (no tenant context) fails the ref path
  // closed rather than inventing an outline.
  cadState?: RegionGeometrySource,
  /** Shared with drawing.inspect_floorplan when registered via registerAllTools. */
  sharedRegionCache?: RegionCache
): void {
  // Scopes to this registration so it can never outlive the server whose drawing it describes.
  const regionCache = sharedRegionCache ?? createRegionCache()

  server.registerTool(
    'pccc_overlay',
    {
      title: 'PCCC overlay executor (sprinkler layout + pipe network in one plan)',
      description:
        `Compile and draw a whole sprinkler overlay in ONE step instead of hand-drawing heads and pipes entity by entity. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `preview: run the deterministic planners (sprinkler grid per TCVN 7336 Table 1 spacing, pipe network with Table 4 diameters, independent connectivity verification) against the room the DRAWING defines, check the symbol block exists (reading an approved library DWG when the drawing lacks it), and return a bounded plan (counts, spacing, areas, tri-state findings) — preview writes NOTHING to the drawing. ` +
        `Address the room by the roomRef that drawing.inspect_floorplan published (or the sheet's roomName) plus floorplanName: the tool takes the closed outline from the drawing and checks it lies inside that plan's real region, blocking with ROOM_REF_UNRESOLVED (naming the refs that do resolve) or ROOM_OUTSIDE_FLOORPLAN instead of designing over a box copied from a container's extents. ` +
        `apply: draw a previewed plan as ONE journaled batch (one undo group, no per-stroke pacing) — requires the planId, clones a missing approved symbol block into the drawing first (definitions only, outside that undo group: revert removes the drawn entities, not the imported definition), fails closed if the drawing revision changed, the plan expired, a geometry check FAILED, or the plan was already used. ` +
        `status: report one plan's state (ready/blocked/applied/expired/consumed + the apply receipt). ` +
        `hazardGroup, riserLocation and the symbol block are REQUIRED: this tool never guesses a design basis, and an INSUFFICIENT_DATA standard verdict is reported verbatim — it is never promoted to "compliant". ` +
        `Never fabricate a boundary: supply roomBoundary only when the inspect could not bind a ring, and take it from entity.traceBoundary. ` +
        `Forbidden zones work the same way — list them in excludedRefs by the ref (or label) the inspect reported, and their outlines come from the drawing; a zone that resolves to no outline blocks with EXCLUDED_REF_UNRESOLVED, and one that misses the protected room blocks with EXCLUDED_OUTSIDE_ROOM, rather than being guessed. Layout, pipe routing and the independent verification all run on that one resolved set of rings.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    mutatingGuarded(async (input: z.infer<typeof inputSchema>, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)

      if (input.operation === 'status') {
        const plan = plans.get(input.planId)
        if (!plan) {
          return textResult({
            planId: input.planId,
            state: 'unknown',
            hint: 'Plans live in this AutoCAD session only; preview the layout again to mint a new one.'
          })
        }
        const expired = plan.expiresAt < Date.now()
        return textResult({
          planId: plan.planId,
          state: plan.consumed
            ? 'applied'
            : plan.blocked
              ? 'blocked'
              : expired
                ? 'expired'
                : 'ready',
          documentName: plan.documentName,
          headCount: plan.headCount,
          pipeSegmentCount: plan.pipeSegmentCount,
          layoutStatus: plan.layoutStatus,
          verificationFindings: plan.verificationFindings,
          ...(plan.blocked && { blockedReasons: plan.blockedReasons }),
          ...(plan.lastApplyReceipt && { lastApplyReceipt: plan.lastApplyReceipt }),
          ...(plan.lastReadback && { readback: plan.lastReadback }),
          expiresAt: plan.expiresAt
        })
      }

      if (input.operation === 'apply') {
        const plan = plans.get(input.planId)
        if (!plan) {
          throw new Error(
            `No plan "${input.planId}" in this session — run pccc_overlay preview first.`
          )
        }
        if (plan.consumed) {
          throw new Error(
            `Plan "${input.planId}" was already applied — re-preview to draw again (no duplicate batch).`
          )
        }
        if (plan.expiresAt < Date.now()) {
          plans.delete(input.planId)
          throw new Error(
            `Plan "${input.planId}" expired (>15 min) — re-preview against the current drawing.`
          )
        }
        if (plan.blocked) {
          throw new Error(
            `Plan "${input.planId}" is blocked by its own checks: ${plan.blockedReasons.join('; ')} — fix the design basis/geometry and re-preview.`
          )
        }
        const doc = await resolveDocument(bridge, input.documentName ?? plan.documentName)
        if (doc.name !== plan.documentName) {
          throw new Error(
            `Plan targets "${plan.documentName}" but the resolved document is "${doc.name}" — re-preview on the right tab.`
          )
        }
        if (doc.revision !== plan.documentRevision) {
          throw new Error(
            `Drawing "${doc.name}" changed since preview (${plan.documentRevision} -> ${doc.revision}) — the plan is stale; re-preview so verification matches what gets drawn.`
          )
        }
        // Re-derive from the stored ops; a planId can never authorize a different payload.
        if (hashCanonical(plan.operations) !== plan.planHash) {
          throw new Error(`Plan "${input.planId}" failed integrity check — re-preview.`)
        }
        requireVisualReview(plan.operations.length, input.capture, input.visualReview)

        // Preview only PROVED the library holds this block; the clone happens now. The revision is
        // re-read afterwards: the import moved it, and the native precondition must match the
        // drawing as it is about to be written.
        // The copy is deliberately NOT journaled under the batch's task id: its model-space
        // instance is erased immediately (only the block DEFINITION needs to arrive), and
        // operations.revert(taskId) refuses a change set whose created handle no longer exists —
        // journaling it would make the whole overlay un-revertable. The batch below carries the
        // task id, so the drawn overlay stays one revertable unit (#413 §11.5).
        let expectedRevision = plan.documentRevision
        let importedBlocks: string[] = []
        const taskId = operationKey(ctx, input.idempotencyKey)
        if (plan.pendingImport) {
          const imported = await bridge.request(
            RpcMethod.DrawingOpen,
            { path: plan.pendingImport.libraryPath, readOnly: true },
            { timeoutMs: DRAWING_OPEN_TIMEOUT_MS }
          )
          try {
            const copy = await bridge.request(RpcMethod.EntityCopyTo, {
              handles: [plan.pendingImport.libraryHandle],
              documentName: imported.name,
              targetDocumentName: doc.name
            })
            // Only the definition was wanted: drop the sample instance so no stray symbol lands
            // at the library's coordinates in the user's drawing.
            await bridge
              .request(RpcMethod.EntityErase, {
                documentName: doc.name,
                handles: (copy.copied ?? []).map((c) => c.handle)
              })
              .catch(() => undefined)
          } finally {
            // Never leave the library tab open in the user's AutoCAD, even if the copy failed.
            await bridge
              .request(RpcMethod.DrawingClose, { documentName: imported.name })
              .catch(() => undefined)
          }
          importedBlocks = [plan.pendingImport.blockName]
          expectedRevision = (await resolveDocument(bridge, plan.documentName)).revision
        } else if (plan.pendingDefinition) {
          // No library DWG to open at all: the geometry is already inline from `cad_symbol_catalog`.
          await bridge.request(RpcMethod.BlockEnsureDefinition, {
            documentName: doc.name,
            blockName: plan.pendingDefinition.blockName,
            entities: plan.pendingDefinition.entities as CreateEntityParams[]
          })
          importedBlocks = [plan.pendingDefinition.blockName]
          expectedRevision = (await resolveDocument(bridge, plan.documentName)).revision
        }

        if (plan.unitsPerMetre === null) {
          throw new Error(
            `Plan "${input.planId}" was minted without resolved drawing units — it cannot be ` +
              `measured, read back, or drawn. Re-preview after declaring units with drawing.setup.`
          )
        }
        // E9: re-check the STORED batch against the inspected region before drawing.
        // The preview gate already blocked out-of-scope heads; this refuses any plan whose stored ops place a device outside.
        const scopeViolation = checkOperationsScope(plan.operations, plan.scope, {
          tolerance: SCOPE_TOLERANCE_MM * (plan.unitsPerMetre / 1000)
        })
        if (scopeViolation) {
          throw new Error(scopeViolation)
        }

        plan.consumed = true
        const { refs, payload, claim } = await applyBatch(bridge, plan.operations, {
          documentName: plan.documentName,
          ensureLayer: true,
          result: input.result ?? 'summary',
          view: { follow: 'off' },
          // Machine batch: one transaction, no Live-Drawing pacing (§13.2).
          progressive: false,
          paceMs: 0,
          idempotencyKey: taskId,
          taskId,
          signal: ctx.mcpReq.signal,
          // #413 phase A: the check above already refuses a stale plan from TS, but that read and
          // this apply are two separate round trips -- a mutation could land in between. Forwarding
          // the SAME captured revision makes the plugin check it again atomically, right before its
          // transaction opens, closing that window completely. When this apply imported a symbol,
          // the plan's own import moved the revision, so the live post-import value is the one to
          // assert.
          expectedRevision
        })
        plan.lastApplyReceipt = {
          status: payload.status,
          batchId: payload.batchId,
          executionId: payload.executionId,
          committedOperations: payload.committedOperations
        }
        // Post-apply verification: a batch that did not land is never reported committed.
        // A PNG capture cannot prove drawn geometry matches the plan, so it never substitutes.
        if (payload.status !== 'committed') {
          throw new Error(
            `Plan "${input.planId}" was not committed (apply reported status ` +
              `"${String(payload.status)}") — nothing is reported as drawn.`
          )
        }
        if (refs.length === 0 && plan.operations.length > 0) {
          throw new Error(
            `Plan "${input.planId}" applied 0 entities for ${plan.operations.length} planned ` +
              `operations — the batch is not reported committed.`
          )
        }
        let readback: PlanReadbackReport
        try {
          readback = await verifyPcccApply(
            bridge,
            plan.documentName,
            plan.operations,
            plan.unitsPerMetre
          )
        } catch (err) {
          throw new Error(
            `Post-apply read-back verification could not run for plan "${input.planId}": ` +
              `${(err as Error).message} — the batch is not reported committed. ` +
              `The batch itself already committed: revert it with operations.revert(taskId ` +
              `"${taskId}") before retrying — the plan is consumed and a fresh apply would ` +
              `duplicate the entities.`
          )
        }
        if (!readback.faithful) {
          throw new Error(
            `Post-apply read-back verification FAILED for plan "${input.planId}": ` +
              `${readback.discrepancies.join('; ')} (${readback.stats.matchedSteps}/` +
              `${readback.stats.totalSteps} steps matched). The batch committed but did not ` +
              `land as planned — it is not reported committed. Revert it with ` +
              `operations.revert(taskId "${taskId}") before retrying — the plan is consumed ` +
              `and a fresh apply would duplicate the entities.`
          )
        }
        plan.lastReadback = {
          status: readback.status,
          faithful: readback.faithful,
          matchedSteps: readback.stats.matchedSteps,
          totalSteps: readback.stats.totalSteps
        }
        return withCapture(
          bridge,
          {
            planId: plan.planId,
            headCount: plan.headCount,
            pipeSegmentCount: plan.pipeSegmentCount,
            ...(importedBlocks.length > 0 && { importedFromLibrary: importedBlocks }),
            ...payload,
            readback: plan.lastReadback
          },
          {
            mode: input.capture,
            handles: refs.map((ref) => ref.handle),
            review: input.visualReview,
            documentName: plan.documentName,
            width: input.width,
            height: input.height
          },
          outcomeMeta(claim)
        )
      }

      // preview
      const doc = await resolveDocument(bridge, input.documentName)

      // Same posture as `pccc_fire_alarm_overlay`: the room the design fills has to come from the
      // drawing. A sprinkler grid laid over a polygon copied off a container's extents produces a
      // hydraulically consistent, spatially wrong system, and no downstream check can see it.
      const region = await resolveDesignRegion(
        bridge,
        cadState,
        regionCache,
        doc.name && doc.revision
          ? designRegionCacheKey({
              instanceId: input.instanceId,
              documentName: doc.name,
              floorplanName: input.floorplanName,
              revision: doc.revision,
              layoutName: input.floorplanLayoutName ?? 'Model',
              candidateIndex: input.candidateIndex
            })
          : null,
        input.floorplanName,
        input.documentName,
        input.floorplanLayoutName,
        { candidateIndex: input.candidateIndex }
      )
      if ('problem' in region) {
        return textResult({
          status: 'BLOCKED',
          blockedReasons: [`FLOORPLAN_REGION_UNRESOLVED: ${region.problem}`],
          hint: 'Nothing was planned. Name the floor plan this sheet reports (and candidateIndex when there are multiple copies), then preview again.'
        })
      }
      if (
        (input.roomBoundary || (input.excludedBoundaries && input.excludedBoundaries.length > 0)) &&
        input.acceptCallerGeometry !== true
      ) {
        return textResult({
          status: 'BLOCKED',
          blockedReasons: [
            'CALLER_GEOMETRY_REQUIRES_ACCEPT: roomBoundary/excludedBoundaries need acceptCallerGeometry:true ' +
              '(drafting-only). Prefer roomRef/roomName and excludedRefs from drawing.inspect_floorplan so ' +
              'outlines come from CAD — typed boxes are how overlays land on the wrong room.'
          ],
          hint: 'Nothing was planned. Use roomRef from inspect, or re-preview with acceptCallerGeometry:true and a traceBoundary ring.'
        })
      }
      const located = locateRoom(region.rooms, { ref: input.roomRef, name: input.roomName })
      // Prefer CAD outline whenever inspect published one; caller polygon is draft-only fallback.
      const fromDrawing = located?.boundary
      const roomBoundary =
        fromDrawing ?? (input.acceptCallerGeometry === true ? input.roomBoundary : undefined)
      const boundarySource: 'cad' | 'caller' = fromDrawing ? 'cad' : 'caller'
      if (!roomBoundary) {
        return textResult({
          status: 'BLOCKED',
          blockedReasons: [
            `ROOM_REF_UNRESOLVED: no room outline for ${
              input.roomRef
                ? `ref "${input.roomRef}"`
                : `name "${input.roomName ?? '(none given)'}"`
            } — ${
              located
                ? `its boundary is ${located.boundaryStatus}: ${located.boundaryEvidence ?? 'no single closed ring contains the label'}`
                : 'this sheet does not report that room'
            }. Rooms this read resolved: ${resolvedRoomSummary(region.rooms) || '(none)'}. Pass the roomRef from drawing.inspect_floorplan, or acceptCallerGeometry:true with a roomBoundary from entity.traceBoundary.`
          ],
          hint: 'Nothing was planned. Resolve the room geometry, then preview again.'
        })
      }
      if (boundaryOutsideRegion(roomBoundary, region.bounds)) {
        return textResult({
          status: 'BLOCKED',
          blockedReasons: [
            `ROOM_OUTSIDE_FLOORPLAN: the room polygon does not lie inside ${input.floorplanName} at ` +
              `[${region.bounds.join(', ')}] (${region.basis}). Heads and pipes would be laid over the ` +
              `wrong part of the sheet — take the boundary from CAD geometry rather than coordinates.`
          ],
          hint: 'Nothing was planned. Resolve the room geometry, then preview again.'
        })
      }

      const excluded = resolveExcludedRings(
        region.rooms,
        input.excludedRefs ?? [],
        input.acceptCallerGeometry === true ? (input.excludedBoundaries ?? []) : [],
        roomBoundary
      )
      if (excluded.problems.length > 0) {
        return textResult({
          status: 'BLOCKED',
          blockedReasons: excluded.problems,
          hint: 'Nothing was planned. A forbidden zone the drawing cannot outline is a zone the layout would guess at.'
        })
      }
      // Empty array vs undefined: the planners treat both as "no exclusions", but passing what was
      // actually resolved keeps layout, routing and verification reading the same set of rings.
      const excludedBoundaries = excluded.rings.length > 0 ? excluded.rings : undefined

      // E8: resolve the drawing's real units from drawing.summary before measuring anything.
      // Unknown units block the plan here — no layout is generated on an assumed millimetre.
      const units = await resolveDrawingUnits(bridge, input.documentName)
      if (!units) {
        return textResult({
          status: 'INSUFFICIENT_DATA',
          violations: [
            'UNKNOWN_DRAWING_UNITS: drawing units are unknown (drawing.summary insUnits is ' +
              '"unitless" or unreadable) — area, spacing and length cannot be measured from ' +
              'this drawing. Declare the units with drawing.setup, then preview again.'
          ],
          hint: 'Set the drawing units (drawing.setup insUnits) and preview again.'
        })
      }
      const layout = generateSprinklerLayout({
        roomBoundary,
        hazardGroup: input.hazardGroup,
        ...(excludedBoundaries && { excludedBoundaries }),
        insUnits: units.insUnits,
        ...(input.customMaxSpacingMm != null && { customMaxSpacingMm: input.customMaxSpacingMm }),
        ...(input.wallClearanceMm != null && { wallClearanceMm: input.wallClearanceMm })
      })
      if (layout.status === 'INSUFFICIENT_DATA') {
        return textResult({
          status: 'INSUFFICIENT_DATA',
          violations: layout.violations,
          hint: 'Fix the inputs (hazard group must be one of Group 1/2/3; polygon needs real area) and preview again.'
        })
      }

      const route = routeSprinklerPipes({
        heads: layout.heads,
        riserLocation: input.riserLocation,
        insUnits: units.insUnits,
        ...(input.mainPipeOrientation && { mainPipeOrientation: input.mainPipeOrientation }),
        ...(excludedBoundaries && { excludedBoundaries }),
        ...(input.wallClearanceMm != null && { clearanceMm: input.wallClearanceMm }),
        layerMain: input.layerMain,
        layerBranch: input.layerBranch
      })

      // The independent check has to see the SAME rings the layout and the router used; verifying
      // against the caller's raw list while planning with resolved outlines would certify a different
      // design than the one that was produced.
      const report = verifyEngineeringDesign({
        targetDocument: doc.name,
        sprinklerLayout: layout,
        pipeRoute: route,
        riserLocation: input.riserLocation,
        ...(excludedBoundaries && { excludedBoundaries })
      })

      let importProblem: string | null = null
      let pendingImport: PendingSymbolImport | null = null
      let pendingDefinition: PendingBlockDefinition | null = null
      // #413 §14 B/C: the model names an APPROVED symbol-catalog KEY, not a raw block name.
      // Resolution + the 'approved' gate live in resolveSymbolCatalogEntry; no entry (or a
      // draft/deprecated one, or a transport without caller identity) = fail closed as before.
      const workspaceId = callerWorkspaceId(ctx)
      const catalogEntry = workspaceId
        ? await resolveSymbolCatalogEntry(workspaceId, input.sprinklerSymbol)
        : null
      // When an approved entry exists but the drawing lacks the block, PROVE the library holds it.
      // The clone itself is deferred to apply: a preview that deep-cloned definitions into the
      // target mutated the user's DWG, moved its revision mid-preview, and was classified `read`
      // by RunService's operation table, so the CAD State cache was never invalidated. Nothing here
      // may throw past the tool boundary: every failure becomes a blocked reason naming the entry.
      if (
        catalogEntry &&
        catalogEntry.libraryPath &&
        catalogEntry.libraryHandle &&
        !(await blockExists(bridge, catalogEntry.blockName, input.documentName))
      ) {
        const libraryPath = catalogEntry.libraryPath
        const libraryHandle = catalogEntry.libraryHandle
        try {
          const library = await bridge.request(
            RpcMethod.DrawingOpen,
            { path: libraryPath, readOnly: true },
            { timeoutMs: DRAWING_OPEN_TIMEOUT_MS }
          )
          try {
            // Read the catalog's stored handle back as a block DEFINITION rather than trusting it:
            // a stale entry that points at some other entity must not get cloned into the user's
            // drawing just because the catalog said so.
            const probed = await bridge.request(RpcMethod.BlockInspect, {
              handle: libraryHandle,
              documentName: library.name
            })
            if (probed.name !== catalogEntry.blockName) {
              importProblem =
                `Symbol catalog entry "${input.sprinklerSymbol}" points at handle ` +
                `${libraryHandle} in "${libraryPath}", which is the block ` +
                `"${probed.name}" — not "${catalogEntry.blockName}". Fix the catalog entry (cad_symbol_catalog).`
            } else {
              pendingImport = {
                libraryPath,
                libraryHandle,
                blockName: catalogEntry.blockName
              }
            }
          } finally {
            // Don't leave the library tab open in the user's AutoCAD, even if the probe failed.
            await bridge
              .request(RpcMethod.DrawingClose, { documentName: library.name })
              .catch(() => undefined)
          }
        } catch (err) {
          importProblem = `Symbol catalog entry "${input.sprinklerSymbol}" could not be read from "${libraryPath}": ${(err as Error).message}`
        }
      } else if (
        catalogEntry &&
        catalogEntry.geometryJson &&
        !(await blockExists(bridge, catalogEntry.blockName, input.documentName))
      ) {
        // No library DWG at all: the geometry is already inline, nothing to open or probe. Apply
        // builds the definition via `block.ensureDefinition`.
        pendingDefinition = {
          blockName: catalogEntry.blockName,
          entities: catalogEntry.geometryJson
        }
      }
      // Preview wrote nothing, so this is still the revision the plan is valid against.
      const current = await resolveDocument(bridge, input.documentName)
      const blockedReasons: string[] = []
      let draftingOnlySymbol = false
      if (!catalogEntry) {
        // A missing catalog entry used to block the whole plan even when the block was already a
        // definition in the user's own drawing. That gate only ever stopped honest callers, so the
        // model routed around it and drew the same entities by hand; what genuinely needs approval is
        // importing a library DWG, and that path still fails closed.
        draftingOnlySymbol = await blockExists(bridge, input.sprinklerSymbol, input.documentName)
        if (!draftingOnlySymbol) {
          const available = await listBlockNames(bridge, input.documentName)
          blockedReasons.push(
            `No APPROVED symbol-catalog entry "${input.sprinklerSymbol}" for this workspace, and no block of that name in "${current.name}" \u2014 register and approve it in the symbol catalog (cad_symbol_catalog) or import the block manually (drawing open + entity copy_to) first. Blocks in "${current.name}": ${available.slice(0, 15).join(', ') || '(none)'}.`
          )
        }
      } else if (
        !(await blockExists(bridge, catalogEntry.blockName, input.documentName)) &&
        !pendingImport &&
        !pendingDefinition
      ) {
        const available = await listBlockNames(bridge, input.documentName)
        blockedReasons.push(
          importProblem ??
            `Symbol catalog entry "${input.sprinklerSymbol}" resolves to block "${catalogEntry.blockName}", but it is still not a definition in "${current.name}" \u2014 the library DWG is stale, libraryHandle points at the wrong entity, or block.ensureDefinition failed. Blocks available: ${available.slice(0, 15).join(', ') || '(none)'}.`
        )
      }
      const failedFindings = report.findings.filter((f) => f.status === 'FAIL')
      if (layout.status === 'FAIL') {
        blockedReasons.push(
          `Layout geometry violates its own spacing table: ${layout.violations.join('; ')}`
        )
      }
      if (route.blocked || route.violations.length > 0) {
        const violDescs = route.violations.map(
          (v) =>
            `${v.segmentId} (${v.code}${v.distanceMm !== undefined ? `, ${v.distanceMm}mm` : ''})`
        )
        blockedReasons.push(`Pipe routing violates excluded boundaries: ${violDescs.join('; ')}`)
      }
      for (const f of failedFindings) {
        blockedReasons.push(`${f.checkId}: ${f.evidence}`)
      }
      // E9: every planner-placed head must lie inside the inspected room polygon.
      // Pipes are not gated: they run to the caller-supplied riser anchor outside the room.
      const scopeViolation = outOfScopeViolation(
        layout.heads.map((h) => [h.x, h.y] as Point2D),
        [roomBoundary],
        SCOPE_TOLERANCE_MM * units.unitsPerMm
      )
      if (scopeViolation) blockedReasons.push(scopeViolation)

      const operations: EntityOperation[] = [
        ...layout.heads.map((head) => ({
          op: 'create' as const,
          entity: {
            kind: 'blockReference' as const,
            layer: input.headLayer,
            // Blocked plans (no approved entry) still get inert ops \u2014 apply refuses them.
            blockName: catalogEntry?.blockName ?? input.sprinklerSymbol,
            position: toPoint3([head.x, head.y]),
            ...(input.blockRotation != null && { rotation: input.blockRotation }),
            ...(input.blockScale && {
              scale: { x: input.blockScale.x ?? 1, y: input.blockScale.y ?? 1, z: 1 }
            }),
            ...(input.attributes && {
              attributes: mapAttributes(input.attributes, head)
            })
          }
        })),
        ...route.cadOperations.map((seg) => ({
          op: 'create' as const,
          entity: {
            kind: 'line' as const,
            layer: seg.layer,
            start: toPoint3(seg.start),
            end: toPoint3(seg.end)
          }
        }))
      ]

      // The room being inside the frame is necessary, not sufficient: heads are laid on a grid
      // derived from the polygon, and a polygon that bulges past the frame (or an excluded ring that
      // pushes the route into the margin) still yields a hydraulically valid, spatially wrong system.
      if (!('problem' in region)) {
        const stray = operationsOutsideRegion(operations, region.bounds)
        if (stray.length > 0) {
          const shown = stray.slice(0, 6)
          blockedReasons.push(
            `DRAWN_OUTSIDE_FLOORPLAN: ${stray.length} of the ${operations.length} entities this plan ` +
              `would draw fall outside ${input.floorplanName} at [${region.bounds.join(', ')}] ` +
              `(${region.basis}): ${shown.join('; ')}` +
              `${stray.length > shown.length ? ` (+${stray.length - shown.length} more)` : ''}. Check ` +
              `the room outline and riserLocation against that frame.`
          )
        }

        let externalDefinitionDocumentName: string | undefined
        let libraryToClose: string | undefined
        let footprintCheck: Awaited<ReturnType<typeof verifyBlockFootprints>>
        try {
          if (pendingImport) {
            const library = await bridge.request(
              RpcMethod.DrawingOpen,
              { path: pendingImport.libraryPath, readOnly: true },
              { timeoutMs: DRAWING_OPEN_TIMEOUT_MS }
            )
            externalDefinitionDocumentName = library.name
            libraryToClose = library.name
          }
          footprintCheck = await verifyBlockFootprints(bridge, operations, region.bounds, current.name, {
            inlineDefinitions: pendingDefinition ? [pendingDefinition] : [],
            externalDefinitionDocumentName,
            externalBlockNames: pendingImport ? [pendingImport.blockName] : []
          })
        } catch (error) {
          footprintCheck = {
            status: 'unverified',
            reason: error instanceof Error ? error.message : String(error)
          }
        } finally {
          if (libraryToClose) {
            await bridge.request(RpcMethod.DrawingClose, { documentName: libraryToClose }).catch(() => undefined)
          }
        }
        if (footprintCheck.status === 'outside') {
          blockedReasons.push(
            `BLOCK_FOOTPRINT_OUTSIDE_FLOORPLAN: AutoCAD's transformed block extents ` +
              `[${footprintCheck.bounds?.join(', ') ?? 'unknown'}] leave ${input.floorplanName} ` +
              `at [${region.bounds.join(', ')}], even though the insert anchor may be inside. ` +
              `Reduce the block scale/rotation or choose a symbol that fits.`
          )
        } else if (footprintCheck.status === 'unverified') {
          blockedReasons.push(
            `BLOCK_FOOTPRINT_UNVERIFIED: the complete transformed symbol footprint could not be ` +
              `confirmed inside ${input.floorplanName}: ${footprintCheck.reason ?? 'no extents returned'}. ` +
              `Nothing will be drawn without a verified footprint.`
          )
        }
      }

      const planId = `pcccplan_${crypto.randomUUID()}`
      prunePlans()
      plans.set(planId, {
        planId,
        documentName: current.name,
        documentRevision: current.revision,
        operations,
        planHash: hashCanonical(operations),
        createdAt: Date.now(),
        expiresAt: Date.now() + PLAN_TTL_MS,
        consumed: false,
        headCount: layout.headCount,
        pipeSegmentCount: route.segments.length,
        layoutStatus: layout.status,
        blocked: blockedReasons.length > 0,
        blockedReasons,
        pendingImport,
        pendingDefinition,
        scope: [roomBoundary],
        riserLocation: input.riserLocation,
        unitsPerMetre: units.unitsPerMetre,
        insUnits: units.insUnits,
        verificationFindings: report.findings.map((f) => ({ checkId: f.checkId, status: f.status }))
      })

      return textResult({
        planId,
        documentName: current.name,
        revision: current.revision,
        status: blockedReasons.length > 0 ? 'BLOCKED' : 'ready',
        headCount: layout.headCount,
        pipeSegmentCount: route.segments.length,
        mainPipeLengthM: route.mainLengthM,
        totalPipeLengthM: route.totalLengthM,
        spacingXMm: layout.spacingXMm,
        spacingYMm: layout.spacingYMm,
        protectedAreaM2: layout.protectedAreaM2,
        averageAreaPerHeadM2: layout.averageAreaPerHeadM2,
        layoutStatus: layout.status,
        // Which geometry the grid was actually laid on: the drawing's own ring, or the caller's
        // polygon (still checked against the plan frame).
        room: {
          floorplanName: input.floorplanName,
          boundarySource,
          basis: region.basis,
          // Where the forbidden zones came from: refs resolved against the drawing, or caller rings.
          excludedFromRefs: input.excludedRefs?.length ?? 0,
          excludedFromCaller:
            input.acceptCallerGeometry === true ? (input.excludedBoundaries?.length ?? 0) : 0
        },
        overallVerification: report.overallStatus,
        findings: report.findings.map((f) => findingSummary(f)),
        totalOperations: operations.length,
        expiresAt: Date.now() + PLAN_TTL_MS,
        ...(pendingImport && {
          importAtApply: [pendingImport.blockName],
          importNote: `apply imports "${pendingImport.blockName}" from "${pendingImport.libraryPath}" before drawing — nothing has been written to the drawing yet.`
        }),
        ...(pendingDefinition && {
          importAtApply: [pendingDefinition.blockName],
          importNote: `apply builds the block "${pendingDefinition.blockName}" from inline catalog geometry before drawing — no library DWG involved, nothing has been written to the drawing yet.`
        }),
        ...((draftingOnlySymbol || boundarySource === 'caller') && {
          draftingOnly: true,
          draftingOnlyNote: [
            draftingOnlySymbol
              ? `Heads are inserted as the block "${input.sprinklerSymbol}" straight from this drawing, not from an approved symbol-catalog entry — shape and legend are drafting content only.`
              : null,
            boundarySource === 'caller'
              ? 'Room outline came from acceptCallerGeometry (caller ring), not a CAD room ref — drafting content only, not engineer-certified geometry.'
              : null
          ]
            .filter(Boolean)
            .join(' ')
        }),
        ...(blockedReasons.length > 0 && { blockedReasons }),
        hint:
          blockedReasons.length > 0
            ? 'Resolve the blockers (symbol import / geometry), then preview again; apply refuses a blocked plan.'
            : 'Call pccc_overlay apply with this planId to draw it as ONE batch. The INSUFFICIENT_DATA verdicts (if any) mean standards evidence was not verified — never report this as code compliance. overallVerification from this preview checks planner segment lists, not a fresh CAD entity read-back — apply still runs verifyPcccApply on what was drawn.'
      })
    })
  )
}

function mapAttributes(
  template: Record<string, string>,
  head: SprinklerHead
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(template).map(([tag, value]) => [tag, value.replaceAll('{headId}', head.id)])
  )
}

function findingSummary(f: VerificationFinding): {
  checkId: string
  status: string
  evidence: string
} {
  return {
    checkId: f.checkId,
    status: f.status,
    evidence: f.evidence.length > 300 ? `${f.evidence.slice(0, 300)}…` : f.evidence
  }
}
