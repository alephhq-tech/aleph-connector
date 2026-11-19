import * as z from 'zod/v4'

/** Which open document (drawing → list_open's `name`) to target — omit to use the active tab. */
export const documentName = z
  .string()
  .optional()
  .describe(
    'Target an open tab by the `name` or stable `documentId` drawing → list_open returns (a bare ' +
      'file name like A-101.dwg works when only one tab has it); omit for the active tab (or the ' +
      'tab pinned with drawing → use).'
  )

/**
 * Which AutoCAD process (`context`'s `instances[].instanceId`) to target — aleph-platform#4. Omit
 * when exactly one AutoCAD instance is online, which keeps every existing call unchanged; with 2+
 * online, every call to an instance-targeted RPC fails `InstanceAmbiguous` without this, naming
 * the instances to choose from.
 */
export const instanceId = z
  .string()
  .optional()
  .describe(
    "Target one AutoCAD process by the `instanceId` context's `instances[]` returns — required " +
      'when 2+ AutoCAD instances are online (omitting it then fails with InstanceAmbiguous, which ' +
      'names them); omit when only one is online.'
  )

/**
 * The literal values of a discriminated union's `key` — used to build tool descriptions from the
 * schemas, so the kinds/operations a description lists can't drift from what's accepted (#11).
 */
export function literalValues(
  options: readonly { shape: Record<string, unknown> }[],
  key: string
): string[] {
  // First literal value = canonical name (later values are aliases, e.g. kind "rect").
  return options.map((option) => String([...(option.shape[key] as z.ZodLiteral<string>).values][0]))
}
