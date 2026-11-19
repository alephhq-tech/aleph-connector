# Opening Geometry, Hinge and Swing Semantics

## What the model reports per opening

| Field            | Meaning                                                                          | Trust rule                                                                            |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `hostWallHandle` | The wall segment the opening sits on                                             | null → the door is not on a wall at all                                               |
| `cutsWall`       | The wall is actually broken at the opening                                       | false → symbol painted over a continuous wall; fix segmentation                       |
| `hinge`          | Pivot point of the leaf                                                          | only as good as `hingeSource`                                                         |
| `hingeSource`    | `block-insertion` / `attribute` = fact from the drawing; `wall-endpoint` = guess | a guessed hinge must not be used to claim the sweep is clear                          |
| `swingDirection` | Which way the leaf swings                                                        | only set from explicit block metadata; `unknown` → INSUFFICIENT_DATA, not a coin flip |
| `connectionType` | `interior` (joins two spaces) / `exterior` (joins one + outside) / `unknown`     | an exterior door legitimately connects exactly one modelled space                     |
| `hasSweptArea`   | The quarter-disc sweep was computable                                            | false → do not claim clearance                                                        |

## Findings that guard openings

- `DOOR_ON_UNCUT_WALL` — advisory PASS status, but never acceptable in final work: rebuild the wall with `openings`.
- `DOOR_CONNECTS_NOTHING` — FAIL: the symbol floats over open ground; reposition on a space boundary.
- `DOOR_CONNECTS_ONE_SPACE` — FAIL for interior doors only; exterior doors are exempt by design.
- `DOOR_SWING_COLLISION` — furniture or another leaf inside the quarter disc; move the item or reverse the swing.
- `DOOR_WITHOUT_HOST_WALL` — no wall carries the opening.

## Sizing

- Clear width is measured on the drawing (gap between segments), not the block name. A "DOOR_900" drawn into a 800 gap is 800.
- Egress widths and any fire-rating requirement come from the standard: `knowledge_search` the corpus first, `web_search` official sources when the edition in force matters, and cite what confirmed it. Record unsourced numbers as missing input.
- Window sill/head heights are design intent unless a standard fixes them; state which.

## Batching rule

Every door in a batch is validated together with the furniture batch. A leaf that clears everything alone can collide with the neighbouring leaf, the wardrobe that arrives in the next step, or the swing of the door being added now.

## Failure modes this prevents

- A "door" that is a block over an unbroken wall — the room is sealed for hatches, area and accessibility.
- Claiming a swing is clear when `hingeSource: "wall-endpoint"` and `swingDirection: "unknown"` — the engine guessed, and the furniture moved.
- Calling a single-room-with-front-door invalid because the door joins only one space.
- Reporting a 900 door where the wall gap is 800.
