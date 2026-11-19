# Engineering Verification Rubric

## 1. Tri-State Verdict System

Every engineering finding must resolve to one of three truthful states:

- **PASS**: The parameter was measured directly from CAD geometry or calculated by the engineering engine, and complies with an identified standard clause.
  - Example: `Sprinkler spacing 3.2 m <= 3.5 m per TCVN 7336:2021 Table 1.`
- **FAIL**: The parameter was measured or calculated, and violates the regulatory limit.
  - Example: `Sprinkler spacing 4.2 m exceeds 3.5 m limit per TCVN 7336:2021 Table 1.`
- **INSUFFICIENT_DATA**: Critical design parameters or clauses are missing.
  - Example: `Water supply pressure is unknown; cannot verify hydraulic adequacy.`

## 2. Separation of CAD QA vs Engineering QA

| Check Level        | Tool                      | What it Proves                                                                 | What it CANNOT Prove                                                       |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **CAD QA**         | `drawing.check`           | Drawing has no duplicate lines, overlapping entities, or zero-length geometry. | Does NOT prove fire protection coverage or code compliance.                |
| **Engineering QA** | `verifyEngineeringDesign` | Symbol spacing, exclusion clearance, piping connectivity, hydraulic adequacy.  | Does NOT guarantee physical construction without qualified engineer stamp. |

```

```
