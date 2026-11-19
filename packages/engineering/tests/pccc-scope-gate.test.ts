import { describe, expect, it } from 'bun:test'
import {
  findOutOfScopePoint,
  outOfScopeViolation,
  unitsPerMetreFor,
  unitsPerMmFor,
  unknownUnitsViolation,
  traceRegionBoundaries,
  type Point2D
} from '../src/index'

const ROOM: Point2D[] = [
  [0, 0],
  [12000, 0],
  [12000, 8000],
  [0, 8000]
]

describe('drawing units (E8)', () => {
  it('resolves every INSUNITS value to drawing units per metre', () => {
    expect(unitsPerMetreFor('mm')).toBe(1000)
    expect(unitsPerMetreFor('cm')).toBe(100)
    expect(unitsPerMetreFor('m')).toBe(1)
    expect(unitsPerMetreFor('in')).toBeCloseTo(39.3701, 4)
    expect(unitsPerMetreFor('ft')).toBeCloseTo(3.2808, 4)
  })

  it('unknown units resolve to null — never a silent millimetre default', () => {
    expect(unitsPerMetreFor('unitless')).toBeNull()
    expect(unitsPerMetreFor(undefined)).toBeNull()
    expect(unitsPerMetreFor(null)).toBeNull()
    expect(unitsPerMetreFor('furlongs')).toBeNull()
    expect(unitsPerMmFor('unitless')).toBeNull()
  })

  it('the unknown-units violation names the unit and the remedy', () => {
    expect(unknownUnitsViolation('unitless')).toContain('UNKNOWN_DRAWING_UNITS')
    expect(unknownUnitsViolation('unitless')).toContain('unitless')
    expect(unknownUnitsViolation(undefined)).toContain('UNKNOWN_DRAWING_UNITS')
  })
})

describe('scope gate (E9)', () => {
  it('passes every point inside the inspected room', () => {
    expect(
      findOutOfScopePoint(
        [
          [100, 100],
          [11900, 7900]
        ],
        [ROOM]
      )
    ).toBeNull()
    expect(outOfScopeViolation([[100, 100]], [ROOM])).toBeNull()
  })

  it('reports the first point outside the inspected room', () => {
    const bad = findOutOfScopePoint(
      [
        [100, 100],
        [20000, 100]
      ],
      [ROOM]
    )
    expect(bad).toEqual({ point: [20000, 100], index: 1 })
    const violation = outOfScopeViolation(
      [
        [100, 100],
        [20000, 100]
      ],
      [ROOM]
    )
    expect(violation).toContain('OUT_OF_SCOPE')
    expect(violation).toContain('[20000, 100]')
  })

  it('a point inside ANY room of the scope is in scope', () => {
    const secondRoom: Point2D[] = [
      [20000, 0],
      [28000, 0],
      [28000, 8000],
      [20000, 8000]
    ]
    expect(findOutOfScopePoint([[25000, 4000]], [ROOM, secondRoom])).toBeNull()
    expect(findOutOfScopePoint([[15000, 4000]], [ROOM, secondRoom])).not.toBeNull()
  })

  it('a point on the room boundary counts as inside within tolerance', () => {
    // On the wall exactly: tol 0 relies on ray casting, tol 1 counts boundary contact.
    expect(findOutOfScopePoint([[0, 4000]], [ROOM], 1)).toBeNull()
    expect(findOutOfScopePoint([[12000, 4000]], [ROOM], 1)).toBeNull()
  })

  it('an empty scope never passes a point', () => {
    expect(findOutOfScopePoint([[100, 100]], [])).toEqual({ point: [100, 100], index: 0 })
    expect(findOutOfScopePoint([], [])).toBeNull()
  })
})

describe('boundary trace (E8)', () => {
  it('refuses to trace when units were not declared, instead of measuring millimetres', async () => {
    let called = 0
    const result = await traceRegionBoundaries(
      async () => {
        called++
        return { found: false, boundaries: [], netArea: 0 }
      },
      [{ point: [18000, 110000], suggestedClass: 'elevator_shaft' }]
    )

    expect(called).toBe(0)
    expect(result.regions).toHaveLength(0)
    expect(result.unresolvedPoints).toHaveLength(1)
    expect(result.unresolvedPoints[0]!.reason).toContain('units were not declared')
  })
})
