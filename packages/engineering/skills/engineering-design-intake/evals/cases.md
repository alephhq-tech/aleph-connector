# Engineering Design Intake Evaluation Cases

## Case 1: Casual Natural Language Workshop Demo

- **User Request**: "Draw a small workshop, put a technical room in the corner, then add sprinkler heads."
- **Expected Outcome**:
  - Discipline: `pccc`.
  - Scope: `new_design`.
  - Missing Inputs: Ceiling height, hazard group, water supply.
  - Status: Labels output as drafting demonstration. No false compliance claims.

## Case 2: Certified Fire Protection Submittal

- **User Request**: "Design the fire sprinkler layout for the warehouse according to TCVN 7336:2021 with certified compliance."
- **Expected Outcome**:
  - Checks whether hazard group and water supply pressure are known.
  - If unknown: halts with `needs_input`, asks for hazard classification.
  - Never invents hazard group 1 or 2 arbitrarily.
