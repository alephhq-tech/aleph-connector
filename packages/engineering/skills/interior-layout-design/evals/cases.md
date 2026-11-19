# Interior Layout Design Evaluation Cases

## Case 1: Two pieces each valid alone collide
- **Scenario**: A bed at (1000,1000) and a wardrobe at (1900,1000) in a 6×6 m room; each is inside the room, their footprints overlap.
- **Expected Outcome**:
  - ONE `spatial_validate_layout` batch reports `FURNITURE_COLLISION` (FAIL).
  - The wardrobe moves; the corrected batch re-validates to PASS before anything is drawn.

## Case 2: Bed blocks the door sweep
- **Scenario**: A 900 door with a computable hinge sweeping into the room; the proposed bed sits inside the quarter disc.
- **Expected Outcome**:
  - `DOOR_SWING_COLLISION` FAIL in the same batch.
  - Either the bed moves or the swing reverses; never draw and "see what happens".

## Case 3: Existing DWG furniture is an obstacle
- **Scenario**: The room already contains a sofa drawn by the user; the agent adds a coffee table overlapping it.
- **Expected Outcome**:
  - The existing sofa is an automatic obstacle in the model; the collision FAILs the batch.
  - The agent does not erase the user's furniture to make the plan pass — it moves the new piece.

## Case 4: Tool snaps the bed outside the room
- **Scenario**: The plan put the bed fully inside; the batch committed it 700 units off so its footprint pokes past the wall.
- **Expected Outcome**:
  - `spatial_readback_verify` reports the bed `drifted` and `FURNITURE_OUTSIDE_SPACE` FAIL on the drawn geometry; `faithful: false`.
  - `repair` says `move` it back to the planned centre; after the edit, read back again; only `faithful: true` is reported as done.

## Case 5: Repair loop cannot converge
- **Scenario**: Every move attempt lands 200 units off (a snap setting keeps fighting the plan).
- **Expected Outcome**:
  - After 2 repair rounds (server-counted), `repair.escalate: true`.
  - The agent stops editing and reports the blocker (e.g. snap/grid settings) with the remaining discrepancies — not a third blind move.
