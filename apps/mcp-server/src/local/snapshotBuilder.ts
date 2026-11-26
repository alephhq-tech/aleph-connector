import { RpcMethod, type CadScanEntity } from '@aleph-connector/cad-protocol'
import type { CadSnapshotEntity, LocalDataStore } from '@aleph-connector/data'
import type { LocalCadStateService } from '@aleph-connector/cad-state'
import type { BridgeClient } from '../bridge/BridgeClient.js'

/**
 * On-demand, revision-bound CAD index for the local runtime. There is no run-engine here,
 * so the MCP server itself owns the single scan path: page `cad.scan` at full detail, verify
 * the scan bracketed one revision equal to the caller's live revision, then record the
 * snapshot. A snapshot only ever answers at that exact revision (LocalCadStateService), so a
 * stale index can never be served as current facts.
 */

const SCAN_PAGE_SIZE = 2_000
const MAX_SNAPSHOT_ROWS = 10_000
const SCAN_TIMEOUT_MS = 15_000

export interface SnapshotIdentity {
  documentId?: string
  documentName?: string
  fingerprintGuid?: string | null
  revision: string
}

export interface SnapshotStore {
  cadState: LocalCadStateService
  data: LocalDataStore
}

export async function buildSnapshot(
  bridge: BridgeClient,
  store: SnapshotStore,
  workspaceId: string,
  identity: SnapshotIdentity
): Promise<string | null> {
  const revision = identity.revision?.trim()
  if (!revision) return null

  const rows: CadSnapshotEntity[] = []
  let expectedTotal: number | undefined
  let documentId = identity.documentId
  let fingerprintGuid = identity.fingerprintGuid ?? null
  let offset = 0

  while (true) {
    const page = await bridge.request(
      RpcMethod.CadScan,
      { documentName: identity.documentId ?? identity.documentName, offset, limit: SCAN_PAGE_SIZE, detail: 'full' },
      { timeoutMs: SCAN_TIMEOUT_MS }
    )

    // Revision bracket: both ends equal and equal to the caller's live revision, or the
    // drawing moved during/after the scan — discard everything rather than index a mix.
    const sameRevision =
      Boolean(page.revisionBefore) &&
      page.revisionBefore === page.revisionAfter &&
      page.revisionBefore === revision
    if (!sameRevision) return null

    const pageDocumentId = typeof page.documentId === 'string' ? page.documentId.trim() : ''
    if (!pageDocumentId) return null
    if (documentId && pageDocumentId !== documentId) return null
    documentId = pageDocumentId
    fingerprintGuid ??= page.fingerprintGuid ?? null

    if (!Number.isSafeInteger(page.total) || page.total < 0) return null
    if (expectedTotal === undefined) expectedTotal = page.total
    else if (page.total !== expectedTotal) return null
    if (expectedTotal > MAX_SNAPSHOT_ROWS) return null
    if (!Array.isArray(page.entities) || page.entities.length > SCAN_PAGE_SIZE) return null

    const nextOffset = offset + page.entities.length
    if (
      (page.hasMore && page.entities.length === 0) ||
      nextOffset > expectedTotal ||
      page.hasMore !== nextOffset < expectedTotal
    ) {
      return null
    }

    for (const entity of page.entities as CadScanEntity[]) {
      rows.push({
        handle: entity.handle,
        kind: entity.kind,
        layer: entity.layer,
        blockName: entity.blockName ?? null,
        geometry: entity.geometry ?? null
      })
    }
    offset = nextOffset
    if (!page.hasMore) break
  }

  const drawingId = store.data.registerDocument({
    workspaceId,
    fingerprintGuid,
    documentId
  })
  const snapshotId = store.cadState.recordSnapshot(workspaceId, drawingId, revision)
  store.data.insertSnapshotEntities(snapshotId, rows)
  return snapshotId
}
