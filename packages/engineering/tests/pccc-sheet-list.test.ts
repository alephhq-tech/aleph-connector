import { describe, expect, test } from 'bun:test'
import {
  planSheetList,
  compileSheetList,
  totalWidthMm,
  SHEET_BANNER_HEIGHT_MM,
  SHEET_HEADER_HEIGHT_MM,
  SHEET_INFO_ROW_HEIGHT_MM,
  SHEET_ROW_HEIGHT_MM,
  SHEET_SECTION_HEADER_HEIGHT_MM,
  SHEET_TOTALS_ROW_HEIGHT_MM,
  type SheetEntryInput
} from '../src/pccc/sheet-list'

const SUNLAND_SHEETS: SheetEntryInput[] = [
  { section: 'BÁO CHÁY TỰ ĐỘNG', code: 'BC-01', description: 'HẦM', qty: 1, size: 'A3' },
  { section: 'BÁO CHÁY TỰ ĐỘNG', code: 'BC-02', description: 'TẦNG 1', qty: 1, size: 'A3' },
  { section: 'CHIẾU SÁNG SỰ CỐ', code: 'CS-01', description: 'HẦM', qty: 1, size: 'A3' },
  { section: 'CHIẾU SÁNG SỰ CỐ', code: 'CS-02', description: 'TẦNG 1-7', qty: 7, size: 'A3' }
]

function planWith(sheets: SheetEntryInput[], overrides = {}) {
  return planSheetList({
    projectName: 'TÒA NHÀ SUNLAND',
    subtitle: 'TÒA NHÀ SUNLAND 20-10-2026',
    address: 'Lô G13, Khu dân cư Sunland, TP. Đà Nẵng',
    projectCode: 'KS-2026',
    sheets,
    ...overrides
  })
}

describe('planSheetList — validation', () => {
  test('PASS on a well-formed index', () => {
    const plan = planWith(SUNLAND_SHEETS)
    expect(plan.status).toBe('PASS')
    expect(plan.violations).toEqual([])
  })

  test('missing projectName is a violation', () => {
    const plan = planSheetList({ projectName: '  ', sheets: SUNLAND_SHEETS })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('projectName')
  })

  test('empty sheets list is a violation', () => {
    const plan = planSheetList({ projectName: 'P', sheets: [] })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('at least one entry')
  })

  test('entry with no section is a violation', () => {
    const plan = planWith([{ section: '', code: 'BC-01', description: 'HẦM', qty: 1 }])
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('no section')
  })

  test('entry with no code is a violation', () => {
    const plan = planWith([{ section: 'A', code: '', description: 'HẦM', qty: 1 }])
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('no code')
  })

  test('entry with no description is a violation', () => {
    const plan = planWith([{ section: 'A', code: 'BC-01', description: '', qty: 1 }])
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('no description')
  })

  test('qty must be a positive integer', () => {
    const zero = planWith([{ section: 'A', code: 'BC-01', description: 'HẦM', qty: 0 }])
    expect(zero.status).toBe('FAIL')
    expect(zero.violations.join(' ')).toContain('positive integer')
    const fractional = planWith([{ section: 'A', code: 'BC-01', description: 'HẦM', qty: 1.5 }])
    expect(fractional.status).toBe('FAIL')
    expect(fractional.violations.join(' ')).toContain('positive integer')
  })

  test('duplicate code in the same section is flagged (once per duplicate)', () => {
    const plan = planWith([
      { section: 'A', code: 'BC-01', description: 'HẦM', qty: 1 },
      { section: 'A', code: 'BC-01', description: 'TẦNG 1', qty: 1 }
    ])
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('duplicate sheet code "BC-01" in section "A"')
  })

  test('same code in DIFFERENT sections is not a duplicate', () => {
    const plan = planWith([
      { section: 'A', code: 'BC-01', description: 'HẦM', qty: 1 },
      { section: 'B', code: 'BC-01', description: 'TẦNG 1', qty: 1 }
    ])
    expect(plan.violations.join(' ')).not.toContain('duplicate')
  })
})

describe('planSheetList — aggregation', () => {
  test('totalSheets = sum of qty; rowCount = row count', () => {
    const plan = planWith(SUNLAND_SHEETS)
    // 1 + 1 + 1 + 7 = 10 sheets; 4 rows
    expect(plan.totalSheets).toBe(10)
    expect(plan.rowCount).toBe(4)
  })

  test('sections keep first-appearance order and per-section totals', () => {
    const plan = planWith(SUNLAND_SHEETS)
    expect(plan.sections.map((s) => s.section)).toEqual(['BÁO CHÁY TỰ ĐỘNG', 'CHIẾU SÁNG SỰ CỐ'])
    expect(plan.sections[0].total).toBe(2)
    expect(plan.sections[1].total).toBe(8)
  })

  test('row numbers are global 1-based', () => {
    const plan = planWith(SUNLAND_SHEETS)
    expect(plan.sections.flatMap((s) => s.rows.map((r) => r.stt))).toEqual([1, 2, 3, 4])
  })

  test('size defaults to A3 when omitted', () => {
    const plan = planWith([{ section: 'A', code: 'BC-01', description: 'HẦM', qty: 1 }])
    expect(plan.sections[0].rows[0].size).toBe('A3')
  })

  test('geometry: total height = banner + info + header + sections + totals', () => {
    const plan = planWith(SUNLAND_SHEETS)
    const tableHeight =
      SHEET_HEADER_HEIGHT_MM +
      plan.sections.reduce((sum, s) => sum + SHEET_SECTION_HEADER_HEIGHT_MM + s.rows.length * SHEET_ROW_HEIGHT_MM, 0) +
      SHEET_TOTALS_ROW_HEIGHT_MM
    expect(plan.geometry.totalHeightMm).toBe(SHEET_BANNER_HEIGHT_MM + SHEET_INFO_ROW_HEIGHT_MM + tableHeight)
    expect(plan.geometry.tableTopMm).toBe(plan.geometry.totalHeightMm - SHEET_BANNER_HEIGHT_MM - SHEET_INFO_ROW_HEIGHT_MM)
    expect(plan.geometry.tableTopMm).toBeGreaterThanOrEqual(SHEET_TOTALS_ROW_HEIGHT_MM)
  })

  test('geometry: width = sum of column widths', () => {
    const plan = planWith(SUNLAND_SHEETS)
    expect(plan.geometry.totalWidthMm).toBe(totalWidthMm())
    expect(plan.geometry.totalWidthMm).toBe(
      plan.geometry.columnMm.stt + plan.geometry.columnMm.description + plan.geometry.columnMm.qty + plan.geometry.columnMm.size + plan.geometry.columnMm.code + plan.geometry.columnMm.note
    )
  })
})

describe('compileSheetList — geometry', () => {
  test('emits one closed outer border, banner/info/header separators and column separators', () => {
    const plan = planWith(SUNLAND_SHEETS)
    const ops = compileSheetList(plan, { unitsPerMm: 1 })
    const polylines = ops.filter((op) => op.entity.kind === 'polyline')
    const lines = ops.filter((op) => op.entity.kind === 'line')
    // One closed outer border.
    expect(polylines).toHaveLength(1)
    // Outer border is closed (first == last vertex).
    const outer = polylines[0].entity.points!
    expect(outer[0]).toEqual(outer[outer.length - 1])
    // 5 column separators + banner/info/header/sections/rows/totals separators.
    expect(lines.length).toBeGreaterThanOrEqual(10)
  })

  test('text ops carry the banner title, section bands and the totals label', () => {
    const plan = planWith(SUNLAND_SHEETS)
    const ops = compileSheetList(plan, { unitsPerMm: 1 })
    const texts = ops.filter((op) => op.entity.kind === 'text.singleLine').map((op) => op.entity.text ?? '')
    expect(texts).toContain('TÒA NHÀ SUNLAND')
    expect(texts).toContain('BÁO CHÁY TỰ ĐỘNG')
    expect(texts).toContain('CHIẾU SÁNG SỰ CỐ')
    expect(texts).toContain('TỔNG SỐ BẢN VẼ')
    // Total sheets value.
    expect(texts).toContain('10')
  })

  test('rows appear in order with global numbering', () => {
    const plan = planWith(SUNLAND_SHEETS)
    const ops = compileSheetList(plan, { unitsPerMm: 1 })
    const texts = ops.filter((op) => op.entity.kind === 'text.singleLine').map((op) => op.entity.text ?? '')
    for (const stt of ['1', '2', '3', '4']) expect(texts).toContain(stt)
    expect(texts).toContain('BC-01')
    expect(texts).toContain('CS-02')
  })

  test('a FAIL plan still compiles inert ops (apply is refused elsewhere)', () => {
    const plan = planSheetList({ projectName: '', sheets: [] })
    const ops = compileSheetList(plan, { unitsPerMm: 1 })
    expect(ops.length).toBeGreaterThan(0)
  })

  test('origin and unitsPerMm scale every emitted coordinate', () => {
    const plan = planWith(SUNLAND_SHEETS)
    const ops = compileSheetList(plan, { unitsPerMm: 10, origin: { x: 1000, y: 2000 } })
    for (const op of ops) {
      if (op.entity.kind === 'polyline') {
        for (const p of op.entity.points!) {
          expect(p.x).toBeGreaterThanOrEqual(1000)
          expect(p.y).toBeGreaterThanOrEqual(2000)
        }
      }
      if (op.entity.kind === 'text.singleLine') {
        expect(op.entity.height).toBeGreaterThan(0)
        expect(op.entity.height).toBe(Math.round(op.entity.height!)) // mm*10, integer
        const insertion = op.entity.insertion!
        expect(insertion.x).toBeGreaterThanOrEqual(1000)
        expect(insertion.y).toBeGreaterThanOrEqual(2000)
      }
    }
  })

  test('same input → same operations (deterministic)', () => {
    const a = compileSheetList(planWith(SUNLAND_SHEETS), { unitsPerMm: 1 })
    const b = compileSheetList(planWith(SUNLAND_SHEETS), { unitsPerMm: 1 })
    expect(a).toEqual(b)
  })
})
