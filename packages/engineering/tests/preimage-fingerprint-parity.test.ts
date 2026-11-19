import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { canonicalize, digest, hashCanonical } from '../src/spatial/fingerprint'

interface Fixture {
  canonicalFormExample: string
  vectors: { name: string; value: unknown; expectedDigest: string }[]
}

/**
 * Pins the digest contract the AutoCAD edit flow depends on.
 *
 * The plugin's C# port (windows/autocad-plugin/Edits/PreImageCanonical.cs)
 * reproduces these digests to prove a locally-captured entity pre-image is exactly the payload a
 * Cloud-issued ticket authorized: Cloud stores only the digest (the payload stays on the user's
 * machine) and the restore path re-computes it inside AutoCAD. This test is the other half of that
 * guarantee — it fails if `canonicalize`/`round`/`digest` change here, so the two implementations
 * cannot drift apart in either direction. Without it, fingerprint.ts has no test at all and the
 * C# port would be the only thing holding the algorithm down.
 *
 * The vectors live in windows/contracts/preimage-contract-vectors.json
 * and are read as plain JSON data across the product boundary (same licence as
 * apps/mcp-autocad/src/pluginInvariants.test.ts reading plugin .cs), not a build dependency.
 * Regenerate that file with fingerprint.ts itself; never hand-edit a digest.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      '../../../windows/contracts/preimage-contract-vectors.json',
      import.meta.url
    ),
    'utf8'
  )
) as Fixture

const storedDigest = (name: string) => FIXTURE.vectors.find((v) => v.name === name)!.expectedDigest

describe('pre-image digest parity with the AutoCAD plugin (PR B slice 01)', () => {
  test('the fixture carries 16-hex digests for every vector', () => {
    expect(FIXTURE.vectors.length).toBeGreaterThanOrEqual(8)
    for (const v of FIXTURE.vectors) expect(v.expectedDigest).toMatch(/^[0-9a-f]{16}$/)
  })

  test('fingerprint.ts reproduces every stored digest', () => {
    for (const v of FIXTURE.vectors) {
      expect(hashCanonical(v.value), v.name).toBe(v.expectedDigest)
    }
  })

  test('the recorded canonical form is exactly what canonicalize emits', () => {
    expect(canonicalize(FIXTURE.vectors.find((v) => v.name === 'line')!.value)).toBe(
      FIXTURE.canonicalFormExample
    )
  })

  test('float wobble collapses to the same digest but a real move does not', () => {
    expect(storedDigest('line')).toBe(storedDigest('line-float-wobble-equals-line'))
    expect(storedDigest('line')).not.toBe(storedDigest('line-moved-differs-from-line'))
  })

  test('negative halves round toward +infinity, not away from zero', () => {
    // The C# port must use Math.Floor(n*1e6 + 0.5), not MidpointRounding.AwayFromZero, or a
    // negative-half coordinate splits the two digests.
    expect(canonicalize({ x: -0.5000005 })).toBe('{"x":-0.500000}')
    expect(canonicalize({ x: -0.0000005 })).toBe('{"x":0.000000}')
  })

  test('volatile keys are dropped while an explicit null is kept', () => {
    expect(
      canonicalize({ handle: 'b7', idempotencyKey: 'x', view: { follow: 'off' }, bounds: null })
    ).toBe('{"bounds":null,"handle":"b7"}')
    expect(canonicalize({ handle: 'b7', bounds: null })).not.toBe(canonicalize({ handle: 'b7' }))
  })

  test('digest is a pure function of the canonical text', () => {
    const line = FIXTURE.vectors.find((v) => v.name === 'line')!
    expect(digest(canonicalize(line.value))).toBe(line.expectedDigest)
  })
})
