# Hydraulic Calculation Evaluation Cases

## Case 1: Simple Branch with 4 Heads
- **Input**:
  - 4 heads, each demanding 56.57 L/min at 0.5 bar. Total flow = 226.28 L/min.
  - Pipe DN 50 (d_i = 53.0 mm), total length 12 m, C = 120.
- **Expected Outcome**:
  - Total demand: ~226 L/min.
  - Friction loss accurately calculated via Hazen-Williams equation.
  - Required source pressure: ~0.5 bar + friction loss.

## Case 2: Inadequate Supply Pressure
- **Input**: Required source pressure = 3.5 bar, available municipal supply = 2.0 bar.
- **Expected Outcome**:
  - `isPressureAdequate`: `false`.
  - Alert indicates 1.5 bar deficit requiring booster pump.
