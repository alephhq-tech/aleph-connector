import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { EntityOperation, Point3d } from '@aleph-connector/cad-protocol'
import { hashCanonical } from '@aleph-connector/engineering'
import {
  planBoqSheet,
  compileBoqSheet,
  type BoqSheetPlan
} from '@aleph-connector/engineering/src/pccc/boq-sheet.js'
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
 * BoQ sheet executor — the THỐNG KÊ VẬT TƯ (material statistics) sheet.
 *
 * The second standalone title sheet of a real Bách Khoa PCCC deliverable: banner, info row,
 * one band per section, one row per material with its per-floor quantity column. It is a
 * per-floor table — like the real reference sheet it has NO grand total row, only per-row
 * totals (Σ floor columns). `pccc_sheet` (the index sheet) and `pccc_boq` are the two
 * standalone sheets; `pccc_overlay`/`pccc_fire_alarm_overlay` draw ON a plan drawing.
 *
 * Safety posture (same as the other drawing tools):
 * - projectName + floors + sections are REQUIRED — no design basis is fabricated. The floor
 *   list is project data: it is never guessed.
 * - preview writes NOTHING to the drawing; apply requires a fresh, single-use, expiring plan
 *   minted on the same drawing revision, checks the drawing did not move, verifies the batch
 *   landed as planned, and reports the receipt — a stale/consumed/expired/blocked plan is
 *   refused, and never redrawn.
 * - A FAIL plan (validation violations) is returned as a bounded blocked plan, not drawn.
 * - The drawing's physical units are resolved — a unitless drawing blocks the plan: the
 *   sheet's geometry is millimetres, and an unverifiable unit can never be drawn as one.
 */

const PLAN_TTL_MS = 15 * 60_000
const MAX_PLANS = 20

interface BoqPlanRecord {
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
  floors: string[]
  rowCount: number
  totalWidthMm: number
  totalHeightMm: number
  unitsPerMetre: number | null
  insUnits: string | null
  lastApplyReceipt?: Record<string, unknown>
  lastReadback?: { status: string; faithful: boolean; matchedSteps: number; totalSteps: number }
}

const plans = new Map<string, BoqPlanRecord>()

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
  return `boq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const rowSchema = z.object({
  name: z.string().describe('Material name (e.g. "Chuông đèn báo cháy").'),
  unit: z.string().describe('Unit of measure (e.g. "Cái", "m", "Tủ").'),
  qty: z
    .record(z.string(), z.number())
    .describe('Per-floor quantity keyed by floor label — must cover every floor.')
})

const sectionSchema = z.object({
  section: z.string().describe('Section band title (e.g. "I — HỆ THỐNG BÁO CHÁY").'),
  rows: z.array(rowSchema).describe('Rows of this section.')
})

const previewInput = z.object({
  operation: z.literal('preview'),
  projectName: z.string().min(1).describe('Project name — required (title banner).'),
  subtitle: z.string().optional().describe('Info-row subtitle.'),
  address: z.string().optional().describe('Info-row address line.'),
  projectCode: z.string().optional().describe('Info-row project code.'),
  floors: z
    .array(z.string().min(1))
    .min(1)
    .describe("Floor labels in column order (e.g. ['Hầm','T1','T2',...,'T7','Tum']) — REQUIRED project data."),
  sections: z
    .array(sectionSchema)
    .min(1)
    .describe('The BoQ sections — REQUIRED data, no default.'),
  origin: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Bottom-left of the sheet in drawing units. Default [0,0].'),
  layer: z.string().min(1).optional().describe("Layer for every emitted entity (default 'PCCC_BOQ')."),
  documentName,
  instanceId
})

const applyInput = z.object({
  operation: z.literal('apply'),
  planId: z.string().min(1).describe('planId from a fresh pccc_boq preview on the same drawing revision.'),
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
export { inputSchema as pcccBoqInputSchema }

async function resolveDocument(
  bridge: BridgeClient,
  documentName: string | undefined
): Promise<{ name: string; revision: string }> {
  const info = await bridge.request(RpcMethod.DrawingInfo, { documentName })
  return { name: info.name, revision: info.revision ?? '' }
}

function toEntityOperations(
  plan: BoqSheetPlan,
  layer: string,
  unitsPerMm: number,
  origin: { x: number; y: number }
): EntityOperation[] {
  const ops = compileBoqSheet(plan, { unitsPerMm, origin, layer })
  return ops.map((op) => ({
    op: 'create' as const,
    entity: { ...op.entity }
  })) as unknown as EntityOperation[]
}

export function registerPcccBoqTools(
  server: McpServer,
  baseBridge: BridgeClient
): void {
  server.registerTool(
    'pccc_boq',
    {
      title: 'PCCC material statistics (THỐNG KÊ VẬT TƯ) sheet',
      description:
        `Draw the material statistics sheet of a PCCC deliverable: banner, info row, one band per section, ` +
        `one row per material (STT | TÊN | ĐVT | per-floor columns | TỔNG CỘNG). Operation: preview | apply | status. ` +
        `preview: compile the deterministic plan (validation verdict, geometry, totals) against the drawing and mint a ` +
        `bounded single-use plan — preview writes NOTHING to the drawing. ` +
        `apply: draw a previewed plan as ONE journaled batch (one undo group, no per-stroke pacing) — requires a fresh ` +
        `planId, refuses a stale/consumed/expired/blocked plan, verifies the drawing did not move, and checks the batch ` +
        `landed as planned before reporting it. ` +
        `status: report one plan's state. ` +
        `projectName + floors + sections are REQUIRED — no design basis is fabricated, and the floor list is project ` +
        `data (never guessed). The plan is FAIL (never applied) when any entry misses a name/unit, is missing qty for a ` +
        `floor, has a non-finite or negative quantity, an unknown floor key, a duplicate section or floor — or the ` +
        `drawing is unitless (geometry is millimetres). There is no grand total row — the reference sheet has only ` +
        `per-row totals (Σ floor columns). Texts are left-aligned at cell-left (the plugin's text DTO has no horizontal ` +
        `alignment field).`,
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
          floors: plan.floors,
          rowCount: plan.rowCount,
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
          throw new Error(`No plan "${input.planId}" in this session — run pccc_boq preview first.`)
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
            floors: plan.floors,
            rowCount: plan.rowCount,
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
      const plan = planBoqSheet({
        projectName: input.projectName,
        subtitle: input.subtitle,
        address: input.address,
        projectCode: input.projectCode,
        floors: input.floors,
        sections: input.sections
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

      const layer = input.layer ?? 'PCCC_BOQ'
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
        floors: plan.floors,
        rowCount: plan.rowCount,
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
        floors: plan.floors,
        rowCount: plan.rowCount,
        totalWidthMm: plan.geometry.totalWidthMm,
        totalHeightMm: plan.geometry.totalHeightMm,
        geometry: {
          totalWidthMm: plan.geometry.totalWidthMm,
          totalHeightMm: plan.geometry.totalHeightMm,
          bannerHeightMm: plan.geometry.bannerHeightMm,
          infoRowHeightMm: plan.geometry.infoRowHeightMm,
          headerHeightMm: plan.geometry.headerHeightMm,
          rowHeightMm: plan.geometry.rowHeightMm,
          sectionHeaderHeightMm: plan.geometry.sectionHeaderHeightMm,
          columnMm: plan.geometry.columnMm
        },
        sections: plan.sections.map((s) => ({
          section: s.section,
          rowCount: s.rows.length
        })),
        operations: operations.length
      })
    })
  )
}
