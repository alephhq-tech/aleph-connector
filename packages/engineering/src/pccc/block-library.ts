import type { CadOperation, FireAlarmDevice, FireAlarmDeviceType } from './fire-alarm-types'

/**
 * Folded (uppercase, diacritic-stripped, `_`-separated) name tokens for each device type, matching
 * the Vietnamese PCCC block vocabulary in the standard symbol library (`ki hieu.dwg`). Tokens are
 * data, not clauses: an unrecognised device type is reported as missing, never drawn as a guess.
 */
const SYMBOL_TOKENS: Record<FireAlarmDeviceType, string[]> = {
  SMOKE_DETECTOR: ['DAU_BAO_KHOI', 'KHOI', 'SMOKE'],
  HEAT_DETECTOR: ['DAU_BAO_NHIET', 'NHIET', 'HEAT'],
  MANUAL_CALL_POINT: ['NUT_NHAN_KHAN_CAP', 'NUT_NHAN', 'CALL_POINT', 'MCP'],
  COMBINATION_ALARM: ['CHUONG_BAO_CHAY', 'CHUONG', 'COI_BAO', 'ALARM'],
  JUNCTION_BOX: ['BOX_NOI_DAY', 'HOP_NOI', 'NOI_DAY', 'JB'],
  END_OF_LINE_RESISTOR: ['DIEN_TRO', 'TRO_CUOI', 'EOL', 'RESISTOR']
}

/** Device types every compliant fire-alarm layout needs a symbol for. */
export const REQUIRED_PCCC_SYMBOLS: readonly FireAlarmDeviceType[] = [
  'SMOKE_DETECTOR',
  'HEAT_DETECTOR',
  'MANUAL_CALL_POINT',
  'COMBINATION_ALARM',
  'JUNCTION_BOX',
  'END_OF_LINE_RESISTOR'
]

export type PcccBlockAssignment = Partial<Record<FireAlarmDeviceType, string>>

export interface PcccBlockResolution {
  /** Device type -> the exact definition name read from the library drawing. */
  blocks: PcccBlockAssignment
  /** Device types with no symbol in the library — the caller must fail closed on these. */
  missing: FireAlarmDeviceType[]
  /** Every non-layout definition name the library actually carries. */
  available: string[]
}

/** Matches the folding `spatial/extract.ts` and `spatial/region.ts` already use for layer/block names. */
function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Maps every fire-alarm device type onto a definition that ACTUALLY exists in the library drawing,
 * by folded-token match against the names `block.list` reported. Names are never hardcoded: the
 * earlier hardcoded guesses (`'DAU BAO KHOI - KHONG DIA CHI'`, `'ĐÈN CHỈ THỊ FIRE'`, ...) matched
 * nothing in the target DWG, `entity.create` refused every `blockReference`, and the layout degraded
 * into hand-drawn white circles — which is what this resolver exists to prevent.
 *
 * Earlier token in the list wins, and a shorter name wins ties, so "DAU BAO KHOI" is preferred over
 * "DAU BAO KHOI - KHONG DIA CHI" only when the bare one exists; both resolve consistently.
 */
export function resolvePcccBlocks(availableNames: readonly string[]): PcccBlockResolution {
  const usable = availableNames
    .map((name) => ({ name, folded: foldName(name) }))
    .filter((entry) => entry.folded.length > 0 && !entry.name.startsWith('*'))

  const blocks: PcccBlockAssignment = {}
  const missing: FireAlarmDeviceType[] = []

  for (const deviceType of REQUIRED_PCCC_SYMBOLS) {
    let best: { name: string; tokenRank: number; length: number } | null = null
    for (const [tokenIndex, token] of SYMBOL_TOKENS[deviceType].entries()) {
      for (const entry of usable) {
        if (!entry.folded.includes(token)) continue
        const candidate = { name: entry.name, tokenRank: tokenIndex, length: entry.name.length }
        if (
          !best ||
          candidate.tokenRank < best.tokenRank ||
          (candidate.tokenRank === best.tokenRank && candidate.length < best.length)
        ) {
          best = candidate
        }
      }
      if (best) break
    }
    if (best) blocks[deviceType] = best.name
    else missing.push(deviceType)
  }

  return { blocks, missing, available: usable.map((entry) => entry.name) }
}

/**
 * Compiles one device as a single `blockReference` of the library symbol it resolved to.
 *
 * Deliberately contains no hand-drawn fallback geometry. A detector whose symbol is missing is not
 * drawn as a circle + letter: `planHighwayFireAlarm` reports the unresolved type as a violation and
 * blocks apply, so a plan is never silently decorated with substitute symbols.
 */
export function compilePcccDeviceCadEntities(
  device: FireAlarmDevice,
  options: {
    blockNames?: PcccBlockAssignment
    layerDevices?: string
    layerText?: string
    scale?: number
    /**
     * Drawing units per millimetre, required: label offsets/heights below are
     * physical millimetres and must be scaled by it. No mm default — a caller
     * that does not know the units must not compile labels at all.
     */
    unitsPerMm: number
  }
): CadOperation[] {
  const layerDev = options.layerDevices ?? 'FA-DEVICES'
  const layerTxt = options.layerText ?? 'FA-TEXT'
  const scale = options.scale ?? 1.0
  const unitsPerMm = options.unitsPerMm

  // Label geometry is physical millimetres scaled into drawing units; `scale` is
  // the block insert scale and multiplies on top. Positions round to 3 decimals —
  // rounding to whole drawing units would quantise metre labels to whole metres.
  const round3 = (v: number) => Math.round(v * 1000) / 1000
  const labelOffset = (mm: number) => mm * unitsPerMm * scale

  const blockName = device.blockName ?? options.blockNames?.[device.type]
  if (!blockName) return []

  const ops: CadOperation[] = [
    {
      op: 'create',
      entity: {
        kind: 'blockReference',
        blockName,
        position: { x: device.x, y: device.y, z: 0 },
        scale: { x: scale, y: scale, z: scale },
        rotation: 0,
        layer: layerDev
      }
    }
  ]

  ops.push({
    op: 'create',
    entity: {
      // `text.singleLine` is the kind the plugin's create dispatch implements. The name used here
      // was not a wire kind at all, so every device label hit its unknown-kind arm and aborted the
      // whole batch — which is what left the model drawing the overlay by hand.
      kind: 'text.singleLine',
      text: device.label,
      insertion: {
        x: round3(device.x + labelOffset(350)),
        y: round3(device.y + labelOffset(350)),
        z: 0
      },
      height: round3(labelOffset(250)),
      layer: layerTxt
    }
  })

  // No end-of-line special case here. The resistor is its own counted device (see
  // planHighwayFireAlarm), so it compiles through this same path and lands in `deviceCounts`.
  // Emitting an extra block from here drew something the schedule never listed, and the
  // `?? blockName` fallback put a second copy of the detector's own symbol on the sheet.

  return ops
}
