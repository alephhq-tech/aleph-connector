---
name: engineering-design-planning
description: Produce a structured, verifiable multi-stage engineering plan before modifying any CAD drawing. Order stages, specify geometric operations, link calculations, set clear stopping conditions, and maintain plan status.
---

# Engineering Design Planning

Act as a Chief Design Engineer. Before generating or modifying geometry in AutoCAD, formulate an ordered, phased engineering plan.

A plan is never considered complete if safety-critical dimensions, constraints, or technical dependencies remain unresolved.

## Workflow

1. **Evaluate Design Basis & CAD Context**:
   - Read the structured `DesignBasis` from `engineering-design-intake`.
   - Read the existing drawing geometry using `cad-semantic-analysis` or `drawing.summary`.
2. **Determine Plan Status**:
   - `blocked`: Critical inputs (hazard group, boundary, flow, clearance) are missing.
   - `ready_for_drafting`: All inputs and standards constraints are resolved; operations are sequenced.
   - `verification_required`: Drafting operations completed; awaiting engineering verification.
   - `reviewed`: Both CAD QA and Engineering compliance checks passed.
3. **Structure Ordered Stages**:
   Each stage must specify:
   - `stageNumber`: Positive integer sequence.
   - `name`: Clear phase name (e.g. "Stage 1: Boundary & Hazard Zone Extraction", "Stage 2: Equipment Grid Placement", "Stage 3: Pipe Network Routing").
   - `operations`: Explicit AutoCAD MCP operations (`entity.create`, `operations.apply`, etc.).
   - `calculationRequired`: Name of deterministic engine calculation (e.g. `hydraulic_calculation`, `coverage_check`).
   - `stoppingCondition`: Measurable state determining when this stage is finished.
4. **Link Real Coordinates & Handles**:
   - Reference real drawing coordinates and entity handles identified during inspection.
   - Never generate arbitrary disconnected coordinates when working inside an existing base DWG.
5. **Enforce Clean Undo & Batching**:
   - Batch operations so the user retains clean undo history.

## Stopping & Refusal Conditions

- If a prerequisite calculation fails or returns `INSUFFICIENT_DATA`, stop and mark plan as `blocked`.
- Do not jump directly into drawing mutations without completing planning.

## References

- `references/planning-rubric.md`: Planning guidelines and stage transitions.
- `evals/cases.md`: Verification cases for phased design planning.
