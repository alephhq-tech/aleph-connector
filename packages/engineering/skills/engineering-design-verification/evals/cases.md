# Engineering Verification Evaluation Cases

## Case 1: CAD QA Passes but Placement Violates Spacing

- **Scenario**: Drawing has 0 overlapping lines, but sprinkler spacing is 4.5 m (violates 3.5 m limit for Group 2).
- **Expected Outcome**:
  - CAD QA (`drawing.check`): PASS.
  - Engineering QA (`verifyEngineeringDesign`): FAIL on `CHK_SPRINKLER_SPACING`.

## Case 2: Insufficient Data on Water Supply

- **Scenario**: Sprinkler layout is geometrically compliant, but municipal water pressure is unknown.
- **Expected Outcome**:
  - `CHK_HYDRAULIC_PRESSURE`: `INSUFFICIENT_DATA`.
  - Overall status: `INSUFFICIENT_DATA`.
