import { db, type CadSymbolCatalogItem } from '@aleph-connector/data'

export interface CadSnapshotAccess {
  snapshot: { id: string } | null
  mayUseForCurrentFacts: boolean
}

export interface CadStateService {
  resolveAccess(
    workspaceId: string,
    drawingId: string,
    revision: string
  ): Promise<CadSnapshotAccess | null>
}

const unconfiguredCadStateService: CadStateService = {
  async resolveAccess() {
    throw new Error('Aleph Connector CAD state service is not configured.')
  }
}

let service: CadStateService = unconfiguredCadStateService

export function configureCadStateService(next: CadStateService): void {
  service = next
}

export const cadStateService: CadStateService = {
  resolveAccess: (...args) => service.resolveAccess(...args)
}

export async function resolveSymbolCatalogEntry(
  workspaceId: string,
  key: string
): Promise<CadSymbolCatalogItem | null> {
  const item = await db.cadSymbolCatalog.findByKey(workspaceId, key)
  return item?.status === 'approved' ? item : null
}
