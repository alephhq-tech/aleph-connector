import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import type * as z from 'zod/v4'

type JsonObject = Record<string, unknown>

/**
 * Wraps a tool's zod input schema so `tools/list` advertises a JSON Schema every major model API
 * accepts, while validation still runs through the original zod schema (strict per-operation
 * checks, typed handler input).
 *
 * Why: zod emits a discriminated union as a root `{ oneOf: [...] }` with no `properties`. The
 * Anthropic Messages API rejects `oneOf`/`anyOf`/`allOf` at the root of a tool schema, OpenAI needs
 * root `properties` (and only allows `anyOf` in strict mode), and Gemini supports neither `oneOf`
 * nor `const`. See `toPortableJsonSchema` for the exact rewrite.
 */
export function portableInputSchema<T extends z.ZodType>(
  schema: T
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const standard = schema['~standard']
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: (options) => toPortableJsonSchema(standard.jsonSchema.input(options)),
        output: (options) => standard.jsonSchema.output(options)
      }
    }
  }
}

/**
 * Rewrites a zod-generated JSON Schema into the portable subset:
 *
 * - A root union of `{ operation: const }` objects becomes one flat object: `operation` is an `enum`,
 *   every other field is optional and its description says which operations use it;
 * - Nested `oneOf` becomes `anyOf`, `const: x` becomes `enum: [x]`, the root `$schema` is dropped.
 */
function toPortableJsonSchema(root: JsonObject): JsonObject {
  const { $schema: _schemaUri, ...rest } = root
  const variants = (rest.oneOf ?? rest.anyOf) as JsonObject[] | undefined
  const flat = variants && isOperationUnion(variants) ? flattenOperationUnion(variants) : rest
  return rewriteNested(flat) as JsonObject
}

function propertiesOf(variant: JsonObject): Record<string, JsonObject> {
  return (variant.properties ?? {}) as Record<string, JsonObject>
}

function operationOf(variant: JsonObject): unknown {
  return propertiesOf(variant).operation?.const
}

function isOperationUnion(variants: JsonObject[]): boolean {
  return variants.every((variant) => typeof operationOf(variant) === 'string')
}

function flattenOperationUnion(variants: JsonObject[]): JsonObject {
  const operations = variants.map((variant) => operationOf(variant) as string)
  const fields = new Map<string, { schema: JsonObject; usedBy: string[]; requiredBy: string[] }>()

  for (const variant of variants) {
    const operation = operationOf(variant) as string
    const required = new Set((variant.required ?? []) as string[])
    for (const [name, schema] of Object.entries(propertiesOf(variant))) {
      if (name === 'operation') continue
      const field = fields.get(name)
      if (field && !schemasCompatible(field.schema, schema)) {
        // Two operations reusing the same field name with a different meaning (e.g. pixel size
        // vs. world-space size) would silently flatten to whichever operation's schema was seen
        // first — the caller's real constraint (type/bounds) for every other operation using that
        // name would be wrong, as happened with view.zoom's `height` colliding with view.capture's
        // pixel `height` cap. Fail loudly at schema-build time instead: give the field a distinct
        // name per operation (e.g. `viewHeight` vs `height`).
        throw new Error(
          `portableInputSchema: field "${name}" has incompatible schemas across operations ` +
            `${field.usedBy.join(', ')} and ${operation} (${JSON.stringify(field.schema)} vs ` +
            `${JSON.stringify(schema)}). Rename one of them so flattening the operation union ` +
            `doesn't silently drop constraints.`
        )
      }
      const merged = field ?? { schema, usedBy: [], requiredBy: [] }
      merged.usedBy.push(operation)
      if (required.has(name)) merged.requiredBy.push(operation)
      fields.set(name, merged)
    }
  }

  const properties: Record<string, JsonObject> = {
    operation: { type: 'string', enum: operations, description: 'Which action to run.' }
  }
  for (const [name, { schema, usedBy, requiredBy }] of fields) {
    const description = [schema.description, usageNote(operations, usedBy, requiredBy)]
      .filter(Boolean)
      .join(' ')
    properties[name] = { ...schema, description }
  }

  return { type: 'object', properties, required: ['operation'] }
}

/**
 * Shallow "same enough to safely share one flattened property" check: same JSON Schema `type`,
 * and — for numbers/integers — the same `minimum`/`maximum` if either side declares them. Doesn't
 * need to be exhaustive (enums, string formats, nested object shapes, …): it only has to catch the
 * class of bug where two operations reuse a field name for genuinely different values.
 */
function schemasCompatible(a: JsonObject, b: JsonObject): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'number' || a.type === 'integer') {
    if (a.minimum !== undefined && b.minimum !== undefined && a.minimum !== b.minimum) return false
    if (a.maximum !== undefined && b.maximum !== undefined && a.maximum !== b.maximum) return false
  }
  return true
}

function usageNote(operations: string[], usedBy: string[], requiredBy: string[]): string {
  const list = (ops: string[]) =>
    ops.length === operations.length ? 'every operation' : ops.join(', ')
  if (requiredBy.length === usedBy.length) return `Required for ${list(requiredBy)}.`
  const used = `Used by ${list(usedBy)}.`
  return requiredBy.length > 0 ? `${used} Required for ${list(requiredBy)}.` : used
}

function rewriteNested(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteNested)
  if (node === null || typeof node !== 'object') return node

  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (key === 'const') continue
    out[key === 'oneOf' ? 'anyOf' : key] = rewriteNested(value)
  }
  if ('const' in node && !('enum' in node)) out.enum = [(node as JsonObject).const]
  return out
}
