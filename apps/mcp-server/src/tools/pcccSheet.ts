import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { EntityOperation, Point3d } from '@aleph-connector/cad-protocol'
import { hashCanonical } from '@aleph-connector/engineering'
import {
  planSheetList,
  compileSheetList,
  type SheetEntryInput,
  type SheetListPlan
} from '@aleph-connector/engineering/src/pccc/sheet-list.js'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { applyBatch } from './applyBatch.js'
import { verifyPcccApply, resolveDrawingUnits } from './pcccVerify.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId } from './shared.js'
import { refsResultMode } from './resultShape.js'
import { idempotencyKey } from '@aleph-connector/cad-tools'
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

/**
 * Sheet-list executor — the DANH MỤC BẢN VẼ (drawing index) sheet.
 *
 * The reference deliverable (CTY Bách Khoa PCCC) carries an index sheet listing every sheet in
 * the set: banner, one band per section, one row per sheet, a totals row whose sum equals the
 * actual sheet count. `pccc_overlay`/`pccc_fire_alarm_overlay` draw ON a plan drawing; this
 * tool draws the index sheet itself as ONE journaled batch — preview compiles the plan,
 * apply commits it.
 *
 * Safety posture (same as the overlay executors):
 * - projectName + sheets are REQUIRED — no design basis is fabricated.
 * - preview writes NOTHING to the drawing; apply requires a fresh, single-use, expiring plan
 *   minted on the same drawing revision, checks the drawing did not move, verifies the batch
 *   landed as planned, re-reads it, and reports the receipt — a stale/consumed/blocked plan
 *   is refused, and never redrawn.
 * - A FAIL plan (validation violations) is returned as a bounded blocked plan, not drawn.
 * - The drawing's physical units are resolved — a unitless drawing blocks the plan: the
 *   sheet's geometry is millimetres, and an unverifiable unit can never be drawn as one.
 * - Fail-closed on missing units means the sheet never silently lands at the wrong scale.
 */

const PLAN_TTL_MS = 15 * 60_000
const MAX_PLANS = 20

interface SheetPlanRecord {
  planId: string
  documentName: string
  documentRevision: string
  operations: EntityOperation[]
  /** Re-derived at apply; a planId cannot authorize a different payload. */
  planHash: string
  createdAt: number
  expiresAt: number
  consumed: boolean
  blocked: boolean
  blockedReasons: string[]
  status: 'PASS' | 'FAIL'
  title: string
  totalSheets: number
  rowCount: number
  sectionCount: number
  totalWidthMm: number
  totalHeightMm: number
  unitsPerMetre: number | null
  insUnits: string | null
  lastApplyReceipt?: Record<string, unknown>
  lastReadback?: { status: string; faithful: boolean; matchedSteps: number; totalSteps: number }
}

const plans = new Map<string, SheetPlanRecord>()

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

function planIdOf(): string {
  return `sheet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const entrySchema = z.object({
  section: z.string().describe("Section band (e.g. 'BÁO CHÁY TỰ ĐỘNG') — required data."),
  code: z.string().describe("Sheet code (e.g. 'BC-01')."),
  description: z.string().describe("Sheet description (e.g. 'HỆ THỐNG BÁO CHÁY TỰ ĐỘNG — HẦM')."),
  qty: z.number().describe("Number of sheets in this code (positive integer)."),
  size: z.string().optional().describe("Sheet size — defaults to A3."),
  note: z.string().optional().describe("Optional free-text note.")
})

const previewInput = z.object({
  operation: z.literal('preview'),
  projectName: z.string().min(1).describe('Project name — required (title banner).'),
  subtitle: z.string().optional().describe('Info-row subtitle (e.g. the project short name).'),
  address: z.string().optional().describe('Info-row address line.'),
  projectCode: z.string().optional().describe('Info-row project code.'),
  sheets: z.array(entrySchema).describe("Sheets of the deliverable — required data, no default."),
  origin: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Bottom-left of the sheet in drawing units. Default [0,0].'),
  layer: z.string().min(1).optional().describe("Layer for every emitted entity (default 'PCCC_INDEX')."),
  documentName,
  instanceId
})

const applyInput = z.object({
  operation: z.literal('apply'),
  planId: z.string().min(1).describe('planId from a fresh pccc_sheet preview on the same drawing revision.'),
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

// Exported so tests pin the required design-basis fields through the real schema.
export { inputSchema as pcccSheetInputSchema }

async function resolveDocument(
  bridge: BridgeClient,
  documentName: string | undefined
): Promise<{ name: string; revision: string }> {
  const info = await bridge.request(RpcMethod.DrawingInfo, { documentName })
  return { name: info.name, revision: info.revision ?? '' }
}

function toEntityOperations(plan: SheetListPlan, layer: string, unitsPerMm: number, origin: { x: number; y: number }): EntityOperation[] {
  const ops = compileSheetList(plan, { unitsPerMm, origin, layer })
  return ops.map((op) => ({
    op: 'create' as const,
    entity: { ...op.entity }
  })) as unknown as EntityOperation[]
}

export function registerPcccSheetTools(
  server: McpServer,
  baseBridge: BridgeClient
): void {
  server.registerTool(
    'pccc_sheet',
    {
      title: 'PCCC drawing index (DANH MỤC BẢN VẼ) sheet',
      description:
        `Draw the drawing index sheet of a PCCC deliverable: banner, subtitle info row, one band per section, ` +
        `one row per sheet (STT | NỘI DUNG | SỐ LƯỢNG | KHỔ | MÃ | GHI CHÚ), and a totals row whose sum is the ` +
        `actual sheet count. operation: preview | apply | status. ` +
        `preview: compile the deterministic plan (validation verdict, geometry heights/widths, totals) against the ` +
        `drawing and mint a bounded single-use plan — preview writes NOTHING to the drawing. ` +
        `apply: draw a previewed plan as ONE journaled batch (one undo group, no per-stroke pacing) — requires a ` +
        `fresh planId, refuses a stale/consumed/expired/blocked plan, verifies the drawing did not move, and ` +
        `checks the batch landed as planned before reporting it. ` +
        `status: report one plan's state. ` +
        `projectName + sheets are REQUIRED — no design basis is fabricated. The plan is FAIL (never applied) when ` +
        `any entry misses a section/code/description, has qty < 1 or a duplicate code in one section, or the ` +
        `drawing is unitless (geometry is millimetres; an unverifiable unit must never be silently drawn). ` +
        `Texts are left-aligned at cell-left (the plugin's text DTO has no horizontal alignment field).`,
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
            hint: 'Plans live in this AutoCAD session only; preview again to mint a new one.'
          })
        }
        const expired = plan.expiresAt < Date.now()
        return textResult({
          planId: plan.planId,
          state: plan.consumed ? 'applied' : plan.blocked ? 'blocked' : expired ? 'expired' : 'ready',
          documentName: plan.documentName,
          totalSheets: plan.totalSheets,
          rowCount: plan.rowCount,
          sectionCount: plan.sectionCount,
          totalWidthMm: plan.totalWidthMm,
          totalHeightMm: plan.totalHeightMm,
          status: plan.status,
          ...(plan.blocked && { blockedReasons: plan.blockedReasons }),
          ...(plan.lastApplyReceipt && { lastApplyReceipt: plan.lastApplyReceipt }),
          ...(plan.lastReadback && { readback: plan.lastReadback }),
          expiresAt: plan.expiresAt
        })
      }

      if (input.operation === 'apply') {
        const plan = plans.get(input.planId)
        if (!plan) {
          throw new Error(`No plan "${input.planId}" in this session — run pccc_sheet preview first.`)
        }
        if (plan.consumed) {
          throw new Error(`Plan "${input.planId}" was already applied — re-preview to draw again (no duplicate batch).`)
        }
        if (plan.expiresAt < Date.now()) {
          plans.delete(input.planId)
          throw new Error(`Plan "${input.planId}" expired (>15 min) — re-preview against the current drawing.`)
        }
        if (plan.blocked) {
          throw new Error(`Plan "${input.planId}" is blocked by its own checks: ${plan.blockedReasons.join('; ')} — fix the input and re-preview.`)
        }
        const doc = await resolveDocument(bridge, input.documentName ?? plan.documentName)
        if (doc.name !== plan.documentName) {
          throw new Error(`Plan targets "${plan.documentName}" but the resolved document is "${doc.name}" — re-preview on the right tab.`)
        }
        if (doc.revision !== plan.documentRevision) {
          throw new Error(`Drawing "${doc.name}" changed since preview (${plan.documentRevision} -> ${doc.revision}) — the plan is stale; re-preview so verification matches what gets drawn.`)
        }
        // Re-derive from the stored ops: a planId can never authorize a different payload.
        if (hashCanonical(plan.operations) !== plan.planHash) {
          throw new Error(`Plan "${input.planId}" failed integrity check — re-preview.`)
        }
        requireVisualReview(plan.operations.length, input.capture, input.visualReview)

        plan.consumed = true
        const taskId = operationKey(ctx, input.idempotencyKey)
        const { refs, payload, claim } = await applyBatch(bridge, plan.operations, {
          documentName: plan.documentName,
          ensureLayer: true,
          result: input.result ?? 'summary',
          view: { follow: 'off' },
          progressive: false,
          paceMs: 0,
          idempotencyKey: taskId,
          taskId,
          signal: ctx.mcpReq.signal,
          expectedRevision: plan.documentRevision
        })
        plan.lastApplyReceipt = {
          status: payload.status,
          batchId: payload.batchId,
          executionId: payload.executionId,
          committedOperations: payload.committedOperations
        }
        if (payload.status !== 'committed') {
          throw new Error(`Plan "${input.planId}" was not committed (apply reported status "${String(payload.status)}") — nothing is reported as drawn.`)
        }
        if (refs.length === 0 && plan.operations.length > 0) {
          throw new Error(`Plan "${input.planId}" applied 0 entities for ${plan.operations.length} planned operations — the batch is not reported committed.`)
        }
        let readback: { status: string; faithful: boolean; matchedSteps: number; totalSteps: number }
        try {
          const report = await verifyPcccApply(
            bridge,
            plan.documentName,
            plan.operations,
            plan.unitsPerMetre ?? 1000
          )
          readback = {
            status: report.status,
            faithful: report.faithful,
            matchedSteps: report.stats.matchedSteps,
            totalSteps: report.stats.totalSteps
          }
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
            `Post-apply read-back verification FAILED for plan "${input.planId}" (${readback.matchedSteps}/${readback.totalSteps} steps matched). ` +
            `The batch committed but did not land as planned — it is not reported committed. Revert it with ` +
            `operations.revert(taskId "${taskId}") before retrying — the plan is consumed and a fresh apply would duplicate the entities.`
          )
        }
        plan.lastReadback = readback
        return withCapture(
          bridge,
          {
            planId: plan.planId,
            title: plan.title,
            totalSheets: plan.totalSheets,
            rowCount: plan.rowCount,
            sectionCount: plan.sectionCount,
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

      // --- preview (default)
      const plan = planSheetList({
        projectName: input.projectName,
        subtitle: input.subtitle,
        address: input.address,
        projectCode: input.projectCode,
        sheets: input.sheets as SheetEntryInput[]
      })

      const doc = await resolveDocument(bridge, input.documentName)
      const units = await resolveDrawingUnits(bridge, input.documentName)

      // A unitless drawing blocks the plan: geometry is millimetres, and a missing unit can never
      // be silently drawn at scale 1.
      const blockedReasons: string[] = [...plan.violations]
      let blocked = plan.status === 'FAIL'
      if (!units) {
        blocked = true
        blockedReasons.push('drawing declares no physical unit (insUnits) — resolve it before drawing a millimetre sheet')
      }

      const layer = input.layer ?? 'PCCC_INDEX'
      const origin: { x: number; y: number } = input.origin ? { x: input.origin[0], y: input.origin[1] } : { x: 0, y: 0 }
      const operations = toEntityOperations(plan, layer, units?.unitsPerMm ?? 1, origin)

      const planId = planIdOf()
      prunePlans()
      const createdAt = Date.now()
      plans.set(planId, {
        planId,
        documentName: doc.name,
        documentRevision: doc.revision,
        operations,
        planHash: hashCanonical(operations),
        createdAt,
        expiresAt: createdAt + PLAN_TTL_MS,
        consumed: false,
        blocked,
        blockedReasons,
        status: plan.status,
        title: plan.title || input.projectName,
        totalSheets: plan.totalSheets,
        rowCount: plan.rowCount,
        sectionCount: plan.sections.length,
        totalWidthMm: plan.geometry.totalWidthMm,
        totalHeightMm: plan.geometry.totalHeightMm,
        unitsPerMetre: units?.unitsPerMetre ?? null,
        insUnits: units?.insUnits ?? null
      })

      return textResult({
        planId,
        documentName: doc.name,
        status: plan.status,
        blocked,
        blockedReasons: blocked ? blockedReasons : undefined,
        title: plan.title,
        totalSheets: plan.totalSheets,
        rowCount: plan.rowCount,
        sectionCount: plan.sections.length,
        totalWidthMm: plan.geometry.totalWidthMm,
        totalHeightMm: plan.geometry.totalHeightMm,
        geometry: {
          totalWidthMm: plan.geometry.totalWidthMm,
          totalHeightMm: plan.geometry.totalHeightMm,
          bannerHeightMm: plan.geometry.bannerHeightMm,
          infoRowHeightMm: plan.geometry.infoRowHeightMm,
          headerHeightMm: plan.geometry.headerHeightMm,
          rowHeightMm: plan.geometry.rowHeightMm,
          totalsRowHeightMm: plan.geometry.totalsRowHeightMm,
          columnMm: plan.geometry.columnMm
        },
        sections: plan.sections.map((s) => ({
          section: s.section,
          rowCount: s.rows.length,
          totalSheets: s.total
        })),
        operations: operations.length
      })
    })
  )
}
