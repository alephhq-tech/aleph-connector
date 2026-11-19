import * as z from 'zod/v4'

/**
 * A WCS point, as `{x, y, z?}` or the compact `[x, y]` / `[x, y, z]` (#71, #19) — both parse to
 * `{x, y, z}` (z defaults to 0), so the wire to the Bridge never sees the compact form. The array
 * form roughly halves the tokens a model spends per point in large batches.
 */
export const point3d = z.union([
  z.object({
    x: z.number(),
    y: z.number(),
    z: z.number().default(0)
  }),
  z
    .array(z.number())
    .min(2)
    .max(3)
    .transform(([x, y, z = 0]) => ({ x: x!, y: y!, z }))
])

/**
 * Per-axis scale factors for a block reference. Unlike point3d, z defaults to 1 (uniform scale),
 * not 0.
 */
export const scale3d = z.object({
  x: z.number().positive().default(1),
  y: z.number().positive().default(1),
  z: z.number().positive().default(1)
})

export const colorSpec = z.union([
  z.object({ aci: z.number().int().min(0).max(256) }),
  z.object({
    rgb: z.object({
      r: z.number().int().min(0).max(255),
      g: z.number().int().min(0).max(255),
      b: z.number().int().min(0).max(255)
    })
  })
])

/**
 * Generic AutoCAD symbol-table name validator (layers, linetypes, text styles, dimension styles):
 * non-empty and free of the characters AutoCAD's symbol tables disallow.
 */
export const layerName = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !/[<>/\\":;?*|,=`]/.test(s), {
    message: 'Name contains a character AutoCAD disallows'
  })

/**
 * A real AutoCAD entity handle (hex), or a batch-local `@id` reference (#19) — only meaningful
 * inside an `operations.apply` batch, where `server` resolves it against an earlier step's `id`
 * before the wire; everywhere else (`entity.*` tools) a `@ref` reaches the plugin literally and
 * fails there as an invalid handle, since there is no batch to resolve it against.
 */
export const entityHandle = z
  .string()
  .min(1)
  .regex(
    /^(?:[0-9A-Fa-f]+|@[A-Za-z0-9_-]+)$/,
    'Entity handle must be a hex string, or a batch-local @ref (operations.apply only)'
  )

/** Matches an `entityHandle` string that is a batch-local reference rather than a real handle. */
export const BATCH_REF_PATTERN = /^@([A-Za-z0-9_-]+)$/

/** `id?: string` on one `operations.apply` step (#19) — later steps reference it as `@id`. */
export const batchStepId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'id must be letters, digits, underscore or hyphen')

/**
 * Caller-supplied dedupe key for a mutating tool call (#9) — spread as `idempotencyKey` on a
 * mutating tool's schema alongside `documentName`/`view`. A retried call with the same key (and the
 * same resolved document) returns the first call's result instead of repeating the mutation, so
 * retrying after a RequestTimeout is safe. Omitted calls default to the MCP request's own id
 * (server/src/tools/*.ts), so even an un-keyed retry over the _same_ MCP connection is still
 * deduped — a brand-new connection/request naturally gets a fresh id and is not deduped.
 */
export const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'Dedupe key: retrying this exact call with the same idempotencyKey returns the original ' +
      'result instead of repeating the mutation — safe to resend after a RequestTimeout. Omit ' +
      "to default to this call's own MCP request id."
  )

/**
 * The spatial-validation ticket a mutating call must carry once the run is an architectural design
 * session (`idempotencyKey`'s neighbour on purpose: both are call-level metadata, not geometry).
 *
 * The AutoCAD MCP server never reads this field — it forwards the batch to the Bridge either way.
 * Aleph Cloud's design guard inspects the *same* arguments one layer above, at
 * `CapabilityRegistry.invoke`, and refuses an unvalidated or mismatched batch before it reaches this
 * server. Declaring it here is what makes the contract visible to the model: an undeclared key would
 * be silently stripped by the tool schema, so the agent could not honestly supply it.
 */
export const validationId = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'The validationId spatial_validate_layout issued for this exact batch. Required once the run is ' +
      'an architectural design session (3+ entity placements, or after spatial_design_begin); the ' +
      'server refuses a mutation whose payload, document, or drawing revision does not match the ' +
      'record. Omit it for one-off edits.'
  )
