import { describe, expect, test } from 'bun:test'
import {
  styleDimStylesCreateParams,
  styleLinetypesLoadParams,
  styleTextStylesCreateParams
} from './style.js'

describe('styleTextStylesCreateParams', () => {
  test('defaults height to 0 (variable), widthFactor to 1, obliqueAngle to 0', () => {
    const parsed = styleTextStylesCreateParams.parse({ name: 'TITLE', font: 'Arial.ttf' })
    expect(parsed).toMatchObject({ height: 0, widthFactor: 1, obliqueAngle: 0 })
  })

  test.each(['BAD<NAME', 'BAD>NAME', 'BAD/NAME', 'BAD:NAME', 'BAD,NAME', 'BAD=NAME', ''])(
    'rejects an illegal or empty name %s',
    (name) => {
      expect(() => styleTextStylesCreateParams.parse({ name, font: 'Arial.ttf' })).toThrow()
    }
  )
})

describe('styleDimStylesCreateParams', () => {
  test('defaults every dimension variable and unitsFormat', () => {
    const parsed = styleDimStylesCreateParams.parse({ name: 'PLOT-1-100' })
    expect(parsed).toMatchObject({
      textHeight: 2.5,
      arrowSize: 2.5,
      extensionOffset: 0.625,
      extensionBeyond: 1.25,
      decimalPlaces: 4,
      unitsFormat: 'decimal',
      scale: 1
    })
  })

  test('rejects decimalPlaces outside 0..8', () => {
    expect(() => styleDimStylesCreateParams.parse({ name: 'X', decimalPlaces: 9 })).toThrow()
    expect(() => styleDimStylesCreateParams.parse({ name: 'X', decimalPlaces: -1 })).toThrow()
  })

  test('rejects an unknown unitsFormat', () => {
    expect(() => styleDimStylesCreateParams.parse({ name: 'X', unitsFormat: 'metric' })).toThrow()
  })
})

describe('styleLinetypesLoadParams', () => {
  test('requires at least one name', () => {
    expect(() => styleLinetypesLoadParams.parse({ names: [] })).toThrow()
  })

  test('file is optional (plugin defaults to acadiso.lin)', () => {
    const parsed = styleLinetypesLoadParams.parse({ names: ['DASHED'] })
    expect(parsed.file).toBeUndefined()
  })
})
