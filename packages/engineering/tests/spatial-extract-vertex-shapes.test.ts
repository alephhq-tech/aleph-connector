import { describe, expect, it } from 'bun:test'
import { extractSpatialModel, type SpatialModel, type SpatialRawEntity } from '../src/index'

/**
 * Polyline vertex shapes on the wire.
 *
 * `ringFromEntity` used to assume the `{ point: { x, y } }` object `entity.get`/`entity.list`
 * detail:"full" emits, and threw on the bare point shorthand (`{x, y}` / `[x, y]`) that the CAD
 * tools accept everywhere else in this repo (compare `semantic/extractor.ts`, which reads
 * `v.point ?? { x: v.x, y: v.y }`). A throw in the middle of `extractSpatialModel` is worse than a
 * rejection: it kills the whole extraction, and an agent whose read failed would then "recover" the
 * room by drawing an axis-aligned rectangle from the bbox. So an unusable vertex list must yield
 * null, which the caller reports as an `insufficientData` entry.
 *
 * Units: millimetres, Aleph drawing convention.
 */

const ROOM_LAYER = 'A-ROOM-PHONG_NGU'

/** The reason string the caller already emits when a ring cannot be read — pinned, never reworded. */
const NOT_FABRICATING =
  'closed boundary could not be read (no vertices on the wire) — not fabricating a rectangle'

const ent = (handle: string, geometry: SpatialRawEntity['geometry']): SpatialRawEntity => ({
  handle,
  kind: 'polyline',
  layer: ROOM_LAYER,
  geometry,
  bounds: { min: { x: 0, y: 0 }, max: { x: 30000, y: 120000 } }
})

const spaceFor = (model: SpatialModel, handle: string) =>
  model.spaces.find((s) => s.sourceHandles[0] === handle)

describe('Spatial extraction — polyline vertex shapes', () => {
  it('reads the bare [x, y] point-array shorthand as a real ring', () => {
    // A 24.902 x 16.770 m room expressed the way the CAD tools accept it.
    const model = extractSpatialModel([
      ent('rmShorthand', {
        closed: true,
        vertices: [
          [4691, 102588],
          [29593, 102588],
          [29593, 119358],
          [4691, 119358]
        ]
      })
    ])

    const space = spaceFor(model, 'rmShorthand')
    expect(space).toBeDefined()
    expect(space!.boundary.length).toBe(4)
    // The ring is the drawn rectangle's real vertices, not a bbox derived from them.
    expect(space!.boundary).toEqual([
      [4691, 102588],
      [29593, 102588],
      [29593, 119358],
      [4691, 119358]
    ])
    expect(space!.areaM2).toBeCloseTo(417.61, 2)
    expect(model.insufficientData.find((i) => i.handle === 'rmShorthand')).toBeUndefined()
  })

  it('reads the bare { x, y } pair form as a real ring', () => {
    const model = extractSpatialModel([
      ent('rmPair', {
        closed: true,
        vertices: [
          { x: 0, y: 0 },
          { x: 6000, y: 0 },
          { x: 6000, y: 6000 },
          { x: 0, y: 6000 }
        ]
      })
    ])
    const space = spaceFor(model, 'rmPair')
    expect(space).toBeDefined()
    expect(space!.areaM2).toBeCloseTo(36, 2)
  })

  it('the existing { point: { x, y } } wire shape still works unchanged', () => {
    const model = extractSpatialModel([
      ent('rmPoint', {
        closed: true,
        vertices: [
          { point: { x: 0, y: 0 } },
          { point: { x: 6000, y: 0 } },
          { point: { x: 6000, y: 6000 } },
          { point: { x: 0, y: 6000 } }
        ]
      })
    ])
    const space = spaceFor(model, 'rmPoint')
    expect(space).toBeDefined()
    expect(space!.boundary.length).toBe(4)
    expect(space!.areaM2).toBeCloseTo(36, 2)
  })

  it('mixed shapes in one vertex list describe one ring', () => {
    const model = extractSpatialModel([
      ent('rmMixed', {
        closed: true,
        vertices: [
          { point: { x: 0, y: 0 } },
          { x: 8000, y: 0 },
          [8000, 5000],
          { point: { x: 0, y: 5000 } }
        ]
      })
    ])
    const space = spaceFor(model, 'rmMixed')
    expect(space).toBeDefined()
    expect(space!.boundary).toEqual([
      [0, 0],
      [8000, 0],
      [8000, 5000],
      [0, 5000]
    ])
    expect(space!.areaM2).toBeCloseTo(40, 2)
  })

  it('a vertex with a non-finite coordinate is dropped, and the ring stays finite', () => {
    // Four vertices, one poisoned: three survivors are still a boundary — a real triangle, never a
    // rectangle patched over the missing corner.
    const model = extractSpatialModel([
      ent('rmNaN', {
        closed: true,
        vertices: [
          { point: { x: 4691, y: 102588 } },
          { x: 29593, y: Number.NaN },
          [29593, 119358],
          { point: { x: 4691, y: 119358 } }
        ]
      })
    ])
    const space = spaceFor(model, 'rmNaN')
    expect(space).toBeDefined()
    expect(space!.boundary.length).toBe(3)
    for (const p of space!.boundary) {
      expect(Number.isFinite(p[0])).toBe(true)
      expect(Number.isFinite(p[1])).toBe(true)
    }
    // The survivors keep drawing order; the poisoned corner is simply gone.
    expect(space!.boundary).toEqual([
      [4691, 102588],
      [29593, 119358],
      [4691, 119358]
    ])
  })

  it('a null coordinate is dropped the same way as NaN, not coerced to 0', () => {
    const model = extractSpatialModel([
      ent('rmNull', {
        closed: true,
        vertices: [
          { point: { x: 4691, y: 102588 } },
          { point: { x: 29593, y: null as unknown as number } },
          [29593, 119358],
          { point: { x: 4691, y: 119358 } }
        ]
      })
    ])
    const space = spaceFor(model, 'rmNull')
    expect(space).toBeDefined()
    expect(space!.boundary.length).toBe(3)
    // `Number(null)` would have fabricated a vertex at y=0 far outside the drawn room.
    for (const p of space!.boundary) expect(p[1]).toBeGreaterThan(100000)
  })

  it('dropping a vertex drops its bulge with it, so bulges stay aligned with the survivors', () => {
    // The poisoned vertex is the only one carrying a bulge. If the bulge list were taken from the
    // unfiltered vertices it would land on a surviving segment and tessellate arc points the
    // drawing does not have — invented geometry.
    const model = extractSpatialModel([
      ent('rmAligned', {
        closed: true,
        vertices: [
          { point: { x: 0, y: 0 } },
          { point: { x: 8000, y: 0 } },
          { x: Number.NaN, y: 8000, bulge: 0.5 },
          { point: { x: 0, y: 8000 } }
        ]
      })
    ])
    const space = spaceFor(model, 'rmAligned')
    expect(space).toBeDefined()
    expect(space!.boundary.length).toBe(3)
  })

  it('a surviving vertex keeps its own bulge after filtering', () => {
    const model = extractSpatialModel([
      ent('rmBulge', {
        closed: true,
        vertices: [
          { point: { x: 0, y: 0 } },
          { point: { x: 8000, y: 0 }, bulge: 0.5 },
          { x: Number.NaN, y: 8000 },
          { point: { x: 0, y: 5000 } }
        ]
      })
    ])
    const space = spaceFor(model, 'rmBulge')
    expect(space).toBeDefined()
    // Arc tessellation inserts points between survivors: the bulge is still applied, to the segment
    // that survivor actually starts.
    expect(space!.boundary.length).toBeGreaterThan(3)
    for (const p of space!.boundary) {
      expect(Number.isFinite(p[0])).toBe(true)
      expect(Number.isFinite(p[1])).toBe(true)
    }
  })

  it('fewer than 3 usable vertices lands in insufficientData with the existing reason, and nothing throws', () => {
    let model!: SpatialModel
    expect(() => {
      model = extractSpatialModel([
        ent('rmTooFew', {
          closed: true,
          vertices: [
            { point: { x: 0, y: 0 } },
            { point: { x: 6000, y: Number.NaN } },
            { x: null as unknown as number, y: 6000 }
          ]
        })
      ])
    }).not.toThrow()

    expect(spaceFor(model, 'rmTooFew')).toBeUndefined()
    const entry = model.insufficientData.find((i) => i.handle === 'rmTooFew')
    expect(entry).toBeDefined()
    expect(entry!.reason).toBe(NOT_FABRICATING)
  })

  it('an all-non-finite vertex list is insufficientData, not a fabricated boundary', () => {
    const model = extractSpatialModel([
      ent('rmAllBad', {
        closed: true,
        vertices: [
          [Number.NaN, Number.NaN],
          [Number.POSITIVE_INFINITY, 0],
          [0, Number.NaN]
        ]
      })
    ])
    expect(model.spaces.length).toBe(0)
    expect(model.insufficientData.find((i) => i.handle === 'rmAllBad')?.reason).toBe(
      NOT_FABRICATING
    )
  })
})
