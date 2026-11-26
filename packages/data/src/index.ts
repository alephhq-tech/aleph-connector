import { createHash } from 'node:crypto'

export * from './local.js'

export interface CadDocumentRecord {
  id: string
}

export interface CadSnapshotEntity {
  handle: string
  kind: string
  layer: string
  blockName?: string | null
  geometry?: Record<string, unknown> | null
}

export interface CadSymbolCatalogItem {
  id: string
  workspaceId: string
  key: string
  category: string
  blockName: string
  libraryPath?: string | null
  libraryHandle?: string | null
  status: string
  createdAt: number
  updatedAt: number
  geometryJson?: Record<string, unknown>[] | null
}

export interface EditApprovalConsumeInput {
  token: string
  editId: string
  diffDigest?: string
  now?: number
}

export interface EditApprovalConsumeResult {
  success: boolean
  reason?: string
}

export interface AlephConnectorDataStore {
  cadDocuments: {
    findByFingerprint(workspaceId: string, fingerprint: string): Promise<CadDocumentRecord | null>
    findBySession(workspaceId: string, sessionId: string): Promise<CadDocumentRecord[]>
  }
  cadSnapshotEntities: {
    query(
      snapshotId: string,
      options: { window: unknown; limit: number }
    ): Promise<CadSnapshotEntity[]>
  }
  editApprovals: {
    consumeToken(input: EditApprovalConsumeInput): Promise<EditApprovalConsumeResult>
    createPending(input: Record<string, unknown>): Promise<void>
    resolve(runId: string, resolution: Record<string, unknown>): Promise<void>
  }
  cadSymbolCatalog: {
    insert(item: CadSymbolCatalogItem): Promise<void>
    findByKey(workspaceId: string, key: string): Promise<CadSymbolCatalogItem | null>
  }
}

interface EditApprovalRow {
  id: string
  runId: string
  workspaceId: string
  deviceId?: string | null
  editId: string
  diffDigest: string
  status: string
  tokenHash: string | null
  expiresAt: number | null
  createdAt: number
  resolvedAt: number | null
}

/**
 * In-memory parity tier (Local-first default). Mirrors the Aleph `InMemory*Repo` semantics: the
 * same consumeToken state machine, the same approved-only catalog, and empty results for the
 * document/snapshot lookups a standalone local host has nothing to index. `configureDataStore`
 * swaps this out for the PostgreSQL adapter when `DATABASE_URL` is a postgres:// connection.
 */
export class InMemoryDataStore implements AlephConnectorDataStore {
  private readonly approvals = new Map<string, EditApprovalRow>()
  private readonly catalog = new Map<string, CadSymbolCatalogItem>()

  readonly cadDocuments = {
    findByFingerprint: async (
      _workspaceId: string,
      _fingerprint: string
    ): Promise<CadDocumentRecord | null> => null,
    findBySession: async (
      _workspaceId: string,
      _sessionId: string
    ): Promise<CadDocumentRecord[]> => []
  }

  readonly cadSnapshotEntities = {
    query: async (
      _snapshotId: string,
      _options: { window: unknown; limit: number }
    ): Promise<CadSnapshotEntity[]> => []
  }

  readonly editApprovals = {
    consumeToken: async (
      input: EditApprovalConsumeInput
    ): Promise<EditApprovalConsumeResult> => {
      const hash = hashApprovalToken(input.token)
      const now = input.now ?? Date.now()
      let found: EditApprovalRow | null = null
      for (const a of this.approvals.values()) {
        if (a.tokenHash === hash) {
          found = a
          break
        }
      }
      if (!found) return { success: false, reason: 'Invalid or unknown approval token.' }
      if (found.status === 'consumed')
        return { success: false, reason: 'Approval token has already been consumed.' }
      if (found.status !== 'approved')
        return { success: false, reason: `Approval token is in invalid state: ${found.status}.` }
      if (found.expiresAt !== null && now > found.expiresAt) {
        found.status = 'expired'
        return { success: false, reason: 'Approval token has expired.' }
      }
      if (found.editId !== input.editId)
        return {
          success: false,
          reason: `Approval token belongs to edit "${found.editId}", not "${input.editId}".`
        }
      if (input.diffDigest && found.diffDigest !== input.diffDigest)
        return {
          success: false,
          reason: 'Approval token diff digest does not match expected diff digest.'
        }
      found.status = 'consumed'
      found.resolvedAt = now
      return { success: true }
    },
    createPending: async (input: Record<string, unknown>): Promise<void> => {
      const now = Date.now()
      const id = `apv_${this.approvals.size + 1}_${now}`
      this.approvals.set(id, {
        id,
        runId: String(input.runId ?? ''),
        workspaceId: String(input.workspaceId ?? ''),
        deviceId: (input.deviceId as string | null | undefined) ?? null,
        editId: String(input.editId ?? ''),
        diffDigest: String(input.diffDigest ?? ''),
        status: 'pending',
        tokenHash: null,
        expiresAt: (input.expiresAt as number | null | undefined) ?? null,
        createdAt: now,
        resolvedAt: null
      })
    },
    resolve: async (runId: string, resolution: Record<string, unknown>): Promise<void> => {
      for (const a of this.approvals.values()) {
        if (a.runId === runId && a.status === 'pending') {
          a.status = resolution.approved ? 'approved' : 'rejected'
          a.tokenHash = (resolution.tokenHash as string | null | undefined) ?? null
          a.expiresAt = (resolution.expiresAt as number | null | undefined) ?? a.expiresAt
          a.resolvedAt = Date.now()
          return
        }
      }
    }
  }

  readonly cadSymbolCatalog = {
    insert: async (item: CadSymbolCatalogItem): Promise<void> => {
      this.catalog.set(item.id, item)
    },
    findByKey: async (
      workspaceId: string,
      key: string
    ): Promise<CadSymbolCatalogItem | null> => {
      for (const item of this.catalog.values()) {
        if (item.workspaceId === workspaceId && item.key === key) return item
      }
      return null
    }
  }
}

let store: AlephConnectorDataStore = new InMemoryDataStore()

export function configureDataStore(next: AlephConnectorDataStore): void {
  store = next
}

export const db: AlephConnectorDataStore = {
  cadDocuments: {
    findByFingerprint: (...args) => store.cadDocuments.findByFingerprint(...args),
    findBySession: (...args) => store.cadDocuments.findBySession(...args)
  },
  cadSnapshotEntities: {
    query: (...args) => store.cadSnapshotEntities.query(...args)
  },
  editApprovals: {
    consumeToken: (...args) => store.editApprovals.consumeToken(...args),
    createPending: (...args) => store.editApprovals.createPending(...args),
    resolve: (...args) => store.editApprovals.resolve(...args)
  },
  cadSymbolCatalog: {
    insert: (...args) => store.cadSymbolCatalog.insert(...args),
    findByKey: (...args) => store.cadSymbolCatalog.findByKey(...args)
  }
}

export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
