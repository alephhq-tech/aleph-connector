# PCCC overlay drafting

This reference governs CAD behavior, not regulatory approval.

## Base drawing first

For an existing architectural DWG, treat architecture as the base. Inspect it before adding PCCC content.

Do not redraw the building unless the user asks. Preserve the original geometry and use separate PCCC layers.

## Natural workflow

A user may simply say:

- "Add sprinkler heads to this workshop.";
- "Connect the heads with branch pipes.";
- "Move the top row down a little.";
- "Keep the architecture unchanged.".

Interpret the request from the drawing. Do not require tool or layer names.

## Design basis gate

Do not claim code-compliant spacing, pipe sizing, detector selection, hydraulic performance, or equipment quantity unless an approved design basis/rule set was provided.

For a technical demo with no approved basis, say internally and in the report that the layout is visual/drafting-only. Use evenly spaced, visually coherent symbols rather than pretending the spacing is regulatory.

## Standards research (TCVN / QCVN / NĐ)

Vietnamese fire-protection rules change editions — TCVN 7568-14:2025 replaced the 2015 edition, QCVN 10:2025/BCA took effect 30/12/2025, Nghị định 105/2025/NĐ-CP from 01/07/2025. Citing a superseded edition is a defect even when the arithmetic is right.

When a number (spacing, coverage radius, water flow, equipment count, egress width) must come from a standard:

1. `knowledge_search` the workspace knowledge base first — the user's own copies of the standards are indexed there. Quote the clause text and the document name back to the user.
2. If the KB has no match, or you cannot tell which edition is in force for this project's date, `web_search` official sources (thuvienphapluat.vn, the issuing ministry, the standards body) and say which source confirmed the edition. A vendor's product page is never the sole basis for a number.
3. If neither yields the clause, record it as missing input — do not fill the gap from memory.

Distinguish what binds: a **quy chuẩn** (QCVN) is mandatory; a **tiêu chuẩn** (TCVN) is voluntary unless invoked by regulation, the approved dossier, or the contract. The "bảng đối chiếu" comparison tables in a project folder are checklists, not an independent legal source — every row still traces to a clause.

## Verification states

Every PCCC claim ends in one of three states, and the report says which:

- **PASS** — measured against a named clause (standard + edition + article) with the actual number from the drawing (e.g. "detector spacing 8.4 m ≤ 9 m per TCVN 7568-XX:20YY clause N");
- **FAIL** — measured and outside the limit;
- **INSUFFICIENT_DATA** — the geometry, the clause, or the design basis is missing.

"No overlaps found by `drawing` → `check`" is a geometry PASS, never a compliance PASS. Compliance needs the clause, the measurement, and the inputs listed together.

## Reading a large base drawing

For an existing DWG (a barn, a factory, anything with thousands of entities), start with `drawing` → `summary` — one call returns extents, units, per-layer counts, block/xref inventory, a preview of the drawing's free-standing text (notes), and `blockTexts`: the non-empty attribute values of every distinct block, each tagged with its block name. A title block's project name, drawing number, scale and date live in those attributes, never in model-space text — read them from `blockTexts` before concluding the drawing is unlabelled. Then read only the region you need: `entity` → `list` with a `layer` or `window` filter. Never page `entity.list` across a whole large drawing to "understand it" — that is slow and buries the signal. Never call `entity` → `get` in a loop over dozens of handles: sequential single-handle reads exhaust the turn budget and cause incomplete, truncated answers.

## Establishing authoritative room geometry without modifying the source plan

For PCCC work on an unexploded architectural block or a DWG containing loose wall lines instead of closed room polylines, **do not** invent `A-ROOM` rectangles or alter the building simply to make spatial analysis return a space.

1. Read the selected native drawing/region and inspect nested block geometry and nearby wall/door/opening handles without exploding shared definitions.
2. Build virtual closed region candidates **in memory**, with exact source handles, unit provenance and confidence; resolve open corners and ambiguous boundaries from existing geometry.
3. If the requested region remains ambiguous, report precisely which geometry is missing and request the minimum necessary selection or dimension. Do not assert an area or force a guessed polygon.
4. Compile all authorized PCCC placements from verified design inputs and an approved real block catalog. Preflight the logical plan once in the engineering engine, not once per entity or native micro-batch.
5. Write one or a few native journaled CAD batches to the actual selected DWG. Then verify the affected handles/blocks/positions using native receipts and targeted read-back. Keep standards compliance separate from drafting completeness.

## Symbol placement

Prefer block references from the project's existing symbol library when available. Use consistent block scale and rotation.

If no block exists and the user accepts a demo symbol, use a simple geometric placeholder on a dedicated layer. Do not present the placeholder as a final PCCC symbol standard.

## Sprinkler drafting & pipe networks

> **Primary Skill Reference:** For engineering calculations, hazard classification (Group 1/2/3), sprinkler spacing, water flow rates, and coverage standards per TCVN 7336:2021, refer directly to `pccc-sprinkler-design` and `pccc-pipe-routing`. For hydraulic friction losses and pump calculations, refer to `pccc-hydraulic-calculation`.

From a CAD drafting perspective:
1. **Tool Authority:** Always use the dedicated overlay tool `pccc_overlay` (`preview` → `apply` or `execute`) to generate sprinkler heads and pipe geometry. Never hand-draw heads or pipes with raw `entity.create`.
2. **Layer Separation:** Keep sprinkler heads and pipe networks on dedicated layers (e.g. `SPK-HEADS`, `SPK-PIPES`, `SPK-TEXT`).
3. **Preserve Base Architecture:** Never trim, break, or modify existing architectural walls, structural columns, or room boundaries when drawing pipe runs.
4. **Visual Hierarchy:** Keep branch/main hierarchy visually distinct through standard lineweight and layer conventions. Align heads visibly across room grids.

## Fire alarm drafting (CAD standards & overlay execution)

> **Primary Skill Reference:** For regulatory standards in force (**TCVN 7568-14:2025**, TCVN 3890:2023, QCVN 06:2022/BXD), detailed detector selection (heat vs. smoke), coverage radii, pitch calculations, circuit topologies (Daisy-Chain / EOLR), and module mappings, refer directly to `pccc-fire-alarm-design`. Do not duplicate regulatory criteria here.

Follow these strict CAD drafting and architectural layout constraints:

### 1. Layer discipline & text formatting
- **Dedicated layers:** Keep fire alarm devices, wiring, and annotations strictly on dedicated layers: `FA-DEVICES` (or `PCCC-BAOCHAY-THIETBI`), `FA-WIRING` (or `PCCC-BAOCHAY-DAYTIN`), and `FA-TEXT`.
- **Text style & font encoding:** When annotating on legacy drawings with `.vn` or `.shx` fonts (TCVN3), use unaccented uppercase text (e.g. `BANG KY HIEU THIET BI BAO CHAY`, `MAT BANG HE THONG BAO CHAY TANG HAM`) to avoid character corruption, or ensure TextStyle is configured with a TrueType Unicode font (Arial).
- **Equipment legend placement:** The equipment legend table (`BẢNG KÝ HIỆU THIẾT BỊ BÁO CHÁY`) must be placed completely outside the architectural floor plan footprint ($3\text{ – }5\text{ m}$ clear distance in margins or title block corner). NEVER overlap legend tables onto rooms, structural grid lines, or building geometry.

### 2. Spatial containment & exclusion zones
- **Room boundary containment:** Always reference verified room boundaries from `drawing.inspect_floorplan`. Never pass an oversized bounding box that places devices into exterior setbacks, outdoor ramps, or yards.
- **Elevator shaft exclusion:** Never place detectors, manual call points, sounders, or signal cables inside or cutting across elevator shafts. Pass shaft coordinates as `elevatorPickPoints` so `pccc_fire_alarm_overlay` excludes them natively.
- **Wall & column attachment:** Snap manual call points (`MCP`) and sounders directly to the interior clear face of walls or columns beside egress doors ($Z = 1.4\text{ m} \pm 0.2\text{ m}$). Never float them outside walls.
- **Orthogonal wiring:** Signal cable lines must run orthogonally along beam axes and corridors, never cutting diagonally across open spaces or slicing through solid walls and shafts.

### 3. Overlay tool execution (1-Shot workflow)
- Call `pccc_fire_alarm_overlay` with `operation: 'preview'`, passing `floorplanName` and `rooms` as `{ ref, usage }`.
- When preview status is `PASS`, commit with `operation: 'apply'` and `planId`. Alternatively, call `operation: 'execute'` to compile and draw in one verified step.
- Drawn entities commit as an atomic, journaled batch that can be undone cleanly with `operations.undo` without affecting base drawing geometry.

## Hydrant, exit, and other systems

Keep each system on its own functional layer set and preserve the base architecture. Do not add every system merely because the drawing is a PCCC drawing.

## QA

For overlays, additionally check:

- symbols are inside the intended protected area;
- excluded rooms are actually excluded;
- rows intended to be regular are aligned;
- pipes connect to the intended symbols;
- specialist content does not modify architectural walls;
- annotation remains readable after the overlay is added.
