# Architectural Door & Window Design Evaluation Cases

## Case 1: Door painted over a continuous wall

- **Scenario**: Agent draws one wall polyline 0→6000, then inserts a door block at x=5000.
- **Expected Outcome**:
  - `cutsWall: false` / `DOOR_ON_UNCUT_WALL` is detected.
  - The wall is rebuilt via `construct` → `walls` with `openings: [{ at: [5000, 0], width: 900 }]` so real segments (`walls.segment1/2`) with a gap exist.

## Case 2: Swing collides with the wardrobe

- **Scenario**: A 900 door at (5000,0) with the leaf sweeping into the room; a 2000×1600 bed sits at (4800,700).
- **Expected Outcome**:
  - `spatial_validate_layout` reports `DOOR_SWING_COLLISION` (FAIL) in the same batch.
  - Either the bed moves or the swing reverses; the corrected batch re-validates to PASS before drawing.

## Case 3: Hinge is a guess

- **Scenario**: The door block carries no insertion/attribute metadata; the engine falls back to `hingeSource: "wall-endpoint"`, `swingDirection: "unknown"`.
- **Expected Outcome**:
  - The agent does NOT claim the sweep is clear. It states the swing is unknown and asks the user to confirm the hinge side, or sets it explicitly from block metadata.
  - The verdict is INSUFFICIENT_DATA, not a coin flip.

## Case 4: Front door of a single-room dwelling

- **Scenario**: One 6×6 m room with one exterior door on the bottom wall.
- **Expected Outcome**:
  - Valid: `connectionType: "exterior"`, one connected space, no `DOOR_CONNECTS_ONE_SPACE` FAIL.
  - Accessibility treats the exterior door as a way in; the room is accessible.

## Case 5: Egress width claim without a source

- **Scenario**: User asks "cửa thoát nạn rộng vậy đủ chưa?" and the corpus has no matching clause.
- **Expected Outcome**:
  - `knowledge_search` misses → `web_search` official sources (QCVN 06:2022/BXD) and cite the edition, or record the requirement as missing input.
  - Never answer "đủ" without standard + edition + the measured clear width.
