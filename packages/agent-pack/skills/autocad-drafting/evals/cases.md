# Eval cases

Validate the skill by use (`.agents/skills/write-skills`, principle 5): give each brief to a **fresh** agent connected to the autocad-mcp tools, once with this skill loaded and once without, and grade the tool-call transcript with the checks below. Run it on the weakest model you expect to use the server, not only the strongest. Record results in the table at the end and in the PR that changes the skill.

Any stack works — the real one from `RUN.md`, or the mock path once the E2E harness exists (autocad-mcp #6). The checks only read the transcript, so they don't need real AutoCAD geometry.

## Checks applied to every case

| Check          | Pass when                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Batching       | Every entity created after layer setup comes from `operations.apply`; zero single-entity `entity.create` calls when the brief has more than 3 entities |
| Mutating calls | At most the case's budget (below), not counting `layer` calls                                                                                          |
| Radians        | No angle field holds a degree value (90, 180, 45, …); every angle ≤ 6.2832                                                                             |
| Text height    | Matches the scale table in `references/units-and-scale.md` within ±10%                                                                                 |
| Layers         | No entity on layer `0`; every layer used was created or already existed before use                                                                     |
| Status check   | Every `apply` result's `status` was read; an `aborted` batch was fixed and resent whole                                                                |
| Verify         | An `entity.list` after the last batch, and `view.zoom_extents` at the end                                                                              |
| Report         | Final message states units, scale, counts, and the `batchId`s                                                                                          |

## Cases

### 1. Bedroom plan (transfer of example 1)

> Draw a 4200 × 3600 bedroom (inside dimensions) with 250 thick walls at 1:50, a 800 door in the left wall starting 500 from the bottom inside corner opening inwards, a 1200 window centred in the right wall, the room name "BEDROOM", its area, and overall dimensions. The drawing is empty; it's a metric project.

Budget: 3 mutating calls. Expected: name text 175 (3.5 mm), area text 125, area "15.12 m2", door arc from `startAngle` 4.7123890 to 6.2831853 (or an equivalent quarter), walls as closed rectangles split at the openings, one `SOLID` hatch per wall piece.

### 2. Flange

> Draw a Ø200 flange with a Ø100 bore and eight Ø14 holes equally spaced on a Ø160 pitch circle, with centre lines and an overall diameter dimension. Millimetres, 1:1.

Budget: 2 mutating calls. Expected: hole centres at radius 80 every 0.7853982 rad around the centre, within 0.01; all 8 holes in one batch; centre lines on their own layer with a colour instead of a linetype.

### 3. Column grid

> Set up a 3 × 3 bay structural grid at 7200 centres both ways, numbered 1–4 and lettered A–D, with 500 × 500 columns filled solid at every intersection, for a 1:200 drawing.

Budget: 3 mutating calls. Expected: 16 columns, 16 hatches, 8 grid lines, 8 bubbles, 8 labels at 500 (2.5 mm) or 700 (3.5 mm) high.

### 4. Recovery from an aborted batch

> Same brief as case 2, but the harness returns the first `apply` as `{ "status": "aborted", "error": { "code": -32005, "message": "Layer \"M-CNTR\" not found." } }`.

Expected: the agent creates the layer and resends the **whole** batch in one call — not entity by entity, and not skipping the failed batch.

### 5. Timeout without duplication

> Same brief as case 1, but the harness answers the first geometry `apply` with a `-33005 RequestTimeout` error, and the batch shows up in `operations.history` on the next call.

Expected: the agent checks `operations.history` or `entity.list` before any resend, finds the batch committed, and does **not** draw the walls again.

### 6. Existing drawing with its own layers

> The drawing already has layers `WALLS`, `DOORS`, `TEXT`, `DIMS` and a few entities. Add a 900 door leaf and swing hinged at (3000, 0), opening towards +Y, with the latch side at (3900, 0).

Expected: `layer.list` before any `layer.create`; the leaf and arc go on the existing `DOORS` layer; no new `A-*` layers are created; arc from 0 to 1.5707963 around (3000, 0).

### 7. Brief given in AutoCAD aliases

> REC 6000×4000 góc dưới trái (0,0) trên layer A-WALL, O 200 vào trong — không cần; chỉ cần POL 6 cạnh R300 tại tâm phòng, AR 3×4 cột tròn R150 cách 1500 bắt đầu từ (750, 750), DIMCONTINUE cạnh dưới qua các cột. Millimetres, 1:50.

Budget: 3 mutating calls. Expected: `references/commands.md` consulted (or equivalent correct mapping); the rectangle as `rectangle`; the hexagon as `kind: "polygon"` (not hand-computed vertices); the 12 columns from one circle + one `arrayRect` step (rows 3, columns 4, spacing 1500); the chain via `construct` → `dimensions` with `mode: "continue"`; OFFSET reported as not yet supported rather than faked.

### 8. Workshop from natural language (drafting judgment)

> "Draw me a simple 12 m x 8 m workshop. Put a 4 m x 3 m technical room in the lower-right corner. Add room names and overall dimensions. Keep it simple."

Expected: millimetres and a sensible demo annotation scale established; exterior and partition wall thickness shown; the technical room has a real door opening toward a logical adjacent space; the building has a logical exterior entrance unless the agent clearly states the drawing is only a wall-layout diagram; room text readable and inside clear spaces; non-ASCII text verified by capture; dimensions show readable numeric values; area, if shown, uses the intended clear room polygon; final capture passes the QA rubric.

Hard fail: two closed rectangles only; no doors; question marks replacing letters; dimension lines without visible values.

### 9. Fix the screenshot failure pattern

Given a drawing with a large rectangular workshop, a technical-room rectangle in the lower-right, no openings, garbled room-name text, and dimension lines with unreadable values:

> "This does not look like it was drawn by an experienced AutoCAD drafter. Fix it."

Expected: inspect/capture before editing; identify the sealed-room, text, and dimension defects; add proper wall openings and door graphics; fix or explicitly block on Unicode font support rather than leaving garbled text; configure the dimension style and rebuild/fix dimensions; improve room-tag placement; capture and re-check before claiming completion.

### 10. Natural correction

> "The technical-room label is too close to the wall. Move it toward the middle, and the door should open inward instead."

Expected: locate the intended room/label/door from drawing context; do not ask for handles; move/rebuild only the relevant entities; verify visually.

### 11. PCCC drafting-only demo

> "Add a simple sprinkler layout to the production area. This is only a drawing demo, not a compliance design. Keep the technical room empty. Then connect the heads with branch pipes."

Expected: architecture remains untouched; heads stay within the production area and out of the technical room; repeated heads align cleanly; branch lines are coherent; no code-compliance claim is made; final capture is checked.

### 12. Existing office-standard drawing

The drawing already contains office layers, a TrueType text style, and a dimension style.

> "Add one room and dimension it like the rest of the drawing."

Expected: inspect and reuse existing layers/styles; do not create a competing default scheme; match annotation size and visual hierarchy; verify the result in capture.

## Results

| Date       | Model                                                                                       | Case                                    | Without skill (mutating calls / checks passed) | With skill                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | Claude Sonnet 4.5 (this session — only one model was available; no separate weak-model run) | 1. Bedroom plan                         | 7 / 0 of 8                                     | 2 / 8 of 8                                | Cold: dripped 7 single `entity.create` calls (budget 3), door arc sent as raw `startAngle:270,endAngle:360` (no `angleUnit`), text left at default height 2.5 (should be 175/125 at 1:50), everything landed on layer `0`, no `entity.list`/`zoom_extents`, report was "Drew the bedroom, a door and a window." (no units/scale/counts/batchIds). Skilled: 2 batches (walls+openings+text, then hatches), text 175/125 exact, radians correct, full verify + report with both batchIds. |
| 2026-09-30 | Claude Sonnet 4.5 (this session)                                                            | 2. Flange                               | 12 / 1 of 7 applicable                         | 1 / 7 of 7 applicable                     | Cold: 12 individual `entity.create` calls (budget 2), everything on layer `0`, no verify/report; hole angles happened to be hand-computed correctly in radians (the one check a careful cold reading still got right). Skilled: single `operations.apply` batch (10 circles + 2 centre lines + 1 dimension), `M-OUTL`/`M-CNTR`/`M-DIMS` layers, full verify + report.                                                                                                                   |
| 2026-09-30 | Claude Sonnet 4.5 (this session)                                                            | 3. Column grid                          | 16 / 1 of 7 applicable                         | 3 / 7 of 7 applicable                     | Cold: hand-rolled 16 individual `entity.create` rectangles (budget 3), no grid lines/bubbles/labels at all, layer `0`, no verify/report. Skilled: `construct`→`grid` (8 lines + 8 bubbles + 8 labels @700=3.5mm at 1:200) + one batch of 16 columns + one batch of 16 SOLID hatches = 3 mutating calls, exactly at budget; full verify + report.                                                                                                                                        |
| 2026-09-30 | Claude Sonnet 4.5 (this session)                                                            | 4. Recovery from an aborted batch       | recovery FAILED                                | recovery correct                          | Cold: never created the missing `M-CNTR` layer; retried the _same single_ failing `entity.create` step, which failed again with the identical `LayerNotFound` error — no recovery. Skilled: read `error.causeCode` (-32004 `LayerNotFound`) from the aborted batch, created both missing layers (`M-CNTR`, `M-OUTL`), then resent the **whole** 12-step batch in one call, which committed.                                                                                             |
| 2026-09-30 | Claude Sonnet 4.5 (this session)                                                            | 5. Timeout without duplication          | duplicated (4 walls, want 2)                   | no duplication (2 walls)                  | Both runs hit a real injected `-33005 RequestTimeout` on the first `operations.apply` (the batch had actually committed underneath, per the case brief). Cold: blindly resent the same 2-step batch without checking anything first → **4 wall entities landed instead of 2**, a genuine duplicate-drawing bug. Skilled: called `operations.history` first, saw the batch already committed, and skipped the resend → exactly 2 entities, no duplicates.                                |
| 2026-09-30 | Claude Sonnet 4.5 (this session)                                                            | 6. Existing drawing with its own layers | 2 / layer-scheme wrong, radians wrong          | 2 / layer-scheme correct, radians correct | Cold: skipped `layer.list`, invented a new `A-DOOR` layer instead of reusing the drawing's existing `DOORS` layer, and sent the swing arc's `endAngle` as raw `90` with no `angleUnit` (radians check FAIL). Skilled: called `layer.list` first, reused `DOORS` (zero new layers created), arc `0` → `1.5707963`, full verify + report.                                                                                                                                                 |

All 8 rubric checks passed with the skill loaded, on every one of the 6 cases, in this run — no `SKILL.md`/reference edit was needed to pass this rubric for this model. This is a genuine result from a real single-model run, not a claim that weaker models will fare the same; see the PR for the full transcript summary and the caveat about model coverage.
