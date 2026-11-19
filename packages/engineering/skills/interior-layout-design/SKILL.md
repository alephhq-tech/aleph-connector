---
name: interior-layout-design
description: Place furniture, equipment and fittings inside finished rooms — clearances, circulation, door swings and ergonomics — with batch validation before drawing and read-back after. Use when the task is nội thất, bố trí giường/tủ/bàn/ghế, showroom layout, or fitting equipment into rooms.
---

# Interior Layout Design

Furniture is the hardest part of a plan to get right automatically: every piece has a footprint, most have a clearance zone (in front of a wardrobe, under a range hood), and every one of them interacts with door swings and circulation. Treat the whole room's contents as ONE batch, never piece by piece.

## Workflow

1. **Read the room as the engine sees it.** `entity.list` (detail: "full", scoped by `layer`/`window` on a large DWG) → `spatial_analyze`. Existing furniture and columns in the DWG become obstacles automatically — you are placing into a room that already has things in it, not a blank rectangle. Note each space's `areaM2`, `accessPoints` and openings' `hinge`/`swingDirection`.
2. **Get the pieces right.** Real footprints: a bed is 2000×1600, not "a bed block"; if the user's block library has named blocks, use their measured width/depth. Clearances are part of the placement (wardrobe door swing, chair pull-out, appliance service zone) — model them as part of the footprint or as obstacles.
3. **Propose placements with a spaceId.** Each placement: `id`, `kind`, `center`, `width`, `depth`, `rotationDeg`, `spaceId`. Rotation is part of the geometry — a rotated bed has a rotated footprint, and the engine measures the rotated rectangle, not the bbox.
4. **Validate the whole batch in ONE call.** `spatial_validate_layout` checks every pair: furniture–furniture collisions (`FURNITURE_COLLISION`), furniture–door-sweep (`DOOR_SWING_COLLISION`), furniture outside its room (`FURNITURE_OUTSIDE_SPACE`), circulation pinch, accessibility. Two pieces each valid alone can still collide — that is exactly what batch validation catches. A FAIL means fix the placement, not draw anyway.
5. **Draw in one batch, keep the handles.** `operations.apply` with one step per piece; record the `entityRefs` (handle per planned id) from the result.
6. **Read back and prove it.** `entity.list` (detail: "full") after the batch, then `spatial_readback_verify` with the planned items + reported handles. `faithful: true` means every piece landed where planned and the drawn layout still passes. If not, follow the `repair` plan exactly (move/draw/erase), re-read, re-verify — at most 2 rounds, then report the blocker.

## Hard rules

- Never claim "không va chạm"/"fits" without a passing `spatial_validate_layout` verdict for that batch.
- Never claim the drawing matches the plan without a faithful `spatial_readback_verify`.
- Existing DWG furniture is an obstacle even when the user did not mention it — the engine treats it that way; your plan must too.
- A piece that must touch a wall (wardrobe, headboard) is placed by measured distance to the wall ring, not by eyeballing the bbox.
- When the room geometry is uncertain (`insufficientData` in the model), gather it first — INSUFFICIENT_DATA is not a PASS.

## References

- `references/clearance-table.md`: typical footprints and clearance zones to start from (and when to source instead of assume).
- `evals/cases.md`: worked interior-layout cases.
