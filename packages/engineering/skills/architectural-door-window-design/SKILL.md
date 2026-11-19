---
name: architectural-door-window-design
description: Choose and place doors and windows — width, swing, hinge side, sill height, egress and fire ratings — so the opening is real geometry, not a symbol painted on a wall. Use when the task involves cửa đi, cửa sổ, opening sizes, door swing, or wall cutouts.
---

# Architectural Door & Window Design

An opening is a gap in a wall plus a leaf that swings somewhere. Both halves must be real on the drawing, and the swing must be provably clear of everything.

## Workflow

1. **Read the walls before choosing openings.** `spatial_analyze` returns each opening's `hostWallHandle`, `center`, `width`, `hinge`, `hingeSource`, `swingDirection`, `cutsWall` and `connectionType`. `hingeSource` tells you whether the hinge is a fact from the drawing (`block-insertion`/`attribute`) or a guess (`wall-endpoint`) — a guessed hinge must never be trusted to clear furniture.
2. **Size the opening from use and code.** Clear width for the traffic (and for egress where a standard applies), sill height for the window type, and any fire rating the design basis requires. Where a number comes from a standard, `knowledge_search` the corpus for the clause, else `web_search` an official source and cite it; if neither yields it, record it as missing input.
3. **Cut the wall, don't cover it.** `construct` → `walls` with `openings: [{ at | along, width }]`. The wall returns as `walls.segmentN` closed outlines with a genuine gap. A continuous wall with a door arc drawn over it is a sealed room: it breaks hatches, area take-offs and every later topology question.
4. **Check the swing.** The leaf sweeps a quarter disc around the hinge. `spatial_validate_layout` reports `DOOR_SWING_COLLISION` when furniture or another leaf sits in it, and `DOOR_SWING_CLEAR` when it does not. If the swing direction is unknown, the verdict is INSUFFICIENT_DATA — set it explicitly from the block metadata rather than guessing.
5. **Verify the opening is real and legal.** `cutsWall: true` at the door's position; `connectionType` matches the spaces it joins (interior joins two, exterior joins one + the outside); `DOOR_CONNECTS_NOTHING` means the symbol is floating over open ground.
6. **Read back after the batch.** `entity.list` (detail: "full") then `spatial_readback_verify` with the reported handles — a snapped opening position can put a door in the wrong segment.

## Hard rules

- Never report a door as compliant with an egress width without naming the standard, edition and the measured clear width.
- A door on an unbroken wall is never acceptable even when the check only advises: fix the wall segmentation.
- Exterior doors are ways in: an accessibility check treats them as reaching outside, so a single room with a front door is valid — do not "fix" it by inventing a second space.
- Two leaves that would collide when both open is a batch-level failure; validate both doors in the same call.

## References

- `references/opening-details.md`: opening geometry, hinge/swing semantics and the findings that guard them.
- `evals/cases.md`: worked door and window cases.
