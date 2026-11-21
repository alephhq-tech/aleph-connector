# MCP tool playbook

This reference maps drafting intent to the current Aleph AutoCAD tool surface.

## Session and drawing

- `context`: connection, every AutoCAD instance, open documents — and `documentsError` naming why the tab list is missing (check `references/errors.md` before retrying).
- `drawing` -> `list_open`: enumerate tabs.
- `drawing` -> `use`: pin a target tab.
- `drawing` -> `inspect_floorplan`: locate, inspect, and frame a specific floor plan (e.g. 'tầng hầm', 'hầm', 'basement', 'tầng 1', 'lầu 1', 'mái'). The returned `bounds` are justified by `regionBasis`: `title-frame` (a closed border contains that title and no other plan's title), `block-frame` (the extents AutoCAD reports for the block reference named after that plan — the drafter's own grouping, which is what a one-block-per-floor drawing actually delivers) or `connected-geometry` (the stroke cluster the title belongs to) come with bounds; `ambiguous`/`unresolved` return none, because no single rectangle in the sheet can be attributed to that title. When `ambiguous` arrives with `regionCandidates`, the plan is genuinely drawn several times on that sheet: re-call with `candidateIndex` (0-based) to read one copy — re-searching with different wording changes nothing, and designing over all copies at once puts devices on the wrong floor view. On an attributed region each `rooms[]` entry also carries a real `boundary` (closed WCS polygon), `boundaryStatus` (`verified`/`unresolved`/`ambiguous`), `ref` (stable per revision — pass it to the PCCC tools instead of re-typing coordinates) and `areaM2`, assembled from the CAD State index with no extra drawing read; `geometryComplete` says whether every room resolved. A room with no single trusted closed ring around its label comes back `unresolved`/`ambiguous` with no polygon — never guess one. `capture.status` reports the PNG result (`ok`/`failed`) as data, not an error. When the basis is not one of the first two, do NOT re-inspect with different wording and do not design over the whole sheet — ask the user which plan it is, or have them add/close a border around it. ALWAYS use this when the user asks to identify, inspect, or see a specific floor plan.
- `drawing` -> `info`: drawing metadata and counts.
- `drawing` -> `setup`: units, precision, annotation scale, linetype/dimension scale.
- `drawing` -> `check`: duplicates, overlaps, zero-length, open outlines, layer zero, text size, dimension overrides, off-extents.
- `drawing` -> `cleanup`: selected cleanup operations; use dry-run first.

## Layers and styles

- `layer` -> `list` before creating a new scheme.
- `layer` -> `ensure` for a coherent layer set.
- `style` -> `linetypes.load` before assigning dashed/center/hidden linetypes.
- `style` -> `textStyles.list/create/setCurrent` for text-style state; `create` supports `trueTypeFace` for real Unicode-capable styles (see `source-limitations.md`).
- `style` -> `dimStyles.list/create/setCurrent` for dimension-style state.

## Geometry

Use `entity` for a few direct objects and `operations` for coordinated groups.

Supported create kinds include:

- line;
- circle;
- arc;
- polyline;
- rectangle;
- polygon;
- donut;
- mtext;
- single-line text;
- block reference;
- linear/aligned/ordinate dimensions;
- dimension chains;
- hatch.

Transform operations include move, rotate, scale, mirror, copy, rectangular array, polar array, and path array.

## Construct

Use `construct` only when its semantic intent matches the desired geometry:

- `walls`: wall run from a centreline; pass `openings` (`{ at | along, width }`) so doors/windows are cut as real gaps instead of drawn over a sealed wall — see `references/architecture.md`;
- `grid`: structural grid with bubbles/labels;
- `room`: room outline plus tag and area; avoid duplicating a room outline already defined by walls;
- `dimensions`: chain dimensions.

## Batching

Use `operations` -> `apply` for repeated or related entities. One coherent batch should correspond to one logical undo step.

Good batch boundaries:

1. base wall geometry;
2. openings/door graphics;
3. room labels;
4. dimensions;
5. one specialist overlay system.

Do not put the entire project into one giant opaque batch if later correction would require undoing unrelated work.

## References inside a batch

Use batch-local ids and `@id` references when later steps consume earlier handles within the same batch and the schema supports it.

## Capture and live view

By default, drafting uses stationary camera (`follow: off`). Only use `view` -> `live` with `follow: fit` or `pan` when the user explicitly asks to track individual stroke motions.

Use `view` -> `capture` after meaningful phases. Capture is part of the QA loop, not a decorative final screenshot. `capture` can't render a model space with zero entities — draw something first; the plugin now fails fast with a clear "no entities to capture" error on a blank drawing instead of a cryptic native-graphics exception. `zoom`/`zoom_extents` alone don't help here since they only move the camera, not the geometry.

A batch of 20+ entities is refused unless it passes `capture: "changed"` (or `"all"`) or an explicit `visualReview: "unavailable"` saying a picture cannot be produced. The refusal happens before anything is drawn, and the choice you make is recorded on the commit receipt — an unviewed bulk draw stays visible in the ledger afterwards. Prefer `capture`; on a drawing that is wrong at that scale, a handle list proves nothing. Counted is what gets drawn, not how many steps you wrote: one `dimension.chain` or array step counts as the entities it expands to, and `entity` refuses outright once a preset expands past that bound — draw bulk geometry with `construct` or `operations` so a picture comes back with it.

`view` -> `zoom`'s world-space size field is `viewHeight` (drawing units, e.g. millimetres), not `height` — `height`/`width` on this tool are `capture`'s pixel image size (max 2048) and are unrelated; the portable tool schema flattens every operation's fields into one object, so reusing `height` for both would silently apply the wrong bound.

## Existing drawing edits

Use `entity` -> `list` with full detail for geometry inspection, then `entity` -> `get` for exact targets.

A very large sheet can outrun the region walk itself. `inspect_floorplan` then answers `regionBasis: "unresolved"` with `stoppedReason: "budget"`, **no bounds and no rooms**: that is a read-size limit, not evidence that the plan is absent, and it is not a reason to retry the same sheet with different wording. Shrink the read instead — target one `documentName`, or have the user isolate/freeze the other plans on the sheet.

On a drawing whose model space is a handful of merged block references (one per floor), `entity` -> `list` returns almost nothing and says nothing about what is inside those blocks. Answer "where are this plan's labels and walls" with **one** `block` -> `inspect { handle, includeContents: true }`: it reports per-kind entity counts of the definition, every text-bearing entity (DBText/MText/ATTDEF, ATTDEF with its tag) in the definition's local coordinates, the nested block names, and the ATTRIB values attached to the instance in world coordinates. `rooms: []` from `inspect_floorplan` is only meaningful once that census has run — it distinguishes "the labels are deeper in the block tree" from "this drawing was produced with no room labels at all", and the second case is a fact to report, not a gap to keep probing.

When the user refers to "the upper row", "the room on the right", or "the pipe near the door", resolve the target from geometry and visual context. Do not ask for handles.
