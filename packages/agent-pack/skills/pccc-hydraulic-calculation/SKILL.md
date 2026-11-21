---
name: pccc-hydraulic-calculation
description: Orchestrate deterministic hydraulic calculations for fire sprinkler pipe networks. Calculate friction losses via Hazen-Williams, check static elevation head changes, determine required pump pressure, and compare against available water supply.
---

# PCCC Hydraulic Calculation

Act as a Fire Protection Hydraulic Specialist. Never perform safety-critical hydraulic calculations by free-form LLM estimation or rough guessing.

All hydraulic results must be computed by the deterministic `@aleph/engineering` calculation engine.

## Workflow

1. **Collect Network Topology & Parameters**:
   - Pipe segment lengths (m) and internal diameters (mm).
   - Hazen-Williams roughness coefficient $C$ (default 120 for black carbon steel pipe).
   - Remote sprinkler head minimum operating pressure (default 0.5 bar per TCVN 7336).
   - Sprinkler K-factor (standard metric K = 80 L/min·bar$^{0.5}$).
2. **Execute Deterministic Solver**:
   - Invoke `solveHydraulicSystem` from `@aleph/engineering`.
   - Traverses network tree from demand nodes to supply source.
   - Calculates segment flow (L/min) and friction loss $\Delta P$ (bar).
   - Calculates elevation static pressure changes.
3. **Compare Demand Against Supply**:
   - Compare required source pressure against available municipal or fire pump supply pressure.
   - If available pressure is lower than required: report inadequate pressure and calculate deficit.
4. **Report Traceable Results**:
   - Total demand flow (L/min).
   - Required source pressure (bar).
   - Most remote head identifier.
   - Segment-by-segment pressure loss breakdown.

## Stopping & Refusal Conditions

- If pipe network has disconnected nodes or cycles, fail with `NOT_SUPPORTED` or `DISCONNECTED`.
- If pipe internal diameter is missing, do not guess; prompt for diameter or pipe standard schedule.

## References

- `references/hydraulic-formulas.md`: Hazen-Williams and elevation equations.
- `evals/cases.md`: Test cases and validated hydraulic fixtures.
