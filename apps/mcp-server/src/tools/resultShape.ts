import * as z from 'zod/v4'
import type { EntityRef } from '@aleph-connector/cad-types'

/**
 * Result-size controls (#72). A model reads every byte a tool returns, so large batches and lists
 * default to compact shapes and callers opt into detail only when they need it.
 */

/** Refs at or below this count come back in full by default; above it, as a handle list. */
const FULL_REFS_DEFAULT_LIMIT = 20

export const refsResultMode = z
  .enum(['full', 'handles', 'summary'])
  .optional()
  .describe(
    'Result detail for affected entities. full: {handle,kind,layer} per entity. handles: handle ' +
      'array + counts. summary: counts + compressed handle ranges only. Default: full for up to ' +
      `${FULL_REFS_DEFAULT_LIMIT} entities, handles above that.`
  )

type RefsResultMode = z.infer<typeof refsResultMode>

interface RefCounts {
  count: number
  byKind: Record<string, number>
  byLayer: Record<string, number>
}

function countRefs(refs: EntityRef[]): RefCounts {
  const byKind: Record<string, number> = {}
  const byLayer: Record<string, number> = {}
  for (const ref of refs) {
    byKind[ref.kind] = (byKind[ref.kind] ?? 0) + 1
    byLayer[ref.layer] = (byLayer[ref.layer] ?? 0) + 1
  }
  return { count: refs.length, byKind, byLayer }
}

/** Collapses consecutive hex handles into `first..last` runs, keeping step order. */
function handleRanges(handles: string[]): string[] {
  const ranges: string[] = []
  let start = 0
  for (let i = 1; i <= handles.length; i++) {
    const contiguous =
      i < handles.length && parseInt(handles[i]!, 16) === parseInt(handles[i - 1]!, 16) + 1
    if (contiguous) continue
    const first = handles[start]!
    const last = handles[i - 1]!
    ranges.push(start === i - 1 ? first : `${first}..${last}`)
    start = i
  }
  return ranges
}

/** Shapes a list of affected entity refs according to `mode` (see `refsResultMode`). */
export function shapeRefs(
  refs: EntityRef[],
  mode: RefsResultMode
): EntityRef[] | (RefCounts & { handles: string[] }) | (RefCounts & { handleRanges: string[] }) {
  const effective = mode ?? (refs.length <= FULL_REFS_DEFAULT_LIMIT ? 'full' : 'handles')
  if (effective === 'full') return refs.map(({ handle, kind, layer }) => ({ handle, kind, layer }))
  const handles = refs.map((ref) => ref.handle)
  if (effective === 'handles') return { ...countRefs(refs), handles }
  return { ...countRefs(refs), handleRanges: handleRanges(handles) }
}

/** `fields` projection parameter for list/get results whose items have the given keys. */
export function fieldsParam<const K extends string>(keys: readonly [K, ...K[]]) {
  return z
    .array(z.enum(keys))
    .min(1)
    .optional()
    .describe(`Return only these fields per item (default: all). One of: ${keys.join(', ')}.`)
}

/** Keeps only `fields` on `item`; returns it unchanged when no projection was requested. */
export function project<T extends object>(
  item: T,
  fields: readonly string[] | undefined
): Partial<T> {
  if (!fields) return item
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => fields.includes(key))
  ) as Partial<T>
}
