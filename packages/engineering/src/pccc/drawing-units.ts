/**
 * Drawing units, resolved from `drawing.summary` `insUnits` — never assumed.
 * Mirrors the wire protocol's `InsUnits` vocabulary so tools can pass the value
 * straight through; this package keeps its own copy and never imports the wire protocol.
 */
export type DrawingUnits = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'unitless'

/** Drawing units per metre for each known unit. `unitless` has no physical meaning. */
export const UNITS_PER_METRE: Record<Exclude<DrawingUnits, 'unitless'>, number> = {
  mm: 1000,
  cm: 100,
  m: 1,
  in: 1000 / 25.4,
  ft: 1000 / 304.8
}

/**
 * Resolve an INSUNITS value to drawing units per metre, or `null` when unknown.
 * Callers must treat `null` as "cannot measure" — never fall back to 1000.
 */
export function unitsPerMetreFor(
  insUnits: DrawingUnits | string | undefined | null
): number | null {
  if (insUnits === undefined || insUnits === null || insUnits === 'unitless') return null
  const resolved = UNITS_PER_METRE[insUnits as Exclude<DrawingUnits, 'unitless'>]
  return typeof resolved === 'number' && Number.isFinite(resolved) && resolved > 0 ? resolved : null
}

/** Drawing units per millimetre (e.g. 1 for mm drawings, 0.001 for metre drawings). */
export function unitsPerMmFor(insUnits: DrawingUnits | string | undefined | null): number | null {
  const upm = unitsPerMetreFor(insUnits)
  return upm === null ? null : upm / 1000
}

/** The one violation string for undeclared units, shared by every planner. */
export function unknownUnitsViolation(insUnits: DrawingUnits | string | undefined | null): string {
  const shown = insUnits === undefined || insUnits === null ? 'unknown' : String(insUnits)
  return (
    `UNKNOWN_DRAWING_UNITS: drawing units are "${shown}" — area, spacing and length cannot be ` +
    `measured from this drawing. Read insUnits from drawing.summary (drawing.setup to declare ` +
    `them) and pass it explicitly; geometry is never assumed to be millimetres.`
  )
}
