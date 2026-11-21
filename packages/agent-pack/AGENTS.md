# Aleph Connector — agent instructions

You drive a live AutoCAD on the user's machine through the **aleph-connector** MCP server.

## Work on the user's drawing (required)

1. If the user names a DWG path (or it is already open), **open/pin that file** — `drawing` → `open` / `use` / `activate` — before any mutation. Never invent a second file under `%TEMP%` / `AppData\Local\Temp`.
2. Draw **in that document** at existing world coordinates. Do not `drawing` → `new` or `save` to a temp/`*_FA.dwg` sidecopy unless the user explicitly asked for a new file and gave the path.
3. After meaningful edits, `drawing` → `activate` the pinned tab (and `view` → `zoom_extents` only if needed) so the user can see the live AutoCAD window.
4. Save only when asked, only to a path they gave (or QSAVE of the open file). Never save to Temp.

## Before drawing

1. Call the MCP `guide` tool (or read `autocad://guide/drafting/SKILL.md`).
2. Prefer in-place edits (`operations.apply` update / transform / offset / trim / break / fillet / extend). Do **not** erase-and-redraw existing user geometry unless the user explicitly asks.

## Vietnamese fire alarm (PCCC)

Standards in force: **TCVN 7568-14:2025**, TCVN 3890:2023, QCVN 06:2022/BXD. **TCVN 5738:2021 is withdrawn** — never treat it as current design basis.

Workflow (required):

1. Survey rooms / occupancy from the drawing (`drawing.summary`, `entity.list`, spatial tools).
2. Map each space to detector/MCP rules (heat in parking/ramps; smoke in technical rooms / elevator lobbies; MCP at egress).
3. Call **`pccc_fire_alarm_overlay`** (or `pccc_overlay`) — do **not** freehand place detectors with raw `entity.create`.
4. Verify coverage / wiring (no T-tap, no shaft pierce).
5. Deliver a **device schedule / BOM** (counts by type, IDs, locations).

Read skills: `pccc-fire-alarm-design` (`autocad://guide/pccc/pccc-fire-alarm-design/SKILL.md`), then sprinkler / pipe / hydraulic skills when those systems are in scope.

## Small fixes

Use `offset`, `trim`, `extend`, `break`, `fillet` on existing handles. Keep handles stable when `update` supports the change. Never explode shared blocks unless asked.
