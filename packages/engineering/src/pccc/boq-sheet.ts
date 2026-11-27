/**
 * BoQ sheet planner — compiles the THỐNG KÊ VẬT TƯ (material statistics) sheet.
 *
 * The second standalone title sheet of a real Bách Khoa PCCC deliverable: banner, a
 * subtitle info row, one band per section, and one row per material with its per-floor
 * quantity column. It is a per-floor table — the real SUNLAND reference has no grand
 * total row, only per-row totals (Σ floor columns), so this planner emits no grand total.
 *
 * Physically the sheet is a paper-style layout (origin bottom-left, y up, millimetres),
 * drawn at the drawing's own scale — the same posture as the index sheet and the overlays
 * (symbols at scale 1). A true A3 paper-space version is not possible with the entity API:
 * layout/sheet creation is not part of the bridge (honest limitation).
 *
 * Pure and deterministic: same input → same plan, same ops. No I/O, no randomness.
 */

export interface BoqRowInput {
  /** Material name (e.g. "Chuông đèn báo cháy"). */
  name: string
  /** Unit of measure (e.g. "Cái", "m", "Tủ"). */
  unit: string
  /** Per-floor quantity keyed by floor label — every floor in `floors` must be present. */
  qty: Record<string, number>
}

export interface BoqSectionInput {
  /** Section band title (e.g. "I — HỆ THỐNG BÁO CHÁY"). */
  section: string
  rows: BoqRowInput[]
}

export interface BoqSheetInput {
  projectName: string
  /** Info-row subtitle (e.g. the project short name). */
  subtitle?: string
  address?: string
  projectCode?: string
  /** Floor labels in column order (e.g. ['Hầm','T1',...,'T7','Tum']). Never guessed. */
  floors: string[]
  sections: BoqSectionInput[]
}

export interface BoqRowData {
  /** Per-section row number, 1-based (mirrors the reference sheet). */
  stt: number
  name: string
  unit: string
  /** Per-floor quantity, only valid (finite, ≥ 0) entries are kept. */
  qty: Record<string, number>
  /** Σ qty across floors — the row's total. */
  total: number
}

export interface BoqSectionData {
  section: string
  rows: BoqRowData[]
}

export interface BoqSheetGeometry {
  totalWidthMm: number
  columnMm: {
    stt: number
    name: number
    unit: number
    floor: number
    total: number
  }
  bannerHeightMm: number
  infoRowHeightMm: number
  headerHeightMm: number
  sectionHeaderHeightMm: number
  rowHeightMm: number
  totalHeightMm: number
  bannerBottomMm: number
  tableTopMm: number
}

export interface BoqSheetPlan {
  status: 'PASS' | 'FAIL'
  title: string
  subtitle?: string
  address?: string
  projectCode?: string
  floors: string[]
  sections: BoqSectionData[]
  rowCount: number
  violations: string[]
  geometry: BoqSheetGeometry
}

// Physical mm — same posture as the index sheet (rows 600–700 mm, text 280 mm).
export const BOQ_COLUMN_MM = {
  stt: 800,
  name: 5600,
  unit: 900,
  floor: 1100,
  total: 1300
} as const

export const BOQ_BANNER_HEIGHT_MM = 1500
export const BOQ_INFO_ROW_HEIGHT_MM = 600
export const BOQ_HEADER_HEIGHT_MM = 700
export const BOQ_SECTION_HEADER_HEIGHT_MM = 900
export const BOQ_ROW_HEIGHT_MM = 600

export const BOQ_TEXT_HEIGHT_BANNER_MM = 700
export const BOQ_TEXT_HEIGHT_INFO_MM = 350
export const BOQ_TEXT_HEIGHT_HEADER_MM = 300
export const BOQ_TEXT_HEIGHT_SECTION_MM = 350
export const BOQ_TEXT_HEIGHT_ROW_MM = 280

export function totalWidthMm(floorCount: number): number {
  return BOQ_COLUMN_MM.stt + BOQ_COLUMN_MM.name + BOQ_COLUMN_MM.unit + floorCount * BOQ_COLUMN_MM.floor + BOQ_COLUMN_MM.total
}

/** Left edge (x) of each column. `floorIndex` is 0-based over `floors`. */
export function columnX(floors: string[], col: 'stt' | 'name' | 'unit' | 'total' | number): number {
  if (col === 'stt') return 0
  if (col === 'name') return BOQ_COLUMN_MM.stt
  if (col === 'unit') return BOQ_COLUMN_MM.stt + BOQ_COLUMN_MM.name
  if (col === 'total') return BOQ_COLUMN_MM.stt + BOQ_COLUMN_MM.name + BOQ_COLUMN_MM.unit + floors.length * BOQ_COLUMN_MM.floor
  return BOQ_COLUMN_MM.stt + BOQ_COLUMN_MM.name + BOQ_COLUMN_MM.unit + col * BOQ_COLUMN_MM.floor
}

/**
 * Validates the BoQ and lays out its geometry. A FAIL plan is still returned (never thrown):
 * the tool's `apply` refuses a FAIL plan, which is the whole fail-closed posture.
 */
export function planBoqSheet(input: BoqSheetInput): BoqSheetPlan {
  const violations: string[] = []

  const projectName = (input.projectName ?? '').trim()
  if (!projectName) violations.push('projectName is required')

  const floors = Array.isArray(input.floors) ? input.floors.map((f) => (f ?? '').trim()).filter(Boolean) : []
  if (floors.length === 0) violations.push('floors must contain at least one floor label')
  const seenFloors = new Set<string>()
  for (const floor of floors) {
    if (seenFloors.has(floor)) violations.push(`duplicate floor "${floor}"`)
    seenFloors.add(floor)
  }

  const sections = Array.isArray(input.sections) ? input.sections : []
  if (sections.length === 0) violations.push('sections must contain at least one section')

  const seenSections = new Set<string>()
  let rowCount = 0
  const sectionData: BoqSectionData[] = []
  for (const [sectionIndex, sectionInput] of sections.entries()) {
    const sectionTitle = (sectionInput.section ?? '').trim()
    const sectionLabel = `#${sectionIndex + 1}`
    if (!sectionTitle) violations.push(`section ${sectionLabel} has no title`)
    if (sectionTitle && seenSections.has(sectionTitle)) violations.push(`duplicate section "${sectionTitle}"`)
    seenSections.add(sectionTitle)

    const rows: BoqRowData[] = []
    const rawRows = Array.isArray(sectionInput.rows) ? sectionInput.rows : []
    for (const [rowIndex, rowInput] of rawRows.entries()) {
      const rowLabel = `row #${rowIndex + 1}`
      const name = (rowInput.name ?? '').trim()
      const unit = (rowInput.unit ?? '').trim()
      if (!name) violations.push(`${sectionLabel} ${rowLabel} has no name`)
      if (!unit) violations.push(`${sectionLabel} ${rowLabel} ("${name || '(no name)'}") has no unit`)

      const qty: Record<string, number> = {}
      const qtyInput = rowInput.qty ?? {}
      for (const key of Object.keys(qtyInput)) {
        if (!seenFloors.has(key)) violations.push(`${sectionLabel} ${rowLabel} ("${name || '(no name)'}") has qty for unknown floor "${key}"`)
      }
      for (const floor of floors) {
        const value = qtyInput[floor]
        if (value === undefined) {
          violations.push(`${sectionLabel} ${rowLabel} ("${name || '(no name)'}") is missing qty for floor "${floor}"`)
          continue
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          violations.push(`${sectionLabel} ${rowLabel} ("${name || '(no name)'}"): qty for floor "${floor}" must be a finite number ≥ 0`)
          continue
        }
        qty[floor] = value
      }
      const total = Object.values(qty).reduce((sum, v) => sum + v, 0)
      rows.push({ stt: rows.length + 1, name, unit, qty, total })
      rowCount += 1
    }
    sectionData.push({ section: sectionTitle, rows })
  }

  const bannerHeightMm = BOQ_BANNER_HEIGHT_MM
  const infoRowHeightMm = BOQ_INFO_ROW_HEIGHT_MM
  const headerHeightMm = BOQ_HEADER_HEIGHT_MM
  const sectionHeaderHeightMm = BOQ_SECTION_HEADER_HEIGHT_MM
  const rowHeightMm = BOQ_ROW_HEIGHT_MM

  const tableHeightMm =
    headerHeightMm +
    sectionData.reduce((sum, s) => sum + sectionHeaderHeightMm + s.rows.length * rowHeightMm, 0)
  const totalHeightMm = bannerHeightMm + infoRowHeightMm + tableHeightMm
  const bannerBottomMm = totalHeightMm - bannerHeightMm
  const tableTopMm = bannerBottomMm - infoRowHeightMm

  return {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    title: projectName,
    ...(input.subtitle ? { subtitle: input.subtitle.trim() } : {}),
    ...(input.address ? { address: input.address.trim() } : {}),
    ...(input.projectCode ? { projectCode: input.projectCode.trim() } : {}),
    floors,
    sections: sectionData,
    rowCount,
    violations,
    geometry: {
      totalWidthMm: totalWidthMm(floors.length),
      columnMm: { ...BOQ_COLUMN_MM },
      bannerHeightMm,
      infoRowHeightMm,
      headerHeightMm,
      sectionHeaderHeightMm,
      rowHeightMm,
      totalHeightMm,
      bannerBottomMm,
      tableTopMm
    }
  }
}

/** One `operations.apply` step in wire form — same shape the index sheet and overlays emit. */
export interface BoqSheetOperation {
  op: 'create'
  entity: {
    kind: 'polyline' | 'line' | 'text.singleLine'
    layer: string
    points?: Array<{ x: number; y: number; z: number }>
    start?: { x: number; y: number; z: number }
    end?: { x: number; y: number; z: number }
    insertion?: { x: number; y: number; z: number }
    text?: string
    height?: number
  }
}

export interface BoqSheetCompileOptions {
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
 * alignment field, so centering would have to be faked with estimated widths. Left-aligned
 * text in a table cell is honest and deterministic.
 */
export function compileBoqSheet(
  plan: BoqSheetPlan,
  options: BoqSheetCompileOptions
): BoqSheetOperation[] {
  const u = options.unitsPerMm
  const origin = options.origin ?? { x: 0, y: 0 }
  const layer = options.layer ?? 'PCCC_BOQ'
  const g = plan.geometry
  const mm = (v: number) => v * u
  const X = (v: number) => origin.x + mm(v)
  const Y = (v: number) => origin.y + mm(v)

  const ops: BoqSheetOperation[] = []
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

  const floors = plan.floors
  const width = g.totalWidthMm
  const total = g.totalHeightMm
  const bannerBottom = g.bannerBottomMm
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
  line(0, tableTop, width, tableTop)

  // --- Banner: title (left-aligned, vertically centered).
  text(
    250,
    bannerBottom + (g.bannerHeightMm - BOQ_TEXT_HEIGHT_BANNER_MM) / 2,
    BOQ_TEXT_HEIGHT_BANNER_MM,
    plan.title
  )

  // --- Info row: subtitle — subtitle/address/projectCode joined.
  const infoLine = [plan.subtitle, plan.address, plan.projectCode].filter((s) => s && s.trim()).join('  |  ')
  if (infoLine) {
    text(250, tableTop + 125, BOQ_TEXT_HEIGHT_INFO_MM, infoLine)
  }

  // --- Header row.
  const headerBottom = tableTop - g.headerHeightMm
  line(0, headerBottom, width, headerBottom)
  const headerTextY = headerBottom + 200
  const nameX = columnX(floors, 'name') + 250
  const unitX = columnX(floors, 'unit') + 150
  const totalX = columnX(floors, 'total') + 200
  text(columnX(floors, 'stt') + 150, headerTextY, BOQ_TEXT_HEIGHT_HEADER_MM, 'STT')
  text(nameX, headerTextY, BOQ_TEXT_HEIGHT_HEADER_MM, 'DANH MỤC / TÊN THIẾT BỊ VẬT LIỆU')
  text(unitX, headerTextY, BOQ_TEXT_HEIGHT_HEADER_MM, 'ĐVT')
  for (let i = 0; i < floors.length; i++) {
    text(columnX(floors, i) + 150, headerTextY, BOQ_TEXT_HEIGHT_HEADER_MM, floors[i])
  }
  text(totalX, headerTextY, BOQ_TEXT_HEIGHT_HEADER_MM, 'TỔNG CỘNG')

  // --- Sections.
  let cursorY = headerBottom
  for (const section of plan.sections) {
    const sectionBottom = cursorY - g.sectionHeaderHeightMm
    line(0, sectionBottom, width, sectionBottom)
    text(
      250,
      sectionBottom + (g.sectionHeaderHeightMm - BOQ_TEXT_HEIGHT_SECTION_MM) / 2,
      BOQ_TEXT_HEIGHT_SECTION_MM,
      section.section.toUpperCase()
    )
    cursorY = sectionBottom
    for (const row of section.rows) {
      const rowBottom = cursorY - g.rowHeightMm
      line(0, rowBottom, width, rowBottom)
      const cellTextY = rowBottom + (g.rowHeightMm - BOQ_TEXT_HEIGHT_ROW_MM) / 2
      text(columnX(floors, 'stt') + 150, cellTextY, BOQ_TEXT_HEIGHT_ROW_MM, String(row.stt))
      text(nameX, cellTextY, BOQ_TEXT_HEIGHT_ROW_MM, row.name)
      text(unitX, cellTextY, BOQ_TEXT_HEIGHT_ROW_MM, row.unit)
      for (let i = 0; i < floors.length; i++) {
        const value = row.qty[floors[i]]
        text(columnX(floors, i) + 150, cellTextY, BOQ_TEXT_HEIGHT_ROW_MM, value === undefined ? '—' : String(value))
      }
      text(totalX, cellTextY, BOQ_TEXT_HEIGHT_ROW_MM, String(row.total))
      cursorY = rowBottom
    }
  }

  // --- Column separators (from the table's top to its bottom edge).
  const boundaries: number[] = [columnX(floors, 'name'), columnX(floors, 'unit')]
  for (let i = 0; i < floors.length; i++) boundaries.push(columnX(floors, i))
  boundaries.push(columnX(floors, 'total'))
  boundaries.push(width)
  for (const x of [...new Set(boundaries)].sort((a, b) => a - b)) {
    if (x > 0 && x < width) line(x, 0, x, tableTop)
  }

  return ops
}
