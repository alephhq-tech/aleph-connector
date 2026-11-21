# PCCC Pipe Routing Evaluation Cases

## Case 1: Grid of 12 Heads (3 rows x 4 cols)
- **Input**: 12 heads, riser at (0, 0).
- **Expected Outcome**:
  - Main cross pipe connects from riser along row Y levels.
  - 3 branch lines created.
  - Full connectivity: 0 disconnected heads.
  - Branch sizing: DN 50 for 4 heads. Main sizing: DN 80 for 12 heads.

## Case 2: Disconnected Branch Detection
- **Input**: Pipe network with gap between branch and main.
- **Expected Outcome**:
  - Verification reports `FAIL` with disconnected segment alert.
