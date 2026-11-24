import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
  hashApprovalToken,
  type AlephConnectorDataStore,
  type CadDocumentRecord,
  type CadSnapshotEntity,
  type CadSymbolCatalogItem,
  type EditApprovalConsumeInput,
  type EditApprovalConsumeResult
} from './index.js'

/**
 * SQLite-backed local data store (bun:sqlite) — the local-first replacement for the
 * in-memory parity tier. Same interface semantics: approved-only catalog reads, the same
 * consume-token state machine, and document/snapshot lookups that actually find rows the
 * local snapshot builder wrote.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cad_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  fingerprint_guid TEXT,
  document_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_ws_fp ON cad_documents (workspace_id, fingerprint_guid);
CREATE INDEX IF NOT EXISTS idx_documents_ws_doc ON cad_documents (workspace_id, document_id);

CREATE TABLE IF NOT EXISTS cad_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  drawing_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ws_drawing ON cad_snapshots (workspace_id, drawing_id);

CREATE TABLE IF NOT EXISTS cad_snapshot_entities (
  snapshot_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  kind TEXT NOT NULL,
  layer TEXT NOT NULL,
  block_name TEXT,
  geometry_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_snapshot ON cad_snapshot_entities (snapshot_id);

CREATE TABLE IF NOT EXISTS edit_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  device_id TEXT,
  edit_id TEXT NOT NULL,
  diff_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  token_hash TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS cad_symbol_catalog (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  category TEXT NOT NULL,
  block_name TEXT NOT NULL,
  library_path TEXT,
  library_handle TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  geometry_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_ws_key ON cad_symbol_catalog (workspace_id, key);
`

interface ApprovalRow {
  id: string
  runId: string
  workspaceId: string
  deviceId: string | null
  editId: string
  diffDigest: string
  status: string
  tokenHash: string | null
  expiresAt: number | null
  createdAt: number
  resolvedAt: number | null
}

export class LocalDataStore implements AlephConnectorDataStore {
  constructor(protected readonly db: Database) {}

  /** Registers a drawing identity and returns its stable drawingId (reuses an existing row). */
  registerDocument(input: {
    workspaceId?: string
    fingerprintGuid?: string | null
    documentId?: string | null
  }): string {
    const workspaceId = input.workspaceId ?? 'local'
    const existing =
      (input.fingerprintGuid
        ? (this.db
            .query(
              `SELECT id FROM cad_documents WHERE workspace_id = ? AND fingerprint_guid = ? LIMIT 1`
            )
            .get(workspaceId, input.fingerprintGuid) as { id: string } | null)
        : null) ??
      (input.documentId
        ? (this.db
            .query(
              `SELECT id FROM cad_documents WHERE workspace_id = ? AND document_id = ? LIMIT 1`
            )
            .get(workspaceId, input.documentId) as { id: string } | null)
        : null)
    if (existing) return existing.id

    const id = `caddoc_${randomUUID().replace(/-/g, '')}`
    this.db
      .query(`INSERT INTO cad_documents (id, workspace_id, fingerprint_guid, document_id) VALUES (?, ?, ?, ?)`)
      .run(id, workspaceId, input.fingerprintGuid ?? null, input.documentId ?? null)
    return id
  }

  /** Bulk-inserts one scan page for a snapshot. */
  insertSnapshotEntities(snapshotId: string, rows: CadSnapshotEntity[]): void {
    const insert = this.db.query(
      `INSERT INTO cad_snapshot_entities (snapshot_id, handle, kind, layer, block_name, geometry_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(
        snapshotId,
        row.handle,
        row.kind,
        row.layer,
        row.blockName ?? null,
        row.geometry ? JSON.stringify(row.geometry) : null
      )
    }
  }

  snapshotEntityCount(snapshotId: string): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM cad_snapshot_entities WHERE snapshot_id = ?`)
      .get(snapshotId) as { n: number }
    return row.n
  }

  readonly cadDocuments = {
    findByFingerprint: async (workspaceId: string, fingerprint: string): Promise<CadDocumentRecord | null> => {
      const row = this.db
        .query(`SELECT id FROM cad_documents WHERE workspace_id = ? AND fingerprint_guid = ? LIMIT 1`)
        .get(workspaceId, fingerprint) as { id: string } | null
      return row ? { id: row.id } : null
    },
    findBySession: async (workspaceId: string, sessionId: string): Promise<CadDocumentRecord[]> => {
      const rows = this.db
        .query(`SELECT id FROM cad_documents WHERE workspace_id = ? AND document_id = ?`)
        .all(workspaceId, sessionId) as { id: string }[]
      return rows.map((r) => ({ id: r.id }))
    }
  }

  readonly cadSnapshotEntities = {
    // `window` is accepted for interface parity; the local store serves whole-snapshot pages
    // (the snapshot builder already bounded what got indexed).
    query: async (
      snapshotId: string,
      options: { window: unknown; limit: number }
    ): Promise<CadSnapshotEntity[]> => {
      const rows = this.db
        .query(
          `SELECT handle, kind, layer, block_name, geometry_json FROM cad_snapshot_entities
           WHERE snapshot_id = ? LIMIT ?`
        )
        .all(snapshotId, options.limit) as {
        handle: string
        kind: string
        layer: string
        block_name: string | null
        geometry_json: string | null
      }[]
      return rows.map((r) => ({
        handle: r.handle,
        kind: r.kind,
        layer: r.layer,
        blockName: r.block_name,
        geometry: parseJson<Record<string, unknown>>(r.geometry_json)
      }))
    }
  }

  readonly editApprovals = {
    consumeToken: async (input: EditApprovalConsumeInput): Promise<EditApprovalConsumeResult> => {
      const hash = hashApprovalToken(input.token)
      const now = input.now ?? Date.now()
      const found = this.db
        .query(`SELECT * FROM edit_approvals WHERE token_hash = ? LIMIT 1`)
        .get(hash) as Record<string, unknown> | null
      if (!found) return { success: false, reason: 'Invalid or unknown approval token.' }
      const row = mapApprovalRow(found)
      if (row.status === 'consumed')
        return { success: false, reason: 'Approval token has already been consumed.' }
      if (row.status !== 'approved')
        return {
          success: false,
          reason: `Approval token is in invalid state: ${row.status}.`
        }
      if (row.expiresAt !== null && now > row.expiresAt) {
        this.db.query(`UPDATE edit_approvals SET status = 'expired' WHERE id = ?`).run(row.id)
        return { success: false, reason: 'Approval token has expired.' }
      }
      if (row.editId !== input.editId)
        return {
          success: false,
          reason: `Approval token belongs to edit "${row.editId}", not "${input.editId}".`
        }
      if (input.diffDigest && row.diffDigest !== input.diffDigest)
        return {
          success: false,
          reason: 'Approval token diff digest does not match expected diff digest.'
        }
      this.db
        .query(`UPDATE edit_approvals SET status = 'consumed', resolved_at = ? WHERE id = ?`)
        .run(now, row.id)
      return { success: true }
    },
    createPending: async (input: Record<string, unknown>): Promise<void> => {
      const now = Date.now()
      const id = `apv_${randomUUID().replace(/-/g, '')}`
      this.db
        .query(
          `INSERT INTO edit_approvals
             (id, run_id, workspace_id, device_id, edit_id, diff_digest, status, token_hash, expires_at, created_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`
        )
        .run(
          id,
          String(input.runId ?? ''),
          String(input.workspaceId ?? ''),
          (input.deviceId as string | null | undefined) ?? null,
          String(input.editId ?? ''),
          String(input.diffDigest ?? ''),
          (input.expiresAt as number | null | undefined) ?? null,
          now
        )
    },
    resolve: async (runId: string, resolution: Record<string, unknown>): Promise<void> => {
      this.db
        .query(
          `UPDATE edit_approvals
             SET status = ?, token_hash = ?, expires_at = COALESCE(?, expires_at), resolved_at = ?
           WHERE run_id = ? AND status = 'pending'
           LIMIT 1`
        )
        .run(
          resolution.approved ? 'approved' : 'rejected',
          (resolution.tokenHash as string | null | undefined) ?? null,
          (resolution.expiresAt as number | null | undefined) ?? null,
          Date.now(),
          runId
        )
    }
  }

  readonly cadSymbolCatalog = {
    insert: async (item: CadSymbolCatalogItem): Promise<void> => {
      this.db
        .query(
          `INSERT INTO cad_symbol_catalog
             (id, workspace_id, key, category, block_name, library_path, library_handle, status, created_at, updated_at, geometry_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          item.id,
          item.workspaceId,
          item.key,
          item.category,
          item.blockName,
          item.libraryPath ?? null,
          item.libraryHandle ?? null,
          item.status,
          item.createdAt,
          item.updatedAt,
          item.geometryJson ? JSON.stringify(item.geometryJson) : null
        )
    },
    findByKey: async (workspaceId: string, key: string): Promise<CadSymbolCatalogItem | null> => {
      const row = this.db
        .query(
          `SELECT * FROM cad_symbol_catalog WHERE workspace_id = ? AND key = ? AND status = 'approved' LIMIT 1`,
          [workspaceId, key]
        )
        .get(workspaceId, key) as Record<string, unknown> | null
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        key: String(row.key),
        category: String(row.category),
        blockName: String(row.block_name),
        libraryPath: (row.library_path as string | null) ?? null,
        libraryHandle: (row.library_handle as string | null) ?? null,
        status: String(row.status),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        geometryJson: parseJson<Record<string, unknown>[]>(
          row.geometry_json === null ? null : String(row.geometry_json)
        )
      }
    }
  }
}

/** Rows are written by this store; a corrupt value reads as null, never throws. */
function parseJson<T>(text: string | null): T | null {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function mapApprovalRow(row: Record<string, unknown>): ApprovalRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    workspaceId: String(row.workspace_id),
    deviceId: (row.device_id as string | null) ?? null,
    editId: String(row.edit_id),
    diffDigest: String(row.diff_digest),
    status: String(row.status),
    tokenHash: (row.token_hash as string | null) ?? null,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at)
  }
}

export interface LocalStoreHandle {
  data: LocalDataStore
  /** Shared handle so `LocalCadStateService` (packages/cad-state) can bind the same file. */
  db: Database
  close(): void
}

/** Opens (creating on first use) the local SQLite store. WAL for concurrent readers. */
export function openLocalStore(dbPath: string): LocalStoreHandle {
  const db = new Database(dbPath, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(SCHEMA)
  return {
    data: new LocalDataStore(db),
    db,
    close: () => db.close()
  }
}
