/**
 * Sheet-list planner — compiles the DANH MỤC BẢN VẼ (drawing index) sheet.
 *
 * A standalone title sheet, not an overlay: the engineering planners (sprinkler, fire alarm,
 * pipe routing) place devices on an existing plan drawing, while this module lays out the
 * index table of every sheet in the deliverable — banner, section bands, per-sheet rows and
 * a totals row — as deterministic geometry the `pccc_sheet` tool draws.
 *
 * Physically the sheet is a paper-style layout (origin bottom-left, y up, millimetres). It is
 * drawn at the drawing's own scale, so on a 1:100 drawing the sheet reads as the sheet of the
 * same physical size in model space — the same posture as the overlays, whose symbols are
 * drawn at scale 1 too. A true A3 paper-space version is not possible with the entity API:
 * layout/sheet creation is not part of the bridge (honest limitation, not a faked one).
 *
 * Pure and deterministic: same input → same plan, same ops. No I/O, no randomness.
 */

export interface SheetEntryInput {
  /** Section band this sheet belongs to (e.g. "BÁO CHÁY TỰ ĐỘNG"). */
  section: string
  /** Sheet code (e.g. "BC-01"). */
  code: string
  /** Sheet description (e.g. "HỆ THỐNG BÁO CHÁY TỰ ĐỘNG — HẦM"). */
  description: string
  /** Number of sheets in this code. Must be a positive integer. */
  qty: number
  /** Sheet size (e.g. "A3"). Optional — defaults to A3. */
  size?: string
  /** Optional free-text note (e.g. "theo tiêu chuẩn Bách Khoa"). */
  note?: string
}

export interface SheetListInput {
  projectName: string
  /** Short subtitle line for the info row (e.g. "TÒA NHÀ SUNLAND"). */
  subtitle?: string
  address?: string
  projectCode?: string
  sheets: SheetEntryInput[]
}

export interface SheetListRowData {
  /** Global row number, 1-based across the whole sheet. */
  stt: number
  code: string
  description: string
  qty: number
  size: string
  note?: string
}

export interface SheetListSectionData {
  section: string
  rows: SheetListRowData[]
  /** Sum of `qty` across this section's rows. */
  total: number
}

/** Physical millimetres at scale 1 — matches the overlay convention. */
export interface SheetListColumnMm {
  stt: number
  description: number
  qty: number
  size: number
  code: number
  note: number
}

export interface SheetListGeometry {
  totalWidthMm: number
  columnMm: SheetListColumnMm
  bannerHeightMm: number
  infoRowHeightMm: number
  headerHeightMm: number
  sectionHeaderHeightMm: number
  rowHeightMm: number
  totalsRowHeightMm: number
  totalHeightMm: number
  /** Y of the bottom edge of the banner (and top of the info row). */
  bannerBottomMm: number
  /** Y of the bottom edge of the info row (and top of the table). */
  tableTopMm: number
}

export interface SheetListPlan {
  status: 'PASS' | 'FAIL'
  title: string
  subtitle?: string
  address?: string
  projectCode?: string
  sections: SheetListSectionData[]
  /** Sum of every row's qty — the actual number of sheets in the deliverable. */
  totalSheets: number
  /** Number of index rows (not sheet count — rows carry qty). */
  rowCount: number
  violations: string[]
  geometry: SheetListGeometry
}

export const DEFAULT_SHEET_SIZE = 'A3'

// Physical mm. Row height is the spec's 600–700 mm; column proportions follow the index-table
// layout in the reference deliverables (BoQ spec: 1000/6600/1300/1300/1500/4000).
export const SHEET_COLUMN_MM: SheetListColumnMm = {
  stt: 900,
  description: 6600,
  qty: 1300,
  size: 1300,
  code: 1500,
  note: 4000
}

export const SHEET_BANNER_HEIGHT_MM = 1500
export const SHEET_INFO_ROW_HEIGHT_MM = 600
export const SHEET_HEADER_HEIGHT_MM = 700
export const SHEET_SECTION_HEADER_HEIGHT_MM = 900
export const SHEET_ROW_HEIGHT_MM = 600
export const SHEET_TOTALS_ROW_HEIGHT_MM = 700

export const SHEET_TEXT_HEIGHT_BANNER_MM = 700
export const SHEET_TEXT_HEIGHT_INFO_MM = 350
export const SHEET_TEXT_HEIGHT_HEADER_MM = 300
export const SHEET_TEXT_HEIGHT_SECTION_MM = 350
export const SHEET_TEXT_HEIGHT_ROW_MM = 280
export const SHEET_TEXT_HEIGHT_TOTALS_MM = 320

/** Left edge (x) of each column. Order matches SheetListColumnMm. */
export function columnX(col: keyof SheetListColumnMm): number {
  const c = SHEET_COLUMN_MM
  switch (col) {
    case 'stt': return 0
    case 'description': return c.stt
    case 'qty': return c.stt + c.description
    case 'size': return c.stt + c.description + c.qty
    case 'code': return c.stt + c.description + c.qty + c.size
    case 'note': return c.stt + c.description + c.qty + c.size + c.code
  }
}

export function totalWidthMm(): number {
  const c = SHEET_COLUMN_MM
  return c.stt + c.description + c.qty + c.size + c.code + c.note
}

/**
 * Validates the index and lays out its geometry. A FAIL plan is still returned (never thrown):
 * the tool's `apply` refuses a FAIL plan, which is the whole fail-closed posture.
 */
export function planSheetList(input: SheetListInput): SheetListPlan {
  const violations: string[] = []

  const projectName = (input.projectName ?? '').trim()
  if (!projectName) violations.push('projectName is required')

  const sheets = Array.isArray(input.sheets) ? input.sheets : []
  if (sheets.length === 0) violations.push('sheets must contain at least one entry')

  // Group rows by section, preserving first-appearance order. Row numbers are global (1-based).
  const sections: SheetListSectionData[] = []
  const seen = new Set<string>()
  let stt = 0
  for (const [index, entry] of sheets.entries()) {
    const rowLabel = `#${index + 1}`
    const section = (entry.section ?? '').trim()
    const code = (entry.code ?? '').trim()
    const description = (entry.description ?? '').trim()
    const qty = typeof entry.qty === 'number' ? entry.qty : NaN
    const size = (entry.size ?? '').trim() || DEFAULT_SHEET_SIZE
    const note = (entry.note ?? '').trim() || undefined

    if (!section) violations.push(`sheet entry ${rowLabel} (code "${code || '(no code)'}") has no section`)
    if (!code) violations.push(`sheet entry ${rowLabel} has no code`)
    if (!description) violations.push(`sheet entry ${rowLabel} (code "${code || '(no code)'}") has no description`)
    if (!Number.isInteger(qty) || qty < 1) {
      violations.push(`sheet entry ${rowLabel} (code "${code || '(no code)'}") has qty ${String(entry.qty)} — must be a positive integer`)
    }

    const key = `${section}::${code}`
    if (section && code && seen.has(key)) {
      violations.push(`duplicate sheet code "${code}" in section "${section}"`)
    }
    seen.add(key)

    stt += 1
    const row: SheetListRowData = { stt, code, description, qty: Number.isInteger(qty) ? qty : 0, size, ...(note ? { note } : {}) }
    let sectionData = sections.find((s) => s.section === section)
    if (!sectionData) {
      sectionData = { section: section || '(unknown section)', rows: [], total: 0 }
      sections.push(sectionData)
    }
    sectionData.rows.push(row)
    sectionData.total += Number.isInteger(qty) && qty >= 1 ? qty : 0
  }

  const totalSheets = sections.reduce((sum, s) => sum + s.total, 0)
  const rowCount = sections.reduce((sum, s) => sum + s.rows.length, 0)

  const bannerHeightMm = SHEET_BANNER_HEIGHT_MM
  const infoRowHeightMm = SHEET_INFO_ROW_HEIGHT_MM
  const headerHeightMm = SHEET_HEADER_HEIGHT_MM
  const sectionHeaderHeightMm = SHEET_SECTION_HEADER_HEIGHT_MM
  const rowHeightMm = SHEET_ROW_HEIGHT_MM
  const totalsRowHeightMm = SHEET_TOTALS_ROW_HEIGHT_MM

  const tableHeightMm =
    headerHeightMm +
    sections.reduce((sum, s) => sum + sectionHeaderHeightMm + s.rows.length * rowHeightMm, 0) +
    totalsRowHeightMm
  const totalHeightMm = bannerHeightMm + infoRowHeightMm + tableHeightMm
  const bannerBottomMm = totalHeightMm - bannerHeightMm
  const tableTopMm = bannerBottomMm - infoRowHeightMm

  const columnMm = { ...SHEET_COLUMN_MM }

  return {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    title: projectName,
    ...(input.subtitle ? { subtitle: input.subtitle.trim() } : {}),
    ...(input.address ? { address: input.address.trim() } : {}),
    ...(input.projectCode ? { projectCode: input.projectCode.trim() } : {}),
    sections,
    totalSheets,
    rowCount,
    violations,
    geometry: {
      totalWidthMm: totalWidthMm(),
      columnMm,
      bannerHeightMm,
      infoRowHeightMm,
      headerHeightMm,
      sectionHeaderHeightMm,
      rowHeightMm,
      totalsRowHeightMm,
      totalHeightMm,
      bannerBottomMm,
      tableTopMm
    }
  }
}

/** One `operations.apply` step in wire form — same shape the overlay tools emit. */
export interface SheetListOperation {
  op: 'create'
  entity: {
    kind: 'polyline' | 'line' | 'text.singleLine'
    layer: string
    /** polyline: closed border / grid vertices. */
    points?: Array<{ x: number; y: number; z: number }>
    start?: { x: number; y: number; z: number }
    end?: { x: number; y: number; z: number }
    insertion?: { x: number; y: number; z: number }
    text?: string
    height?: number
  }
}

export interface SheetListCompileOptions {
  /** Drawing units per millimetre — required (the tool resolves it from the drawing). */
  unitsPerMm: number
  /** Bottom-left of the whole sheet in drawing units. Default: origin (0,0). */
  origin?: { x: number; y: number }
  layer?: string
}

/**
 * Compiles a plan to the operations the tool draws, in drawing units.
 *
 * Texts are left-aligned at cell-left + inset: the plugin's text DTO has no horizontal
 * alignment field, so a centered title/number would have to be faked with estimated widths.
 * Left-aligned text in a table cell is honest and deterministic.
 */
export function compileSheetList(
  plan: SheetListPlan,
  options: SheetListCompileOptions
): SheetListOperation[] {
  const u = options.unitsPerMm
  const origin = options.origin ?? { x: 0, y: 0 }
  const layer = options.layer ?? 'PCCC_INDEX'
  const g = plan.geometry
  const mm = (v: number) => v * u
  const X = (v: number) => origin.x + mm(v)
  const Y = (v: number) => origin.y + mm(v)

  const ops: SheetListOperation[] = []
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ops.push({
      op: 'create',
      entity: {
        kind: 'line',
        layer,
        start: { x: X(x1), y: Y(y1), z: 0 },
        end: { x: X(x2), y: Y(y2), z: 0 }
      }
    })
  }
  const polyline = (points: Array<{ x: number; y: number }>) => {
    ops.push({
      op: 'create',
      entity: {
        kind: 'polyline',
        layer,
        points: points.map((p) => ({ x: X(p.x), y: Y(p.y), z: 0 }))
      }
    })
  }
  const text = (x: number, y: number, heightMm: number, value: string) => {
    if (!value) return
    ops.push({
      op: 'create',
      entity: {
        kind: 'text.singleLine',
        layer,
        insertion: { x: X(x), y: Y(y), z: 0 },
        text: value,
        height: mm(heightMm)
      }
    })
  }

  const width = g.totalWidthMm
  const total = g.totalHeightMm
  const bannerTop = total
  const bannerBottom = g.bannerBottomMm
  const infoBottom = g.tableTopMm
  const tableTop = g.tableTopMm

  // --- Outer border (one closed polyline around the full sheet).
  polyline([
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: total },
    { x: 0, y: total },
    { x: 0, y: 0 }
  ])

  // --- Banner separator + info-row separator (table top).
  line(0, bannerBottom, width, bannerBottom)
  line(0, infoBottom, width, infoBottom)

  // --- Banner: title (left-aligned, vertically centered).
  text(250, bannerBottom + (g.bannerHeightMm - SHEET_TEXT_HEIGHT_BANNER_MM) / 2, SHEET_TEXT_HEIGHT_BANNER_MM, plan.title)

  // --- Info row: subtitle — subtitle/address/projectCode joined.
  const infoLine = [plan.subtitle, plan.address, plan.projectCode].filter((s) => s && s.trim()).join('  |  ')
  if (infoLine) {
    text(250, infoBottom + 125, SHEET_TEXT_HEIGHT_INFO_MM, infoLine)
  }

  // --- Header row.
  const headerBottom = tableTop - g.headerHeightMm
  line(0, headerBottom, width, headerBottom)
  const headerTextY = headerBottom + 200
  const sttX = columnX('stt') + 150
  const descX = columnX('description') + 250
  const qtyX = columnX('qty') + 150
  const sizeX = columnX('size') + 150
  const codeX = columnX('code') + 150
  const noteX = columnX('note') + 250
  text(sttX, headerTextY, SHEET_TEXT_HEIGHT_HEADER_MM, 'STT')
  text(descX, headerTextY, SHEET_TEXT_HEIGHT_HEADER_MM, 'NỘI DUNG DANH MỤC BẢN VẼ')
  text(qtyX, headerTextY, SHEET_TEXT_HEIGHT_HEADER_MM, 'SỐ LƯỢNG')
  text(sizeX, headerTextY, SHEET_TEXT_HEIGHT_HEADER_MM, 'KHỔ BẢN VẼ')
  text(codeX, headerTextY, SHEET_TEXT_HEIGHT_HEADER_MM, 'MÃ BẢN VẼ')
  text(noteX, headerTextY, SHEET_TEXT_HEIGHT_HEADER_MM, 'GHI CHÚ')

  // --- Sections.
  let cursorY = headerBottom
  for (const section of plan.sections) {
    const sectionBottom = cursorY - g.sectionHeaderHeightMm
    // Section band separator (bottom edge of the band).
    line(0, sectionBottom, width, sectionBottom)
    text(
      250,
      sectionBottom + (g.sectionHeaderHeightMm - SHEET_TEXT_HEIGHT_SECTION_MM) / 2,
      SHEET_TEXT_HEIGHT_SECTION_MM,
      section.section.toUpperCase()
    )
    cursorY = sectionBottom
    for (const row of section.rows) {
      const rowBottom = cursorY - g.rowHeightMm
      // Skip the separator that would duplicate the totals-row top edge.
      if (rowBottom > g.totalsRowHeightMm) line(0, rowBottom, width, rowBottom)
      const cellTextY = rowBottom + (g.rowHeightMm - SHEET_TEXT_HEIGHT_ROW_MM) / 2
      text(sttX, cellTextY, SHEET_TEXT_HEIGHT_ROW_MM, String(row.stt))
      text(descX, cellTextY, SHEET_TEXT_HEIGHT_ROW_MM, row.description)
      text(qtyX, cellTextY, SHEET_TEXT_HEIGHT_ROW_MM, String(row.qty))
      text(sizeX, cellTextY, SHEET_TEXT_HEIGHT_ROW_MM, row.size)
      text(codeX, cellTextY, SHEET_TEXT_HEIGHT_ROW_MM, row.code)
      if (row.note) text(noteX, cellTextY, SHEET_TEXT_HEIGHT_ROW_MM, row.note)
      cursorY = rowBottom
    }
  }

  // --- Totals row (spans y = 0 .. totalsRowHeight).
  line(0, g.totalsRowHeightMm, width, g.totalsRowHeightMm)
  const totalsBottom = 0
  const totalsTextY = totalsBottom + (g.totalsRowHeightMm - SHEET_TEXT_HEIGHT_TOTALS_MM) / 2
  text(descX, totalsTextY, SHEET_TEXT_HEIGHT_TOTALS_MM, 'TỔNG SỐ BẢN VẼ')
  text(qtyX, totalsTextY, SHEET_TEXT_HEIGHT_TOTALS_MM, String(plan.totalSheets))

  // --- Column separators (from the table's top to the bottom edge, i.e. above the border).
  for (const edge of [columnX('description'), columnX('qty'), columnX('size'), columnX('code'), columnX('note')]) {
    line(edge, 0, edge, tableTop)
  }

  return ops
}
