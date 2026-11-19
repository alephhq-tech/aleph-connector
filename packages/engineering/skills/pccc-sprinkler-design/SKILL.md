---
name: pccc-sprinkler-design
description: Design code-compliant automatic fire sprinkler layouts per TCVN 7336:2021 and QCVN 06:2022/BXD. Identify hazard classification, calculate maximum head spacing and coverage areas, avoid excluded regions and structural obstacles, and generate verified CAD placements.
---

# PCCC Sprinkler Design

Assist a qualified fire-protection engineer; never imply that AI-generated plans are professionally certified. Never place sprinkler heads on an arbitrary visually-regular grid without verifying against an approved Design Basis and technical regulations.

Never claim regulatory compliance if hazard classification, ceiling height, or water supply are unknown.

## One door (mandatory for live AutoCAD)

When AutoCAD MCP is connected, **only** use `pccc_overlay` (`preview` → `apply`, or status). Do **not** hand-draw heads or pipes with `entity.create` / freeform `operations.apply`. Optional Cloud `pccc_state_*` tools checkpoint design state across turns; they do not draw CAD.

## Workflow

1. **Verify Design Basis Prerequisites**
   - Confirm hazard classification, occupancy, ceiling/obstructions, units and TCVN/QCVN edition from project-approved sources. Never assume a hazard group.
   - If critical values are missing, label the output as a non-certified visual draft.

2. **Inspect once**
   - `drawing.inspect_floorplan` with the sheet's plan title. Use `candidateIndex` when the sheet has multiple copies.
   - Take `roomRef` / `roomName` and `excludedRefs` from that result. Do **not** invent `roomBoundary` boxes.

3. **Preview → apply via `pccc_overlay`**
   - `preview`: `floorplanName`, `roomRef` or `roomName`, `hazardGroup`, `riserLocation`, `sprinklerSymbol` (catalog key or existing block). Optional `candidateIndex`, `excludedRefs`.
   - `roomBoundary` / `excludedBoundaries` require `acceptCallerGeometry: true` and must come from `entity.traceBoundary` — drafting-only.
   - If `status === ready` (not BLOCKED), `apply` with that `planId`.
   - Quote `room.boundarySource` (`cad` | `caller`) to the user. Preview verification findings check planner segment lists; **apply** runs CAD read-back (`verifyPcccApply`) on what was drawn.

## Stopping & Refusal Conditions

- Refuse compliance claims when hazard group is unverified.
- Never place heads inside excluded compartments.
- Never report compliance from preview findings alone — only apply CAD read-back proves what was drawn.
- Never invent enclosing rectangles to "make spatial analysis run".

## References

- `references/sprinkler-standards.md`: Spacing and coverage tables per TCVN 7336.
- `evals/cases.md`: Sprinkler design evaluation scenarios.
