import type { FireAlarmDeviceType } from './fire-alarm-types'

/**
 * Aleph's built-in PCCC symbol geometry — shipped as CODE, never read from a DWG at runtime
 * (specs/pccc-cad-drawing-truth/slices/06-symbols-are-a-product-asset.md).
 *
 * Every entry is a block-local entity list, origin at the symbol's insertion point, units matching
 * the target drawing (millimetres on a typical TCVN floor plan at 1:100). `block.ensureDefinition`
 * (the new RPC) builds the `BlockTableRecord` from exactly this list the first time a drawing lacks
 * the named block — no `DrawingOpen`/`BlockList`/`EntityCopyTo` round trip to any library DWG, and
 * no dependency on the device running AutoCAD having any file at all.
 *
 * Shape distinctions are deliberate, not decorative — the circle vs. square split is what separates
 * `COMBINATION_ALARM` from `MANUAL_CALL_POINT`, the exact pair a live customer test
 * (`cn48870`, 2026-11-10) rendered as two indistinguishable red squares when the symbol library
 * path was absent and a generic fallback drew instead. A plan is never silently decorated with a
 * substitute shape (`block-library.ts`'s existing no-fallback invariant); these are the one real
 * shape every workspace gets when it has not registered its own `cad_symbol_catalog` override.
 *
 * `[INFERENCE]` on exact TCVN pictogram fidelity: these shapes are reasoned from TCVN 5738 circle+
 * letter convention (already proven correct in production — Aleph's own `SMOKE_DETECTOR`/
 * `HEAT_DETECTOR` circle+"S"/"H" rendered correctly in the `cn48870` test) plus the shapes actually
 * observed on a real production sheet (`MẶT BẰNG PCCC QUẢNG HƯNG 14-9-2026.dwg` — X-in-square for
 * `JUNCTION_BOX`, zigzag for `END_OF_LINE_RESISTOR`). A PCCC engineer should sign off on these before
 * `status: 'approved'` on any seeded catalog row that points at them (see Slice 06 §Delegated) —
 * until then, treat this set as the zero-config default, not a certified final pictogram.
 *
 * Each entity matches the shape `CreateEntityParams` (`@aleph/mcp-autocad-wire-protocol`) accepts,
 * kept as plain JSON here (not imported) so this domain package stays free of a wire-protocol
 * dependency — the same posture `compilePcccDeviceCadEntities` already takes in `block-library.ts`.
 */
export const DEFAULT_PCCC_SYMBOL_GEOMETRY: Record<FireAlarmDeviceType, Record<string, unknown>[]> =
  {
    SMOKE_DETECTOR: [
      { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 400 },
      {
        kind: 'text.singleLine',
        insertion: { x: -140, y: -175, z: 0 },
        text: 'S',
        height: 350
      }
    ],
    HEAT_DETECTOR: [
      { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 400 },
      {
        kind: 'text.singleLine',
        insertion: { x: -150, y: -175, z: 0 },
        text: 'H',
        height: 350
      }
    ],
    /**
     * Square outline + one break-glass diagonal — the manual call point's defining feature versus
     * `COMBINATION_ALARM`'s circle. Matches the real sheet's "ô vuông đỏ" silhouette while staying
     * geometrically distinct from the alarm bell.
     */
    MANUAL_CALL_POINT: [
      {
        kind: 'polyline',
        points: [
          { x: -400, y: -400, z: 0 },
          { x: 400, y: -400, z: 0 },
          { x: 400, y: 400, z: 0 },
          { x: -400, y: 400, z: 0 }
        ],
        closed: true
      },
      { kind: 'line', start: { x: -400, y: -400, z: 0 }, end: { x: 400, y: 400, z: 0 } },
      {
        kind: 'text.singleLine',
        insertion: { x: -550, y: -650, z: 0 },
        text: 'MCP',
        height: 250
      }
    ],
    /**
     * Circle (never a square — that is `MANUAL_CALL_POINT`) with a short clapper stroke at the base,
     * the minimal glyph that still reads as "bell", not "box".
     */
    COMBINATION_ALARM: [
      { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 400 },
      { kind: 'line', start: { x: -120, y: -400, z: 0 }, end: { x: 120, y: -400, z: 0 } },
      { kind: 'line', start: { x: 0, y: -400, z: 0 }, end: { x: 0, y: -550, z: 0 } }
    ],
    /** Square outline with a diagonal cross — the exact silhouette read off a live production sheet
     * (`MẶT BẰNG PCCC QUẢNG HƯNG 14-9-2026.dwg`, "HỘP NỐI DÂY KỸ THUẬT" row). */
    JUNCTION_BOX: [
      {
        kind: 'polyline',
        points: [
          { x: -350, y: -350, z: 0 },
          { x: 350, y: -350, z: 0 },
          { x: 350, y: 350, z: 0 },
          { x: -350, y: 350, z: 0 }
        ],
        closed: true
      },
      { kind: 'line', start: { x: -350, y: -350, z: 0 }, end: { x: 350, y: 350, z: 0 } },
      { kind: 'line', start: { x: -350, y: 350, z: 0 }, end: { x: 350, y: -350, z: 0 } }
    ],
    /** Zigzag resistor symbol — the exact silhouette read off the same live sheet's "ĐIỆN TRỞ CUỐI
     * MẠCH (EOL)" row, not the IEC rectangle convention, to match what TCVN sheets actually draw. */
    END_OF_LINE_RESISTOR: [
      {
        kind: 'polyline',
        points: [
          { x: -400, y: 0, z: 0 },
          { x: -280, y: 150, z: 0 },
          { x: -140, y: -150, z: 0 },
          { x: 0, y: 150, z: 0 },
          { x: 140, y: -150, z: 0 },
          { x: 280, y: 150, z: 0 },
          { x: 400, y: 0, z: 0 }
        ],
        closed: false
      }
    ]
  }

/** The block name Aleph's default geometry registers under, keyed by device type — distinct from
 * whatever a customer's own `cad_symbol_catalog` override names its blocks, so the two can coexist
 * in one drawing without a name collision. */
export const DEFAULT_PCCC_BLOCK_NAMES: Record<FireAlarmDeviceType, string> = {
  SMOKE_DETECTOR: 'ALEPH_PCCC_SMOKE_DETECTOR',
  HEAT_DETECTOR: 'ALEPH_PCCC_HEAT_DETECTOR',
  MANUAL_CALL_POINT: 'ALEPH_PCCC_MANUAL_CALL_POINT',
  COMBINATION_ALARM: 'ALEPH_PCCC_COMBINATION_ALARM',
  JUNCTION_BOX: 'ALEPH_PCCC_JUNCTION_BOX',
  END_OF_LINE_RESISTOR: 'ALEPH_PCCC_EOL_RESISTOR'
}
