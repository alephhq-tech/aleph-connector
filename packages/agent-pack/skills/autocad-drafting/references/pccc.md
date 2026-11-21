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

## Sprinkler drafting

A simple demo sequence is:

1. identify the protected polygon;
2. exclude rooms/voids the user said not to protect;
3. place a first row/grid coherently;
4. use arrays for repeated heads;
5. create branch lines through rows;
6. create a main line and sensible connections;
7. capture and inspect alignment, wall clearance, and exclusions;
8. respond to natural-language adjustments.

Repeated heads should align visibly. Branch lines should not randomly cross room labels or architecture.

## Pipes

Use separate layers for heads and pipes when useful. Keep branch/main hierarchy visually clear through lineweight/layer conventions.

Do not infer pipe diameter from appearance alone. Label diameters only when the design basis or user provides them.

## Fire alarm drafting (TCVN 7568-14:2025 & TCVN 3890:2023)

Keep fire alarm devices and cabling on dedicated layers (e.g. `FA-DEVICES`, `FA-WIRING`, `FA-TEXT` or `PCCC-BAOCHAY-THIETBI`, `PCCC-BAOCHAY-DAYTIN`). Follow practical architectural constraints and standard fire safety design rules (TCVN 7568-14:2025 & TCVN 3890:2023):

### 1. Detector selection by area type (Chọn loại đầu báo theo khu vực)

- **Garages, vehicle ramps, and basement parking:** Never place optical smoke detectors `(S)` directly above vehicle ramps or in exhaust-laden driveway zones — vehicle exhaust triggers persistent false alarms. Use heat detectors `(H)` (rate-of-rise / fixed temperature) or linear beam detectors. Never place detectors on sloping ramp flights.
- **Elevator shafts strict exclusion (Tuyệt đối cấm đặt trong giếng thang máy):** NEVER place any fire detector (S/H), manual call point, alarm sounder, or cable inside or cutting across elevator shafts on basement or typical floors. Elevator shafts are moving cabin zones, not rooms for floor detectors. When the floor plan actually carries elevator labels matching "THANG MÁY", "THANG", or "ELEVATOR", pass their coordinates as `elevatorPickPoints` to `pccc_fire_alarm_overlay` so AutoCAD's native `entity.traceBoundary` auto-excludes the shaft polygon. Many production drawings are delivered as one merged block per floor with **no room labels at all** — confirm with one `block` -> `inspect { includeContents: true }` census before hunting for labels, and if none exist, derive shafts/rooms from geometry or ask the user to identify them instead of looping through `entity`/`view` probes.
- **Mandatory technical room protection (Bắt buộc bảo vệ phòng kỹ thuật):** Every enclosed room labelled `P. KỸ THUẬT`, `KHO`, `PHÒNG ĐIỆN`, `MÁY PHÁT ĐIỆN`, or `AHU` MUST have at least 1 dedicated fire detector. Never leave high-risk technical rooms unprotected.
- **Anti-clustering & minimum separation (Chống dính chùm):** NEVER place multiple detectors adjacent or clustered within < 2.0m of each other. In small rooms or staircase landings (< 15m2), place exactly ONE detector.
- **Enclosed staircases (Buồng thang bộ thoát hiểm):** Do not place multiple detectors hovering midway down sloping stair flights. Install exactly ONE smoke detector at the landing ceiling per 3 floors. NEVER place heat detectors inside escape stairwells.
- **General rooms and corridors (Điều 5.9.1.1.2 / 5.9.1.1.4):** Optical smoke detectors `(S)`. The controlling limit is the **reach**: every point of the protected ceiling must lie within $7{,}2\text{ m}$ of the nearest detector, and the distance between detectors must not exceed $10{,}2\text{ m}$. A square grid therefore needs a pitch $\le 7{,}2\sqrt2 \approx 10{,}18\text{ m}$ — taking the pitch from the spacing figure alone leaves each cell corner just outside the reach. Heat detectors: $5{,}1\text{ m}$ / $7{,}2\text{ m}$ (5.9.2.1.2), pitch $\le 7{,}2\text{ m}$.
- **Clearance (5.9.1.1.4 a) / 5.9.2.1.4 a):** the outer row sits between $0{,}5\text{ m}$ and $5{,}1\text{ m}$ from a wall (smoke), between $0{,}3\text{ m}$ and $3{,}6\text{ m}$ (heat) — a detector hugging a wall is a violation, not just untidy. Keep $\ge 0{,}4\text{ m}$ from a supply-air diffuser edge (smoke) / $\ge 0{,}6\text{ m}$ (heat).

### 2. Manual call points & peripheral devices (Nút ấn báo cháy khẩn cấp & Chuông/Còi)

- **Wall & column attachment:** Manual call points (`FIRE` / `MCP`) and alarm sounders/strobes must be wall- or column-mounted at exit pathways, stairwell entry doors, or main building exits at an installation height of $1.4\text{ m} \pm 0.2\text{ m}$ from finished floor level. NEVER mount on elevator shaft walls.
- **Strict snap requirement:** Never place manual call points floating outside architectural boundary walls or in open driveways/ramps. Snap directly to the interior face of a structural column or adjacent solid wall beside egress doors.
- **Text Style & Font Encoding:** When generating Vietnamese notes or equipment legends on legacy drawings with .vn or .shx fonts (TCVN3), use unaccented uppercase text (e.g. BANG KY HIEU THIET BI BAO CHAY, MAT BANG HE THONG BAO CHAY TANG HAM) to avoid corrupted characters, or ensure TextStyle is configured with TrueType Unicode font (Arial).
- **Legend Table & Note Placement (Vị trí Bảng Ký Hiệu & Chú Thích):** The equipment legend table (`BẢNG KÝ HIỆU THIẾT BỊ BÁO CHÁY`) must be placed completely outside the architectural floor plan footprint (cách xa mặt bằng công trình ít nhất 3m - 5m, thường đặt ở khoảng trống lề trái, lề phải hoặc góc khung bản vẽ). NEVER draw legend tables overlapping onto rooms, structural grid lines (trục cột), or floor plan geometry.

### 3. Signal cable routing & circuit topology (Định tuyến dây tín hiệu báo cháy)

- **Continuous Daisy-Chain:** Conventional zones (Class B / Style Y) must be wired in a continuous **Daisy-Chain** without T-Tap branching or closed loops (`FACP -> Dev 1 -> Dev 2 -> ... -> Last Dev -> EOLR`).
- **Terminal EOL supervision:** The terminal detector carries the End-of-Line Resistor (EOLR). Never place an EOL resistor mid-circuit.
- **Orthogonal routing (Đi dây vuông góc):** Cable lines must run orthogonally (horizontal and vertical along structural beam lines, column axes, and wall perimeters), not diagonal cuts across open floor space.
- **Strict exclusion zones:** Never route fire alarm cabling across elevator shafts or open double-height voids. Cable trays/conduits must circumvent shaft boundaries along corridors or technical risers. Protect signal wires in designated conduit (e.g. `PVC D20` or fire-rated cable `2x1.5mm2`).

### 4. Building perimeter & room boundaries (Never place devices outside)

- **Reference rooms, do not redraw them.** `drawing.inspect_floorplan` returns each room it found with a `ref` and, when the drawing supports it, its closed `boundary` (`boundaryStatus: "verified"`, plus `areaM2`). Pass that `ref` and the room's `usage` to `pccc_fire_alarm_overlay`; the tool takes the outline from the drawing. This is one less thing to get wrong and one less round trip: no coordinates to copy, no box to re-derive after a retry.
- Do NOT pass a single oversized rectangular bounding box covering the whole DWG as a single room. An oversized box causes the grid generator to place detectors out in exterior yards, setbacks, or outdoor ramps!
- Only supply a `boundary` yourself when the inspect could not bind a ring (`unresolved`/`ambiguous`), with `acceptCallerGeometry: true`, and take it from `entity.traceBoundary` — never typing. Without accept → `CALLER_GEOMETRY_REQUIRES_ACCEPT`. A room with no outline blocks with `ROOM_REF_UNRESOLVED` — never a guessed box.
- Exclude open-air gardens, outdoor driveways, and voids from protected rooms.
- Sprinkler overlays use the same rule via `pccc_overlay` (one door) — do not freehand heads/pipes with `entity.create` for live drawing.

### 5. Executing the design (1-Shot overlay workflow)

- Call `pccc_fire_alarm_overlay` with `operation: 'preview'`, passing `documentName`, `floorplanName` (e.g. `"MẶT BẰNG TẦNG HẦM"`), `rooms` as `{ ref, usage }`, optional `candidateIndex`, optional `elevatorPickPoints`. **Do not invent `symbolLibraryPath`** — omit it unless you have a real library DWG on the AutoCAD machine; defaults/catalog cover the six common device types.
- `floorplanName` (+ `candidateIndex` when multi-copy) makes placement checkable: the tool resolves that plan's region (reusing a same-revision inspect when possible) and refuses with `ROOM_OUTSIDE_FLOORPLAN` / `FLOORPLAN_REGION_UNRESOLVED` rather than drawing on the wrong frame.

- Check the preview result: if `status === 'PASS'` and not blocked, immediately call `pccc_fire_alarm_overlay` with `operation: 'apply'` and the returned `planId`. Apply clones the missing symbol definitions in, then commits all entities to AutoCAD in one atomic batch. The drawn entities are one revertable unit (`operations.revert(taskId)`); the imported block definitions stay in the drawing — they are inert, invisible, and needed by the reverted entities, so reverting does not remove them.
- **`operation: 'execute'` does both in one call** — the ordinary path when the user wants the system drawn and has no reason to review a plan first. It runs the same compile + every gate as `preview` and draws only if nothing blocked; a blocked request returns the violations with `drawn: false` and writes nothing. Same code path, not a weaker one. Keep `preview` → `apply` split when a human should see the plan before it is drawn.
- Keep each system on its own functional layer set (`FA-DEVICES`, `FA-WIRING`, `FA-TEXT`) and preserve the base architecture.

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
