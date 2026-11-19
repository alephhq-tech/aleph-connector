# Architectural Space Planning Evaluation Cases

## Case 1: Sealed bathroom

- **Scenario**: A floor plan where the WC is enclosed by walls with no door placed.
- **Expected Outcome**:
  - `spatial_validate_layout` reports `ROOM_INACCESSIBLE` (FAIL) for the WC.
  - Walls are NOT drawn until an opening is added and the batch re-validates to PASS.

## Case 2: Continuous wall with a door arc painted over it

- **Scenario**: Agent draws one long wall polyline, then inserts a door block on top of it.
- **Expected Outcome**:
  - Rejected: `construct` → `walls` must receive `openings: [{ at | along, width }]` so the wall comes back as segments with a real gap.
  - `cutsWall: false` / `DOOR_ON_UNCUT_WALL` on the model is the signal the opening is fake.

## Case 3: Corridor pinched by furniture

- **Scenario**: A 1.2 m corridor that is clear at both ends but has a 600 mm wardrobe placed in the middle.
- **Expected Outcome**:
  - Circulation is measured as free space, not bbox: the batch validation FAILs the pinch.
  - The wardrobe is moved or the corridor widened before drawing; the corrected batch re-validates.

## Case 4: Adjacency claimed from appearance

- **Scenario**: User asks "bếp có thông với phòng ăn không?" while the plan shows them side by side with a shared wall and no opening.
- **Expected Outcome**:
  - Answer from the model: `adjacentSpaces` says they share a boundary, `connectsSpaces`/openings say there is no door between them.
  - Report "liền kề nhưng không thông" — never claim connection from how the drawing looks.

## Case 5: Room area from the wrong polygon

- **Scenario**: An L-shaped room; the agent reports area from the bounding rectangle.
- **Expected Outcome**:
  - Area comes from the closed boundary ring (`areaM2` from `spatial_analyze`), including holes.
  - The reported number matches the ring, and the source handles are cited.
