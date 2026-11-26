import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { CadSnapshotAccess, CadStateService } from './index.js'

/**
 * Revision-bound CAD state over the local SQLite store (same `cad_snapshots` table
 * `openLocalStore` creates). A snapshot is usable for current facts ONLY at the exact
 * revision it was verified at; any other revision resolves to null so callers rebuild.
 */
export class LocalCadStateService implements CadStateService {
  constructor(private readonly db: Database) {}

  /** Records a verified snapshot for (workspace, drawing, revision), replacing any prior one. */
  recordSnapshot(workspaceId: string, drawingId: string, revision: string): string {
    const id = `snap_${randomUUID().replace(/-/g, '')}`
    this.db
      .query(`DELETE FROM cad_snapshots WHERE workspace_id = ? AND drawing_id = ?`)
      .run(workspaceId, drawingId)
    this.db
      .query(
        `INSERT INTO cad_snapshots (id, workspace_id, drawing_id, revision, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, workspaceId, drawingId, revision, Date.now())
    return id
  }

  snapshotForRevision(workspaceId: string, drawingId: string, revision: string): string | null {
    const row = this.db
      .query(
        `SELECT id FROM cad_snapshots WHERE workspace_id = ? AND drawing_id = ? AND revision = ? LIMIT 1`
      )
      .get(workspaceId, drawingId, revision) as { id: string } | null
    return row?.id ?? null
  }

  async resolveAccess(
    workspaceId: string,
    drawingId: string,
    revision: string
  ): Promise<CadSnapshotAccess | null> {
    const id = this.snapshotForRevision(workspaceId, drawingId, revision)
    if (!id) return null
    return { snapshot: { id }, mayUseForCurrentFacts: true }
  }
}
