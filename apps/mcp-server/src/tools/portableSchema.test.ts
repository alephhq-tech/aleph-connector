import { describe, expect, test } from 'bun:test'
import * as z from 'zod/v4'
import { portableInputSchema } from './portableSchema.js'
import { captureSize } from './capture.js'
import { viewZoomParams } from '@aleph-connector/cad-tools'

function flatten(schema: z.ZodType): unknown {
  return portableInputSchema(schema)['~standard'].jsonSchema.input({ target: 'draft-07' })
}

describe('portableInputSchema: operation-union flattening', () => {
  test('two operations sharing a field name with the same type/bounds flatten fine', () => {
    const schema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('a'), size: z.number().min(0).max(10) }),
      z.object({ operation: z.literal('b'), size: z.number().min(0).max(10) })
    ])
    expect(() => flatten(schema)).not.toThrow()
  })

  test('two operations reusing a field name with different bounds throws instead of silently picking one', () => {
    // Reproduces the real bug: view.capture's pixel `height` (<=2048) and view.zoom's world-space
    // `height` used to share the same field name, so the flattened schema silently applied
    // capture's <=2048 pixel cap to zoom's drawing-unit height, rejecting legitimate calls like
    // `{ operation: "zoom", center: [...], height: 25000 }`.
    const schema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('capture'), height: z.number().int().min(64).max(2048) }),
      z.object({ operation: z.literal('zoom'), height: z.number().positive() })
    ])
    expect(() => flatten(schema)).toThrow(/incompatible schemas/)
  })

  test("the real view tool's capture (pixel height) and zoom (viewHeight) no longer collide", () => {
    const schema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('capture'), ...captureSize }),
      z.object({ operation: z.literal('zoom'), ...viewZoomParams.shape })
    ])
    expect(() => flatten(schema)).not.toThrow()
  })
})
