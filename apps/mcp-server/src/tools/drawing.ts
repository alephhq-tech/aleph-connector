import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { RpcMethod } from '@aleph-connector/cad-protocol'
import type { CadScanEntity } from '@aleph-connector/cad-protocol'
import { db } from '@aleph-connector/data'
import { cadStateService } from '@aleph-connector/cad-state'
import {
  assembleFloorplanGeometry,
  emptyGeometrySource,
  type InspectIdentity,
  type RegionGeometrySource,
  type SnapshotRow
} from './floorplanCadState.js'
import {
  drawingCheckParams,
  drawingCleanupParams,
  drawingCloseParams,
  drawingNewParams,
  drawingOpenParams,
  drawingSaveParams,
  drawingSetupParams,
  idempotencyKey
} from '@aleph-connector/cad-tools'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import type { DocumentPin } from '../bridge/PinnedBridgeClient.js'
import { withInstance } from './instanceScope.js'
import { operationKey } from './operationIdentity.js'
import { portableInputSchema } from './portableSchema.js'
import { documentName, instanceId, literalValues } from './shared.js'
import { imageResult, textResult } from './textResult.js'
import { mutatingGuarded } from './toolError.js'
import {
  designRegionCacheKey,
  rememberDesignRegion,
  type DesignRegion,
  type RegionCache
} from './pcccRegion.js'

/**
 * The `setup` operation's schema, hoisted for `drawing.test.ts`: `.strict()` rejects any key
 * outside the allowlist (`contracts/mcp-tools` `drawingSetupParams` + `documentName`) before the
 * request ever reaches the plugin, and each field's own `min`/`max` rejects out-of-range values.
 */
export const drawingSetupOperationSchema = z
  .object({
    operation: z.literal('setup'),
    ...drawingSetupParams.shape,
    documentName,
    instanceId,
    idempotencyKey
  })
  .strict()

/**
 * The `drawing` tool's full operation union, hoisted to module scope and exported so
 * `drawing.test.ts` can flatten it through `portableInputSchema` and assert the summary operation
 * exists without a field-name collision (the same reason `drawingSetupOperationSchema` is
 * exported). `registerDrawingTools` below is the only runtime consumer.
 */
export const drawingInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('info'), documentName, instanceId }),
  z.object({
    operation: z.literal('inspect_floorplan'),
    name: z
      .string()
      .min(1)
      .describe(
        "Floor plan name or search query to locate, inspect, and visualize (e.g. 'tầng hầm', 'hầm', 'basement', 'tầng 1', 'lầu 1', 'mái')."
      ),
    documentName,
    layoutName: z
      .string()
      .min(1)
      .optional()
      .describe('Exact layout tab to inspect (from drawing.summary); omitted keeps the existing model-space behavior.'),
    instanceId,
    capture: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Whether to capture and return an AutoCAD off-screen PNG snapshot of the floor plan.'
      ),
    width: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Snapshot width in pixels (default 1280).'),
    height: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Snapshot height in pixels (default 960).'),
    candidateIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'When an earlier inspect returned regionBasis "ambiguous" WITH regionCandidates, that means this plan title exists as several separate copies on the sheet. Pass the 0-based index of the copy you want; do not re-run the search with different wording.'
      )
  }),
  z.object({ operation: z.literal('summary'), documentName, instanceId }),
  z.object({ operation: z.literal('list_open'), instanceId }),
  z.object({ operation: z.literal('open'), ...drawingOpenParams.shape, instanceId }),
  z.object({ operation: z.literal('new'), ...drawingNewParams.shape, instanceId }),
  z.object({
    operation: z.literal('close'),
    ...drawingCloseParams.shape,
    documentName,
    instanceId
  }),
  z.object({
    operation: z.literal('activate'),
    documentName: z
      .string()
      .min(1)
      .describe('The tab to activate (a `name` or `documentId` from list_open).'),
    instanceId
  }),
  z.object({
    operation: z.literal('use'),
    documentName: z
      .string()
      .optional()
      .describe(
        'The tab to pin (a `name` or `documentId` from list_open). Omit to release the pin.'
      ),
    instanceId
  }),
  z.object({
    operation: z.literal('save'),
    ...drawingSaveParams.shape,
    documentName,
    instanceId,
    idempotencyKey
  }),
  drawingSetupOperationSchema,
  z.object({
    operation: z.literal('check'),
    ...drawingCheckParams.shape,
    documentName,
    instanceId
  }),
  z.object({
    operation: z.literal('cleanup'),
    ...drawingCleanupParams.shape,
    documentName,
    instanceId
  })
])

/**
 * `drawing.open`'s per-call execute timeout: opening a multi-MB DWG cold in AutoCAD routinely
 * exceeds the gateway's 15 s default (`config.ts` defaultExecuteTimeoutMs). Exported so the test
 * can pin the value next to the passthrough assertion.
 */
export const DRAWING_OPEN_TIMEOUT_MS = 60_000

/**
 * A region walk over a large model space legitimately runs longer than the gateway's 15 s default
 * (measured: a sheet with ~2400 texts + ~1400 polylines exceeded it). It MUST stay above the plugin's
 * own walk budget, otherwise the caller gives up while the AutoCAD main thread is still inside the
 * transaction: every later call on that instance times out until the walk ends, which looks like a
 * dead bridge. The plugin stops itself first and returns a fail-closed verdict instead.
 */
export const DRAWING_INSPECT_TIMEOUT_MS = 45_000

// Layout boundary assembly only consumes closed polylines. Keep each RPC page below the plugin's
// 2000-row ceiling and the total read bounded, while allowing multi-page architectural layouts.
const MAX_CAD_SCAN_PAGE_SIZE = 2_000
const MAX_LAYOUT_POLYLINE_ROWS = 10_000

/**
 * Builds the production {@link RegionGeometrySource}: reads the CAD State snapshot the run engine
 * already indexed (via the shared `@aleph-connector/data`), and hydrates only a region's full geometry
 * through one bounded `cad.scan`. It NEVER claims an index job or writes a snapshot — that single
 * scan path belongs to run-engine. `workspaceId` is the authenticated tenant from the MCP caller;
 * every lookup is scoped to it, so another workspace's snapshot can never answer.
 */
export function createCadStateSource(
  workspaceId: string,
  bridge: BridgeClient
): RegionGeometrySource {
  return {
    async snapshotFor(identity) {
      if (!identity.revision) return null
      let drawingId: string | undefined
      if (identity.fingerprintGuid) {
        const byFp = await db.cadDocuments.findByFingerprint(workspaceId, identity.fingerprintGuid)
        if (byFp) drawingId = byFp.id
      }
      if (!drawingId && identity.documentId) {
        const bySession = await db.cadDocuments.findBySession(workspaceId, identity.documentId)
        drawingId = bySession[0]?.id
      }
      if (!drawingId) return null
      // resolveAccess is the ONE freshness authority; a snapshot not verified at the live revision
      // is `mayUseForCurrentFacts:false`, so we never serve stale geometry as if it were current.
      const access = await cadStateService.resolveAccess(workspaceId, drawingId, identity.revision)
      if (!access?.snapshot || !access.mayUseForCurrentFacts) return null
      return { snapshotId: access.snapshot.id, fresh: true }
    },
    async rowsInWindow(snapshotId, window, limit) {
      const rows = await db.cadSnapshotEntities.query(snapshotId, { window, limit })
      return rows.map((r) => ({
        handle: r.handle,
        kind: r.kind,
        layer: r.layer,
        blockName: r.blockName,
        geometry: r.geometry ?? null
      }))
    },
    async hydrate(handles, identity) {
      if (handles.length === 0) return []
      const page = await bridge.request(RpcMethod.CadScan, {
        handles,
        detail: 'full',
        documentName: identity.documentId ?? identity.documentName
      })
      return (page.entities as CadScanEntity[]).map((e) => ({
        handle: e.handle,
        kind: e.kind,
        layer: e.layer,
        blockName: e.blockName,
        geometry: e.geometry ?? null
      }))
    },
    async scanLayout(layoutName, identity, limit) {
      const requestedLayout = layoutName.trim()
      const pageSize = Number.isFinite(limit) && limit > 0
        ? Math.max(1, Math.min(Math.floor(limit), MAX_CAD_SCAN_PAGE_SIZE))
        : MAX_CAD_SCAN_PAGE_SIZE
      const rows: SnapshotRow[] = []
      let expectedTotal: number | undefined
      let expectedDocumentId = identity.documentId
      let expectedRevision = identity.revision
      let offset = 0
      const incomplete = (note: string) => ({ rows: [], complete: false, note })

      while (true) {
        const page = await bridge.request(RpcMethod.CadScan, {
          documentName: identity.documentId ?? identity.documentName,
          layoutName: requestedLayout,
          kind: 'polyline',
          offset,
          limit: pageSize,
          detail: 'full'
        }, {
          timeoutMs: DRAWING_INSPECT_TIMEOUT_MS
        })
        const layoutMatches =
          page.layoutName?.trim().toLowerCase() === requestedLayout.toLowerCase()
        if (!layoutMatches) {
          return incomplete(`CAD scan did not confirm layout "${requestedLayout}"; no partial boundaries were used`)
        }
        const pageDocumentId = typeof page.documentId === 'string' ? page.documentId.trim() : ''
        if (!pageDocumentId) {
          return incomplete('CAD scan did not confirm the drawing identity; no partial boundaries were used')
        }
        if (expectedDocumentId && pageDocumentId !== expectedDocumentId) {
          return incomplete('CAD scan resolved a different document than the floor-plan inspection; no partial boundaries were used')
        }
        expectedDocumentId ??= pageDocumentId
        const sameRevision =
          Boolean(page.revisionBefore) &&
          page.revisionBefore === page.revisionAfter &&
          (!expectedRevision || page.revisionBefore === expectedRevision)
        if (!sameRevision) {
          return incomplete('layout changed during or after the scan; no partial boundaries were used')
        }
        expectedRevision ??= page.revisionBefore
        if (page.offset !== offset) {
          return incomplete('CAD scan returned an unexpected page offset; no partial boundaries were used')
        }
        if (!Number.isSafeInteger(page.total) || page.total < 0) {
          return incomplete('CAD scan returned an invalid layout total; no partial boundaries were used')
        }
        if (expectedTotal === undefined) expectedTotal = page.total
        else if (page.total !== expectedTotal) {
          return incomplete('layout changed during or after the scan; no partial boundaries were used')
        }
        if (expectedTotal > MAX_LAYOUT_POLYLINE_ROWS) {
          return incomplete(`layout has more than ${MAX_LAYOUT_POLYLINE_ROWS} polylines; no partial boundaries were used`)
        }
        if (!Array.isArray(page.entities) || page.entities.length > pageSize) {
          return incomplete('CAD scan returned an invalid page; no partial boundaries were used')
        }

        const nextOffset = offset + page.entities.length
        if (
          (page.hasMore && page.entities.length === 0) ||
          nextOffset > expectedTotal ||
          page.hasMore !== (nextOffset < expectedTotal)
        ) {
          return incomplete('CAD scan returned inconsistent pagination; no partial boundaries were used')
        }
        rows.push(...(page.entities as CadScanEntity[]).map((entity) => ({
          handle: entity.handle,
          kind: entity.kind,
          geometry: entity.geometry ?? null
        })))

        if (!page.hasMore) {
          return rows.length === expectedTotal
            ? { complete: true, rows }
            : incomplete('layout scan was incomplete; no partial boundaries were used')
        }
        offset = nextOffset
      }
    }
  }
}

export function registerDrawingTools(
  server: McpServer,
  baseBridge: BridgeClient,
  pin: DocumentPin,
  // Optional for the 5 `createServer` callers/tests that carry no tenant context: without a source
  // the inspect fails closed (rooms unresolved), never fabricating a boundary.
  cadState?: RegionGeometrySource,
  /** Shared with PCCC overlays so a successful inspect answers the next preview without re-walking. */
  regionCache?: RegionCache
): void {
  const inputSchema = drawingInputSchema

  server.registerTool(
    'drawing',
    {
      title:
        'Drawing (info, summary, open/new/close/activate tabs, list_open, save, setup, quality check, cleanup)',
      description:
        `Drawing-level information, saving, unit/scale setup, and quality control. operation: ${literalValues(inputSchema.options, 'operation').join(' | ')}. ` +
        `info: name, path, entity/layer counts, modified, current annotationScale. ` +
        `summary: ONE cheap read-only pass that makes a large DWG legible without paging entity.list — ` +
        `total model-space entity count, every layer with its entity count (empty layers included), ` +
        `drawing extents, units/annotationScale, block-reference inventory (top 50 names by count, ` +
        `hasMore flag), attached xrefs with load status, a preview of up to 30 free-standing ` +
        `text/mtext strings with their layers, plus up to 30 block-attribute values (blockTexts, ` +
        `each tagged with its block name — this is where a title block's project name / drawing ` +
        `number / scale / date actually lives, from model space AND every paper layout's own ` +
        `title block, tagged with \`layout\` when it came from a sheet), and layout names. Call it first on any ` +
        `drawing you have not seen; then read just the region you care about with entity → list \`window\`. ` +
        `open: open an existing DWG/DXF file from disk path into AutoCAD. ` +
        `new: create a new drawing tab (optionally with template .dwt). ` +
        `close: close a tab (discard by default, or save: true). ` +
        `activate: switch AutoCAD's active MDI tab to documentName. ` +
        `list_open: every open tab — pass its ` +
        `\`name\` (or its stable \`documentId\`) as documentName to any tool. use: pin a tab so every ` +
        `call that names no documentName goes there even if the user clicks another tab (a closed ` +
        `pinned tab fails with DocumentNotFound); no documentName releases the pin. A pin taken with an ` +
        `instanceId also binds that process: later unscoped calls go to the same AutoCAD window, and a ` +
        `pin-bound call that names a different instance fails with PinnedInstanceMismatch instead of ` +
        `silently retargeting. save: QSAVE, or SAVEAS when \`path\` is given ` +
        `— path must be an absolute .dwg path, and once this drawing already has a file of its own, inside that same folder; ` +
        `overwriting an existing file other than that one needs \`overwrite: true\` (only save when the user asked). ` +
        `setup: apply insUnits/linearUnits/linearPrecision/angularUnits/` +
        `ltScale/celtScale/dimScale/lwDisplay (or the \`scale\` convenience: ltScale = scale * 0.5, dimScale = scale), and ` +
        `annotationScale (e.g. "1:100" — sets CANNOSCALE, adds it to the scale list if missing, and makes entity.create's ` +
        `mtext/text.singleLine/dimension.linear/aligned/ordinate/hatch default to annotative afterward) in one ` +
        `undoable transaction; returns every setting read back from the drawing. Call it before drawing at a plot scale. ` +
        `check: read-only quality pass — ` +
        `duplicates, overlaps, zeroLength, openOutlines, layerZero, textSize, dimOverride, ` +
        `offExtents (default: all 8), optionally scoped to \`handles\`/\`layer\`/\`window\`; each ` +
        `finding has a \`check\`, \`severity\`, \`handles\`, \`message\`, and an optional \`fix\` name ` +
        `for cleanup. Run it after every drawing phase. cleanup: the safe fixes — duplicates, ` +
        `zeroLength, purge (unused layers/blocks/styles/linetypes), audit (not implemented — fails ` +
        `the call, see the error hint) — in one transaction and one undo step; touches only entities/layers CadAI created (user geometry and user layers are never removed); \`dryRun\` (default ` +
        `true) reports what would change without committing. Optional instanceId (every operation) ` +
        `targets another AutoCAD process when 2+ are online.`,
      inputSchema: portableInputSchema(inputSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    mutatingGuarded(async (input, ctx) => {
      const bridge = withInstance(baseBridge, input.instanceId)
      switch (input.operation) {
        case 'inspect_floorplan': {
          console.log(
            `\x1b[34m[DRAWING]\x1b[0m inspect_floorplan query="${input.name}", layout="${input.layoutName ?? 'Model'}", doc="${input.documentName ?? '(active)'}"`
          )
          const res = await bridge.request(
            RpcMethod.DrawingInspectFloorplan,
            {
              name: input.name,
              documentName: input.documentName,
              layoutName: input.layoutName,
              capture: input.capture ?? true,
              width: input.width,
              height: input.height,
              candidateIndex: input.candidateIndex ?? -1
            },
            { timeoutMs: DRAWING_INSPECT_TIMEOUT_MS }
          )
          if (
            input.layoutName &&
            res.layoutName?.toLowerCase() !== input.layoutName.toLowerCase()
          ) {
            return textResult({
              ...res,
              found: false,
              bounds: undefined,
              rooms: [],
              geometryComplete: false,
              note: `requested layout "${input.layoutName}" was not confirmed by the AutoCAD plugin; no geometry from another space was used`
            })
          }
          const roomCount = res.rooms?.length ?? 0
          const elevatorRooms = (res.rooms ?? []).filter((r: any) =>
            /thang|elevator/i.test(r.name || '')
          )
          console.log(
            `\x1b[34m[DRAWING]\x1b[0m inspect_floorplan: found=${res.found}, matched="${res.matchedName}", rooms=${roomCount}, elevatorLabels=${elevatorRooms.length}`
          )
          if (elevatorRooms.length > 0) {
            console.log(
              `\x1b[34m[DRAWING]\x1b[0m Elevator candidates:`,
              elevatorRooms.map((e: any) => `${e.name} at [${e.labelPosition?.join(', ')}]`)
            )
          }
          // `regionBasis` says how the bounds were justified. Anything but a proven frame or
          // cluster means the plugin could not attribute a rectangle to this title — say what to
          // do instead of letting the model re-inspect the same sheet with different wording, or
          // design over all of it.
          const attributed =
            res.regionBasis === 'title-frame' ||
            res.regionBasis === 'block-frame' ||
            res.regionBasis === 'connected-geometry'

          // Slice 02: an attributed region gets its rooms' real boundaries from the CAD State
          // snapshot the run engine already indexed. This is a READER, not a scanner: no snapshot
          // verified at this exact revision -> every room stays `unresolved`, never a fabricated
          // polygon. On a warm snapshot it costs zero extra AutoCAD round trips; a cold region pays
          // at most one bounded cad.scan hydrate.
          // An attributed region is enriched even with zero rooms: `geometryComplete`,
          // `coordinateSystem` and `geometryNote` are how the caller learns the region is framed but
          // label-less, instead of inferring it from their absence (measured live: every real sheet
          // returns `rooms: []` with a resolved frame).
          let enriched = res
          if (attributed && res.bounds) {
            const identity: InspectIdentity = {
              documentId: res.documentId,
              fingerprintGuid: res.fingerprintGuid,
              revision: res.revision,
              documentName: input.documentName,
              layoutName: res.layoutName ?? 'Model',
              units: res.units
            }
            const assembly = await assembleFloorplanGeometry(
              cadState ?? emptyGeometrySource,
              identity,
              res.rooms,
              res.bounds
            )
            // `ref` rides on every assembled room (attached in one place, `roomRef`), so the payload
            // and `pccc_fire_alarm_overlay`'s resolver cannot drift apart.
            enriched = {
              ...res,
              coordinateSystem: 'WCS',
              geometryComplete: assembly.geometryComplete,
              rooms: assembly.rooms,
              ...(assembly.geometryNote ? { geometryNote: assembly.geometryNote } : {})
            }
            // Publish for PCCC overlays on the same MCP server: same revision + candidateIndex →
            // resolveDesignRegion returns this without a second inspect RPC.
            if (regionCache && res.bounds && res.revision) {
              const docName = input.documentName?.trim() || pin.target?.name || ''
              if (docName) {
                const cached: DesignRegion = {
                  bounds: res.bounds,
                  basis: res.regionBasis ?? 'attributed',
                  rooms: assembly.rooms,
                  geometryComplete: assembly.geometryComplete,
                  evidenceRows: assembly.evidenceRows,
                  ...(assembly.geometryNote ? { geometryNote: assembly.geometryNote } : {})
                }
                rememberDesignRegion(
                  regionCache,
                  designRegionCacheKey({
                    instanceId: input.instanceId,
                    documentName: docName,
                    floorplanName: input.name,
                    revision: res.revision,
                    layoutName: res.layoutName ?? input.layoutName ?? 'Model',
                    candidateIndex: input.candidateIndex
                  }),
                  cached
                )
              }
            }
          }

          // A capture failure is not a reason to re-inspect: the CAD data (bounds, layers, rooms)
          // this same pass read is complete and valid; only the image is missing. Say so, and never
          // invite a reworded retry that would repeat the whole read.
          const captureFailed = res.capture?.status === 'failed'
          // The refs this read published are what the design tools consume, so naming them here is
          // what stops a caller from re-reading the sheet or retyping vertices later.
          const verifiedRefs = enriched.rooms
            .filter((r) => r.boundaryStatus === 'verified')
            .map((r) => r.ref)
            .filter((r): r is string => r !== undefined)
          const guidance = attributed
            ? captureFailed
              ? {
                  hint:
                    `The region was resolved (${res.regionBasis}) but the capture failed: ` +
                    `${res.capture?.error ?? 'no reason given'}. The CAD data above is complete — ` +
                    `do not re-inspect or re-capture to get the image; proceed from the bounds, ` +
                    `layers, and rooms, or ask the user to check the AutoCAD session.`
                }
              : verifiedRefs.length > 0
                ? {
                    hint:
                      `${verifiedRefs.length} room outline(s) above came from the drawing itself. ` +
                      `Design tools take a room by its "ref" plus its usage — do not retype ` +
                      `coordinates. Re-inspect only if the drawing changes.`
                  }
                : {}
            : res.stoppedReason === 'budget'
              ? {
                  // The walk never finished, so `availableFloorplans` is empty by construction — a hint
                  // saying "no titles found" would be false, and "design over the whole drawing" would
                  // build on a half-read sheet. Say what actually stopped and how to shrink the read.
                  hint:
                    `The region walk exceeded its time budget on this drawing and stopped before ` +
                    `choosing a region (regionBasis: unresolved, stoppedReason: budget). This is a ` +
                    `read-size limit, NOT evidence that the plan is missing: do not retry with ` +
                    `different wording, and do not design over the whole drawing. Shrink the read ` +
                    `instead — target one documentName, or ask the user to isolate/freeze the other ` +
                    `plans on the sheet. Plugin note: ${res.note ?? '(none)'}`
                }
              : res.regionCandidates && res.regionCandidates.length > 0
                ? {
                    // Not "we could not find a plan": this plan really is drawn several times on the
                    // sheet, or the index asked for was past the end. The plugin can name every copy
                    // that is actually usable, so the caller picks; re-searching with different
                    // wording changes nothing, and designing over all copies at once puts devices on
                    // the wrong floor view.
                    hint:
                      res.regionCandidates.length === 1
                        ? `Only one frame on this sheet is usable for "${res.matchedName ?? input.name}" and it is not the one at that index. Re-inspect with candidateIndex: 0 → ${JSON.stringify(res.regionCandidates[0])}. Do not search again with different wording. Plugin note: ${res.note ?? '(none)'}`
                        : `"${res.matchedName ?? input.name}" appears as ${res.regionCandidates.length} separate copies on this sheet, each with its own frame. Pick one and re-inspect with candidateIndex (0-based) — e.g. candidateIndex: 0 for ${JSON.stringify(res.regionCandidates[0])}. ` +
                          `Do not search the same sheet again with different wording, and never design over all copies at once: they are different places in the drawing. Plugin note: ${res.note ?? '(none)'}`
                  }
                : {
                    hint:
                      `No rectangle in this drawing can be attributed to ` +
                      `"${res.matchedName ?? input.name}" (regionBasis: ${res.regionBasis ?? 'unresolved'}). ` +
                      `Do not re-inspect the same sheet with different wording, and do not design over ` +
                      `the whole drawing: ask the user which plan it is, or have them close a border ` +
                      `around it. Titles found: ${(res.availableFloorplans ?? []).join(' | ') || '(none)'}.`
                  }
          if (enriched.data && enriched.mimeType) {
            const { data, mimeType, ...meta } = enriched
            return imageResult({ ...meta, ...guidance }, { data, mimeType })
          }
          return textResult({ ...enriched, ...guidance })
        }
        case 'info':
          return textResult(
            await bridge.request(RpcMethod.DrawingInfo, { documentName: input.documentName })
          )
        case 'summary':
          return textResult(
            await bridge.request(RpcMethod.DrawingSummary, {
              documentName: input.documentName
            })
          )
        case 'list_open':
          return textResult(
            await bridge.request(RpcMethod.DrawingListOpen, {}).then((listed) => ({
              documents: pin.mark(listed.documents, input.instanceId)
            }))
          )
        case 'use': {
          if (!input.documentName) {
            pin.set(undefined)
            return textResult({ pinned: null })
          }
          // Resolved by the plugin, so a short name works; what is stored is the stable id, bound to
          // the instance it was read from — with 2+ `acad.exe`, an id alone cannot say which window
          // a later unscoped call would land on (#331).
          const { documentId, name } = await bridge.request(RpcMethod.DrawingInfo, {
            documentName: input.documentName
          })
          pin.set({ documentId, name, instanceId: input.instanceId })
          return textResult({ pinned: pin.target })
        }
        case 'open':
          // Opening a multi-MB DWG cold in AutoCAD routinely exceeds the gateway's 15 s default
          // execute timeout; give this call DRAWING_OPEN_TIMEOUT_MS. The 15 s default stays for
          // everything else. drawing.check is the next candidate (a full quality pass on a huge
          // drawing can also exceed 15 s) — deliberately left alone pending that perf work.
          return textResult(
            await bridge.request(
              RpcMethod.DrawingOpen,
              {
                path: input.path,
                readOnly: input.readOnly
              },
              { timeoutMs: DRAWING_OPEN_TIMEOUT_MS }
            )
          )
        case 'new':
          return textResult(
            await bridge.request(RpcMethod.DrawingNew, {
              template: input.template
            })
          )
        case 'close':
          return textResult(
            await bridge.request(RpcMethod.DrawingClose, {
              documentName: input.documentName,
              save: input.save
            })
          )
        case 'activate':
          return textResult(
            await bridge.request(RpcMethod.DrawingActivate, {
              documentName: input.documentName
            })
          )
        case 'save':
          return textResult(
            await bridge.request(
              RpcMethod.DrawingSave,
              {
                path: input.path,
                documentName: input.documentName,
                overwrite: input.overwrite,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'setup':
          return textResult(
            await bridge.request(
              RpcMethod.DrawingSetup,
              {
                insUnits: input.insUnits,
                linearUnits: input.linearUnits,
                linearPrecision: input.linearPrecision,
                angularUnits: input.angularUnits,
                ltScale: input.ltScale,
                celtScale: input.celtScale,
                dimScale: input.dimScale,
                lwDisplay: input.lwDisplay,
                scale: input.scale,
                annotationScale: input.annotationScale,
                documentName: input.documentName,
                idempotencyKey: operationKey(ctx, input.idempotencyKey)
              },
              { signal: ctx.mcpReq.signal }
            )
          )
        case 'check':
          return textResult(
            await bridge.request(RpcMethod.DrawingCheck, {
              scope: input.scope,
              checks: input.checks,
              documentName: input.documentName
            })
          )
        case 'cleanup':
          return textResult(
            await bridge.request(RpcMethod.DrawingCleanup, {
              fixes: input.fixes,
              dryRun: input.dryRun,
              documentName: input.documentName
            })
          )
      }
    })
  )
}
