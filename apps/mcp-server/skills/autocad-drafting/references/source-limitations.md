# Current source limitations

These are current Aleph AutoCAD integration constraints observed in source. The skill must work around them honestly instead of hiding them.

## 1. TrueType text-style creation (fixed)

`style.textStyles.create` now accepts `trueTypeFace` (+ optional `bold`, `italic`, `charSet`,
`pitchAndFamily`). When set, `integrations/autocad/plugin/RpcHandlers/StyleHandlers.cs` calls
`TextStyleTableRecord.Font(typeface, bold, italic, charset, pitchAndFamily)` and clears
`FileName`, instead of writing the typeface into the SHX `FileName` field. `style.textStyles.list`
round-trips `isTrueType`/`typeface`/`bold`/`italic`/`charSet`/`pitchAndFamily` so the agent can
verify the style it just created.

For Vietnamese text, pass `charSet: 163` (Windows VIETNAMESE_CHARSET) with a typeface that has
Vietnamese glyph coverage (e.g. "Arial", "Times New Roman", "Tahoma").

The plain `font` field (SHX file path) still exists for legacy/engineering SHX workflows; it is
simply no longer the only option. Always verify rendering per `annotations.md`'s "Vietnamese and
other non-ASCII text" gate before mass annotation — a correct `trueTypeFace` call plus the
matching `charSet` is necessary but a visual check is still required.

## 2. Native text justification is not exposed

Single-line text is created with a baseline-left position. MText uses an insertion location. The tool schema does not expose DBText horizontal/vertical alignment or MText attachment point.

Impact:

- room-name centering is approximate;
- generated centering can drift with font metrics and long text.

Workaround:

- estimate initial placement;
- capture;
- move based on the rendered result.

Recommended source enhancement: add horizontal/vertical justification for DBText and attachment/justification for MText.

## 3. `construct room` is a geometry generator, not a room-tag-only command

It creates a closed room outline plus text/area.

Impact:

- using it after walls already define a room can create an unnecessary duplicate outline;
- its area is based on the supplied outline, not automatically on clear wall faces.

Workaround: tag existing rooms separately and calculate area from the intended clear polygon.

Recommended source enhancement: add a `room.tag` / `space.tag` intent that accepts an existing boundary or points but does not draw a new room outline.

## 4. Walls are opening-aware (fixed)

`construct` -> `walls` accepts `openings: [{ at | along, width }]` and cuts real gaps: the run comes
back as `walls.segmentN` closed outlines with nothing drawn across an opening, so a door is an actual
break in the wall rather than an arc painted over a sealed one.

`at` is projected perpendicularly onto the centreline (it need not sit exactly on it); `along` is the
arc-length distance from the run's start. Overlapping openings merge, and an opening that straddles a
closed ring's start vertex is handled by splitting the solid run at that vertex.

Still not available: trim/break of wall geometry that already exists in the drawing (issue #196).
The cut happens at construction time. Do **not** erase-and-redraw existing walls silently:
it can lose bulges, entity handles, dependencies, widths or shared block data. In the default
direct-edit workflow, explain that this operation is unsupported and request a safe native
trim/break implementation or an explicit human-reviewed replacement path.

## 5. Annotative dimension style must be configured

Annotative dimensions use the `CadAI-Annotative` dimension style created on demand. A blank style may not have the visual values expected by a professional drawing.

Workaround: explicitly create/update `CadAI-Annotative` with text/arrow/extension settings before dimensioning a blank drawing, then capture the first dimension.

Recommended source enhancement: create the annotative style by cloning the current dimension style or initialize documented paper-space defaults.

## 6. No native layout/paper-space production workflow yet

The current tool surface focuses on model-space drafting. Full layout viewport/title block/plot/publish automation is not yet a complete production surface.

Impact: do not claim that the agent can generate a complete issued drawing set merely because model-space geometry is correct.
