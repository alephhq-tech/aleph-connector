# Verification Rubric: Finding Codes and Report Shape

## What each finding proves

| Code                       | Status               | What it means                                                     | What closes it                                     |
| -------------------------- | -------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `FURNITURE_COLLISION`      | FAIL                 | Two drawn footprints overlap                                      | move one; re-validate                              |
| `FURNITURE_OUTSIDE_SPACE`  | FAIL                 | A footprint crosses its room's boundary ring                      | move it inside the ring (rings, not bbox)          |
| `DOOR_SWING_COLLISION`     | FAIL                 | An item sits in a door's quarter-disc sweep                       | move the item or reverse the swing                 |
| `DOOR_ON_UNCUT_WALL`       | advisory             | The wall is continuous under the door                             | rebuild the wall with `openings`                   |
| `DOOR_CONNECTS_NOTHING`    | FAIL                 | The opening joins no space                                        | reposition on a boundary                           |
| `DOOR_CONNECTS_ONE_SPACE`  | FAIL (interior only) | An interior door joins one space                                  | add the second space or mark exterior              |
| `ROOM_INACCESSIBLE`        | FAIL                 | No door path from an entrance/exterior                            | add an opening                                     |
| circulation width          | FAIL                 | Free space between footprints below required                      | move/reduce items                                  |
| `insufficientData` entries | INSUFFICIENT_DATA    | Geometry could not be judged (unknown swing, unclassified entity) | read more (`window`/`layer` scope, block metadata) |

## Planned-vs-actual states

| State     | Meaning                                              | Repair                                              |
| --------- | ---------------------------------------------------- | --------------------------------------------------- |
| `matched` | landed within `positionTolerance` (default 50 units) | —                                                   |
| `drifted` | drawn, but beyond tolerance                          | `move` back to the planned centre                   |
| `missing` | planned, never drawn                                 | `draw` at the planned centre                        |
| `extra`   | drawn, never planned                                 | `erase` (unless the user added it themselves — ask) |

`faithful: true` = every item matched AND the re-validated layout passes. The two are independent: faithful+FAIL means the plan itself was wrong; drifted+PASS means the drawing is valid but not the one that was approved.

## Report shape

Every verification answer contains:

1. The verdict: PASS / FAIL / INSUFFICIENT_DATA.
2. The scope actually read: which layers, which window, how many entities — "no overlaps found" is only true over that scope.
3. Per finding: code, entity handles, the measurement (e.g. "bed handle 3A2F footprint overlaps door 4C10 sweep by 300 mm").
4. Per inference: labelled as inferred (`hingeSource: "wall-endpoint"`, low confidence).
5. What would change the verdict: the missing geometry or the corrected placement.

## Failure modes this prevents

- Re-verifying from the pre-mutation snapshot and reporting the old drawing.
- Reporting PASS because the preflight passed, without reading the drawing back.
- Treating INSUFFICIENT_DATA as "probably fine".
- Quoting a drawing's text ("đã kiểm tra") as if it were a verdict.
