import * as z from 'zod/v4'
import { layerName as symbolTableName } from './geometry.js'

export const styleLinetypesLoadParams = z.object({
  names: z.array(symbolTableName).min(1),
  file: z.string().min(1).optional()
})

export const styleTextStylesCreateParams = z.object({
  name: symbolTableName,
  font: z.string().min(1),
  /** 0 = variable height (prompted per use); any positive value fixes it. */
  height: z.number().min(0).default(0),
  widthFactor: z.number().positive().default(1),
  /** Radians. */
  obliqueAngle: z.number().default(0),
  update: z.boolean().optional(),
  /**
   * Real TrueType typeface name (e.g. "Arial"). When set, `font` is ignored and the style is a
   * real TrueType face instead of an SHX file path — use this for reliable Vietnamese/Unicode
   * rendering.
   */
  trueTypeFace: z.string().min(1).optional(),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  /** Windows LOGFONT charset; 163 = Vietnamese, 0 = ANSI (default). */
  charSet: z.number().int().min(0).default(0),
  /** Windows LOGFONT pitch-and-family; 34 (VARIABLE_PITCH | FF_SWISS) suits most sans-serif TrueType faces. */
  pitchAndFamily: z.number().int().min(0).default(34)
})

export const styleTextStylesSetCurrentParams = z.object({
  name: symbolTableName
})

export const dimStyleUnitsFormat = z.enum(['decimal', 'architectural', 'engineering'])

export const styleDimStylesCreateParams = z.object({
  name: symbolTableName,
  basedOn: symbolTableName.optional(),
  textHeight: z.number().positive().default(2.5),
  arrowSize: z.number().positive().default(2.5),
  extensionOffset: z.number().min(0).default(0.625),
  extensionBeyond: z.number().min(0).default(1.25),
  decimalPlaces: z.number().int().min(0).max(8).default(4),
  unitsFormat: dimStyleUnitsFormat.default('decimal'),
  scale: z.number().positive().default(1),
  update: z.boolean().optional()
})

export const styleDimStylesSetCurrentParams = z.object({
  name: symbolTableName
})
