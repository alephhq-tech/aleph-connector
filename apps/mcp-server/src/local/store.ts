import { join } from 'node:path'
import { configureDataStore, openLocalStore, type LocalDataStore, type LocalStoreHandle } from '@aleph-connector/data'
import { configureCadStateService, LocalCadStateService } from '@aleph-connector/cad-state'

/**
 * The local runtime's single SQLite store: one file, one handle, wired into the shared
 * `db` and `cadStateService` seams the tools already read. Opened once at startup from
 * the runtime state dir; `localStore()` exposes it to the on-demand snapshot builder.
 */
let handle: (LocalStoreHandle & { cadState: LocalCadStateService }) | null = null

export function configureLocalStore(stateDir: string): LocalStoreHandle & { cadState: LocalCadStateService } {
  if (handle) return handle
  const opened = openLocalStore(join(stateDir, 'cad-state.db'))
  const cadState = new LocalCadStateService(opened.db)
  configureDataStore(opened.data)
  configureCadStateService(cadState)
  handle = { ...opened, cadState }
  return handle
}

export function localStore(): { data: LocalDataStore; cadState: LocalCadStateService } | null {
  return handle
}
