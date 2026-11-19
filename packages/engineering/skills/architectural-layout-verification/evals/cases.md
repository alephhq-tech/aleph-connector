# Architectural Layout Verification Evaluation Cases

## Case 1: Verify after a mutation, not from the old snapshot

- **Scenario**: A batch just committed 12 furniture items; the user asks "xong chưa, kiểm tra lại".
- **Expected Outcome**:
  - A FRESH `entity.list` (detail: "full") after the batch, then `spatial_readback_verify` with the reported handles.
  - The verdict cites the drawn geometry; the pre-draw PASS is never quoted as proof.

## Case 2: Faithful but invalid

- **Scenario**: Every item landed exactly where planned, but the plan itself put a bed across the door sweep.
- **Expected Outcome**:
  - `faithful: true` (planned == drawn) AND status FAIL (`DOOR_SWING_COLLISION`).
  - The report says both: the drawing faithfully implements the plan, and the plan is wrong — fix the placement and re-run the preflight, do not edit entities blindly.

## Case 3: Valid but not faithful

- **Scenario**: The drawn layout passes every check, but the bed landed 700 units from where it was planned.
- **Expected Outcome**:
  - status PASS, `faithful: false`, the bed `drifted`.
  - The agent reports the discrepancy and applies the `repair` move — a valid drawing is not the approved drawing.

## Case 4: Unknown swing blocks the verdict

- **Scenario**: A door block carries no metadata; `swingDirection: "unknown"`, `hingeSource: "wall-endpoint"`.
- **Expected Outcome**:
  - The door-sweep question is INSUFFICIENT_DATA, not PASS.
  - The report names what would close it (explicit hinge/swing metadata or the user's confirmation).

## Case 5: "No overlaps" over a partial scope

- **Scenario**: The agent read only the `A-NOI_THAT` layer of a 3 MB DWG and found no collisions.
- **Expected Outcome**:
  - The report states the scope: "no overlaps among the 41 items on A-NOI_THAT within the read window" — not "the drawing has no overlaps".
  - Anything outside the scope is named as unverified.
