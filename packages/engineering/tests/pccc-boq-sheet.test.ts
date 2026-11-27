import { describe, expect, test } from 'bun:test'
import {
  planBoqSheet,
  compileBoqSheet,
  totalWidthMm,
  BOQ_BANNER_HEIGHT_MM,
  BOQ_HEADER_HEIGHT_MM,
  BOQ_INFO_ROW_HEIGHT_MM,
  BOQ_ROW_HEIGHT_MM,
  BOQ_SECTION_HEADER_HEIGHT_MM,
  type BoqSheetInput
} from '../src/pccc/boq-sheet'

const FLOORS = ['Hầm', 'T1', 'T2', 'Tum']

const VALID: BoqSheetInput = {
  projectName: 'TÒA NHÀ SUNLAND',
  subtitle: 'TÒA NHÀ SUNLAND 20-10-2026',
  address: 'Lô G13, Khu dân cư Sunland',
  projectCode: 'KS-2026',
  floors: FLOORS,
  sections: [
    {
      section: 'I — HỆ THỐNG BÁO CHÁY',
      rows: [
        { name: 'Trung tâm báo cháy', unit: 'Tủ', qty: { Hầm: 1, T1: 0, T2: 0, Tum: 0 } },
        { name: 'Chuông đèn báo cháy', unit: 'Cái', qty: { Hầm: 2, T1: 2, T2: 2, Tum: 1 } }
      ]
    },
    {
      section: 'II — CHIẾU SÁNG SỰ CỐ & THOÁT NẠN',
      rows: [
        { name: 'Đèn chiếu sáng sự cố', unit: 'Cái', qty: { Hầm: 5, T1: 7, T2: 4, Tum: 4 } }
      ]
    }
  ]
}

describe('planBoqSheet — validation', () => {
  test('PASS on a well-formed BoQ', () => {
    const plan = planBoqSheet(VALID)
    expect(plan.status).toBe('PASS')
    expect(plan.violations).toEqual([])
  })

  test('missing projectName is a violation', () => {
    const plan = planBoqSheet({ ...VALID, projectName: '  ' })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('projectName')
  })

  test('empty floors is a violation', () => {
    const plan = planBoqSheet({ ...VALID, floors: [] })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('floors')
  })

  test('duplicate floor label is a violation', () => {
    const plan = planBoqSheet({ ...VALID, floors: ['Hầm', 'T1', 'T1'] })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('duplicate floor "T1"')
  })

  test('empty sections is a violation', () => {
    const plan = planBoqSheet({ ...VALID, sections: [] })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('sections')
  })

  test('duplicate section title is a violation', () => {
    const plan = planBoqSheet({
      ...VALID,
      sections: [VALID.sections[0], VALID.sections[0]]
    })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('duplicate section')
  })

  test('a section with no title is a violation', () => {
    const plan = planBoqSheet({
      ...VALID,
      sections: [{ section: '', rows: [{ name: 'A', unit: 'Cái', qty: { Hầm: 1, T1: 1, T2: 1, Tum: 1 } }] }]
    })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('no title')
  })

  test('row with no name / no unit is a violation', () => {
    const plan = planBoqSheet({
      ...VALID,
      sections: [{ section: 'A', rows: [{ name: '', unit: '', qty: { Hầm: 1, T1: 1, T2: 1, Tum: 1 } }] }]
    })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('no name')
    expect(plan.violations.join(' ')).toContain('no unit')
  })

  test('row missing qty for a floor is a violation', () => {
    const plan = planBoqSheet({
      ...VALID,
      sections: [{
        section: 'A',
        rows: [{ name: 'X', unit: 'Cái', qty: { Hầm: 1, T1: 1, T2: 1 } }]  // Tum missing
      }]
    })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('missing qty for floor "Tum"')
  })

  test('unknown floor key is a violation', () => {
    const plan = planBoqSheet({
      ...VALID,
      sections: [{
        section: 'A',
        rows: [{ name: 'X', unit: 'Cái', qty: { Hầm: 1, T1: 1, T2: 1, Tum: 1, T9: 1 } }]
      }]
    })
    expect(plan.status).toBe('FAIL')
    expect(plan.violations.join(' ')).toContain('unknown floor "T9"')
  })

  test('negative / non-finite qty is a violation', () => {
    for (const value of [-1, NaN, Infinity]) {
      const plan = planBoqSheet({
        ...VALID,
        sections: [{
          section: 'A',
          rows: [{ name: 'X', unit: 'Cái', qty: { Hầm: value, T1: 1, T2: 1, Tum: 1 } }]
        }]
      })
      expect(plan.status).toBe('FAIL')
      expect(plan.violations.join(' ')).toContain('finite number')
    }
  })

  test('zero is a valid quantity', () => {
    const plan = planBoqSheet({
      ...VALID,
      sections: [{
        section: 'A',
        rows: [{ name: 'X', unit: 'Cái', qty: { Hầm: 0, T1: 1, T2: 0, Tum: 0 } }]
      }]
    })
    expect(plan.status).toBe('PASS')
  })
})

describe('planBoqSheet — aggregation', () => {
  test('row total = sum of floor columns', () => {
    const plan = planBoqSheet(VALID)
    const row = plan.sections[0].rows[1]
    // 2 + 2 + 2 + 1 = 7
    expect(row.total).toBe(7)
  })

  test('row numbers are per-section, 1-based', () => {
    const plan = planBoqSheet(VALID)
    expect(plan.sections[0].rows.map((r) => r.stt)).toEqual([1, 2])
    expect(plan.sections[1].rows.map((r) => r.stt)).toEqual([1])
  })

  test('rowCount counts all rows across sections', () => {
    const plan = planBoqSheet(VALID)
    expect(plan.rowCount).toBe(3)
  })

  test('geometry: total height = banner + info + header + sections', () => {
    const plan = planBoqSheet(VALID)
    const tableHeight =
      BOQ_HEADER_HEIGHT_MM +
      plan.sections.reduce((sum, s) => sum + BOQ_SECTION_HEADER_HEIGHT_MM + s.rows.length * BOQ_ROW_HEIGHT_MM, 0)
    expect(plan.geometry.totalHeightMm).toBe(BOQ_BANNER_HEIGHT_MM + BOQ_INFO_ROW_HEIGHT_MM + tableHeight)
    expect(plan.geometry.tableTopMm).toBe(plan.geometry.totalHeightMm - BOQ_BANNER_HEIGHT_MM - BOQ_INFO_ROW_HEIGHT_MM)
  })

  test('geometry: width = sum of column widths for the given floor count', () => {
    const plan = planBoqSheet(VALID)
    expect(plan.geometry.totalWidthMm).toBe(totalWidthMm(FLOORS.length))
    expect(plan.geometry.totalWidthMm).toBe(
      800 + 5600 + 900 + FLOORS.length * 1100 + 1300
    )
  })
})

describe('compileBoqSheet — geometry', () => {
  test('emits one closed outer border and one closed section band per section', () => {
    const plan = planBoqSheet(VALID)
    const ops = compileBoqSheet(plan, { unitsPerMm: 1 })
    const polylines = ops.filter((op) => op.entity.kind === 'polyline')
    expect(polylines).toHaveLength(1)
    expect(polylines[0].entity.points![0]).toEqual(polylines[0].entity.points![polylines[0].entity.points!.length - 1])
  })

  test('text ops carry the banner title, section bands and the column headers', () => {
    const plan = planBoqSheet(VALID)
    const ops = compileBoqSheet(plan, { unitsPerMm: 1 })
    const texts = ops.filter((op) => op.entity.kind === 'text.singleLine').map((op) => op.entity.text ?? '')
    expect(texts).toContain('TÒA NHÀ SUNLAND')
    expect(texts).toContain('I — HỆ THỐNG BÁO CHÁY')
    expect(texts).toContain('II — CHIẾU SÁNG SỰ CỐ & THOÁT NẠN')
    expect(texts).toContain('DANH MỤC / TÊN THIẾT BỊ VẬT LIỆU')
    expect(texts).toContain('TỔNG CỘNG')
    // Floor headers present.
    expect(texts).toContain('Hầm')
    expect(texts).toContain('Tum')
  })

  test('row values and per-row totals appear in the texts (total column = Σ floors)', () => {
    const plan = planBoqSheet(VALID)
    const ops = compileBoqSheet(plan, { unitsPerMm: 1 })
    const texts = ops.filter((op) => op.entity.kind === 'text.singleLine').map((op) => op.entity.text ?? '')
    expect(texts).toContain('Chuông đèn báo cháy')
    expect(texts).toContain('7')   // 2+2+2+1
    expect(texts).toContain('5')   // Hầm for Đèn chiếu sáng sự cố
    expect(texts).toContain('20')  // 5+7+4+4
  })

  test('a FAIL plan still compiles inert ops (apply is refused elsewhere)', () => {
    const plan = planBoqSheet({ projectName: '', floors: [], sections: [] })
    const ops = compileBoqSheet(plan, { unitsPerMm: 1 })
    expect(ops.length).toBeGreaterThan(0)
  })

  test('origin and unitsPerMm scale every emitted coordinate', () => {
    const plan = planBoqSheet(VALID)
    const ops = compileBoqSheet(plan, { unitsPerMm: 10, origin: { x: 1000, y: 2000 } })
    for (const op of ops) {
      if (op.entity.kind === 'polyline') {
        for (const p of op.entity.points!) {
          expect(p.x).toBeGreaterThanOrEqual(1000)
          expect(p.y).toBeGreaterThanOrEqual(2000)
        }
      }
      if (op.entity.kind === 'text.singleLine') {
        const insertion = op.entity.insertion!
        expect(insertion.x).toBeGreaterThanOrEqual(1000)
        expect(insertion.y).toBeGreaterThanOrEqual(2000)
      }
    }
  })

  test('same input → same operations (deterministic)', () => {
    const a = compileBoqSheet(planBoqSheet(VALID), { unitsPerMm: 1 })
    const b = compileBoqSheet(planBoqSheet(VALID), { unitsPerMm: 1 })
    expect(a).toEqual(b)
  })
})
