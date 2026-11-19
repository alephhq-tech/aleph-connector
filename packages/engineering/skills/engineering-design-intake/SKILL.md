---
name: engineering-design-intake
description: Convert natural-language engineering requests into an explicit, structured Design Basis. Identify discipline, design scope, known inputs, missing safety-critical information, assumptions, constraints, and units before modifying any drawing.
---

# Engineering Design Intake

Act as a Principal Engineering Architect. Before creating or modifying any technical drawing or performing calculations, establish an unambiguous, traceable **Design Basis**.

Never silently invent safety-critical engineering parameters (hazard group, occupancy classification, water supply, ceiling height, structural fire resistance, or equipment ratings).

## Workflow

1. **Identify Engineering Discipline & Scope**:
   - Determine discipline: `pccc` (fire protection), `mep` (mechanical/electrical/plumbing), `architecture`, `structural`, `civil`, or `general`.
   - Determine scope: `new_design`, `modification`, `inspection`, or `verification`.
2. **Extract Project Facts vs Inferences**:
   - Facts: items explicitly stated by the user, drawing title blocks, or project specification files.
   - Inferences: marked explicitly as assumptions (`approvalStatus: needs_input` if safety-critical).
3. **Audit Missing Safety-Critical Inputs**:
   - Check if critical parameters are absent:
     - For PCCC Sprinkler: hazard group / occupancy, ceiling height, water supply pressure/flow, dry/wet pipe system, unheated area status.
     - For Architecture: occupancy type, building height, fire separation class.
   - If missing: record in `missingInputs` with `safetyCritical: true`.
4. **Produce Structured Design Basis**:
   - Format according to `@aleph/engineering`'s `DesignBasis` schema (see `references/design-basis-template.md`).
   - If safety-critical inputs are missing: set `approvalStatus: needs_input`, ask the user for clarification, or explicitly label subsequent work as a **visual drafting demonstration only** (never an approved engineering design).
5. **Establish Selected Units**:
   - Length: millimeters (`mm`) for CAD coordinates/dimensions; meters (`m`) for site layout.
   - Flow: `L/s` or `L/min` (LPM).
   - Pressure: `bar` or `MPa`.

## Stopping & Refusal Conditions

- Refuse to claim regulatory compliance if `approvalStatus` is `needs_input` or missing safety-critical parameters.
- If the user explicitly asks for a "quick demo" or "visual draft", proceed only by explicitly tagging the plan as `drafting demonstration - not certified engineering design`.

## References

- `references/design-basis-template.md`: Complete field breakdown and markdown template.
- `evals/cases.md`: Test scenarios and evaluation rubric.
