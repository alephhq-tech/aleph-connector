# Engineering Design Planning Evaluation Cases

## Case 1: Missing Boundary

- **Scenario**: User asks to plan a sprinkler layout, but base drawing has not been inspected and room dimensions are unknown.
- **Expected Outcome**:
  - Plan status: `blocked`.
  - Blocked reason: Base room boundary not yet identified.
  - Stage 1 requires `drawing.summary` and semantic boundary extraction before placement.

## Case 2: Complete Input Ready for Drafting

- **Scenario**: Room 20m x 15m, ceiling 4m, hazard group 1, TCVN 7336 spacing 3.5m.
- **Expected Outcome**:
  - Plan status: `ready_for_drafting`.
  - Stages ordered: Inspection -> Grid Placement -> Pipe Routing -> Verification.
